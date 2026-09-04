import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setImmediate as waitImmediate } from 'node:timers/promises';
import vm from 'node:vm';
import { describe, test } from 'node:test';
import { WebSocketServer } from 'ws';
import { analyzeJavaScriptCandidates } from '../../src/plugins/webcrypto-observer/analyzer.js';
import {
  cdpSafetyContract,
  CdpClient,
  CdpInboundTrafficGate,
  classifyAttachedTarget,
  classifyObservationRequest,
  ObservationTrafficGate,
} from '../../src/plugins/webcrypto-observer/cdp.js';
import {
  buildInstrumentationScript,
  buildMutationUpdateExpression,
  normalizeMutationRule,
} from '../../src/plugins/webcrypto-observer/instrumentation.js';
import {
  chromiumHostResolverRules,
  normalizeObserveRequest,
  WEBCRYPTO_OBSERVER_LIMITS,
} from '../../src/plugins/webcrypto-observer/policy.js';
import { WebCryptoObserverService } from '../../src/plugins/webcrypto-observer/service.js';
import { createWebCryptoObserverPlugin, webCryptoObserverSafetyContract } from '../../src/plugins/webcrypto-observer/index.js';
import type {
  BrowserObservationCallbacks,
  BrowserObservationDriver,
  BrowserObservationHandle,
  DriverCompletion,
  NormalizedObserveRequest,
  RawRuntimeCryptoEvent,
  TrafficSnapshot,
} from '../../src/plugins/webcrypto-observer/types.js';

const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];
const VALID_POLICY = {
  getPolicy: () => ({ enabled: true, allowedDomains: ['app.example.com'] }),
};
const BASE_REQUEST = {
  authorizationConfirmed: true,
  sessionEnabled: true,
  targetUrl: 'https://app.example.com/path?token=do-not-return',
};

class FakeDriver implements BrowserObservationDriver {
  request?: NormalizedObserveRequest;
  callbacks?: BrowserObservationCallbacks;
  mutationRules: Array<{ phase: string; matchLiteral: string; replacementLiteral: string }> = [];
  mutationError?: Error;
  stopCalls = 0;
  private resolveCompletion?: (result: DriverCompletion) => void;
  private traffic: TrafficSnapshot = {
    requestsStarted: 1,
    requestsBlocked: 0,
    responseBytesObserved: 512,
    requestBytesAllowed: 0,
    peakConcurrentRequests: 1,
  };

  async start(request: NormalizedObserveRequest, callbacks: BrowserObservationCallbacks): Promise<BrowserObservationHandle> {
    this.request = request;
    this.callbacks = callbacks;
    const completion = new Promise<DriverCompletion>((resolve) => { this.resolveCompletion = resolve; });
    return {
      completion,
      getTraffic: () => ({ ...this.traffic }),
      setMutation: async (rule) => {
        if (this.mutationError) throw this.mutationError;
        this.mutationRules.push({ ...rule });
      },
      stop: async () => {
        this.stopCalls += 1;
        this.complete('stopped', 'user-stopped');
      },
    };
  }

  emit(event: Omit<RawRuntimeCryptoEvent, 'token'>): void {
    this.callbacks?.onCryptoEvent({ token: 'fake-driver-token', ...event });
  }

  complete(outcome: DriverCompletion['outcome'], reasonCode?: string): void {
    this.resolveCompletion?.({ outcome, reasonCode, traffic: { ...this.traffic } });
    this.resolveCompletion = undefined;
  }
}

describe('offline WebCrypto candidate analysis', () => {
  test('returns locations and API names without executing or returning source', () => {
    const sourceText = [
      'const secret = "super-secret-value";',
      'const encoded = new TextEncoder().encode(secret);',
      'await crypto.subtle.encrypt({ name: "AES-GCM" }, key, encoded);',
      'const plain = await window.crypto.subtle.decrypt(algorithm, key, ciphertext);',
    ].join('\n');
    const result = analyzeJavaScriptCandidates({ authorizationConfirmed: true, sourceText });
    assert.equal(result.truncated, false);
    assert.deepEqual(Object.keys(result).sort(), ['candidates', 'truncated']);
    assert.deepEqual(result.candidates.filter((candidate) => candidate.confidence === 'high').map((candidate) => candidate.api), [
      'crypto.subtle.encrypt',
      'crypto.subtle.decrypt',
    ]);
    assert.equal(result.candidates.find((candidate) => candidate.api === 'crypto.subtle.encrypt')?.line, 3);
    assert.doesNotMatch(JSON.stringify(result), /super-secret-value|AES-GCM/);
  });

  test('enforces authorization and the 256 KiB UTF-8 hard cap', () => {
    assert.throws(() => analyzeJavaScriptCandidates({ sourceText: 'crypto.subtle.encrypt()' }), /허가/);
    assert.throws(() => analyzeJavaScriptCandidates({
      authorizationConfirmed: true,
      sourceText: 'a'.repeat(WEBCRYPTO_OBSERVER_LIMITS.maxSourceBytes + 1),
    }), /262144/);
    const benignFlood = analyzeJavaScriptCandidates({
      authorizationConfirmed: true,
      sourceText: 'a'.repeat(WEBCRYPTO_OBSERVER_LIMITS.maxSourceBytes),
    });
    assert.equal(benignFlood.candidates.length, 0);
    const candidateFlood = analyzeJavaScriptCandidates({
      authorizationConfirmed: true,
      sourceText: 'crypto.subtle.encrypt();\n'.repeat(101),
    });
    assert.equal(candidateFlood.truncated, true);
    assert.equal(candidateFlood.candidates.length, 100);
  });
});

describe('host policy, DNS pinning, and request scope', () => {
  test('fails closed without an enabled exact-domain host policy', async () => {
    await assert.rejects(normalizeObserveRequest(BASE_REQUEST, undefined, PUBLIC_DNS), /정책/);
    await assert.rejects(normalizeObserveRequest(BASE_REQUEST, { getPolicy: () => ({ enabled: false, allowedDomains: ['app.example.com'] }) }, PUBLIC_DNS), /활성화/);
    await assert.rejects(normalizeObserveRequest(BASE_REQUEST, { getPolicy: () => ({ enabled: true, allowedDomains: [] }) }, PUBLIC_DNS), /allowlist/);
    await assert.rejects(normalizeObserveRequest(BASE_REQUEST, { getPolicy: () => ({ enabled: true, allowedDomains: ['*.example.com'] }) }, PUBLIC_DNS), /정확한 DNS/);
    await assert.rejects(normalizeObserveRequest({ ...BASE_REQUEST, targetUrl: 'https://evilapp.example.com/' }, VALID_POLICY, PUBLIC_DNS), /allowlist/);
  });

  test('allows only HTTPS default port and rejects any special DNS answer', async () => {
    await assert.rejects(normalizeObserveRequest({ ...BASE_REQUEST, targetUrl: 'http://app.example.com/' }, VALID_POLICY, PUBLIC_DNS), /HTTPS.*443/);
    await assert.rejects(normalizeObserveRequest({ ...BASE_REQUEST, targetUrl: 'https://app.example.com:8443/' }, VALID_POLICY, PUBLIC_DNS), /표준 웹 포트|HTTPS.*443/);
    await assert.rejects(normalizeObserveRequest(BASE_REQUEST, VALID_POLICY, async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]), /특수 IP/);
    await assert.rejects(normalizeObserveRequest(BASE_REQUEST, VALID_POLICY, async () => [
      { address: '2001:db8::1', family: 6 },
    ]), /특수 IP/);
  });

  test('pins one validated address, redacts the URL, and blocks DNS fallback', async () => {
    const normalized = await normalizeObserveRequest(BASE_REQUEST, VALID_POLICY, async () => [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ]);
    assert.equal(normalized.target.pinnedAddress, '93.184.216.34');
    assert.equal(normalized.target.resolvedAddressCount, 2);
    assert.doesNotMatch(normalized.target.redactedUrl, /do-not-return/);
    const rules = chromiumHostResolverRules(normalized.target.host, normalized.target.pinnedAddress);
    assert.match(rules, /^MAP app\.example\.com 93\.184\.216\.34, MAP \* ~NOTFOUND$/);
  });

  test('requires paired state-changing opt-ins and has an explicit method policy', async () => {
    await assert.rejects(normalizeObserveRequest({ ...BASE_REQUEST, allowStateChangingRequests: true }, VALID_POLICY, PUBLIC_DNS), /별도 확인/);
    const active = await normalizeObserveRequest({
      ...BASE_REQUEST,
      allowStateChangingRequests: true,
      stateChangingRequestsConfirmed: true,
    }, VALID_POLICY, PUBLIC_DNS);
    assert.equal(active.allowStateChangingRequests, true);
    assert.equal(classifyObservationRequest('https://app.example.com/a', 'GET', active.target.origin, false), 'allow-network');
    assert.equal(classifyObservationRequest('https://app.example.com/a', 'POST', active.target.origin, false), 'block-method');
    assert.equal(classifyObservationRequest('https://app.example.com/a', 'POST', active.target.origin, true), 'allow-network');
    assert.equal(classifyObservationRequest('https://app.example.com/a', 'DELETE', active.target.origin, true), 'block-method');
    assert.equal(classifyObservationRequest('https://app.example.com/app.js.map', 'GET', active.target.origin, false), 'block-source-map');
    assert.equal(classifyObservationRequest('https://cdn.example.com/a', 'GET', active.target.origin, false), 'block-origin');
    assert.equal(classifyObservationRequest('https://user:secret@app.example.com/a', 'GET', active.target.origin, false), 'block-credentials');
    assert.equal(classifyObservationRequest('wss://app.example.com/socket', 'GET', active.target.origin, false), 'block-scheme');
  });

  test('requires two explicit plaintext-preview confirmations', async () => {
    await assert.rejects(normalizeObserveRequest({
      ...BASE_REQUEST,
      plaintextPreview: { enabled: true },
    }, VALID_POLICY, PUBLIC_DNS), /별도 확인/);
    const normalized = await normalizeObserveRequest({
      ...BASE_REQUEST,
      plaintextPreview: { enabled: true, previewConfirmed: true, maxBytes: 128 },
    }, VALID_POLICY, PUBLIC_DNS);
    assert.deepEqual(normalized.preview, { enabled: true, maxBytes: 128 });
  });
});

describe('isolated instrumentation', () => {
  test('observes only the WebCrypto boundary and applies one literal mutation', async () => {
    const bindingName = '__MrRobotEvent_abcdefghijklmnop';
    const mutationUpdateName = '__MrRobotMutation_abcdefghijklmnop';
    const payloads: string[] = [];
    class FakeSubtleCrypto {
      async encrypt(_algorithm: unknown, _key: unknown, data: Uint8Array): Promise<Uint8Array> { return data; }
      async decrypt(): Promise<Uint8Array> { return new TextEncoder().encode('plain-secret'); }
    }
    class BlockableTransport {}
    class FakeWorklet { async addModule(_url?: string): Promise<void> {} }
    class FakeServiceWorkerContainer { async register(_url?: string): Promise<void> {} }
    class FakeNavigator {
      readonly serviceWorker = new FakeServiceWorkerContainer();
      sendBeacon(_url?: string, _data?: string): boolean { return true; }
    }
    const navigator = new FakeNavigator();
    const context = vm.createContext({
      crypto: { subtle: new FakeSubtleCrypto() },
      SubtleCrypto: FakeSubtleCrypto,
      TextEncoder,
      TextDecoder,
      ArrayBuffer,
      Uint8Array,
      DOMException,
      Worker: BlockableTransport,
      SharedWorker: BlockableTransport,
      WebSocket: BlockableTransport,
      WebSocketStream: BlockableTransport,
      EventSource: BlockableTransport,
      WebTransport: BlockableTransport,
      RTCPeerConnection: BlockableTransport,
      webkitRTCPeerConnection: BlockableTransport,
      Worklet: FakeWorklet,
      navigator,
      open: () => ({ opened: true }),
      [bindingName]: (payload: string) => payloads.push(payload),
    });
    const script = buildInstrumentationScript({
      bindingName,
      mutationUpdateName,
      eventToken: 'a'.repeat(32),
      previewEnabled: false,
      previewMaxBytes: 0,
    });
    assert.doesNotMatch(script, /document\.|querySelector|localStorage|sessionStorage|getResponseBody|addEventListener\(['"]key/i);
    vm.runInContext(script, context);
    assert.throws(() => vm.runInContext('new Worker("worker.js")', context), /disabled/);
    assert.throws(() => vm.runInContext('new WebSocket("wss://app.example.com")', context), /disabled/);
    assert.throws(() => vm.runInContext('new WebSocket.prototype.constructor("wss://app.example.com")', context), /disabled/);
    assert.throws(() => vm.runInContext('new WebSocketStream("wss://app.example.com")', context), /disabled/);
    assert.throws(() => vm.runInContext('new EventSource("https://app.example.com/events")', context), /disabled/);
    assert.throws(() => vm.runInContext('new RTCPeerConnection()', context), /disabled/);
    assert.equal(vm.runInContext('open("https://app.example.com/popup")', context), null);
    assert.equal(vm.runInContext('navigator.sendBeacon("/collect", "x")', context), false);
    assert.equal(FakeNavigator.prototype.sendBeacon.call(navigator, '/collect', 'x'), false);
    await assert.rejects(vm.runInContext('navigator.serviceWorker.register("/sw.js")', context), /disabled/);
    await assert.rejects(FakeServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, '/sw.js'), /disabled/);
    await assert.rejects(vm.runInContext('new Worklet().addModule("/worklet.js")', context), /disabled/);
    assert.equal(vm.runInContext('delete globalThis.WebSocket', context), false);
    assert.throws(
      () => vm.runInContext('Object.defineProperty(globalThis, "WebSocket", { value: function() {} })', context),
      /redefine|configurable/i,
    );
    assert.equal(Object.getOwnPropertyDescriptor(context, 'Worker')?.configurable, false);
    assert.equal(Object.getOwnPropertyDescriptor(BlockableTransport.prototype, 'constructor')?.configurable, false);
    assert.equal(Object.getOwnPropertyDescriptor(FakeNavigator.prototype, 'sendBeacon')?.configurable, false);
    assert.equal(Object.getOwnPropertyDescriptor(FakeServiceWorkerContainer.prototype, 'register')?.configurable, false);
    assert.equal(Object.getOwnPropertyDescriptor(FakeSubtleCrypto.prototype, 'encrypt')?.configurable, false);
    assert.throws(
      () => vm.runInContext('"use strict"; SubtleCrypto.prototype.encrypt = function() {}', context),
      /read only|readonly|assign/i,
    );
    const readiness = payloads
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .find((payload) => payload.control === 'safety-ready');
    assert.equal(readiness?.blockersReady, true);

    assert.equal(vm.runInContext(`${mutationUpdateName}({ phase: "encrypt-input", matchLiteral: "secret", replacementLiteral: "attacker" })`, context), false);
    assert.equal(vm.runInContext(buildMutationUpdateExpression(mutationUpdateName, 'a'.repeat(32), {
      phase: 'encrypt-input', matchLiteral: 'secret', replacementLiteral: '',
    }), context), false);
    vm.runInContext(buildMutationUpdateExpression(mutationUpdateName, 'a'.repeat(32), {
      phase: 'encrypt-input', matchLiteral: 'secret', replacementLiteral: 'public',
    }), context);
    const first = await vm.runInContext('crypto.subtle.encrypt("AES-GCM", {}, new TextEncoder().encode("secret-value"))', context) as Uint8Array;
    const second = await vm.runInContext('crypto.subtle.encrypt("AES-GCM", {}, new TextEncoder().encode("secret-value"))', context) as Uint8Array;
    assert.equal(new TextDecoder().decode(first), 'public-value');
    assert.equal(new TextDecoder().decode(second), 'secret-value');
    const events = payloads
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .filter((event) => event.operation === 'encrypt');
    assert.equal(events[0].mutationApplied, true);
    assert.equal(events[1].mutationApplied, false);
    assert.equal(Object.hasOwn(events[0], 'preview'), false);
    assert.equal(Object.hasOwn(events[0], 'key'), false);
  });

  test('reports fail-closed readiness if a required transport cannot be locked', () => {
    const bindingName = '__MrRobotEvent_abcdefghijklmnop';
    const mutationUpdateName = '__MrRobotMutation_abcdefghijklmnop';
    const payloads: string[] = [];
    class FakeSubtleCrypto {
      async encrypt(): Promise<Uint8Array> { return new Uint8Array(); }
      async decrypt(): Promise<Uint8Array> { return new Uint8Array(); }
    }
    class UnreplaceableWebSocket {}
    const context = vm.createContext({
      crypto: { subtle: new FakeSubtleCrypto() },
      SubtleCrypto: FakeSubtleCrypto,
      TextEncoder,
      TextDecoder,
      ArrayBuffer,
      Uint8Array,
      DOMException,
      [bindingName]: (payload: string) => payloads.push(payload),
    });
    Object.defineProperty(context, 'WebSocket', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: UnreplaceableWebSocket,
    });
    vm.runInContext(buildInstrumentationScript({
      bindingName,
      mutationUpdateName,
      eventToken: 'a'.repeat(32),
      previewEnabled: false,
      previewMaxBytes: 0,
    }), context);
    const readiness = payloads.map((payload) => JSON.parse(payload) as Record<string, unknown>)[0];
    assert.equal(readiness.control, 'safety-ready');
    assert.equal(readiness.blockersReady, false);
    assert.equal(Object.hasOwn(context, mutationUpdateName), false);
  });

  test('keeps literal encoding stable if target code patches TextEncoder after startup', async () => {
    const bindingName = '__MrRobotEvent_ponmlkjihgfedcba';
    const mutationUpdateName = '__MrRobotMutation_ponmlkjihgfedcba';
    class StableEncoder {
      encode(value = ''): Uint8Array { return new Uint8Array(Buffer.from(String(value), 'utf8')); }
    }
    class StableDecoder {
      decode(value: Uint8Array): string { return Buffer.from(value).toString('utf8'); }
    }
    class FakeSubtleCrypto {
      async encrypt(_algorithm: unknown, _key: unknown, data: Uint8Array): Promise<Uint8Array> { return data; }
      async decrypt(): Promise<Uint8Array> { return new Uint8Array(); }
    }
    const context = vm.createContext({
      crypto: { subtle: new FakeSubtleCrypto() },
      SubtleCrypto: FakeSubtleCrypto,
      TextEncoder: StableEncoder,
      TextDecoder: StableDecoder,
      ArrayBuffer,
      Uint8Array,
      DOMException,
      [bindingName]: () => undefined,
    });
    vm.runInContext(buildInstrumentationScript({
      bindingName,
      mutationUpdateName,
      eventToken: 'b'.repeat(32),
      previewEnabled: false,
      previewMaxBytes: 0,
    }), context);
    StableEncoder.prototype.encode = () => new Uint8Array([0]);
    assert.equal(vm.runInContext(buildMutationUpdateExpression(mutationUpdateName, 'b'.repeat(32), {
      phase: 'encrypt-input', matchLiteral: 'secret', replacementLiteral: 'public',
    }), context), true);
    const input = new Uint8Array(Buffer.from('secret-value', 'utf8'));
    (context as Record<string, unknown>).input = input;
    const changed = await vm.runInContext('crypto.subtle.encrypt("AES-GCM", {}, input)', context) as Uint8Array;
    assert.equal(Buffer.from(changed).toString('utf8'), 'public-value');
  });

  test('rejects unconfirmed, regex-like, or oversized mutation requests as literals', () => {
    assert.throws(() => normalizeMutationRule({
      sessionId: '12345678-1234-4234-8234-123456789abc', phase: 'encrypt-input',
      matchLiteral: 'a', replacementLiteral: 'b', mutationConfirmed: false,
    }), /확인/);
    const literal = normalizeMutationRule({
      sessionId: '12345678-1234-4234-8234-123456789abc', phase: 'encrypt-input',
      matchLiteral: '.*', replacementLiteral: '$1', mutationConfirmed: true,
    });
    assert.equal(literal.matchLiteral, '.*');
    assert.throws(() => normalizeMutationRule({
      ...literal, matchLiteral: '가'.repeat(30), mutationConfirmed: true,
    }), /64바이트/);
    assert.throws(() => normalizeMutationRule({
      ...literal, replacementLiteral: '', mutationConfirmed: true,
    }), /1~64바이트/);
  });
});

describe('shared traffic and auxiliary-target gate', () => {
  const limits: NormalizedObserveRequest['limits'] = {
    durationMs: 10_000,
    maxRequests: 2,
    maxResponseBytes: 100,
    maxConcurrentRequests: 1,
    maxRingEvents: 8,
    maxRequestBodyBytes: 4,
    maxUploadBytes: 6,
  };

  test('blocks overflow without giving auxiliary targets an independent budget', () => {
    const traffic: TrafficSnapshot = {
      requestsStarted: 0,
      requestsBlocked: 0,
      responseBytesObserved: 0,
      requestBytesAllowed: 0,
      peakConcurrentRequests: 0,
    };
    const gate = new ObservationTrafficGate(limits, traffic);
    assert.deepEqual(gate.admitRequest('one', 4), { allowed: true });
    assert.deepEqual(gate.admitRequest('concurrent', 0), {
      allowed: false,
      terminateSession: false,
      reasonCode: 'request-concurrency-limit',
    });
    gate.complete('one');
    assert.deepEqual(gate.admitRequest('two', 2), { allowed: true });
    gate.complete('two');
    assert.deepEqual(gate.admitRequest('three', 0), {
      allowed: false,
      terminateSession: true,
      reasonCode: 'request-count-limit',
    });
    assert.deepEqual(gate.getSnapshot(), {
      requestsStarted: 2,
      requestsBlocked: 2,
      responseBytesObserved: 0,
      requestBytesAllowed: 6,
      peakConcurrentRequests: 1,
    });

    const uploadTraffic: TrafficSnapshot = {
      requestsStarted: 0,
      requestsBlocked: 0,
      responseBytesObserved: 0,
      requestBytesAllowed: 0,
      peakConcurrentRequests: 0,
    };
    const uploadGate = new ObservationTrafficGate({ ...limits, maxRequests: 4 }, uploadTraffic);
    assert.deepEqual(uploadGate.admitRequest('upload-one', 4), { allowed: true });
    uploadGate.complete('upload-one');
    assert.deepEqual(uploadGate.admitRequest('upload-two', 3), {
      allowed: false,
      terminateSession: true,
      reasonCode: 'request-byte-limit',
    });

    assert.deepEqual(classifyAttachedTarget('main', {
      sessionId: 'worker-session',
      targetInfo: { targetId: 'worker-target', type: 'worker' },
    }), { action: 'close-auxiliary', targetId: 'worker-target' });
    assert.deepEqual(classifyAttachedTarget('main', {
      sessionId: 'popup-session',
      targetInfo: { targetId: 'popup-target', type: 'page' },
    }), { action: 'close-auxiliary', targetId: 'popup-target' });
    assert.deepEqual(classifyAttachedTarget('main', { targetInfo: {} }), { action: 'fail-closed' });
  });

  test('reserves concurrent Content-Length values and stops streamed overflow', () => {
    const responseLimits = { ...limits, maxRequests: 4, maxConcurrentRequests: 2 };
    const traffic: TrafficSnapshot = {
      requestsStarted: 0,
      requestsBlocked: 0,
      responseBytesObserved: 0,
      requestBytesAllowed: 0,
      peakConcurrentRequests: 0,
    };
    const gate = new ObservationTrafficGate(responseLimits, traffic);
    assert.deepEqual(gate.admitRequest('one', 0), { allowed: true });
    assert.deepEqual(gate.admitRequest('two', 0), { allowed: true });
    assert.deepEqual(gate.admitResponse('one', 60), { allowed: true });
    assert.equal(gate.observeResponseData('one', 40), false);
    assert.deepEqual(gate.admitResponse('two', 41), {
      allowed: false,
      terminateSession: true,
      reasonCode: 'response-byte-limit',
    });

    const streamedTraffic: TrafficSnapshot = {
      requestsStarted: 0,
      requestsBlocked: 0,
      responseBytesObserved: 0,
      requestBytesAllowed: 0,
      peakConcurrentRequests: 0,
    };
    const streamed = new ObservationTrafficGate({ ...responseLimits, maxResponseBytes: 64 }, streamedTraffic);
    assert.deepEqual(streamed.admitRequest('chunked', 0), { allowed: true });
    assert.deepEqual(streamed.admitResponse('chunked', undefined), { allowed: true });
    assert.equal(streamed.observeResponseData('chunked', 64), false);
    assert.equal(streamed.observeResponseData('chunked', 1), true);
  });
});

describe('cumulative inbound CDP traffic gate', () => {
  test('counts invalid Runtime.bindingCalled attempts independently from every raw frame', () => {
    const gate = new CdpInboundTrafficGate(3, 16 * 1024, 10, 2);
    const invalidBinding = JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: { name: '__unknown', payload: '{"token":"invalid"}' },
    });
    const bytes = Buffer.byteLength(invalidBinding, 'utf8');
    assert.deepEqual(gate.admitFrame(bytes), { allowed: true });
    assert.deepEqual(gate.admitRuntimeBindingAttempt(), { allowed: true });
    assert.deepEqual(gate.admitInvalidRuntimeBinding(), { allowed: true });
    assert.deepEqual(gate.admitFrame(bytes), { allowed: true });
    assert.deepEqual(gate.admitRuntimeBindingAttempt(), { allowed: true });
    assert.deepEqual(gate.admitInvalidRuntimeBinding(), { allowed: true });
    assert.deepEqual(gate.admitFrame(bytes), { allowed: true });
    assert.deepEqual(gate.admitRuntimeBindingAttempt(), { allowed: true });
    assert.deepEqual(gate.admitInvalidRuntimeBinding(), {
      allowed: false,
      reasonCode: 'invalid-runtime-binding-limit',
    });
    assert.deepEqual(gate.admitFrame(bytes), {
      allowed: false,
      reasonCode: 'cdp-frame-count-limit',
    });
    assert.deepEqual(gate.snapshot(), {
      frames: 4,
      bytes: bytes * 3,
      runtimeBindingAttempts: 3,
      invalidRuntimeBindings: 3,
    });

    const totalBindings = new CdpInboundTrafficGate(10, 16 * 1024, 2, 10);
    assert.deepEqual(totalBindings.admitRuntimeBindingAttempt(), { allowed: true });
    assert.deepEqual(totalBindings.admitRuntimeBindingAttempt(), { allowed: true });
    assert.deepEqual(totalBindings.admitRuntimeBindingAttempt(), {
      allowed: false,
      reasonCode: 'runtime-binding-attempt-limit',
    });
  });

  test('stops unrelated large CDP events at the cumulative byte cap before parsing', () => {
    const unrelated = JSON.stringify({
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log', args: [{ type: 'string', value: 'x'.repeat(8 * 1024) }] },
    });
    const bytes = Buffer.byteLength(unrelated, 'utf8');
    const gate = new CdpInboundTrafficGate(100, bytes * 2, 100);
    assert.deepEqual(gate.admitFrame(bytes), { allowed: true });
    assert.deepEqual(gate.admitFrame(bytes), { allowed: true });
    assert.deepEqual(gate.admitFrame(bytes), { allowed: false, reasonCode: 'cdp-byte-limit' });
    assert.deepEqual(gate.snapshot(), {
      frames: 3,
      bytes: bytes * 2,
      runtimeBindingAttempts: 0,
      invalidRuntimeBindings: 0,
    });
  });

  test('CdpClient terminates an invalid binding flood as soon as validation crosses its cap', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    assert.equal(typeof address, 'object');
    assert.ok(address);
    const connection = once(server, 'connection');
    let client: CdpClient | undefined;
    let peer: Awaited<ReturnType<typeof once>>[0] | undefined;
    try {
      const gate = new CdpInboundTrafficGate(100, 1024 * 1024, 100, 2);
      client = await CdpClient.connect(
        `ws://127.0.0.1:${address.port}`,
        AbortSignal.timeout(1_000),
        gate,
      );
      [peer] = await connection;
      const peerClosed = once(peer, 'close');
      let dispatched = 0;
      let fatalCalls = 0;
      const invalidDecisions: boolean[] = [];
      client.setEventHandler((message) => {
        dispatched += 1;
        if (message.method === 'Runtime.bindingCalled' && typeof message.params?.payload !== 'string') {
          invalidDecisions.push(client!.noteInvalidRuntimeBinding());
        }
      });
      const fatal = new Promise<Error>((resolve) => client!.setFatalHandler((error) => {
        fatalCalls += 1;
        resolve(error);
      }));
      const invalidBinding = JSON.stringify({
        method: 'Runtime.bindingCalled',
        params: { name: '__observer_binding__', payload: 42 },
      });

      peer.send(invalidBinding);
      peer.send(invalidBinding);
      peer.send(invalidBinding);

      const error = await fatal;
      assert.match(error.message, /invalid-runtime-binding-limit/);
      await peerClosed;
      await waitImmediate();
      assert.equal(dispatched, 3);
      assert.deepEqual(invalidDecisions, [true, true, false]);
      assert.equal(fatalCalls, 1);
      assert.deepEqual(gate.snapshot(), {
        frames: 3,
        bytes: Buffer.byteLength(invalidBinding) * 3,
        runtimeBindingAttempts: 3,
        invalidRuntimeBindings: 3,
      });
    } finally {
      client?.close();
      try { peer?.terminate(); } catch { /* already closed by the client */ }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('CdpClient rejects an unrelated oversized cumulative frame before parsing and ignores queued input', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    assert.equal(typeof address, 'object');
    assert.ok(address);
    const connection = once(server, 'connection');
    let client: CdpClient | undefined;
    let peer: Awaited<ReturnType<typeof once>>[0] | undefined;
    const first = JSON.stringify({ method: 'Page.frameStartedLoading', params: { frameId: 'main' } });
    const queuedAfterLimit = JSON.stringify({ method: 'Page.frameStoppedLoading', params: { frameId: 'main' } });
    const exactAllowedBytes = Buffer.byteLength(first) + Buffer.byteLength(queuedAfterLimit);
    try {
      client = await CdpClient.connect(
        `ws://127.0.0.1:${address.port}`,
        AbortSignal.timeout(1_000),
        new CdpInboundTrafficGate(100, exactAllowedBytes, 100),
      );
      [peer] = await connection;
      const peerClosed = once(peer, 'close');
      const methods: string[] = [];
      let firstDispatched!: () => void;
      const firstEvent = new Promise<void>((resolve) => { firstDispatched = resolve; });
      client.setEventHandler((message) => {
        methods.push(message.method ?? '');
        if (message.method === 'Page.frameStartedLoading') firstDispatched();
      });
      const fatal = new Promise<Error>((resolve) => client!.setFatalHandler(resolve));

      peer.send(first);
      await firstEvent;
      // This frame is deliberately malformed. The cumulative byte gate must
      // reject it before JSON.parse can report a generic malformed-message error.
      peer.send(`{${'x'.repeat(exactAllowedBytes)}`);
      peer.send(queuedAfterLimit);

      const error = await fatal;
      assert.match(error.message, /cdp-byte-limit/);
      await peerClosed;
      // Deterministically model a frame already queued by ws when terminate()
      // ran; receive() must latch closed before accounting or parsing it.
      (client as unknown as { receive(raw: Buffer): void }).receive(Buffer.from(queuedAfterLimit));
      await waitImmediate();
      assert.deepEqual(methods, ['Page.frameStartedLoading']);
    } finally {
      client?.close();
      try { peer?.terminate(); } catch { /* already closed by the client */ }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('session lifecycle and bounded ring buffer', () => {
  test('starts immediately, polls events, scrubs previews on completion, and stops idempotently', async () => {
    const driver = new FakeDriver();
    const ids = ['12345678-1234-4234-8234-123456789abc', '22345678-1234-4234-8234-123456789abc'];
    const service = new WebCryptoObserverService({
      policyProvider: VALID_POLICY,
      dnsLookup: PUBLIC_DNS,
      browserDriver: driver,
      randomId: () => ids.shift()!,
    });
    const started = await service.observe({
      ...BASE_REQUEST,
      plaintextPreview: { enabled: true, previewConfirmed: true, maxBytes: 8 },
      limits: { maxRingEvents: 2 },
    });
    assert.equal(started.status, 'running');
    assert.equal(started.metadataOnly, false);
    assert.doesNotMatch(started.target.url, /do-not-return/);
    await assert.rejects(service.observe(BASE_REQUEST), /동시에 하나/);

    driver.emit({ operation: 'encrypt', phase: 'encrypt-input', algorithm: 'AES-GCM', byteLength: 11, preview: 'first-secret' });
    driver.emit({ operation: 'decrypt', phase: 'decrypt-output', algorithm: 'AES-GCM', byteLength: 12, preview: 'second-secret' });
    driver.emit({ operation: 'encrypt', phase: 'encrypt-input', algorithm: 'AES-GCM', byteLength: 5, preview: 'third' });
    const polled = service.events({ sessionId: started.sessionId, afterSequence: 0 });
    assert.equal(polled.truncated, true);
    assert.deepEqual(polled.events.map((event) => event.sequence), [2, 3]);
    assert.equal(polled.events.every((event) => Buffer.byteLength(event.preview ?? '') <= 8), true);

    await assert.rejects(service.setMutation({
      sessionId: started.sessionId,
      phase: 'encrypt-input',
      matchLiteral: 'not-seen',
      replacementLiteral: 'other',
      mutationConfirmed: true,
    }), /관찰 평문/);
    const armed = await service.setMutation({
      sessionId: started.sessionId,
      phase: 'encrypt-input',
      matchLiteral: 'third',
      replacementLiteral: 'other',
      mutationConfirmed: true,
    });
    assert.equal(armed.armed, true);
    assert.equal(driver.mutationRules.length, 1);
    driver.emit({ operation: 'encrypt', phase: 'encrypt-input', algorithm: 'AES-GCM', byteLength: 11, preview: 'other-secret', mutationApplied: true });
    assert.equal(service.events({ sessionId: started.sessionId }).mutation.applied, true);
    await assert.rejects(service.setMutation({
      sessionId: started.sessionId,
      phase: 'encrypt-input',
      matchLiteral: 'third', replacementLiteral: 'b', mutationConfirmed: true,
    }), /하나만/);

    driver.complete('completed');
    await waitImmediate();
    const completed = service.events({ sessionId: started.sessionId });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.events.every((event) => event.preview === undefined), true);
    assert.deepEqual(await service.stop({ sessionId: started.sessionId }), {
      sessionId: started.sessionId, stopped: false, status: 'completed',
    });

    const metadata = await service.observe(BASE_REQUEST);
    driver.emit({ operation: 'decrypt', phase: 'decrypt-output', algorithm: 'AES-GCM', byteLength: 6, preview: 'secret' });
    assert.equal(service.events({ sessionId: metadata.sessionId }).events[0].preview, undefined);
    await assert.rejects(service.setMutation({
      sessionId: metadata.sessionId,
      phase: 'decrypt-output',
      matchLiteral: 'secret',
      replacementLiteral: 'public',
      mutationConfirmed: true,
    }), /평문 미리보기/);
    const stopped = await service.stop({ sessionId: metadata.sessionId });
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.status, 'stopped');
    assert.equal(driver.stopCalls, 1);
  });

  test('preserves an idempotent stop that races policy or DNS startup', async () => {
    const sessionId = '32345678-1234-4234-8234-123456789abc';
    let resolveDns!: (answers: Array<{ address: string; family: number }>) => void;
    const dnsPending = new Promise<Array<{ address: string; family: number }>>((resolve) => { resolveDns = resolve; });
    const service = new WebCryptoObserverService({
      policyProvider: VALID_POLICY,
      dnsLookup: async () => await dnsPending,
      browserDriver: new FakeDriver(),
      randomId: () => sessionId,
    });
    const observing = service.observe(BASE_REQUEST).then(
      () => undefined,
      (error: unknown) => error,
    );
    await waitImmediate();
    const stopped = await service.stop({ sessionId });
    assert.deepEqual(stopped, { sessionId, stopped: true, status: 'stopped' });
    resolveDns([{ address: '93.184.216.34', family: 4 }]);
    assert.ok(await observing instanceof Error);
    assert.equal(service.events({ sessionId }).status, 'stopped');
    assert.deepEqual(await service.stop({ sessionId }), { sessionId, stopped: false, status: 'stopped' });
  });

  test('scrubs an opted-in preview if browser startup fails after an early event', async () => {
    const sessionId = '42345678-1234-4234-8234-123456789abc';
    const failingDriver: BrowserObservationDriver = {
      async start(_request, callbacks): Promise<BrowserObservationHandle> {
        callbacks.onCryptoEvent({
          token: 'early',
          operation: 'encrypt',
          phase: 'encrypt-input',
          algorithm: 'AES-GCM',
          byteLength: 12,
          preview: 'never-retain',
        });
        throw new Error('startup failed');
      },
    };
    const service = new WebCryptoObserverService({
      policyProvider: VALID_POLICY,
      dnsLookup: PUBLIC_DNS,
      browserDriver: failingDriver,
      randomId: () => sessionId,
    });
    await assert.rejects(service.observe({
      ...BASE_REQUEST,
      plaintextPreview: { enabled: true, previewConfirmed: true, maxBytes: 32 },
    }), /startup failed/);
    const failed = service.events({ sessionId });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.events.length, 1);
    assert.equal(failed.events[0].preview, undefined);
  });

  test('fails closed when mutation acknowledgement is ambiguous', async () => {
    const sessionId = '52345678-1234-4234-8234-123456789abc';
    const driver = new FakeDriver();
    const service = new WebCryptoObserverService({
      policyProvider: VALID_POLICY,
      dnsLookup: PUBLIC_DNS,
      browserDriver: driver,
      randomId: () => sessionId,
    });
    await service.observe({
      ...BASE_REQUEST,
      plaintextPreview: { enabled: true, previewConfirmed: true, maxBytes: 32 },
    });
    driver.emit({
      operation: 'encrypt',
      phase: 'encrypt-input',
      algorithm: 'AES-GCM',
      byteLength: 6,
      preview: 'secret',
    });
    driver.mutationError = new Error('acknowledgement lost');
    await assert.rejects(service.setMutation({
      sessionId,
      phase: 'encrypt-input',
      matchLiteral: 'secret',
      replacementLiteral: 'public',
      mutationConfirmed: true,
    }), /acknowledgement lost/);
    const failed = service.events({ sessionId });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.reasonCode, 'mutation-channel-failed');
    assert.equal(failed.events[0].preview, undefined);
    assert.equal(driver.stopCalls, 1);
  });

  test('cancels and stops the session when a mutation request loses its caller', async () => {
    const sessionId = '62345678-1234-4234-8234-123456789abc';
    let releaseAcknowledgement!: () => void;
    const acknowledgement = new Promise<void>((resolve) => { releaseAcknowledgement = resolve; });
    let releaseStop!: () => void;
    const stopped = new Promise<void>((resolve) => { releaseStop = resolve; });
    const driver = new FakeDriver();
    const originalStart = driver.start.bind(driver);
    driver.start = async (request, callbacks) => {
      const handle = await originalStart(request, callbacks);
      return {
        ...handle,
        setMutation: async (rule) => {
          driver.mutationRules.push({ ...rule });
          await acknowledgement;
        },
        stop: async () => {
          await stopped;
          await handle.stop();
        },
      };
    };
    const service = new WebCryptoObserverService({
      policyProvider: VALID_POLICY,
      dnsLookup: PUBLIC_DNS,
      browserDriver: driver,
      randomId: () => sessionId,
    });
    await service.observe({
      ...BASE_REQUEST,
      plaintextPreview: { enabled: true, previewConfirmed: true, maxBytes: 32 },
    });
    driver.emit({
      operation: 'encrypt',
      phase: 'encrypt-input',
      algorithm: 'AES-GCM',
      byteLength: 6,
      preview: 'secret',
    });
    const controller = new AbortController();
    const pending = service.setMutation({
      sessionId,
      phase: 'encrypt-input',
      matchLiteral: 'secret',
      replacementLiteral: 'public',
      mutationConfirmed: true,
    }, controller.signal);
    await waitImmediate();
    controller.abort(new Error('portal request disconnected'));
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await waitImmediate();
    assert.equal(settled, false);
    assert.equal(driver.stopCalls, 0);
    releaseStop();
    await assert.rejects(pending, /disconnected/);
    releaseAcknowledgement();
    const failed = service.events({ sessionId });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.reasonCode, 'mutation-request-cancelled');
    assert.equal(failed.mutation.armed, false);
    assert.equal(failed.events[0].preview, undefined);
    assert.equal(driver.stopCalls, 1);
  });
});

test('plugin manifest and safety contract expose the bounded pentest backend', () => {
  const plugin = createWebCryptoObserverPlugin();
  assert.equal(plugin.manifest.id, 'webcrypto-observer');
  assert.equal(plugin.manifest.category, 'pentest');
  assert.equal(webCryptoObserverSafetyContract.targetTransport, 'https:443-only');
  assert.equal(cdpSafetyContract.auxiliaryTargetsAllowed, false);
  assert.equal(cdpSafetyContract.webRtcAllowed, false);
  assert.equal(cdpSafetyContract.userCookiesUsed, false);
  assert.equal(cdpSafetyContract.maxPendingCdpCommands, 64);
  assert.equal(cdpSafetyContract.maxCdpSessionFrames, 4_096);
  assert.equal(cdpSafetyContract.maxCdpSessionBytes, 8 * 1024 * 1024);
  assert.equal(cdpSafetyContract.maxRuntimeEvents, 512);
  assert.equal(cdpSafetyContract.maxRuntimeBindingAttempts, 513);
  assert.equal(cdpSafetyContract.maxInvalidRuntimeBindings, 16);
});
