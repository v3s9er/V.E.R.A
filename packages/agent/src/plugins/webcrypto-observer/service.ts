import { randomUUID } from 'node:crypto';
import { SystemCdpBrowserDriver } from './cdp.js';
import { normalizeMutationRule, normalizeSessionId } from './instrumentation.js';
import { normalizeObserveRequest, policyStatus, WEBCRYPTO_OBSERVER_LIMITS } from './policy.js';
import { boundedUtf8Preview } from './preview.js';
import type {
  BrowserObservationHandle,
  CryptoPhase,
  ObservationEventsResult,
  ObservationSessionStatus,
  ObservationStartResult,
  RawRuntimeCryptoEvent,
  RuntimeCryptoEvent,
  TrafficSnapshot,
  WebCryptoObserverOptions,
} from './types.js';

const MAX_RETAINED_SESSIONS = 4;
const EMPTY_TRAFFIC: TrafficSnapshot = Object.freeze({
  requestsStarted: 0,
  requestsBlocked: 0,
  responseBytesObserved: 0,
  requestBytesAllowed: 0,
  peakConcurrentRequests: 0,
});

interface SessionState {
  id: string;
  status: ObservationSessionStatus;
  startedAtMs: number;
  expiresAtMs: number;
  target?: { url: string; origin: string; resolvedAddressCount: number };
  metadataOnly: boolean;
  previewMaxBytes: number;
  maxRingEvents: number;
  events: RuntimeCryptoEvent[];
  latestSequence: number;
  controller: AbortController;
  handle?: BrowserObservationHandle;
  traffic: TrafficSnapshot;
  reasonCode?: string;
  mutation: { armed: boolean; applied: boolean; phase?: CryptoPhase; configured: boolean };
  removeExternalAbort?: () => void;
}

export interface ObserverStateNotice {
  sessionId: string;
  status: ObservationSessionStatus;
  eventCount: number;
  reasonCode?: string;
}

export class WebCryptoObserverService {
  private readonly driver;
  private readonly sessions = new Map<string, SessionState>();
  private activeSessionId?: string;

  constructor(
    private readonly options: WebCryptoObserverOptions = {},
    private readonly onState?: (notice: ObserverStateNotice) => void,
  ) {
    this.driver = options.browserDriver ?? new SystemCdpBrowserDriver();
  }

  async observe(raw: unknown, externalSignal?: AbortSignal): Promise<ObservationStartResult> {
    if (this.activeSessionId) throw new Error('WebCrypto 관찰 세션은 동시에 하나만 실행할 수 있습니다.');
    const id = this.options.randomId?.() ?? randomUUID();
    normalizeSessionId(id);
    const now = this.now();
    const session: SessionState = {
      id,
      status: 'starting',
      startedAtMs: now,
      expiresAtMs: now,
      metadataOnly: true,
      previewMaxBytes: 0,
      maxRingEvents: WEBCRYPTO_OBSERVER_LIMITS.maxRingEvents.default,
      events: [],
      latestSequence: 0,
      controller: new AbortController(),
      traffic: { ...EMPTY_TRAFFIC },
      mutation: { armed: false, applied: false, configured: false },
    };
    this.sessions.set(id, session);
    this.activeSessionId = id;
    const forwardAbort = () => session.controller.abort(externalSignal?.reason ?? new Error('관찰 시작이 취소되었습니다.'));
    if (externalSignal?.aborted) forwardAbort();
    else {
      externalSignal?.addEventListener('abort', forwardAbort, { once: true });
      session.removeExternalAbort = () => externalSignal?.removeEventListener('abort', forwardAbort);
    }

    try {
      const request = await normalizeObserveRequest(raw, this.options.policyProvider, this.options.dnsLookup, session.controller.signal);
      const elapsedMs = Math.max(0, this.now() - session.startedAtMs);
      const remainingMs = request.limits.durationMs - elapsedMs;
      if (remainingMs <= 0) {
        throw new Error('DNS와 정책 확인 후 안전한 관찰 시간이 남지 않았습니다.');
      }
      session.expiresAtMs = session.startedAtMs + request.limits.durationMs;
      session.target = {
        url: request.target.redactedUrl,
        origin: request.target.origin,
        resolvedAddressCount: request.target.resolvedAddressCount,
      };
      session.metadataOnly = !request.preview.enabled;
      session.previewMaxBytes = request.preview.maxBytes;
      session.maxRingEvents = request.limits.maxRingEvents;
      const driverRequest = { ...request, limits: { ...request.limits, durationMs: remainingMs } };
      session.handle = await this.driver.start(driverRequest, {
        onCryptoEvent: (event) => this.recordEvent(session, event),
      }, session.controller.signal);
      session.status = 'running';
      this.emitState(session);
      void session.handle.completion.then(
        (completion) => this.completeSession(session, completion.outcome, completion.traffic, completion.reasonCode),
        () => this.completeSession(session, 'failed', session.handle?.getTraffic() ?? session.traffic, 'driver-failed'),
      );
      return {
        sessionId: id,
        status: 'running',
        startedAt: new Date(session.startedAtMs).toISOString(),
        expiresAt: new Date(session.expiresAtMs).toISOString(),
        target: { ...session.target },
        metadataOnly: session.metadataOnly,
        limits: request.limits,
      };
    } catch (error) {
      this.scrubPreviews(session);
      // A concurrent idempotent stop may abort policy/DNS/browser startup after
      // the session id became visible through status(). Preserve that terminal
      // stop result instead of relabeling it as a startup failure.
      if (session.status === 'stopping' || session.status === 'stopped') {
        session.removeExternalAbort?.();
        session.removeExternalAbort = undefined;
        this.trimSessions();
        throw error;
      }
      session.status = 'failed';
      session.reasonCode = 'startup-failed';
      session.removeExternalAbort?.();
      if (this.activeSessionId === id) this.activeSessionId = undefined;
      this.emitState(session);
      this.trimSessions();
      throw error;
    }
  }

  async status(raw?: unknown): Promise<Record<string, unknown>> {
    const sessionId = optionalSessionId(raw);
    const session = sessionId ? this.sessions.get(sessionId) : this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    const policy = await policyStatus(this.options.policyProvider);
    return {
      ok: true,
      engine: 'isolated system Chrome/Edge over loopback CDP',
      policy,
      activeSessions: this.activeSessionId ? 1 : 0,
      limits: WEBCRYPTO_OBSERVER_LIMITS,
      privacy: {
        metadataOnlyByDefault: true,
        userBrowserProfileUsed: false,
        cookiesImported: false,
        keyboardOrPasswordCapture: false,
        sourceMaps: false,
        recursiveCrawl: false,
      },
      session: session ? this.sessionSummary(session) : undefined,
    };
  }

  events(raw: unknown): ObservationEventsResult {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('이벤트 요청 객체가 필요합니다.');
    const request = raw as Record<string, unknown>;
    rejectUnknown(request, ['sessionId', 'afterSequence'], '이벤트 요청');
    const sessionId = normalizeSessionId(request.sessionId);
    const afterSequence = request.afterSequence === undefined ? 0 : Number(request.afterSequence);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('afterSequence는 0 이상의 안전한 정수여야 합니다.');
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('관찰 세션을 찾을 수 없습니다.');
    const firstSequence = session.events[0]?.sequence ?? session.latestSequence + 1;
    return {
      sessionId,
      status: session.status,
      afterSequence,
      nextSequence: session.latestSequence,
      truncated: afterSequence < firstSequence - 1,
      events: session.events.filter((event) => event.sequence > afterSequence).map((event) => ({ ...event })),
      traffic: this.liveTraffic(session),
      mutation: {
        armed: session.mutation.armed,
        applied: session.mutation.applied,
        phase: session.mutation.phase,
      },
      reasonCode: session.reasonCode,
    };
  }

  async setMutation(raw: unknown, externalSignal?: AbortSignal): Promise<{ sessionId: string; armed: true; phase: CryptoPhase }> {
    const rule = normalizeMutationRule(raw);
    externalSignal?.throwIfAborted();
    const session = this.sessions.get(rule.sessionId);
    if (!session || session.status !== 'running' || !session.handle) throw new Error('활성 관찰 세션을 찾을 수 없습니다.');
    if (session.metadataOnly) throw new Error('일회성 변경은 평문 미리보기를 명시적으로 활성화한 세션에서만 사용할 수 있습니다.');
    const observedMatch = session.events.some((event) => event.phase === rule.phase
      && event.preview === rule.matchLiteral && event.previewTruncated !== true);
    if (!observedMatch) throw new Error('잘리지 않은 관찰 평문과 정확히 일치하는 literal만 다음 1회 변경에 사용할 수 있습니다.');
    if (session.mutation.configured || session.mutation.applied || session.mutation.armed) {
      throw new Error('세션당 일회성 수정 규칙은 하나만 설정할 수 있습니다.');
    }
    session.mutation = { configured: true, armed: true, applied: false, phase: rule.phase };
    const handle = session.handle;
    let requestAborted = false;
    let rejectAbort: ((reason?: unknown) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => {
      requestAborted = true;
      rejectAbort?.(externalSignal?.reason ?? new Error('일회성 수정 요청이 취소되었습니다.'));
    };
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      const update = handle.setMutation({
        phase: rule.phase,
        matchLiteral: rule.matchLiteral,
        replacementLiteral: rule.replacementLiteral,
      });
      await (externalSignal ? Promise.race([update, aborted]) : update);
      externalSignal?.throwIfAborted();
    } catch (error) {
      // A lost CDP acknowledgement is ambiguous: the rule may already be live
      // in the page. A caller disconnect is equally ambiguous. End the
      // disposable session so an unacknowledged rule can never remain armed.
      session.mutation = { configured: true, armed: false, applied: false, phase: rule.phase };
      const reasonCode = requestAborted || externalSignal?.aborted
        ? 'mutation-request-cancelled'
        : 'mutation-channel-failed';
      session.controller.abort(new Error(reasonCode === 'mutation-request-cancelled'
        ? '일회성 수정 요청이 취소되어 관찰 세션을 종료합니다.'
        : '일회성 수정 채널 확인에 실패했습니다.'));
      await handle.stop().catch(() => undefined);
      // handle.stop() may resolve its ordinary `stopped` completion first. The
      // security-significant mutation outcome must still win after cleanup.
      this.completeSession(session, 'failed', handle.getTraffic(), reasonCode, true);
      throw error;
    } finally {
      externalSignal?.removeEventListener('abort', onAbort);
    }
    this.emitState(session);
    return { sessionId: rule.sessionId, armed: true, phase: rule.phase };
  }

  async stop(raw: unknown): Promise<{ sessionId: string; stopped: boolean; status: ObservationSessionStatus }> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('중지 요청 객체가 필요합니다.');
    const request = raw as Record<string, unknown>;
    rejectUnknown(request, ['sessionId'], '중지 요청');
    const sessionId = normalizeSessionId(request.sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) return { sessionId, stopped: false, status: 'stopped' };
    if (session.status !== 'starting' && session.status !== 'running' && session.status !== 'stopping') {
      return { sessionId, stopped: false, status: session.status };
    }
    session.status = 'stopping';
    this.emitState(session);
    session.controller.abort(new Error('사용자가 관찰 세션을 중지했습니다.'));
    await session.handle?.stop().catch(() => undefined);
    this.completeSession(session, 'stopped', session.handle?.getTraffic() ?? session.traffic, 'user-stopped');
    return { sessionId, stopped: true, status: session.status };
  }

  async stopAll(): Promise<void> {
    const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    if (!active) return;
    active.controller.abort(new Error('플러그인이 종료되어 관찰을 중지했습니다.'));
    await active.handle?.stop().catch(() => undefined);
    this.completeSession(active, 'stopped', active.handle?.getTraffic() ?? active.traffic, 'plugin-unloaded');
  }

  private recordEvent(session: SessionState, raw: RawRuntimeCryptoEvent): void {
    if (session.status !== 'running' && session.status !== 'starting') return;
    const byteLength = Number(raw.byteLength);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) return;
    const phaseMatches = (raw.operation === 'encrypt' && raw.phase === 'encrypt-input')
      || (raw.operation === 'decrypt' && raw.phase === 'decrypt-output');
    if (!phaseMatches) return;
    const mutationApplied = raw.mutationApplied === true
      && session.mutation.armed
      && session.mutation.phase === raw.phase;
    if (mutationApplied) {
      session.mutation.armed = false;
      session.mutation.applied = true;
    }
    session.latestSequence += 1;
    const event: RuntimeCryptoEvent = {
      sequence: session.latestSequence,
      elapsedMs: Math.max(0, this.now() - session.startedAtMs),
      operation: raw.operation,
      phase: raw.phase,
      algorithm: sanitizeAlgorithm(raw.algorithm),
      byteLength,
      mutationApplied,
      recommendation: raw.phase === 'encrypt-input'
        ? 'WebCrypto encrypt의 BufferSource 입력 직전 후보'
        : 'WebCrypto decrypt Promise의 ArrayBuffer 반환 직후 후보',
    };
    if (!session.metadataOnly && typeof raw.preview === 'string') {
      const preview = boundedUtf8Preview(raw.preview, session.previewMaxBytes);
      event.preview = preview.text;
      event.previewTruncated = raw.previewTruncated === true || preview.truncated;
    }
    session.events.push(event);
    while (session.events.length > session.maxRingEvents) session.events.shift();
    this.emitState(session);
  }

  private completeSession(
    session: SessionState,
    outcome: 'completed' | 'stopped' | 'limit-reached' | 'failed',
    traffic: TrafficSnapshot,
    reasonCode?: string,
    replaceTerminalOutcome = false,
  ): void {
    if (!replaceTerminalOutcome && !['starting', 'running', 'stopping'].includes(session.status)) return;
    session.status = outcome;
    session.reasonCode = reasonCode;
    session.traffic = { ...traffic };
    session.removeExternalAbort?.();
    session.removeExternalAbort = undefined;
    session.handle = undefined;
    session.controller = new AbortController();
    session.mutation.armed = false;
    // Plaintext previews exist only while the explicitly enabled session is active.
    this.scrubPreviews(session);
    if (this.activeSessionId === session.id) this.activeSessionId = undefined;
    this.emitState(session);
    this.trimSessions();
  }

  private scrubPreviews(session: SessionState): void {
    for (const event of session.events) {
      delete event.preview;
      delete event.previewTruncated;
    }
  }

  private liveTraffic(session: SessionState): TrafficSnapshot {
    return session.handle?.getTraffic() ?? { ...session.traffic };
  }

  private sessionSummary(session: SessionState): Record<string, unknown> {
    return {
      sessionId: session.id,
      status: session.status,
      startedAt: new Date(session.startedAtMs).toISOString(),
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      target: session.target,
      metadataOnly: session.metadataOnly,
      eventCount: session.latestSequence,
      traffic: this.liveTraffic(session),
      mutation: { armed: session.mutation.armed, applied: session.mutation.applied, phase: session.mutation.phase },
      reasonCode: session.reasonCode,
    };
  }

  private emitState(session: SessionState): void {
    try {
      this.onState?.({
        sessionId: session.id,
        status: session.status,
        eventCount: session.latestSequence,
        reasonCode: session.reasonCode,
      });
    } catch {
      // UI notifications never fail or retain a sensitive session.
    }
  }

  private trimSessions(): void {
    while (this.sessions.size > MAX_RETAINED_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (!oldest || oldest === this.activeSessionId) break;
      this.sessions.delete(oldest);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function optionalSessionId(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('상태 요청은 객체여야 합니다.');
  const request = raw as Record<string, unknown>;
  rejectUnknown(request, ['sessionId'], '상태 요청');
  return request.sessionId === undefined ? undefined : normalizeSessionId(request.sessionId);
}

function sanitizeAlgorithm(raw: unknown): string {
  const normalized = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return ['AES-GCM', 'AES-CBC', 'AES-CTR', 'RSA-OAEP'].includes(normalized) ? normalized : 'unknown';
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label}에 지원하지 않는 필드가 있습니다: ${unknown.slice(0, 3).join(', ')}`);
}
