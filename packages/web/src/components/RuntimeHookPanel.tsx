import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Input, Select } from './ui';
import type { RuntimeHookAction, RuntimeHookCandidate, RuntimeHookEvent, RuntimeHookSession } from '../tool-portal-contract';
import './PluginWorkbench.css';
import './RuntimeHookPanel.css';

const SOURCE_MAX_BYTES = 256 * 1024;
const EVENT_RING_SIZE = 64;
const MUTATION_LITERAL_MAX_BYTES = 64;

export interface RuntimeHookTransport {
  call<T>(action: RuntimeHookAction, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

interface RuntimeHookPanelProps {
  transport: RuntimeHookTransport;
  onCompleted?: (label: string, value: unknown) => void;
  onError?: (message: string) => void;
  onRunningChange?: (running: boolean) => void;
  mutationGloballyEnabled?: boolean;
  compact?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function eventFrom(value: unknown): RuntimeHookEvent | null {
  const item = record(value);
  const sequence = Number(item.sequence);
  const elapsedMs = Number(item.elapsedMs);
  const byteLength = Number(item.byteLength);
  const phase = item.phase === 'encrypt-input' || item.phase === 'decrypt-output' ? item.phase : null;
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isFinite(elapsedMs) || !Number.isFinite(byteLength) || !phase) return null;
  return {
    sequence,
    elapsedMs,
    phase,
    operation: typeof item.operation === 'string' ? item.operation : 'unknown',
    algorithm: typeof item.algorithm === 'string' ? item.algorithm : 'unknown',
    byteLength,
    preview: typeof item.preview === 'string' ? item.preview.slice(0, 128) : undefined,
    previewTruncated: item.previewTruncated === true,
    mutationApplied: item.mutationApplied === true,
  };
}

function candidatesFrom(value: unknown): RuntimeHookCandidate[] {
  const items = Array.isArray(record(value).candidates) ? record(value).candidates as unknown[] : [];
  return items.slice(0, 200).map((value, index) => {
    const item = record(value);
    return {
      operation: typeof item.operation === 'string' ? item.operation : `후보 ${index + 1}`,
      api: typeof item.api === 'string' ? item.api : 'WebCrypto',
      line: Number.isSafeInteger(Number(item.line)) ? Number(item.line) : 0,
      column: Number.isSafeInteger(Number(item.column)) ? Number(item.column) : 0,
      confidence: item.confidence === 'high' ? 'high' : 'medium',
    };
  });
}

export function RuntimeHookPanel({ transport, onCompleted, onError, onRunningChange, mutationGloballyEnabled = true, compact = false }: RuntimeHookPanelProps) {
  const [targetUrl, setTargetUrl] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [plaintextEnabled, setPlaintextEnabled] = useState(false);
  const [plaintextConfirmed, setPlaintextConfirmed] = useState(false);
  const [stateChangingEnabled, setStateChangingEnabled] = useState(false);
  const [stateChangingConfirmed, setStateChangingConfirmed] = useState(false);
  const [candidates, setCandidates] = useState<RuntimeHookCandidate[]>([]);
  const [session, setSession] = useState<RuntimeHookSession | null>(null);
  const [events, setEvents] = useState<RuntimeHookEvent[]>([]);
  const [selectedSequence, setSelectedSequence] = useState<number | null>(null);
  const [replacementLiteral, setReplacementLiteral] = useState('');
  const [mutationPhase, setMutationPhase] = useState<'encrypt-input' | 'decrypt-output'>('encrypt-input');
  const [mutationConfirmed, setMutationConfirmed] = useState(false);
  const [busy, setBusy] = useState<RuntimeHookAction | null>(null);
  const [notice, setNotice] = useState('');
  const mountedRef = useRef(true);
  const afterSequenceRef = useRef<number | undefined>(undefined);
  const activeSessionIdRef = useRef<string | null>(null);

  const fail = useCallback((error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    if (mountedRef.current) setNotice(message);
    onError?.(message);
  }, [onError]);

  const appendEvents = useCallback((incoming: unknown[]): void => {
    const normalized = incoming.map(eventFrom).filter((item): item is RuntimeHookEvent => item !== null);
    if (normalized.length === 0) return;
    afterSequenceRef.current = Math.max(afterSequenceRef.current ?? -1, ...normalized.map((item) => item.sequence));
    setEvents((current) => {
      const bySequence = new Map(current.map((item) => [item.sequence, item]));
      for (const item of normalized) bySequence.set(item.sequence, item);
      return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence).slice(-EVENT_RING_SIZE);
    });
  }, []);

  const scrubPlaintextState = useCallback((): void => {
    setEvents((current) => current.map((event) => {
      const { preview: _preview, previewTruncated: _previewTruncated, ...metadata } = event;
      return metadata;
    }));
    setSelectedSequence(null);
    setReplacementLiteral('');
    setMutationConfirmed(false);
    setPlaintextConfirmed(false);
    setStateChangingConfirmed(false);
  }, []);

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const value = await transport.call<unknown>('status', session?.sessionId ? { sessionId: session.sessionId } : {});
      if (!mountedRef.current) return;
      const item = record(value);
      const active = record(item.session ?? value);
      if (typeof active.sessionId === 'string') {
        const running = active.running === true || active.status === 'starting' || active.status === 'running';
        const target = record(active.target);
        activeSessionIdRef.current = running ? active.sessionId : null;
        setSession({
          sessionId: active.sessionId,
          running,
          targetUrl: typeof active.targetUrl === 'string' ? active.targetUrl : typeof target.url === 'string' ? target.url : undefined,
          captureMode: active.captureMode === 'plaintext' || active.metadataOnly === false ? 'plaintext' : 'metadata-only',
          lastSequence: typeof active.lastSequence === 'number' ? active.lastSequence : typeof active.eventCount === 'number' ? active.eventCount : undefined,
        });
        const observedTargetUrl = typeof active.targetUrl === 'string' ? active.targetUrl : typeof target.url === 'string' ? target.url : undefined;
        if (observedTargetUrl) setTargetUrl(observedTargetUrl);
        if (!running) scrubPlaintextState();
      } else {
        activeSessionIdRef.current = null;
        setSession(null);
        scrubPlaintextState();
      }
    } catch {
      // Initial status is optional; explicit operations surface errors.
    }
  }, [scrubPlaintextState, session?.sessionId, transport]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshStatus();
    return () => { mountedRef.current = false; };
  }, [refreshStatus]);

  useEffect(() => () => {
    const sessionId = activeSessionIdRef.current;
    activeSessionIdRef.current = null;
    afterSequenceRef.current = undefined;
    if (sessionId) void transport.call('stop', { sessionId }, 15_000).catch(() => undefined);
  }, [transport]);

  useEffect(() => {
    if (!session?.running || !session.sessionId) return;
    let stopped = false;
    let timer: number | undefined;
    let failures = 0;
    const poll = async (): Promise<void> => {
      let continuePolling = true;
      try {
        const value = await transport.call<unknown>('events', { sessionId: session.sessionId, ...(afterSequenceRef.current === undefined ? {} : { afterSequence: afterSequenceRef.current }) });
        if (stopped) return;
        failures = 0;
        const payload = record(value);
        appendEvents(Array.isArray(payload.events) ? payload.events : []);
        const nextSequence = Number(payload.nextSequence);
        if (Number.isSafeInteger(nextSequence) && nextSequence >= 0) afterSequenceRef.current = Math.max(afterSequenceRef.current ?? -1, nextSequence);
        const status = typeof payload.status === 'string' ? payload.status : '';
        const terminal = status === 'stopped' || status === 'completed' || status === 'expired' || status === 'limit-reached' || status === 'failed';
        const reasonCode = typeof payload.reasonCode === 'string' ? payload.reasonCode.slice(0, 80) : '';
        const gap = payload.truncated === true ? '이벤트 링 상한으로 일부 이전 이벤트가 누락되었습니다. ' : '';
        if (terminal) {
          continuePolling = false;
          activeSessionIdRef.current = null;
          setSession((current) => current ? { ...current, running: false } : current);
          scrubPlaintextState();
          const label = status === 'completed' ? '관찰 세션이 완료되었습니다.'
            : status === 'limit-reached' ? '안전 한도에 도달해 관찰 세션을 종료했습니다.'
              : status === 'failed' ? '관찰 세션이 실패하여 종료되었습니다.'
                : status === 'expired' ? '관찰 세션이 만료되었습니다.' : '관찰 세션이 중지되었습니다.';
          const message = `${gap}${label}${reasonCode ? ` (${reasonCode})` : ''}`;
          if (status === 'failed') fail(new Error(message));
          else setNotice(message);
        } else if (payload.truncated === true) {
          setNotice('이벤트 링 상한으로 일부 이전 이벤트가 누락되었습니다. 표시된 최근 이벤트만 검토하세요.');
        }
      } catch (error) {
        failures += 1;
        if (!stopped) fail(error);
        if (failures >= 3) {
          continuePolling = false;
          const sessionId = activeSessionIdRef.current;
          activeSessionIdRef.current = null;
          setSession((current) => current ? { ...current, running: false } : current);
          scrubPlaintextState();
          if (sessionId) void transport.call('stop', { sessionId }, 15_000).catch(() => undefined);
        }
      } finally {
        if (!stopped && continuePolling) timer = window.setTimeout(() => void poll(), 1_000);
      }
    };
    void poll();
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [appendEvents, fail, scrubPlaintextState, session?.running, session?.sessionId, transport]);

  const selectedEvent = useMemo(() => events.find((item) => item.sequence === selectedSequence) ?? null, [events, selectedSequence]);
  const selectedPreviewBytes = useMemo(() => selectedEvent?.preview === undefined ? 0 : utf8ByteLength(selectedEvent.preview), [selectedEvent]);
  const mutationSourceBlocked = selectedEvent?.previewTruncated === true || selectedPreviewBytes > MUTATION_LITERAL_MAX_BYTES;
  const replacementBytes = useMemo(() => utf8ByteLength(replacementLiteral), [replacementLiteral]);
  const replacementValid = replacementBytes >= 1 && replacementBytes <= MUTATION_LITERAL_MAX_BYTES && replacementLiteral !== selectedEvent?.preview;
  const running = session?.running === true;
  const inputsLocked = busy !== null || running;

  useEffect(() => {
    onRunningChange?.(running);
  }, [onRunningChange, running]);

  useEffect(() => () => onRunningChange?.(false), [onRunningChange]);

  const analyze = async (): Promise<void> => {
    if (busy) return;
    if (!sourceText.trim()) { fail(new Error('분석할 JavaScript 소스를 붙여넣으세요.')); return; }
    if (!authorized) { fail(new Error('대상 또는 붙여넣은 코드에 대한 분석 권한을 먼저 확인하세요.')); return; }
    if (new Blob([sourceText]).size > SOURCE_MAX_BYTES) { fail(new Error('오프라인 분석 소스는 256KiB 이하여야 합니다.')); return; }
    setAuthorized(false);
    onError?.('');
    setBusy('analyze'); setNotice('오프라인 분석 중…');
    try {
      const value = await transport.call<unknown>('analyze', { authorizationConfirmed: true, sourceText }, 30_000);
      if (!mountedRef.current) return;
      const next = candidatesFrom(value);
      const truncated = record(value).truncated === true;
      setCandidates(next);
      setNotice(`후보 ${next.length}개를 찾았습니다.${truncated ? ' 후보 상한에 도달해 이후 항목은 생략했습니다.' : ''} 네트워크 요청은 발생하지 않았습니다.`);
      onCompleted?.('JavaScript 오프라인 분석', value);
    } catch (error) { fail(error); }
    finally { if (mountedRef.current) setBusy(null); }
  };

  const start = async (): Promise<void> => {
    if (busy || running) return;
    let url: URL;
    try { url = new URL(targetUrl.trim()); } catch { fail(new Error('올바른 HTTPS 대상 URL을 입력하세요.')); return; }
    if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) { fail(new Error('자격증명 없는 HTTPS 443 URL만 사용할 수 있습니다.')); return; }
    if (!authorized) { fail(new Error('대상 관찰 권한을 먼저 확인하세요.')); return; }
    if (plaintextEnabled && !plaintextConfirmed) { fail(new Error('평문 미리보기의 민감정보 노출 위험을 명시적으로 확인하세요.')); return; }
    if (stateChangingEnabled && !mutationGloballyEnabled) { fail(new Error('관리자가 포털의 상태 변경 요청과 런타임 변경을 비활성화했습니다.')); return; }
    if (stateChangingEnabled && !stateChangingConfirmed) { fail(new Error('상태 변경 요청의 실행 위험을 명시적으로 확인하세요.')); return; }
    setAuthorized(false); setPlaintextConfirmed(false); setStateChangingConfirmed(false); setMutationConfirmed(false);
    onError?.('');
    setBusy('observe'); setNotice('관찰 세션 시작 중…'); setEvents([]); setSelectedSequence(null); afterSequenceRef.current = undefined;
    try {
      const value = await transport.call<unknown>('observe', {
        authorizationConfirmed: true,
        sessionEnabled: true,
        targetUrl: url.href,
        ...(plaintextEnabled ? { plaintextPreview: { enabled: true, previewConfirmed: true, maxBytes: 128 } } : {}),
        allowStateChangingRequests: stateChangingEnabled,
        stateChangingRequestsConfirmed: stateChangingEnabled && stateChangingConfirmed,
        limits: { durationMs: 10_000, maxRequests: 20, maxResponseBytes: 4 * 1024 * 1024, maxConcurrentRequests: 4, maxRingEvents: 64, maxRequestBodyBytes: 64 * 1024, maxUploadBytes: 128 * 1024 },
      }, 30_000);
      const payload = record(value);
      if (typeof payload.sessionId !== 'string') throw new Error('관찰 세션 ID를 받지 못했습니다.');
      if (!mountedRef.current) {
        await transport.call('stop', { sessionId: payload.sessionId }, 15_000).catch(() => undefined);
        return;
      }
      const captureMode = payload.metadataOnly === false ? 'plaintext' : payload.metadataOnly === true ? 'metadata-only' : plaintextEnabled ? 'plaintext' : 'metadata-only';
      activeSessionIdRef.current = payload.sessionId;
      setSession({ sessionId: payload.sessionId, running: payload.status !== 'stopped', targetUrl: url.href, captureMode });
      setNotice(captureMode === 'plaintext' ? '평문 미리보기를 포함해 관찰 중입니다.' : '메타데이터 전용으로 관찰 중입니다.');
      onCompleted?.('런타임 관찰 시작', value);
    } catch (error) { fail(error); }
    finally { if (mountedRef.current) setBusy(null); }
  };

  const stop = async (): Promise<void> => {
    if (!session?.sessionId || busy !== null) return;
    onError?.('');
    setBusy('stop'); setNotice('세션 중지 중…');
    try {
      const value = await transport.call<unknown>('stop', { sessionId: session.sessionId }, 15_000);
      if (!mountedRef.current) return;
      activeSessionIdRef.current = null;
      setSession((current) => current ? { ...current, running: false } : current);
      scrubPlaintextState();
      setNotice('관찰 세션을 중지했습니다.');
      onCompleted?.('런타임 관찰 중지', value);
    } catch (error) { fail(error); }
    finally { if (mountedRef.current) setBusy(null); }
  };

  const armMutation = async (): Promise<void> => {
    if (!session?.sessionId || busy || !selectedEvent?.preview || !mutationGloballyEnabled) return;
    if (mutationSourceBlocked) { fail(new Error('잘렸거나 UTF-8 64바이트를 넘는 미리보기는 literal 변경 규칙으로 사용할 수 없습니다.')); return; }
    if (!mutationConfirmed) { fail(new Error('다음 일치 1회 변경을 명시적으로 승인하세요.')); return; }
    if (!replacementLiteral || replacementLiteral === selectedEvent.preview) { fail(new Error('원문과 다른 치환 평문을 입력하세요.')); return; }
    if (utf8ByteLength(replacementLiteral) > MUTATION_LITERAL_MAX_BYTES) { fail(new Error('치환 평문은 UTF-8 64바이트 이하여야 합니다.')); return; }
    const request = { sessionId: session.sessionId, phase: mutationPhase, matchLiteral: selectedEvent.preview, replacementLiteral, mutationConfirmed: true };
    setMutationConfirmed(false); setReplacementLiteral('');
    onError?.('');
    setBusy('mutation.set'); setNotice('일회성 literal 변경 규칙 등록 중…');
    try {
      const value = await transport.call<unknown>('mutation.set', request, 15_000);
      if (!mountedRef.current) return;
      setNotice('다음 literal 일치 1회에만 적용됩니다. 실행 후 규칙은 자동 폐기됩니다.');
      onCompleted?.('일회성 변경 규칙 등록', value);
    } catch (error) { fail(error); }
    finally { if (mountedRef.current) setBusy(null); }
  };

  return <div className={`runtime-hook-panel ${compact ? 'compact' : ''}`} aria-busy={busy !== null}>
    <section className="runtime-hook-setup" aria-labelledby="runtime-hook-setup-title">
      <div className="workbench-engine"><span className={`status-dot ${running ? 'ok' : 'off'}`} /><div><b id="runtime-hook-setup-title">WebCrypto Runtime Observer</b><small>{running ? `세션 ${session.sessionId.slice(0, 12)}… 관찰 중` : '세션 없음 · 기본값은 metadata-only'}</small></div><Badge tone={running ? 'ok' : 'default'}>{running ? 'LIVE' : 'IDLE'}</Badge></div>
      <fieldset disabled={inputsLocked} className="runtime-hook-fieldset">
        <label className="field"><span>허가된 HTTPS 대상 URL</span><Input autoFocus value={targetUrl} onChange={(event) => { setTargetUrl(event.target.value); setAuthorized(false); setPlaintextConfirmed(false); setStateChangingConfirmed(false); }} placeholder="https://app.example.com" inputMode="url" autoCapitalize="none" spellCheck={false} /></label>
        <label className="field"><span>JavaScript 붙여넣기 · 오프라인 분석</span><textarea className="input workbench-textarea runtime-source" value={sourceText} onChange={(event) => { setSourceText(event.target.value); setCandidates([]); setAuthorized(false); }} placeholder="// 번들 또는 관련 함수 소스 (최대 256KiB)" spellCheck={false} autoComplete="off" autoCapitalize="none" autoCorrect="off" /><small className="field-hint">붙여넣은 텍스트만 로컬 분석하며 코드를 실행하거나 대상에 요청하지 않습니다.</small></label>
        <div className="runtime-hook-actions"><Button type="button" variant="ghost" onClick={() => void analyze()} disabled={!sourceText.trim() || !authorized}>{busy === 'analyze' ? '분석 중…' : '오프라인 후보 분석'}</Button></div>
        {candidates.length > 0 && <div className="runtime-candidates"><div className="runtime-candidates-heading"><b>오프라인 탐지 후보 {candidates.length}개</b><small>실행 계측은 후보 선택과 무관하게 WebCrypto 고정 범위만 사용합니다.</small></div><div role="list" aria-label="오프라인 WebCrypto 탐지 후보">{candidates.map((candidate, index) => <article key={`${candidate.operation}:${candidate.line}:${candidate.column}:${index}`} role="listitem"><span>{candidate.api}</span><b>{candidate.operation}</b><small>{candidate.line > 0 ? `${candidate.line}:${candidate.column} · ` : ''}신뢰도 {candidate.confidence === 'high' ? '높음' : '보통'}</small></article>)}</div></div>}
        <aside className="runtime-safe-recommendations" aria-labelledby="runtime-safe-recommendations-title"><div><b id="runtime-safe-recommendations-title">기본 추천 경계</b><small>소스 없이도 안전한 WebCrypto 지점만 안내합니다.</small></div><div role="list"><article role="listitem"><code>crypto.subtle.encrypt</code><b>암호화 직전 입력</b><small>메타데이터 기본 · 평문은 명시적 opt-in</small></article><article role="listitem"><code>crypto.subtle.decrypt</code><b>복호화 Promise 완료 출력</b><small>결과가 resolve된 직후만 관찰</small></article><article role="listitem"><code>TextEncoder / TextDecoder</code><b>오프라인 후보만</b><small>실행 후킹 대상으로는 자동 선택하지 않음</small></article></div><p>임의 라이브러리, DOM, 키보드 훅은 추천하거나 실행하지 않습니다.</p></aside>
        <label className="workbench-authorization"><input type="checkbox" checked={authorized} onChange={(event) => { setAuthorized(event.target.checked); if (!event.target.checked) { setPlaintextConfirmed(false); setStateChangingConfirmed(false); } }} /><span><b>대상 또는 붙여넣은 코드에 대한 분석·관찰 권한이 있습니다.</b><small>선택한 단일 URL과 허가 도메인 경계 밖에서는 세션을 시작하지 않습니다.</small></span></label>
        <label className="runtime-privacy-option"><input type="checkbox" checked={plaintextEnabled} onChange={(event) => { setPlaintextEnabled(event.target.checked); if (!event.target.checked) setPlaintextConfirmed(false); }} /><span><b>평문 미리보기 사용</b><small>끄면 알고리즘·길이·호출 시각 같은 메타데이터만 기록합니다.</small></span></label>
        {plaintextEnabled && <label className="workbench-authorization danger"><input type="checkbox" checked={plaintextConfirmed} onChange={(event) => setPlaintextConfirmed(event.target.checked)} /><span><b>평문에 비밀번호·토큰·개인정보가 나타날 수 있음을 확인했습니다.</b><small>미리보기는 이벤트당 최대 128바이트이며 브라우저 저장소에 보관하지 않습니다.</small></span></label>}
        <div className="runtime-request-policy"><b>브라우저 요청 정책</b><span>기본은 같은 출처의 GET·HEAD·OPTIONS만 허용합니다. 10초 세션의 모든 요청은 물리 요청 20회 상한에 포함되며 DELETE는 항상 차단됩니다.</span></div>
        <label className="runtime-privacy-option"><input type="checkbox" checked={stateChangingEnabled} disabled={!mutationGloballyEnabled} onChange={(event) => { setStateChangingEnabled(event.target.checked); if (!event.target.checked) setStateChangingConfirmed(false); }} /><span><b>POST·PUT·PATCH 상태 변경 요청 허용</b><small>{mutationGloballyEnabled ? '대상 애플리케이션의 데이터나 서버 상태가 실제로 바뀔 수 있습니다.' : '관리자가 포털의 런타임·상태 변경을 비활성화했습니다.'}</small></span></label>
        {stateChangingEnabled && <label className="workbench-authorization danger"><input type="checkbox" checked={stateChangingConfirmed} onChange={(event) => setStateChangingConfirmed(event.target.checked)} /><span><b>상태 변경 요청이 실행될 수 있음을 확인했습니다.</b><small>평문 변경 규칙과 함께 쓰면 변형된 값이 서버에 전송될 수 있습니다. DELETE는 이 승인과 무관하게 차단됩니다.</small></span></label>}
      </fieldset>
      <div className="runtime-session-actions"><Button variant="accent" disabled={inputsLocked || !authorized || (plaintextEnabled && !plaintextConfirmed) || (stateChangingEnabled && (!stateChangingConfirmed || !mutationGloballyEnabled))} onClick={() => void start()}>{busy === 'observe' ? '시작 중…' : '관찰 시작'}</Button><Button variant="danger" disabled={!running || busy !== null} onClick={() => void stop()}>{busy === 'stop' ? '중지 중…' : '세션 중지'}</Button></div>
      {notice && <div className="runtime-hook-notice" role="status" aria-live="polite">{notice}</div>}
    </section>
    <section className="runtime-event-workspace" aria-labelledby="runtime-events-title">
      <header><div><span>EVENT RING</span><b id="runtime-events-title">최근 이벤트 {events.length} / {EVENT_RING_SIZE}</b></div><Badge>{session?.captureMode === 'plaintext' ? '평문 opt-in' : 'metadata-only'}</Badge></header>
      <div className="runtime-event-layout">
        <div className="runtime-event-list" aria-label="런타임 이벤트">{events.length === 0 ? <p>수집된 이벤트가 없습니다.</p> : events.map((event) => <button type="button" key={event.sequence} aria-pressed={selectedSequence === event.sequence} className={selectedSequence === event.sequence ? 'active' : ''} onClick={() => { setSelectedSequence(event.sequence); setMutationPhase(event.phase === 'decrypt-output' ? 'decrypt-output' : 'encrypt-input'); setReplacementLiteral(''); setMutationConfirmed(false); }}><time>+{event.elapsedMs}ms</time><b>{event.operation}</b><span>{event.algorithm} · {event.byteLength}B</span><Badge tone={event.mutationApplied ? 'error' : event.preview === undefined ? 'default' : 'warn'}>{event.mutationApplied ? 'MUTATED' : event.preview === undefined ? 'META' : 'PLAIN'}</Badge></button>)}</div>
        <div className="runtime-event-detail">{selectedEvent ? <>
          <div className="plugin-detail-facts"><span><b>단계</b>{selectedEvent.phase}</span><span><b>작업</b>{selectedEvent.operation}</span><span><b>알고리즘</b>{selectedEvent.algorithm}</span><span><b>크기</b>{selectedEvent.byteLength}B</span><span><b>경과</b>{selectedEvent.elapsedMs}ms</span><span><b>변경</b>{selectedEvent.mutationApplied ? '적용됨' : '없음'}</span></div>
          {selectedEvent.preview !== undefined ? <div className="runtime-mutation-editor">
            <div className="runtime-plaintext-preview"><span>선택 이벤트 평문{selectedEvent.previewTruncated ? ' · 잘림' : ''}</span><code>{selectedEvent.preview}</code></div>
            <label className="field"><span>다음 일치 1회 치환값</span><textarea className="input workbench-textarea" value={replacementLiteral} disabled={!running || busy !== null || mutationSourceBlocked} onChange={(event) => { setReplacementLiteral(event.target.value); setMutationConfirmed(false); }} spellCheck={false} autoComplete="off" autoCapitalize="none" autoCorrect="off" /><small className="field-hint" role="status" aria-live="polite">UTF-8 {replacementBytes}/64B · {replacementBytes === 0 ? '1바이트 이상 입력' : replacementBytes > MUTATION_LITERAL_MAX_BYTES ? `${replacementBytes - MUTATION_LITERAL_MAX_BYTES}B 초과` : replacementLiteral === selectedEvent.preview ? '원문과 다른 값이 필요' : '사용 가능'}</small></label>
            {mutationSourceBlocked && <div className="dependency-warning">{selectedEvent.previewTruncated ? '잘린' : 'UTF-8 64바이트를 넘는'} 미리보기는 정확한 literal 규칙으로 사용할 수 없어 편집을 차단했습니다.</div>}
            <label className="field"><span>적용 단계</span><Select value={mutationPhase} disabled={!running || busy !== null || mutationSourceBlocked} onChange={(event) => { setMutationPhase(event.target.value as 'encrypt-input' | 'decrypt-output'); setMutationConfirmed(false); }}><option value="encrypt-input">암호화 입력</option><option value="decrypt-output">복호화 출력</option></Select></label>
            {stateChangingEnabled && <div className="dependency-warning"><b>서버 상태 변경 가능</b><br />이 세션은 POST·PUT·PATCH가 허용되어 다음 일치 변경값이 서버로 전송될 수 있습니다.</div>}
            {mutationGloballyEnabled ? <><label className="workbench-authorization danger"><input type="checkbox" checked={mutationConfirmed} disabled={!running || busy !== null || mutationSourceBlocked || !replacementValid} onChange={(event) => setMutationConfirmed(event.target.checked)} /><span><b>다음 literal 일치 1회 변경을 승인합니다.</b><small>이미 기록된 이벤트는 바뀌지 않으며 한 번 적용된 규칙은 즉시 폐기됩니다.</small></span></label><Button variant="danger" disabled={!running || busy !== null || !mutationConfirmed || mutationSourceBlocked || !replacementValid} onClick={() => void armMutation()}>{busy === 'mutation.set' ? '등록 중…' : '다음 일치 1회 적용'}</Button></> : <div className="dependency-warning">관리자가 포털 런타임 변경을 비활성화했습니다. 관찰만 사용할 수 있습니다.</div>}
          </div> : <div className="runtime-metadata-only"><b>평문은 기록되지 않았습니다.</b><p>metadata-only 기본 세션입니다. 새 세션에서만 평문 미리보기를 명시적으로 켤 수 있습니다.</p></div>}
        </> : <div className="workbench-empty-result"><span>◎</span><div><b>이벤트를 선택하세요</b><small>이벤트 링의 항목을 선택하면 메타데이터와 허용된 평문 미리보기를 확인할 수 있습니다.</small></div></div>}</div>
      </div>
    </section>
  </div>;
}
