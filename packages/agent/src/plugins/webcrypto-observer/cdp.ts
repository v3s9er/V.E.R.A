import { randomBytes } from 'node:crypto';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import WebSocket, { type RawData } from 'ws';
import { buildInstrumentationScript, buildMutationUpdateExpression } from './instrumentation.js';
import { chromiumHostResolverRules } from './policy.js';
import { boundedUtf8Preview } from './preview.js';
import type {
  BrowserObservationCallbacks,
  BrowserObservationDriver,
  BrowserObservationHandle,
  DriverCompletion,
  NormalizedObserveRequest,
  RawRuntimeCryptoEvent,
  TrafficSnapshot,
} from './types.js';

const STARTUP_TIMEOUT_MS = 5_000;
const CDP_COMMAND_TIMEOUT_MS = 3_000;
const MAX_CDP_MESSAGE_BYTES = 256 * 1024;
const MAX_CDP_SESSION_FRAMES = 4_096;
const MAX_CDP_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_BINDING_PAYLOAD_BYTES = 2_048;
const MAX_PENDING_CDP_COMMANDS = 64;
const MAX_RUNTIME_EVENTS = 512;
const MAX_INVALID_RUNTIME_BINDINGS = 16;
// One additional binding is the observer's mandatory safety-ready control.
const MAX_RUNTIME_BINDING_ATTEMPTS = MAX_RUNTIME_EVENTS + 1;
const MAX_AUXILIARY_TARGETS = 8;
const SAFETY_READY_TIMEOUT_MS = 3_000;
const PROFILE_PREFIX = 'mr-robot-webcrypto-';
const AUXILIARY_TARGET_TYPES = new Set([
  'page', 'background_page', 'worker', 'service_worker', 'shared_worker', 'worklet', 'iframe', 'webview',
]);

export type TrafficGateDecision =
  | { allowed: true }
  | { allowed: false; terminateSession: boolean; reasonCode: string };

export type CdpInboundLimitReason = 'cdp-frame-count-limit' | 'cdp-byte-limit'
  | 'runtime-binding-attempt-limit' | 'invalid-runtime-binding-limit'
  | 'runtime-event-limit' | 'invalid-cdp-frame-size';
export type CdpInboundDecision = { allowed: true } | { allowed: false; reasonCode: CdpInboundLimitReason };

/**
 * Bounds every inbound CDP message before JSON parsing, including command
 * replies and events that the observer otherwise ignores. This is independent
 * from the valid WebCrypto-event cap, so invalid bindings and large console
 * events cannot create an unbounded parsing queue.
 */
export class CdpInboundTrafficGate {
  private frames = 0;
  private bytes = 0;
  private runtimeBindingAttempts = 0;
  private invalidRuntimeBindings = 0;

  constructor(
    private readonly maxFrames = MAX_CDP_SESSION_FRAMES,
    private readonly maxBytes = MAX_CDP_SESSION_BYTES,
    private readonly maxRuntimeBindingAttempts = MAX_RUNTIME_BINDING_ATTEMPTS,
    private readonly maxInvalidRuntimeBindings = MAX_INVALID_RUNTIME_BINDINGS,
  ) {
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1
      || !Number.isSafeInteger(maxRuntimeBindingAttempts) || maxRuntimeBindingAttempts < 1
      || !Number.isSafeInteger(maxInvalidRuntimeBindings) || maxInvalidRuntimeBindings < 1) {
      throw new Error('CDP inbound traffic limits must be positive safe integers.');
    }
  }

  admitFrame(frameBytes: number): CdpInboundDecision {
    if (!Number.isSafeInteger(frameBytes) || frameBytes < 0) {
      return { allowed: false, reasonCode: 'invalid-cdp-frame-size' };
    }
    this.frames += 1;
    if (this.frames > this.maxFrames) return { allowed: false, reasonCode: 'cdp-frame-count-limit' };
    if (frameBytes > this.maxBytes - this.bytes) return { allowed: false, reasonCode: 'cdp-byte-limit' };
    this.bytes += frameBytes;
    return { allowed: true };
  }

  admitRuntimeBindingAttempt(): CdpInboundDecision {
    this.runtimeBindingAttempts += 1;
    return this.runtimeBindingAttempts > this.maxRuntimeBindingAttempts
      ? { allowed: false, reasonCode: 'runtime-binding-attempt-limit' }
      : { allowed: true };
  }

  admitInvalidRuntimeBinding(): CdpInboundDecision {
    this.invalidRuntimeBindings += 1;
    return this.invalidRuntimeBindings > this.maxInvalidRuntimeBindings
      ? { allowed: false, reasonCode: 'invalid-runtime-binding-limit' }
      : { allowed: true };
  }

  snapshot(): { frames: number; bytes: number; runtimeBindingAttempts: number; invalidRuntimeBindings: number } {
    return {
      frames: this.frames,
      bytes: this.bytes,
      runtimeBindingAttempts: this.runtimeBindingAttempts,
      invalidRuntimeBindings: this.invalidRuntimeBindings,
    };
  }
}

/**
 * One shared gate owns every physical request admitted for the page target.
 * Auxiliary targets never receive a gate: they are paused and closed before
 * execution, so a worker or popup cannot obtain an independent traffic budget.
 */
export class ObservationTrafficGate {
  private readonly inFlight = new Set<string>();
  private readonly responseReservations = new Map<string, number>();
  private reservedResponseBytes = 0;

  constructor(
    private readonly limits: NormalizedObserveRequest['limits'],
    private readonly traffic: TrafficSnapshot,
  ) {}

  noteBlocked(): void {
    this.traffic.requestsBlocked += 1;
  }

  admitRequest(networkId: string, requestBytes: number): TrafficGateDecision {
    if (!networkId) return this.block('untracked-request', false);
    if (!Number.isSafeInteger(requestBytes) || requestBytes < 0) return this.block('invalid-request-size', true);
    if (this.traffic.requestsStarted >= this.limits.maxRequests) return this.block('request-count-limit', true);
    if (requestBytes > this.limits.maxRequestBodyBytes
      || this.traffic.requestBytesAllowed + requestBytes > this.limits.maxUploadBytes) {
      return this.block('request-byte-limit', true);
    }
    if (this.inFlight.size >= this.limits.maxConcurrentRequests) return this.block('request-concurrency-limit', false);
    this.traffic.requestBytesAllowed += requestBytes;
    this.inFlight.add(networkId);
    this.traffic.peakConcurrentRequests = Math.max(this.traffic.peakConcurrentRequests, this.inFlight.size);
    this.traffic.requestsStarted += 1;
    return { allowed: true };
  }

  admitResponse(networkId: string, announcedBytes: number | undefined): TrafficGateDecision {
    if (!networkId || !this.inFlight.has(networkId)) return this.block('untracked-response', true);
    this.releaseReservation(networkId);
    if (announcedBytes === undefined) return { allowed: true };
    if (!Number.isSafeInteger(announcedBytes) || announcedBytes < 0) return this.block('invalid-response-size', true);
    if (this.traffic.responseBytesObserved + this.reservedResponseBytes + announcedBytes > this.limits.maxResponseBytes) {
      return this.block('response-byte-limit', true);
    }
    this.responseReservations.set(networkId, announcedBytes);
    this.reservedResponseBytes += announcedBytes;
    return { allowed: true };
  }

  observeResponseData(networkId: string, amount: number): boolean {
    if (!Number.isSafeInteger(amount) || amount < 0) return true;
    this.traffic.responseBytesObserved += amount;
    const reserved = this.responseReservations.get(networkId);
    if (reserved !== undefined) {
      const consumed = Math.min(reserved, amount);
      this.reservedResponseBytes -= consumed;
      const remaining = reserved - consumed;
      if (remaining === 0) this.responseReservations.delete(networkId);
      else this.responseReservations.set(networkId, remaining);
    }
    return this.traffic.responseBytesObserved > this.limits.maxResponseBytes;
  }

  complete(networkId: string): void {
    this.inFlight.delete(networkId);
    this.releaseReservation(networkId);
  }

  getSnapshot(): TrafficSnapshot {
    return { ...this.traffic };
  }

  private block(reasonCode: string, terminateSession: boolean): TrafficGateDecision {
    this.noteBlocked();
    return { allowed: false, terminateSession, reasonCode };
  }

  private releaseReservation(networkId: string): void {
    const reserved = this.responseReservations.get(networkId);
    if (reserved === undefined) return;
    this.responseReservations.delete(networkId);
    this.reservedResponseBytes = Math.max(0, this.reservedResponseBytes - reserved);
  }
}

export type AttachedTargetDecision =
  | { action: 'resume-main'; sessionId: string }
  | { action: 'close-auxiliary'; targetId: string }
  | { action: 'fail-closed' };

export function classifyAttachedTarget(mainTargetId: string, params: unknown): AttachedTargetDecision {
  const value = record(params);
  const targetInfo = record(value.targetInfo);
  const targetId = typeof targetInfo.targetId === 'string' ? targetInfo.targetId : '';
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
  if (!targetId) return { action: 'fail-closed' };
  if (targetId === mainTargetId) return sessionId ? { action: 'resume-main', sessionId } : { action: 'fail-closed' };
  return { action: 'close-auxiliary', targetId };
}

class BrowserLaunchError extends Error {}
class CdpInboundLimitError extends Error {
  constructor(readonly reasonCode: CdpInboundLimitReason) {
    super(`CDP inbound traffic limit reached: ${reasonCode}`);
    this.name = 'CdpInboundLimitError';
  }
}
type BrowserChild = ChildProcessByStdio<null, null, Readable>;

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

export class CdpClient {
  private nextId = 1;
  private closed = false;
  private fatalNotified = false;
  private onFatal: (error: Error) => void = () => undefined;
  private readonly pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  private constructor(
    private readonly socket: WebSocket,
    private onEvent: (message: CdpMessage) => void,
    private readonly inboundTraffic: CdpInboundTrafficGate,
  ) {
    socket.on('message', (raw) => this.receive(raw));
    socket.once('close', () => this.fail(new Error('로컬 브라우저 CDP 연결이 닫혔습니다.')));
    socket.once('error', () => this.fail(new Error('로컬 브라우저 CDP 연결에 실패했습니다.')));
  }

  static async connect(
    url: string,
    signal: AbortSignal,
    inboundTraffic = new CdpInboundTrafficGate(),
  ): Promise<CdpClient> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')) {
      throw new BrowserLaunchError('로컬 루프백 CDP 주소만 허용됩니다.');
    }
    signal.throwIfAborted();
    return await new Promise<CdpClient>((resolveConnection, reject) => {
      let settled = false;
      const socket = new WebSocket(parsed.href, {
        handshakeTimeout: CDP_COMMAND_TIMEOUT_MS,
        maxPayload: MAX_CDP_MESSAGE_BYTES,
        perMessageDeflate: false,
      });
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        fn();
      };
      const abort = () => finish(() => {
        socket.terminate();
        reject(signal.reason ?? new Error('브라우저 연결이 취소되었습니다.'));
      });
      signal.addEventListener('abort', abort, { once: true });
      socket.once('open', () => finish(() => resolveConnection(new CdpClient(socket, () => undefined, inboundTraffic))));
      socket.once('error', () => finish(() => reject(new BrowserLaunchError('격리 브라우저 CDP에 연결하지 못했습니다.'))));
    });
  }

  setEventHandler(handler: (message: CdpMessage) => void): void {
    this.onEvent = handler;
  }

  setFatalHandler(handler: (error: Error) => void): void {
    this.onFatal = handler;
  }

  noteInvalidRuntimeBinding(): boolean {
    const decision = this.inboundTraffic.admitInvalidRuntimeBinding();
    if (decision.allowed) return true;
    this.terminateAtLimit(decision.reasonCode);
    return false;
  }

  terminateAtLimit(reasonCode: CdpInboundLimitReason): void {
    if (this.closed) return;
    this.fail(new CdpInboundLimitError(reasonCode));
    this.socket.terminate();
  }

  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new Error('로컬 브라우저 CDP 연결이 열려 있지 않습니다.');
    if (this.pending.size >= MAX_PENDING_CDP_COMMANDS) {
      const error = new Error('로컬 브라우저 CDP 대기 명령이 안전 한도를 초과했습니다.');
      this.fail(error);
      this.socket.terminate();
      throw error;
    }
    const id = this.nextId;
    this.nextId += 1;
    const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return await new Promise<Record<string, unknown>>((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 명령 제한시간 초과: ${method}`));
      }, CDP_COMMAND_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      this.socket.send(message, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error('로컬 브라우저 CDP 명령을 전송하지 못했습니다.'));
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.close(); } catch { this.socket.terminate(); }
    this.shutdown(new Error('로컬 브라우저 CDP 연결이 종료되었습니다.'));
  }

  private receive(raw: RawData): void {
    if (this.closed) return;
    const bytes = rawDataBytes(raw);
    const inbound = this.inboundTraffic.admitFrame(bytes);
    if (!inbound.allowed) {
      this.terminateAtLimit(inbound.reasonCode);
      return;
    }
    if (bytes > MAX_CDP_MESSAGE_BYTES) {
      this.fail(new Error('로컬 브라우저 CDP 메시지가 안전 한도를 초과했습니다.'));
      this.socket.terminate();
      return;
    }
    let message: CdpMessage;
    try {
      message = JSON.parse(rawDataText(raw)) as CdpMessage;
    } catch {
      this.fail(new Error('로컬 브라우저 CDP 메시지가 올바르지 않습니다.'));
      this.socket.terminate();
      return;
    }
    // Count the method before classifying the envelope as a command reply.
    // This keeps the bound total conservative even for an unexpected message
    // carrying both an id and Runtime.bindingCalled.
    if (message.method === 'Runtime.bindingCalled') {
      const bindingAttempt = this.inboundTraffic.admitRuntimeBindingAttempt();
      if (!bindingAttempt.allowed) {
        this.terminateAtLimit(bindingAttempt.reasonCode);
        return;
      }
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`CDP 명령이 거부되었습니다 (${message.error.code ?? 'unknown'}).`));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === 'string') {
      try { this.onEvent(message); } catch { /* an event consumer cannot crash the CDP socket */ }
    }
  }

  private shutdown(error: Error): void {
    if (!this.closed) this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private fail(error: Error): void {
    const wasClosed = this.closed;
    this.shutdown(error);
    if (wasClosed || this.fatalNotified) return;
    this.fatalNotified = true;
    try { this.onFatal(error); } catch { /* fatal cleanup is best-effort and bounded by the driver */ }
  }
}

export class SystemCdpBrowserDriver implements BrowserObservationDriver {
  async start(
    request: NormalizedObserveRequest,
    callbacks: BrowserObservationCallbacks,
    externalSignal: AbortSignal,
  ): Promise<BrowserObservationHandle> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const deadlineReason = new Error('관찰 시간이 완료되었습니다.');
    deadlineReason.name = 'ObservationDurationComplete';
    const forwardAbort = () => controller.abort(externalSignal.reason ?? new Error('관찰이 취소되었습니다.'));
    if (externalSignal.aborted) forwardAbort();
    else externalSignal.addEventListener('abort', forwardAbort, { once: true });
    const durationTimer = setTimeout(() => controller.abort(deadlineReason), request.limits.durationMs);
    durationTimer.unref?.();

    let child: BrowserChild | undefined;
    let profilePath: string | undefined;
    let client: CdpClient | undefined;
    let pageSessionId: string | undefined;
    let completionResolve!: (result: DriverCompletion) => void;
    const completion = new Promise<DriverCompletion>((resolveCompletion) => { completionResolve = resolveCompletion; });
    let finalized = false;
    let finalizePromise: Promise<void> | undefined;
    let outcome: DriverCompletion['outcome'] = 'completed';
    let reasonCode: string | undefined;
    const traffic: TrafficSnapshot = {
      requestsStarted: 0,
      requestsBlocked: 0,
      responseBytesObserved: 0,
      requestBytesAllowed: 0,
      peakConcurrentRequests: 0,
    };
    const trafficGate = new ObservationTrafficGate(request.limits, traffic);
    const bindingName = `__MrRobotEvent_${randomBytes(18).toString('hex')}`;
    const mutationUpdateName = `__MrRobotMutation_${randomBytes(18).toString('hex')}`;
    const eventToken = randomBytes(24).toString('base64url');

    const finalize = (nextOutcome: DriverCompletion['outcome'], nextReason?: string): Promise<void> => {
      if (finalizePromise) return finalizePromise;
      finalized = true;
      outcome = nextOutcome;
      reasonCode = nextReason;
      // Defer the cleanup body by one microtask so finalizePromise is assigned
      // before any synchronous CDP failure can recursively request finalization.
      // Every later stop/limit/abort caller then awaits the same browser/profile
      // cleanup instead of releasing the service's one-session gate early.
      finalizePromise = Promise.resolve().then(async () => {
        clearTimeout(durationTimer);
        externalSignal.removeEventListener('abort', forwardAbort);
        controller.signal.removeEventListener('abort', onInternalAbort);
        const shutdownCommands: Array<Promise<unknown>> = [];
        if (client && pageSessionId) {
          shutdownCommands.push(client.send('Page.stopLoading', {}, pageSessionId).catch(() => undefined));
        }
        if (client) shutdownCommands.push(client.send('Browser.close').catch(() => undefined));
        // Both commands are put on the loopback socket synchronously. Never let a
        // dead CDP connection extend the observation traffic window by its full
        // per-command timeout before the owned browser process is terminated.
        await settleWithin(shutdownCommands, 500);
        client?.close();
        await stopChild(child);
        if (profilePath) await removeTemporaryProfile(profilePath);
        completionResolve({ outcome, reasonCode, traffic: { ...traffic } });
      });
      return finalizePromise;
    };
    const onInternalAbort = () => {
      const normalDeadline = controller.signal.reason === deadlineReason;
      void finalize(normalDeadline ? 'completed' : 'stopped', normalDeadline ? undefined : 'cancelled');
    };
    const hitLimit = (code: string) => { void finalize('limit-reached', code); };

    try {
      controller.signal.throwIfAborted();
      const executable = await resolveBrowserExecutable(request.browserExecutable);
      profilePath = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
      const resolverRules = chromiumHostResolverRules(request.target.host, request.target.pinnedAddress);
      child = spawn(executable, browserArguments(profilePath, resolverRules), {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const browserWebSocket = await waitForDebuggerAddress(child, controller.signal);
      child.stderr.resume();
      client = await CdpClient.connect(browserWebSocket, controller.signal);
      client.setFatalHandler((error) => {
        if (error instanceof CdpInboundLimitError) {
          void finalize('limit-reached', error.reasonCode);
          return;
        }
        void finalize('failed', 'cdp-connection-lost');
      });

      const target = await client.send('Target.createTarget', { url: 'about:blank', background: false });
      const targetId = typeof target.targetId === 'string' ? target.targetId : undefined;
      if (!targetId) throw new BrowserLaunchError('격리 브라우저 페이지를 만들지 못했습니다.');
      const attached = await client.send('Target.attachToTarget', { targetId, flatten: true });
      pageSessionId = typeof attached.sessionId === 'string' ? attached.sessionId : undefined;
      if (!pageSessionId) throw new BrowserLaunchError('격리 브라우저 페이지에 연결하지 못했습니다.');

      let settleSafetyReady: ((ready: boolean) => void) | undefined;
      const safetyReady = new Promise<boolean>((resolveReady) => { settleSafetyReady = resolveReady; });
      const closingAuxiliaryTargets = new Set<string>();
      let runtimeEventsObserved = 0;

      const handleEvent = (message: CdpMessage) => {
        if (finalized || !message.method) return;
        if (message.method === 'Target.attachedToTarget') {
          const decision = classifyAttachedTarget(targetId, message.params);
          if (decision.action === 'resume-main') {
            void client!.send('Runtime.runIfWaitingForDebugger', {}, decision.sessionId)
              .catch(() => { void finalize('failed', 'main-target-resume-failed'); });
            return;
          }
          if (decision.action === 'close-auxiliary') {
            if (closingAuxiliaryTargets.has(decision.targetId)) return;
            if (closingAuxiliaryTargets.size >= MAX_AUXILIARY_TARGETS) {
              void finalize('limit-reached', 'auxiliary-target-limit');
              return;
            }
            closingAuxiliaryTargets.add(decision.targetId);
            // Auxiliary pages, workers, worklets and service workers remain paused
            // until they are closed, so they cannot bypass the shared page gate.
            void client!.send('Target.closeTarget', { targetId: decision.targetId }).then((result) => {
              if (result.success !== true) void finalize('failed', 'auxiliary-target-block-failed');
            }).catch(() => { void finalize('failed', 'auxiliary-target-block-failed'); });
            return;
          }
          void finalize('failed', 'invalid-attached-target');
          return;
        }
        if (message.sessionId !== pageSessionId) return;
        if (message.method === 'Runtime.bindingCalled') {
          const payload = message.params?.payload;
          if (message.params?.name !== bindingName || typeof payload !== 'string') {
            client!.noteInvalidRuntimeBinding();
            return;
          }
          const readiness = validateSafetyReady(payload, eventToken);
          if (readiness !== undefined) {
            settleSafetyReady?.(readiness);
            settleSafetyReady = undefined;
            if (!readiness) void finalize('failed', 'runtime-blockers-unavailable');
            return;
          }
          const event = validateBindingEvent(payload, eventToken, request.preview.enabled, request.preview.maxBytes);
          if (!event) {
            client!.noteInvalidRuntimeBinding();
            return;
          }
          runtimeEventsObserved += 1;
          if (runtimeEventsObserved > MAX_RUNTIME_EVENTS) {
            client!.terminateAtLimit('runtime-event-limit');
            return;
          }
          callbacks.onCryptoEvent(event);
          return;
        }
        if (message.method === 'Fetch.requestPaused') {
          void handlePausedRequest(client!, pageSessionId!, request, message.params ?? {}, trafficGate, hitLimit)
            .catch(() => { void finalize('failed', 'cdp-request-policy'); });
          return;
        }
        if (message.method === 'Network.dataReceived') {
          const requestId = message.params?.requestId;
          const decodedBytes = Number(message.params?.dataLength);
          const encodedBytes = Number(message.params?.encodedDataLength);
          const amount = Number.isSafeInteger(decodedBytes) && Number.isSafeInteger(encodedBytes)
            ? Math.max(decodedBytes, encodedBytes)
            : Number.NaN;
          if (typeof requestId !== 'string' || trafficGate.observeResponseData(requestId, amount)) hitLimit('response-byte-limit');
          return;
        }
        if (message.method === 'Network.webSocketCreated'
          || message.method === 'Network.webTransportCreated'
          || message.method === 'Network.eventSourceMessageReceived') {
          void finalize('failed', 'blocked-stream-attempt');
          return;
        }
        if (message.method === 'Network.loadingFinished' || message.method === 'Network.loadingFailed') {
          const requestId = message.params?.requestId;
          if (typeof requestId === 'string') trafficGate.complete(requestId);
        }
      };
      client.setEventHandler(handleEvent);

      const existingTargets = await client.send('Target.getTargets');
      const targetInfos = Array.isArray(existingTargets.targetInfos) ? existingTargets.targetInfos : [];
      for (const rawTarget of targetInfos) {
        const info = record(rawTarget);
        const existingTargetId = typeof info.targetId === 'string' ? info.targetId : '';
        const existingTargetType = typeof info.type === 'string' ? info.type : '';
        if (!existingTargetId || existingTargetId === targetId || !AUXILIARY_TARGET_TYPES.has(existingTargetType)) continue;
        const closed = await client.send('Target.closeTarget', { targetId: existingTargetId });
        if (closed.success !== true) throw new BrowserLaunchError('기존 보조 브라우저 target을 닫지 못했습니다.');
      }
      await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, pageSessionId);
      await client.send('Browser.setDownloadBehavior', { behavior: 'deny' });
      await client.send('Runtime.enable', {}, pageSessionId);
      await client.send('Page.enable', {}, pageSessionId);
      await client.send('Network.enable', { maxPostDataSize: request.limits.maxRequestBodyBytes + 1 }, pageSessionId);
      await client.send('Network.setCacheDisabled', { cacheDisabled: true }, pageSessionId);
      await client.send('Network.setBypassServiceWorker', { bypass: true }, pageSessionId);
      await client.send('Runtime.addBinding', { name: bindingName }, pageSessionId);
      await client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: buildInstrumentationScript({
          bindingName,
          mutationUpdateName,
          eventToken,
          previewEnabled: request.preview.enabled,
          previewMaxBytes: request.preview.maxBytes,
        }),
      }, pageSessionId);
      await client.send('Fetch.enable', {
        patterns: [
          { urlPattern: '*', requestStage: 'Request' },
          { urlPattern: '*', requestStage: 'Response' },
        ],
        handleAuthRequests: false,
      }, pageSessionId);
      controller.signal.addEventListener('abort', onInternalAbort, { once: true });
      controller.signal.throwIfAborted();
      const navigation = await client.send('Page.navigate', { url: request.target.url, transitionType: 'typed' }, pageSessionId);
      if (typeof navigation.errorText === 'string' && navigation.errorText) {
        await finalize('failed', 'navigation-failed');
        throw new BrowserLaunchError('대상 페이지 탐색을 시작하지 못했습니다.');
      }
      const blockersReady = await awaitSafetyReady(safetyReady, controller.signal);
      if (!blockersReady) {
        await finalize('failed', 'runtime-blockers-unavailable');
        throw new BrowserLaunchError('필수 보조 통신 차단기를 고정하지 못했습니다.');
      }

      return {
        completion,
        getTraffic() { return trafficGate.getSnapshot(); },
        async setMutation(rule) {
          if (finalized || !client || !pageSessionId) throw new Error('활성 관찰 페이지가 없습니다.');
          const expression = buildMutationUpdateExpression(mutationUpdateName, eventToken, rule);
          const evaluated = await client.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: false,
            userGesture: false,
          }, pageSessionId);
          const result = evaluated.result as Record<string, unknown> | undefined;
          if (result?.value !== true) throw new Error('현재 페이지에 일회성 수정 규칙을 설정하지 못했습니다.');
        },
        async stop() {
          await finalize('stopped', 'user-stopped');
        },
      };
    } catch (error) {
      await finalize(controller.signal.reason === deadlineReason ? 'completed' : 'failed', controller.signal.aborted ? 'startup-cancelled' : 'startup-failed');
      if (controller.signal.aborted && controller.signal.reason !== deadlineReason) throw controller.signal.reason;
      if (error instanceof BrowserLaunchError) throw error;
      throw new BrowserLaunchError('격리된 시스템 Chrome/Edge 관찰 세션을 시작하지 못했습니다.');
    }
  }
}

async function handlePausedRequest(
  client: CdpClient,
  sessionId: string,
  request: NormalizedObserveRequest,
  params: Record<string, unknown>,
  trafficGate: ObservationTrafficGate,
  hitLimit: (code: string) => void,
): Promise<void> {
  const fetchRequestId = typeof params.requestId === 'string' ? params.requestId : undefined;
  if (!fetchRequestId) throw new Error('CDP request id missing.');
  const rawRequest = record(params.request);
  const resourceType = typeof params.resourceType === 'string' ? params.resourceType : '';
  const rawUrl = typeof rawRequest.url === 'string' ? rawRequest.url : '';
  const method = String(rawRequest.method ?? '').toUpperCase();
  const requestPolicy = classifyObservationRequest(rawUrl, method, request.target.origin, request.allowStateChangingRequests);
  const responseStage = typeof params.responseStatusCode === 'number';
  if (responseStage) {
    if (requestPolicy === 'allow-local') {
      await client.send('Fetch.continueRequest', { requestId: fetchRequestId }, sessionId);
      return;
    }
    if (requestPolicy !== 'allow-network') {
      trafficGate.noteBlocked();
      await client.send('Fetch.failRequest', { requestId: fetchRequestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => undefined);
      return;
    }
    if (hasResponseHeader(params.responseHeaders, 'alt-svc')) {
      trafficGate.noteBlocked();
      await client.send('Fetch.failRequest', { requestId: fetchRequestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => undefined);
      hitLimit('alternative-service-blocked');
      return;
    }
    const networkId = typeof params.networkId === 'string' ? params.networkId : '';
    const announced = responseContentLength(params.responseHeaders);
    const decision = trafficGate.admitResponse(networkId, announced);
    if (!decision.allowed) {
      await client.send('Fetch.failRequest', { requestId: fetchRequestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => undefined);
      if (decision.terminateSession) hitLimit(decision.reasonCode);
      return;
    }
    await client.send('Fetch.continueRequest', { requestId: fetchRequestId }, sessionId);
    return;
  }

  if (resourceType === 'WebSocket' || resourceType === 'EventSource' || resourceType === 'WebTransport') {
    trafficGate.noteBlocked();
    await client.send('Fetch.failRequest', { requestId: fetchRequestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => undefined);
    return;
  }
  if (requestPolicy === 'allow-local') {
    await client.send('Fetch.continueRequest', { requestId: fetchRequestId }, sessionId);
    return;
  }
  if (requestPolicy !== 'allow-network') {
    trafficGate.noteBlocked();
    await client.send('Fetch.failRequest', { requestId: fetchRequestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => undefined);
    return;
  }

  const hasPostData = rawRequest.hasPostData === true;
  const postData = typeof rawRequest.postData === 'string' ? rawRequest.postData : undefined;
  if (hasPostData && postData === undefined) {
    trafficGate.noteBlocked();
    await client.send('Fetch.failRequest', { requestId: fetchRequestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => undefined);
    return;
  }
  const requestBytes = postData === undefined ? 0 : Buffer.byteLength(postData, 'utf8');
  const networkId = typeof params.networkId === 'string' ? params.networkId : '';
  const decision = trafficGate.admitRequest(networkId, requestBytes);
  if (!decision.allowed) {
    await client.send('Fetch.failRequest', { requestId: fetchRequestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => undefined);
    if (decision.terminateSession) hitLimit(decision.reasonCode);
    return;
  }
  await client.send('Fetch.continueRequest', { requestId: fetchRequestId }, sessionId);
}

export type ObservationRequestDecision = 'allow-network' | 'allow-local' | 'block-origin' | 'block-source-map' | 'block-method' | 'block-scheme' | 'block-credentials';

export function classifyObservationRequest(
  rawUrl: string,
  rawMethod: string,
  targetOrigin: string,
  allowStateChangingRequests: boolean,
): ObservationRequestDecision {
  if (!rawUrl || rawUrl.length > 8_192) return 'block-scheme';
  let url: URL;
  try { url = new URL(rawUrl); } catch { return 'block-scheme'; }
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return 'allow-local';
  if (url.protocol !== 'https:') return 'block-scheme';
  if (url.username || url.password) return 'block-credentials';
  if (url.origin !== targetOrigin) return 'block-origin';
  if (/\.map$/i.test(url.pathname)) return 'block-source-map';
  const method = rawMethod.trim().toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return 'allow-network';
  if (allowStateChangingRequests && (method === 'POST' || method === 'PUT' || method === 'PATCH')) return 'allow-network';
  return 'block-method';
}

function validateBindingEvent(
  payload: string,
  token: string,
  previewEnabled: boolean,
  previewMaxBytes: number,
): RawRuntimeCryptoEvent | undefined {
  if (Buffer.byteLength(payload, 'utf8') > MAX_BINDING_PAYLOAD_BYTES) return undefined;
  let value: Record<string, unknown>;
  try { value = record(JSON.parse(payload)); } catch { return undefined; }
  if (value.token !== token) return undefined;
  const operation = value.operation;
  const phase = value.phase;
  if ((operation !== 'encrypt' && operation !== 'decrypt')
    || (phase !== 'encrypt-input' && phase !== 'decrypt-output')
    || (operation === 'encrypt' && phase !== 'encrypt-input')
    || (operation === 'decrypt' && phase !== 'decrypt-output')) return undefined;
  const byteLength = finiteNonNegative(value.byteLength);
  if (!Number.isSafeInteger(byteLength)) return undefined;
  const normalizedAlgorithm = typeof value.algorithm === 'string' ? value.algorithm.trim().toUpperCase() : '';
  const algorithm = ['AES-GCM', 'AES-CBC', 'AES-CTR', 'RSA-OAEP'].includes(normalizedAlgorithm)
    ? normalizedAlgorithm
    : 'unknown';
  const event: RawRuntimeCryptoEvent = {
    token,
    operation,
    phase,
    algorithm,
    byteLength,
    mutationApplied: value.mutationApplied === true,
  };
  if (previewEnabled && typeof value.preview === 'string') {
    const preview = boundedUtf8Preview(value.preview, previewMaxBytes);
    event.preview = preview.text;
    event.previewTruncated = value.previewTruncated === true || preview.truncated;
  }
  return event;
}

function validateSafetyReady(payload: string, token: string): boolean | undefined {
  if (Buffer.byteLength(payload, 'utf8') > MAX_BINDING_PAYLOAD_BYTES) return undefined;
  let value: Record<string, unknown>;
  try { value = record(JSON.parse(payload)); } catch { return undefined; }
  if (value.token !== token || value.control !== 'safety-ready') return undefined;
  return value.blockersReady === true;
}

async function awaitSafetyReady(pending: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  return await new Promise<boolean>((resolveReady, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new BrowserLaunchError('런타임 차단기 준비 확인 시간이 초과되었습니다.'))), SAFETY_READY_TIMEOUT_MS);
    timer.unref?.();
    const abort = () => finish(() => reject(signal.reason ?? new Error('관찰 시작이 취소되었습니다.')));
    signal.addEventListener('abort', abort, { once: true });
    pending.then((ready) => finish(() => resolveReady(ready)), () => finish(() => reject(new BrowserLaunchError('런타임 차단기 준비 확인에 실패했습니다.'))));
  });
}

function responseContentLength(rawHeaders: unknown): number | undefined {
  if (!Array.isArray(rawHeaders)) return undefined;
  for (const entry of rawHeaders) {
    const header = record(entry);
    if (typeof header.name !== 'string' || header.name.toLowerCase() !== 'content-length') continue;
    const rendered = typeof header.value === 'string' ? header.value.trim() : '';
    if (!/^\d+$/.test(rendered)) return Number.NaN;
    return Number(rendered);
  }
  return undefined;
}

function hasResponseHeader(rawHeaders: unknown, expectedName: string): boolean {
  if (!Array.isArray(rawHeaders)) return false;
  return rawHeaders.some((entry) => {
    const header = record(entry);
    return typeof header.name === 'string' && header.name.toLowerCase() === expectedName;
  });
}

function browserArguments(profilePath: string, resolverRules: string): string[] {
  return [
    '--headless=new', '--disable-gpu', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profilePath}`, '--incognito', '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--disable-extensions', '--disable-component-update', '--disable-background-networking', '--disable-domain-reliability',
    '--disable-client-side-phishing-detection', '--disable-default-apps', '--metrics-recording-only',
    '--safebrowsing-disable-auto-update', '--disable-quic', '--no-proxy-server', '--disable-breakpad',
    '--disable-crash-reporter', '--disk-cache-size=1', '--media-cache-size=1',
    '--disable-features=AutofillServerCommunication,MediaRouter,OptimizationHints,Translate',
    `--host-resolver-rules=${resolverRules}`,
    'about:blank',
  ];
}

async function resolveBrowserExecutable(configured?: string): Promise<string> {
  if (configured !== undefined) {
    if (!isAbsolute(configured) || !isAllowedBrowserName(basename(configured))) {
      throw new BrowserLaunchError('관리자 브라우저 경로는 Chrome/Edge 실행 파일의 절대 경로여야 합니다.');
    }
    await assertExecutable(configured);
    return configured;
  }
  const candidates = systemBrowserCandidates();
  for (const candidate of candidates) {
    try {
      await assertExecutable(candidate);
      return candidate;
    } catch {
      // Continue through fixed system installation locations only.
    }
  }
  throw new BrowserLaunchError('설치된 시스템 Chrome 또는 Edge 실행 파일을 찾지 못했습니다.');
}

function systemBrowserCandidates(): string[] {
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    for (const root of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (!root) continue;
      candidates.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(join(root, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  return [...new Set(candidates.map((candidate) => resolve(candidate)))];
}

function isAllowedBrowserName(name: string): boolean {
  return /^(?:chrome|chrome\.exe|chromium|chromium-browser|msedge|msedge\.exe|google chrome|microsoft edge)$/i.test(name);
}

async function assertExecutable(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) throw new BrowserLaunchError('브라우저 실행 파일이 아닙니다.');
  await access(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
}

async function waitForDebuggerAddress(child: BrowserChild, signal: AbortSignal): Promise<string> {
  return await new Promise<string>((resolveAddress, reject) => {
    let settled = false;
    let buffered = '';
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onData = (chunk: Buffer) => {
      buffered = `${buffered}${chunk.toString('utf8')}`.slice(-64 * 1024);
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buffered);
      if (!match) return;
      try {
        const parsed = new URL(match[1]);
        if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1') throw new Error('not loopback');
        finish(() => resolveAddress(parsed.href));
      } catch {
        finish(() => reject(new BrowserLaunchError('브라우저가 안전한 루프백 CDP 주소를 제공하지 않았습니다.')));
      }
    };
    const onExit = () => finish(() => reject(new BrowserLaunchError('격리 브라우저가 시작 중 종료되었습니다.')));
    const onError = () => finish(() => reject(new BrowserLaunchError('격리 브라우저 프로세스를 시작하지 못했습니다.')));
    const onAbort = () => finish(() => reject(signal.reason ?? new Error('브라우저 시작이 취소되었습니다.')));
    const timer = setTimeout(() => finish(() => reject(new BrowserLaunchError('격리 브라우저 시작 제한시간을 초과했습니다.'))), STARTUP_TIMEOUT_MS);
    timer.unref?.();
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function stopChild(child: BrowserChild | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
    new Promise<void>((resolveTimeout) => {
      const timer = setTimeout(resolveTimeout, 1_500);
      timer.unref?.();
    }),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function settleWithin(promises: Array<Promise<unknown>>, timeoutMs: number): Promise<void> {
  if (promises.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled(promises),
    new Promise<void>((resolveTimeout) => {
      timer = setTimeout(resolveTimeout, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

async function removeTemporaryProfile(path: string): Promise<void> {
  const resolvedPath = resolve(path);
  const resolvedTemp = resolve(tmpdir());
  if (!basename(resolvedPath).startsWith(PROFILE_PREFIX) || !resolvedPath.startsWith(`${resolvedTemp}${process.platform === 'win32' ? '\\' : '/'}`)) return;
  await rm(resolvedPath, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
}

function rawDataBytes(raw: RawData): number {
  if (typeof raw === 'string') return Buffer.byteLength(raw, 'utf8');
  if (Array.isArray(raw)) return raw.reduce((sum, item) => sum + item.byteLength, 0);
  return raw.byteLength;
}

function rawDataText(raw: RawData): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  return Buffer.from(new Uint8Array(raw as ArrayBuffer)).toString('utf8');
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export const cdpSafetyContract = Object.freeze({
  localLoopbackOnly: true,
  temporaryProfile: true,
  userCookiesUsed: false,
  sourceMapsBlocked: true,
  recursiveCrawl: false,
  passwordOrKeyboardCapture: false,
  auxiliaryTargetsAllowed: false,
  webSocketEventSourceWebTransportAllowed: false,
  webRtcAllowed: false,
  defaultMethods: ['GET', 'HEAD', 'OPTIONS'],
  alwaysBlockedMethods: ['DELETE'],
  hostResolverFailClosed: true,
  maxCdpMessageBytes: MAX_CDP_MESSAGE_BYTES,
  maxCdpSessionFrames: MAX_CDP_SESSION_FRAMES,
  maxCdpSessionBytes: MAX_CDP_SESSION_BYTES,
  maxBindingPayloadBytes: MAX_BINDING_PAYLOAD_BYTES,
  maxPendingCdpCommands: MAX_PENDING_CDP_COMMANDS,
  maxRuntimeEvents: MAX_RUNTIME_EVENTS,
  maxRuntimeBindingAttempts: MAX_RUNTIME_BINDING_ATTEMPTS,
  maxInvalidRuntimeBindings: MAX_INVALID_RUNTIME_BINDINGS,
  maxAuxiliaryTargetAttemptsBeforeStop: MAX_AUXILIARY_TARGETS,
});
