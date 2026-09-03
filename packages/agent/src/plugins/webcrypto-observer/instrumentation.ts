import type { CryptoPhase, MutationRuleRequest } from './types.js';

const IDENTIFIER = /^__[A-Za-z0-9_]{16,80}$/;
const TOKEN = /^[A-Za-z0-9_-]{24,128}$/;

export function buildInstrumentationScript(config: {
  bindingName: string;
  mutationUpdateName: string;
  eventToken: string;
  previewEnabled: boolean;
  previewMaxBytes: number;
}): string {
  if (!IDENTIFIER.test(config.bindingName) || !IDENTIFIER.test(config.mutationUpdateName) || !TOKEN.test(config.eventToken)) {
    throw new Error('관찰 스크립트 식별자가 올바르지 않습니다.');
  }
  const serialized = scriptJson(config);
  // This source is deliberately static. It wraps only SubtleCrypto encrypt/decrypt,
  // never reads keys, DOM inputs, keyboard events, cookies, storage, or source maps.
  return `(() => {
  'use strict';
  const cfg = ${serialized};
  const send = globalThis[cfg.bindingName];
  const stringify = JSON.stringify.bind(JSON);
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  const lockValue = (owner, name, value) => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor && descriptor.configurable === false) {
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false;
        if (descriptor.value !== value && descriptor.writable !== true) return false;
        if (descriptor.value !== value || descriptor.writable === true) {
          Object.defineProperty(owner, name, { value, writable: false });
        }
        const locked = Object.getOwnPropertyDescriptor(owner, name);
        return locked && locked.configurable === false && locked.writable === false && locked.value === value;
      }
      Object.defineProperty(owner, name, { configurable: false, enumerable: descriptor ? descriptor.enumerable === true : false, writable: false, value });
      const locked = Object.getOwnPropertyDescriptor(owner, name);
      return locked && locked.configurable === false && locked.writable === false && locked.value === value;
    } catch { return false; }
  };
  const lockMethodChain = (receiver, name, replacement) => {
    let current = receiver;
    let found = false;
    let depth = 0;
    try {
      while (current && depth < 16) {
        if (Object.getOwnPropertyDescriptor(current, name)) {
          found = true;
          if (!lockValue(current, name, replacement)) return false;
        }
        current = Object.getPrototypeOf(current);
        depth += 1;
      }
      return found;
    } catch { return false; }
  };
  const deniedConstructors = new Map();
  const denyConstructor = (name) => {
    try {
      const original = globalThis[name];
      if (typeof original !== 'function') return true;
      const existing = deniedConstructors.get(original);
      if (existing) return lockValue(globalThis, name, existing);
      const blocked = function() { throw new DOMException(name + ' is disabled in this bounded observation session.', 'SecurityError'); };
      const originalPrototype = original.prototype;
      if (!originalPrototype || (typeof originalPrototype !== 'object' && typeof originalPrototype !== 'function')) return false;
      try { blocked.prototype = originalPrototype; } catch { return false; }
      deniedConstructors.set(original, blocked);
      if (!lockValue(originalPrototype, 'constructor', blocked)) return false;
      return lockValue(globalThis, name, blocked);
    } catch { return false; }
  };
  let blockersReady = true;
  for (const name of ['Worker', 'SharedWorker', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'RTCPeerConnection', 'webkitRTCPeerConnection']) {
    blockersReady = denyConstructor(name) && blockersReady;
  }
  try {
    if (typeof globalThis.open === 'function') blockersReady = lockMethodChain(globalThis, 'open', () => null) && blockersReady;
  } catch { blockersReady = false; }
  try {
    if (globalThis.navigator && typeof globalThis.navigator.sendBeacon === 'function') {
      blockersReady = lockMethodChain(globalThis.navigator, 'sendBeacon', () => false) && blockersReady;
    }
  } catch { blockersReady = false; }
  try {
    const registration = globalThis.navigator && globalThis.navigator.serviceWorker;
    if (registration && typeof registration.register === 'function') {
      blockersReady = lockMethodChain(
        registration,
        'register',
        () => Promise.reject(new DOMException('Service workers are disabled in this observation session.', 'SecurityError')),
      ) && blockersReady;
    }
  } catch { blockersReady = false; }
  const blockWorkletModule = () => Promise.reject(new DOMException('Worklets are disabled in this observation session.', 'SecurityError'));
  try {
    const workletProto = globalThis.Worklet && globalThis.Worklet.prototype;
    if (workletProto && typeof workletProto.addModule === 'function') {
      blockersReady = lockMethodChain(
        workletProto,
        'addModule',
        blockWorkletModule,
      ) && blockersReady;
    }
  } catch { blockersReady = false; }
  try {
    for (const name of ['paintWorklet', 'animationWorklet', 'layoutWorklet']) {
      const worklet = globalThis.CSS && globalThis.CSS[name];
      if (worklet && typeof worklet.addModule === 'function') {
        blockersReady = lockMethodChain(
          worklet,
          'addModule',
          blockWorkletModule,
        ) && blockersReady;
      }
    }
  } catch { blockersReady = false; }
  if (typeof send !== 'function') return;
  if (!blockersReady || !subtle) {
    try { send(stringify({ token: cfg.eventToken, control: 'safety-ready', blockersReady: false })); } catch {}
    return;
  }
  const proto = globalThis.SubtleCrypto && globalThis.SubtleCrypto.prototype
    ? globalThis.SubtleCrypto.prototype
    : Object.getPrototypeOf(subtle);
  if (!proto || typeof proto.encrypt !== 'function' || typeof proto.decrypt !== 'function') {
    try { send(stringify({ token: cfg.eventToken, control: 'safety-ready', blockersReady: false })); } catch {}
    return;
  }
  const originalEncrypt = proto.encrypt;
  const originalDecrypt = proto.decrypt;
  let mutation = null;
  let mutationUsed = false;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  // Keep pristine WebIDL callables captured before target code runs. A tested
  // page may patch these prototypes; that must not change which literal the
  // operator armed or what preview the observer reports.
  const encode = encoder.encode.bind(encoder);
  const decode = decoder.decode.bind(decoder);
  const apply = Reflect.apply.bind(Reflect);
  const bytesOf = (value) => {
    try {
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } catch {}
    return null;
  };
  const algorithmName = (value) => {
    const name = typeof value === 'string' ? value : value && typeof value.name === 'string' ? value.name : 'unknown';
    const normalized = String(name).trim().toUpperCase();
    return ['AES-GCM', 'AES-CBC', 'AES-CTR', 'RSA-OAEP'].includes(normalized) ? normalized : 'unknown';
  };
  const preview = (bytes) => {
    if (!cfg.previewEnabled || !bytes) return undefined;
    try {
      return decode(bytes.subarray(0, cfg.previewMaxBytes))
        .replace(/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]/g, '\\uFFFD');
    } catch { return undefined; }
  };
  const replaceLiteralOnce = (bytes, phase) => {
    if (!bytes || !mutation || mutationUsed || mutation.phase !== phase || bytes.byteLength > 65536) {
      return { bytes, applied: false };
    }
    const match = encode(mutation.matchLiteral);
    const replacement = encode(mutation.replacementLiteral);
    if (!match.byteLength || match.byteLength > 64 || replacement.byteLength > 64) return { bytes, applied: false };
    outer: for (let offset = 0; offset <= bytes.byteLength - match.byteLength; offset += 1) {
      for (let index = 0; index < match.byteLength; index += 1) {
        if (bytes[offset + index] !== match[index]) continue outer;
      }
      const output = new Uint8Array(bytes.byteLength - match.byteLength + replacement.byteLength);
      output.set(bytes.subarray(0, offset), 0);
      output.set(replacement, offset);
      output.set(bytes.subarray(offset + match.byteLength), offset + replacement.byteLength);
      mutationUsed = true;
      mutation = null;
      return { bytes: output, applied: true };
    }
    return { bytes, applied: false };
  };
  const emit = (operation, phase, algorithm, bytes, mutationApplied) => {
    if (!bytes) return;
    const text = preview(bytes);
    const event = {
      token: cfg.eventToken,
      operation,
      phase,
      algorithm: algorithmName(algorithm),
      byteLength: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, bytes.byteLength)),
      mutationApplied: mutationApplied === true,
    };
    if (text !== undefined) {
      event.preview = text;
      event.previewTruncated = bytes.byteLength > cfg.previewMaxBytes;
    }
    try { send(stringify(event)); } catch {}
  };
  const updateMutation = (next) => {
    if (mutationUsed || mutation || !next || next.token !== cfg.eventToken || (next.phase !== 'encrypt-input' && next.phase !== 'decrypt-output')) return false;
    if (typeof next.matchLiteral !== 'string' || typeof next.replacementLiteral !== 'string') return false;
    if (!encode(next.matchLiteral).byteLength || encode(next.matchLiteral).byteLength > 64
      || !encode(next.replacementLiteral).byteLength || encode(next.replacementLiteral).byteLength > 64) return false;
    mutation = { phase: next.phase, matchLiteral: next.matchLiteral, replacementLiteral: next.replacementLiteral };
    return true;
  };
  const observedEncrypt = function(algorithm, key, data) {
      const originalBytes = bytesOf(data);
      const changed = replaceLiteralOnce(originalBytes, 'encrypt-input');
      emit('encrypt', 'encrypt-input', algorithm, changed.bytes, changed.applied);
      return apply(originalEncrypt, this, changed.applied ? [algorithm, key, changed.bytes] : arguments);
  };
  const observedDecrypt = function(algorithm, key, data) {
      const result = apply(originalDecrypt, this, arguments);
      return Promise.resolve(result).then((plain) => {
        const originalBytes = bytesOf(plain);
        const changed = replaceLiteralOnce(originalBytes, 'decrypt-output');
        emit('decrypt', 'decrypt-output', algorithm, changed.bytes, changed.applied);
        if (!changed.applied) return plain;
        return changed.bytes.buffer.slice(changed.bytes.byteOffset, changed.bytes.byteOffset + changed.bytes.byteLength);
      });
  };
  blockersReady = lockValue(globalThis, cfg.mutationUpdateName, updateMutation) && blockersReady;
  blockersReady = lockValue(proto, 'encrypt', observedEncrypt) && blockersReady;
  blockersReady = lockValue(proto, 'decrypt', observedDecrypt) && blockersReady;
  try { send(stringify({ token: cfg.eventToken, control: 'safety-ready', blockersReady })); } catch { return; }
})();`;
}

export function buildMutationUpdateExpression(
  mutationUpdateName: string,
  eventToken: string,
  rule: { phase: CryptoPhase; matchLiteral: string; replacementLiteral: string },
): string {
  if (!IDENTIFIER.test(mutationUpdateName)) throw new Error('수정 규칙 채널 식별자가 올바르지 않습니다.');
  if (!TOKEN.test(eventToken)) throw new Error('수정 규칙 채널 토큰이 올바르지 않습니다.');
  return `globalThis[${scriptJson(mutationUpdateName)}](${scriptJson({ token: eventToken, ...rule })})`;
}

export function normalizeMutationRule(raw: unknown): MutationRuleRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('수정 규칙 요청 객체가 필요합니다.');
  const request = raw as Partial<MutationRuleRequest>;
  const unknown = Object.keys(request).filter((key) => !['sessionId', 'phase', 'matchLiteral', 'replacementLiteral', 'mutationConfirmed'].includes(key));
  if (unknown.length > 0) throw new Error(`수정 규칙에 지원하지 않는 필드가 있습니다: ${unknown.slice(0, 3).join(', ')}`);
  if (request.mutationConfirmed !== true) throw new Error('일회성 평문 수정을 별도로 확인해야 합니다.');
  if (request.phase !== 'encrypt-input' && request.phase !== 'decrypt-output') throw new Error('수정 phase가 올바르지 않습니다.');
  if (typeof request.matchLiteral !== 'string' || typeof request.replacementLiteral !== 'string') {
    throw new Error('matchLiteral과 replacementLiteral 문자열이 필요합니다.');
  }
  const matchBytes = Buffer.byteLength(request.matchLiteral, 'utf8');
  const replacementBytes = Buffer.byteLength(request.replacementLiteral, 'utf8');
  if (matchBytes < 1 || matchBytes > 64 || replacementBytes < 1 || replacementBytes > 64) {
    throw new Error('literal은 UTF-8 기준 match와 replacement 모두 1~64바이트여야 합니다.');
  }
  return {
    sessionId: normalizeSessionId(request.sessionId),
    phase: request.phase,
    matchLiteral: request.matchLiteral,
    replacementLiteral: request.replacementLiteral,
    mutationConfirmed: true,
  };
}

export function normalizeSessionId(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('sessionId 형식이 올바르지 않습니다.');
  }
  return value.toLowerCase();
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u2028\u2029]/g, (character) => character === '\u2028' ? '\\u2028' : '\\u2029');
}
