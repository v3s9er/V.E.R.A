import { useCallback, useMemo, useState, useEffect, type FormEvent } from 'react';
import { Badge, Button, Input, Select } from './components/ui';
import { RuntimeHookPanel, type RuntimeHookTransport } from './components/RuntimeHookPanel';
import { ToolPortalHttpClient } from './tool-portal-client';
import { TOOL_PORTAL_ROUTES, type ToolPortalRouteId, type ToolPortalSession } from './tool-portal-contract';
import './ToolPortal.css';

const PORTAL_HAR_MAX_BYTES = 512 * 1024;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function publicResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicResult);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'artifactToken' && key !== 'outputPath')
    .map(([key, item]) => [key, publicResult(item)]));
}

function PortalResult({ value }: { value: unknown }) {
  if (value === null) return <div className="portal-empty"><span>◇</span><b>아직 결과가 없습니다.</b><small>입력과 승인 범위를 확인한 뒤 작업을 실행하세요.</small></div>;
  return <section className="portal-result" aria-labelledby="portal-result-title"><header><span>RESULT</span><b id="portal-result-title">최근 실행 결과</b></header><p className="portal-result-announcement" role="status" aria-live="polite">새 도구 실행 결과가 준비되었습니다.</p><pre tabIndex={0} aria-label="최근 도구 실행 결과 JSON">{JSON.stringify(publicResult(value), null, 2)}</pre></section>;
}

function PortalResourceTool({ api, onResult, onError }: { api: ToolPortalHttpClient; onResult: (value: unknown) => void; onError: (message: string) => void }) {
  const [pageUrl, setPageUrl] = useState('');
  const [harText, setHarText] = useState('');
  const [allowedHosts, setAllowedHosts] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [archiveConfirmed, setArchiveConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [artifact, setArtifact] = useState<{ artifactToken: string; fileName: string; summary: unknown } | null>(null);

  const requestParams = (networkRequestLimit: 0 | 20): Record<string, unknown> | null => {
    let target: URL;
    try { target = new URL(pageUrl.trim()); } catch { onError('올바른 HTTP(S) 페이지 URL을 입력하세요.'); return null; }
    if (!authorized || !['http:', 'https:'].includes(target.protocol) || target.username || target.password) { onError('자격증명 없는 허가된 HTTP(S) URL만 사용할 수 있습니다.'); return null; }
    if (new Blob([harText]).size > PORTAL_HAR_MAX_BYTES) { onError('포털 HAR 입력은 512KiB 이하여야 합니다.'); return null; }
    let har: Record<string, unknown> | undefined;
    if (harText.trim()) {
      try { har = asRecord(JSON.parse(harText)); } catch { onError('HAR JSON 문법을 확인하세요.'); return null; }
    }
    const hosts = allowedHosts.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
    if (hosts.some((host) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(host))) { onError('교차 출처는 와일드카드·포트 없는 정확한 DNS 호스트만 입력하세요.'); return null; }
    return {
      authorizationConfirmed: true,
      pageUrl: target.href,
      ...(har ? { har } : {}),
      fetchMissing: networkRequestLimit > 0,
      discoverDependencies: true,
      rewriteOfflineLinks: true,
      allowedCrossOriginHosts: hosts,
      limits: { maxResources: 100, maxResourceBytes: 2 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024, maxDepth: 1, concurrency: 1, timeoutMs: 5_000, retries: 0, maxRedirects: networkRequestLimit > 0 ? 2 : 0, maxNetworkRequests: networkRequestLimit, overallTimeoutMs: 30_000 },
    };
  };

  const preview = async (): Promise<void> => {
    if (busy) return;
    const params = requestParams(0);
    if (!params) return;
    setAuthorized(false);
    setBusy(true); onError('');
    try {
      const value = await api.call('resource-archiver', 'preview', params, { timeoutMs: 35_000 });
      onResult(value);
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const archive = async (): Promise<void> => {
    if (busy || !archiveConfirmed) return;
    const params = requestParams(20);
    if (!params) return;
    setAuthorized(false); setArchiveConfirmed(false);
    setBusy(true); setArtifact(null); onError('');
    try {
      const value = await api.call<unknown>('resource-archiver', 'archive', params, { timeoutMs: 72_000 });
      const payload = asRecord(value);
      if (typeof payload.artifactToken !== 'string' || !/^[A-Za-z0-9_-]{20,512}$/.test(payload.artifactToken)) throw new Error('ZIP 다운로드 토큰을 받지 못했습니다.');
      const fileName = typeof payload.fileName === 'string' ? payload.fileName.replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0, 180) : 'resource-archive.zip';
      const next = { artifactToken: payload.artifactToken, fileName, summary: payload.summary ?? {} };
      setArtifact(next);
      setArchiveConfirmed(false);
      onResult({ status: 'ready-for-download', fileName, summary: next.summary });
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const download = async (): Promise<void> => {
    if (busy || !artifact) return;
    setBusy(true); onError('');
    try {
      const downloaded = await api.downloadArtifact(artifact.artifactToken, { timeoutMs: 30_000 });
      const objectUrl = URL.createObjectURL(downloaded.blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = downloaded.fileName;
      anchor.rel = 'noopener';
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      onResult({ status: 'downloaded', fileName: downloaded.fileName, summary: artifact.summary });
      setArtifact(null);
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const invalidateArtifact = (): void => { setArtifact(null); setArchiveConfirmed(false); };
  const invalidateScopeApproval = (): void => { invalidateArtifact(); setAuthorized(false); };

  return <div className="portal-tool-form" aria-busy={busy}>
    <div className="portal-tool-intro"><div><span>OFFLINE-FIRST</span><h2>Resource Archiver</h2><p>512KiB 이하 HAR를 사전 점검하고, 허가된 대상을 저트래픽 ZIP으로 보관합니다.</p></div><Badge tone="ok">미리보기 0회</Badge></div>
    <fieldset disabled={busy}>
      <label className="field"><span>페이지 URL</span><Input autoFocus value={pageUrl} onChange={(event) => { setPageUrl(event.target.value); invalidateScopeApproval(); }} placeholder="https://example.com" autoCapitalize="none" spellCheck={false} /></label>
      <label className="field"><span>HAR JSON · 선택 · 최대 512KiB</span><textarea className="input portal-code" value={harText} onChange={(event) => { setHarText(event.target.value); invalidateScopeApproval(); }} placeholder={'{\n  "log": { "entries": [] }\n}'} spellCheck={false} autoComplete="off" autoCapitalize="none" autoCorrect="off" /></label>
      <label className="field"><span>교차 출처 허용 DNS · 선택</span><Input value={allowedHosts} onChange={(event) => { setAllowedHosts(event.target.value); invalidateScopeApproval(); }} placeholder="cdn.example.com" autoCapitalize="none" spellCheck={false} /></label>
      <label className="portal-confirm"><input type="checkbox" checked={authorized} onChange={(event) => { setAuthorized(event.target.checked); invalidateArtifact(); }} /><span><b>이 페이지와 HAR을 분석·보관할 권한이 있습니다.</b><small>미리보기는 요청 0회이며, ZIP 보관은 유실 자원에 한해 요청 최대 20회를 사용합니다.</small></span></label>
      <label className="portal-confirm danger"><input type="checkbox" checked={archiveConfirmed} onChange={(event) => setArchiveConfirmed(event.target.checked)} /><span><b>ZIP 보관이 네트워크 요청과 일회용 다운로드를 생성함을 확인합니다.</b><small>동시성 1·재시도 0·총 8MiB 한도로 실행됩니다.</small></span></label>
    </fieldset>
    <div className="portal-actions"><Button variant="ghost" disabled={busy || !authorized} onClick={() => void preview()}>{busy ? '처리 중…' : '오프라인 사전 점검'}</Button><Button variant="accent" disabled={busy || !authorized || !archiveConfirmed} onClick={() => void archive()}>{busy ? '보관 중…' : 'ZIP 보관'}</Button>{artifact && <Button variant="accent" disabled={busy} onClick={() => void download()}>{busy ? '다운로드 중…' : `ZIP 다운로드 · ${artifact.fileName}`}</Button>}<span>다운로드 토큰은 화면에 출력되지 않고 2분 내 1회만 사용됩니다.</span></div>
  </div>;
}

function PortalSslTool({ api, onResult, onError }: { api: ToolPortalHttpClient; onResult: (value: unknown) => void; onError: (message: string) => void }) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState(443);
  const [mode, setMode] = useState<'quick' | 'standard'>('quick');
  const [authorized, setAuthorized] = useState(false);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const prepare = (event: FormEvent): void => { event.preventDefault(); if (authorized && host.trim()) setPending(true); else onError('허가된 단일 호스트를 입력하고 권한을 확인하세요.'); };
  const scan = async (): Promise<void> => {
    if (busy || !pending) return;
    setAuthorized(false); setPending(false);
    setBusy(true); onError('');
    try {
      const value = await api.call('sslscan', 'scan', { host: host.trim(), port, authorizationConfirmed: true, scanMode: mode, maxCipherTests: mode === 'quick' ? 0 : 12, timeoutMs: 2_500, overallTimeoutMs: mode === 'quick' ? 20_000 : 40_000 }, { timeoutMs: mode === 'quick' ? 30_000 : 50_000 });
      onResult(value);
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <form className="portal-tool-form" aria-busy={busy} onSubmit={prepare}>
    <div className="portal-tool-intro"><div><span>LOW TRAFFIC</span><h2>TLS Inspector</h2><p>독립 TLS 엔진으로 허가된 단일 호스트만 제한 점검합니다.</p></div><Badge tone="accent">{mode === 'quick' ? '4 연결' : '최대 16 연결'}</Badge></div>
    <fieldset disabled={busy} className="portal-grid"><label className="field"><span>단일 호스트</span><Input autoFocus value={host} onChange={(event) => { setHost(event.target.value); setPending(false); setAuthorized(false); }} placeholder="example.com" autoCapitalize="none" spellCheck={false} /></label><label className="field"><span>포트</span><Select value={port} onChange={(event) => { setPort(Number(event.target.value)); setPending(false); setAuthorized(false); }}><option value={443}>443</option><option value={8443}>8443</option><option value={9443}>9443</option></Select></label><label className="field"><span>강도</span><Select value={mode} onChange={(event) => { setMode(event.target.value as 'quick' | 'standard'); setPending(false); setAuthorized(false); }}><option value="quick">빠른 점검 · 암호군 0</option><option value="standard">표준 점검 · 암호군 12</option></Select></label></fieldset>
    <label className="portal-confirm"><input type="checkbox" checked={authorized} disabled={busy} onChange={(event) => { setAuthorized(event.target.checked); setPending(false); }} /><span><b>이 호스트를 소유했거나 TLS 점검 허가를 받았습니다.</b><small>취약점 exploit과 HTTP 요청은 보내지 않습니다.</small></span></label>
    {pending && <div className="portal-danger" role="group" aria-label="TLS 점검 최종 확인"><div><b>{host}:{port} 점검을 실행할까요?</b><small>{mode === 'quick' ? 'TLS 버전 4회와 인증서만 확인' : 'TLS 버전과 암호군 최대 12개 확인'}</small></div><Button autoFocus type="button" variant="danger" onClick={() => void scan()} disabled={busy}>{busy ? '점검 중…' : '확인하고 실행'}</Button></div>}
    <div className="portal-actions"><Button type="submit" variant="accent" disabled={busy || !authorized}>점검 준비</Button></div>
  </form>;
}

export function ToolPortal({ initialTool }: { initialTool: ToolPortalRouteId }) {
  const [tool, setTool] = useState<ToolPortalRouteId>(initialTool);
  const [session, setSession] = useState<ToolPortalSession | null>(null);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [activeRequests, setActiveRequests] = useState(0);
  const [runtimeRunning, setRuntimeRunning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<unknown>(null);
  const invalidateSession = useCallback((message: string): void => {
    setSession((current) => ({ authenticated: false, enabled: current?.enabled !== false }));
    setPassword('');
    setResult(null);
    setError(message);
    setLoading(false);
  }, []);
  const api = useMemo(() => new ToolPortalHttpClient(
    () => invalidateSession('포털 세션이 만료되었거나 관리자에 의해 폐기되었습니다. 다시 로그인하세요.'),
    setActiveRequests,
  ), [invalidateSession]);
  const portalBusy = busy || activeRequests > 0 || runtimeRunning;

  useEffect(() => {
    let alive = true;
    void api.session().then((value) => { if (alive) setSession(value); }).catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api]);

  useEffect(() => () => api.abortAll('도구 포털 페이지가 닫혔습니다.'), [api]);

  useEffect(() => {
    if (!session?.authenticated) return;
    const serverRemaining = typeof session.expiresAt === 'number' ? session.expiresAt - Date.now() : 30 * 60_000;
    const delay = Math.max(0, Math.min(30 * 60_000, serverRemaining));
    const timer = window.setTimeout(() => {
      api.abortAll('도구 포털 세션이 만료되었습니다.');
      api.forgetSessionProof();
      invalidateSession('포털 세션이 만료되었습니다. 다시 로그인하세요.');
    }, delay);
    return () => window.clearTimeout(timer);
  }, [api, invalidateSession, session?.authenticated, session?.expiresAt]);

  const login = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (portalBusy || !password) return;
    setBusy(true); setError('');
    const submittedPassword = password;
    setPassword('');
    try { setSession(await api.login(submittedPassword)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const logout = async (): Promise<void> => {
    if (busy) return;
    api.abortAll('도구 포털에서 로그아웃했습니다.');
    setBusy(true); setError('');
    try { await api.logout(); setSession({ authenticated: false, enabled: true }); setResult(null); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const switchTool = (next: ToolPortalRouteId): void => {
    if (portalBusy || next === tool) return;
    setTool(next); setResult(null); setError('');
    window.history.replaceState(null, '', `/tools/${next}`);
  };

  const runtimeTransport = useMemo<RuntimeHookTransport>(() => ({
    call<T>(action: Parameters<RuntimeHookTransport['call']>[0], params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
      return api.call<T>('runtime-hook', action, params, { timeoutMs, background: action === 'status' || action === 'events' });
    },
  }), [api]);

  if (loading) return <main className="tool-portal loading" role="status"><span className="spinner" />보안 포털 확인 중…</main>;
  if (session === null) return <main className="tool-portal unavailable"><div><span>!</span><h1>도구 포털을 확인하지 못했습니다</h1><p>{error || '보안 경계 또는 네트워크 상태를 확인한 뒤 다시 시도하세요.'}</p><Button variant="ghost" onClick={() => window.location.reload()}>다시 확인</Button></div></main>;
  if (!session?.enabled) return <main className="tool-portal unavailable"><div><span>◌</span><h1>도구 포털이 꺼져 있습니다</h1><p>Mr.Robot 네이티브 설정에서 포털과 허가 도메인을 먼저 구성하세요.</p></div></main>;
  if (!session?.authenticated) return <main className="tool-portal login"><form onSubmit={(event) => void login(event)}><div className="portal-brand"><span>✦</span><div><b>Mr.Robot</b><small>SECURE TOOL PORTAL</small></div></div><h1>도구 포털 로그인</h1><p>관리자가 이 포털 전용으로 설정한 비밀번호를 입력하세요.</p><label className="field"><span>포털 비밀번호</span><Input autoFocus type="password" name="portal-access-phrase" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <div className="portal-error" role="alert">{error}</div>}<Button type="submit" variant="accent" disabled={portalBusy || !password}>{busy ? '확인 중…' : '로그인'}</Button><small>비밀번호는 이 탭의 입력 상태에만 머물며 브라우저 저장소·URL·응답 본문에 저장하지 않습니다.</small></form></main>;

  return <main className="tool-portal workspace">
    <header className="portal-header"><div className="portal-brand"><span>✦</span><div><b>Mr.Robot</b><small>{portalBusy ? 'TOOL PORTAL · 작업 중' : 'TOOL PORTAL'}</small></div></div><nav aria-label="포털 도구 전환">{TOOL_PORTAL_ROUTES.map((item) => <button type="button" key={item.routeId} className={tool === item.routeId ? 'active' : ''} aria-current={tool === item.routeId ? 'page' : undefined} disabled={portalBusy} onClick={() => switchTool(item.routeId)}>{item.label}</button>)}</nav><Button variant="ghost" disabled={busy} onClick={() => void logout()}>{busy ? '로그아웃 중…' : activeRequests > 0 ? '취소하고 로그아웃' : '로그아웃'}</Button></header>
    <div className="portal-body"><section className="portal-controls">{tool === 'resource-archiver' ? <PortalResourceTool api={api} onResult={setResult} onError={setError} /> : tool === 'sslscan' ? <PortalSslTool api={api} onResult={setResult} onError={setError} /> : <RuntimeHookPanel compact transport={runtimeTransport} mutationGloballyEnabled={session.hookMutationEnabled === true} onRunningChange={setRuntimeRunning} onCompleted={(_, value) => setResult(value)} onError={setError} />}{error && <div className="portal-error" role="alert">{error}</div>}</section><PortalResult value={result} /></div>
  </main>;
}
