import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { PluginInfo, WorkspaceInfo } from '@mr-robot/shared';
import type { MrRobotClient } from '../rpc';
import { Badge, Button, Input, Select } from './ui';
import './PluginWorkbench.css';

type WorkbenchResult = { label: string; value: unknown; completedAt: number };

export interface PluginWorkbenchProps {
  plugin: PluginInfo;
  client: MrRobotClient;
  initialResult?: unknown;
  onClose: () => void;
  onResult?: (pluginId: string, value: unknown) => void;
}

interface ResourceArchiveRequest {
  authorizationConfirmed: true;
  pageUrl: string;
  outputPath?: string;
  har?: Record<string, unknown>;
  fetchMissing: boolean;
  discoverDependencies: true;
  rewriteOfflineLinks: true;
  allowedCrossOriginHosts: string[];
  limits: {
    maxResources: number;
    maxResourceBytes: number;
    maxTotalBytes: number;
    maxDepth: number;
    concurrency: number;
    timeoutMs: number;
    retries: number;
    maxRedirects: number;
    maxNetworkRequests: number;
    overallTimeoutMs: number;
  };
}

interface PreparedResourceArchive {
  request: ResourceArchiveRequest;
  revision: number;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
}

type ArchiveMode = 'har-only' | 'direct-bounded';
type SslMode = 'quick' | 'standard';

const HAR_UI_MAX_BYTES = 6 * 1024 * 1024;
const ARCHIVE_OVERALL_TIMEOUT_MS = 60_000;
const SSL_PORTS = [443, 465, 563, 636, 853, 989, 990, 992, 993, 994, 995, 2376, 5061, 8443, 9443] as const;
const BUILTIN_READ_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  calendar: ['calendar.status'],
  'docker-sandbox': ['docker.status'],
  'mcp-host': ['mcp.servers.list'],
  orca: ['orca.status'],
  'remote-link': ['remote-link.status'],
  'tailscale-connect': ['tailscale.status', 'tailscale.peers'],
  'voice-wake': ['voice.status'],
};

interface WorkbenchProgress {
  phase: string;
  percent: number;
  detail?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function formatBytes(value: unknown): string {
  const bytes = asNumber(value);
  if (bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function pluginGlyph(id: string): string {
  if (id === 'resource-archiver') return '⇩';
  if (id === 'sslscan-auditor') return '⌾';
  if (id === 'remote-link') return '☁';
  if (id === 'orca') return '⌘';
  return '◇';
}

function progressFromEvent(value: unknown): WorkbenchProgress | null {
  const event = asRecord(value);
  if (!event) return null;
  const phase = asString(event.phase) ?? asString(event.status) ?? 'running';
  const explicitPercent = asNumber(event.percent);
  const completed = asNumber(event.completed);
  const total = asNumber(event.total);
  const percent = explicitPercent !== undefined
    ? explicitPercent
    : total !== undefined && total > 0 && completed !== undefined ? (completed / total) * 100 : 0;
  return {
    phase,
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    detail: asString(event.detail) ?? asString(event.message) ?? asString(event.target),
  };
}

function progressLabel(phase: string): string {
  const labels: Record<string, string> = {
    validating: '요청 검증', ingesting: '캡처 응답 읽기', fetching: '제한 수집', rewriting: '오프라인 링크 정리',
    packing: 'ZIP 생성', writing: '작업 폴더 저장', complete: '완료', resolving: 'DNS 안전 확인',
    protocols: 'TLS 버전 점검', ciphers: '제한된 암호군 점검', analyzing: '결과 분석', completed: '완료',
    failed: '실패', cancelled: '취소됨', running: '실행 중',
  };
  return labels[phase] ?? phase;
}

function WorkbenchResultView({ result }: { result: WorkbenchResult | null }) {
  if (!result) return (
    <div className="workbench-empty-result">
      <span>◎</span>
      <div><b>아직 실행 결과가 없습니다</b><small>입력값을 검토하고 사전 점검부터 실행하세요.</small></div>
    </div>
  );
  const root = asRecord(result.value);
  const manifest = asRecord(root?.manifest);
  const trafficProfile = asRecord(root?.trafficProfile);
  const protocols = Array.isArray(root?.protocols) ? root.protocols.map(asRecord).filter(Boolean) as Record<string, unknown>[] : [];
  const findings = Array.isArray(root?.findings) ? root.findings.map(asRecord).filter(Boolean) as Record<string, unknown>[] : [];
  const certificate = asRecord(root?.certificate);
  const archiveOutputPath = asString(root?.outputPath);
  const durationMs = asNumber(root?.durationMs);
  const networkRequestsUsed = asNumber(trafficProfile?.requestsUsed) ?? asNumber(manifest?.networkRequestsUsed);
  const networkRequestLimit = asNumber(trafficProfile?.networkRequestLimit);
  const isSsl = protocols.length > 0 || findings.length > 0 || asRecord(root?.scanner)?.id === 'mr-robot.sslscan';
  const isArchive = Boolean(root?.outputPath || manifest || root?.dryRun === true);

  return (
    <section className="workbench-result" aria-live="polite" aria-label="플러그인 실행 결과">
      <header><div><span>RESULT</span><b>{result.label}</b></div><time dateTime={new Date(result.completedAt).toISOString()}>{new Date(result.completedAt).toLocaleTimeString()}</time></header>
      {isArchive && <>
        {root?.dryRun === true && <div className="workbench-result-banner preview"><b>사전 점검 완료</b><span>네트워크 요청 상한 {asNumber(root.networkRequestLimit) ?? 0}회 · 아직 파일이나 네트워크를 변경하지 않았습니다.</span></div>}
        {archiveOutputPath && <div className="workbench-output-path"><span>저장 위치</span><code>{archiveOutputPath}</code></div>}
        {manifest && <div className="workbench-metrics">
          <span><b>{asNumber(manifest.saved) ?? 0}</b>저장</span>
          <span><b>{asNumber(manifest.uniqueBodies) ?? 0}</b>고유 본문</span>
          <span><b>{asNumber(manifest.deduplicated) ?? 0}</b>중복 제거</span>
          <span><b>{formatBytes(manifest.totalDecodedBytes)}</b>본문 합계</span>
          {networkRequestsUsed !== undefined && <span><b>{networkRequestsUsed}{networkRequestLimit !== undefined ? ` / ${networkRequestLimit}` : ''}</b>네트워크 요청</span>}
        </div>}
      </>}
      {isSsl && <>
        <div className="workbench-metrics">
          <span><b>{protocols.filter((item) => item.supported === true).length}</b>지원 TLS</span>
          <span><b>{asNumber(asRecord(root?.cipherProbe)?.tested) ?? 0}</b>암호군 요청</span>
          <span><b>{findings.filter((item) => item.severity !== 'info').length}</b>확인 필요</span>
          <span><b>{durationMs !== undefined ? `${(durationMs / 1000).toFixed(1)}s` : '—'}</b>소요 시간</span>
        </div>
        {protocols.length > 0 && <div className="tls-protocol-row" aria-label="TLS 프로토콜 결과">{protocols.map((item) => {
          const requested = asString(item.requested) ?? 'TLS';
          return <span key={requested} className={item.supported === true ? 'supported' : item.conclusion === 'not-supported' ? 'blocked' : 'unknown'}><b>{requested.replace('TLSv', 'TLS ')}</b>{item.supported === true ? '지원' : item.conclusion === 'not-supported' ? '미지원' : '불확실'}</span>
        })}</div>}
        {certificate && <div className="workbench-certificate"><div><span>인증서 주체</span><b>{asString(certificate.subject) ?? '확인 불가'}</b></div><div><span>유효 기간</span><b>{asString(certificate.validTo) ?? '확인 불가'}</b></div></div>}
        {findings.length > 0 && <div className="workbench-findings">{findings.slice(0, 12).map((item, index) => <article key={`${asString(item.id) ?? 'finding'}-${index}`} data-severity={asString(item.severity) ?? 'info'}><Badge tone={item.severity === 'critical' || item.severity === 'high' ? 'error' : item.severity === 'medium' ? 'warn' : 'default'}>{asString(item.severity) ?? 'info'}</Badge><div><b>{asString(item.title) ?? asString(item.id) ?? '점검 결과'}</b><p>{asString(item.evidence) ?? ''}</p></div></article>)}</div>}
      </>}
      {!isArchive && !isSsl && <pre className="shell-out workbench-json">{safeJson(result.value)}</pre>}
      <details className="workbench-raw"><summary>원본 JSON 보기</summary><pre className="shell-out">{safeJson(result.value)}</pre></details>
    </section>
  );
}

function ResourceArchiverPanel({ client, plugin, onCompleted, setGlobalError }: {
  client: MrRobotClient;
  plugin: PluginInfo;
  onCompleted: (label: string, value: unknown) => void;
  setGlobalError: (message: string) => void;
}) {
  const [pageUrl, setPageUrl] = useState('');
  const [outputPath, setOutputPath] = useState('');
  const [mode, setMode] = useState<ArchiveMode>('har-only');
  const [harText, setHarText] = useState('');
  const [allowedHosts, setAllowedHosts] = useState('');
  const [networkBudget, setNetworkBudget] = useState(40);
  const [authorized, setAuthorized] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [busy, setBusy] = useState<'preview' | 'archive' | null>(null);
  const [pending, setPending] = useState<PreparedResourceArchive | null>(null);
  const formRevisionRef = useRef(0);
  const authorizationRef = useRef(false);
  const workspaceIdRef = useRef('');
  const workspacesRef = useRef<WorkspaceInfo[]>([]);
  const operationActiveRef = useRef(false);

  const invalidatePending = (): void => {
    formRevisionRef.current += 1;
    setPending(null);
  };

  useEffect(() => {
    let live = true;
    const commit = (value: unknown): void => {
      if (!live) return;
      const items = Array.isArray(value) ? value as WorkspaceInfo[] : [];
      const current = workspaceIdRef.current;
      const nextWorkspaceId = current && items.some((item) => item.id === current)
        ? current
        : items.find((item) => item.isDefault)?.id || items[0]?.id || '';
      workspacesRef.current = items;
      workspaceIdRef.current = nextWorkspaceId;
      formRevisionRef.current += 1;
      setPending(null);
      setWorkspaces(items);
      setWorkspaceId(nextWorkspaceId);
    };
    void client.call('workspaces.list', {}).then(commit).catch((error) => setGlobalError(error instanceof Error ? error.message : String(error)));
    const off = client.on('workspaces.changed', commit);
    return () => { live = false; off(); };
  }, [client, setGlobalError]);

  const buildRequest = (): ResourceArchiveRequest => {
    if (!authorized) throw new Error('대상 소유 또는 명시적 보존 허가를 확인하세요.');
    let normalized: URL;
    try { normalized = new URL(pageUrl.trim()); } catch { throw new Error('올바른 HTTP(S) 페이지 URL을 입력하세요.'); }
    if (!['http:', 'https:'].includes(normalized.protocol) || normalized.username || normalized.password) throw new Error('자격증명이 없는 HTTP(S) URL만 사용할 수 있습니다.');
    let har: Record<string, unknown> | undefined;
    if (mode === 'har-only') {
      if (!harText.trim()) throw new Error('트래픽 없이 보존하려면 브라우저에서 내보낸 HAR JSON을 붙여넣으세요.');
      if (new Blob([harText]).size > HAR_UI_MAX_BYTES) throw new Error('앱 전송 여유를 위해 이 화면의 HAR JSON은 6MB 이하여야 합니다.');
      let parsed: unknown;
      try { parsed = JSON.parse(harText); } catch { throw new Error('HAR JSON 문법을 확인하세요.'); }
      har = asRecord(parsed);
      if (!har || !asRecord(har.log) || !Array.isArray(asRecord(har.log)?.entries)) throw new Error('HAR 1.2 log.entries 배열이 필요합니다.');
    }
    const hosts = allowedHosts.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
    if (hosts.some((host) => host.includes('*') || host.includes('/') || host.includes(':') || /\s/.test(host))) throw new Error('추가 호스트는 와일드카드·포트 없이 정확한 DNS 이름만 쉼표로 구분하세요.');
    const direct = mode === 'direct-bounded';
    return {
      authorizationConfirmed: true,
      pageUrl: normalized.href,
      ...(outputPath.trim() ? { outputPath: outputPath.trim() } : {}),
      ...(har ? { har } : {}),
      fetchMissing: direct,
      discoverDependencies: true,
      rewriteOfflineLinks: true,
      allowedCrossOriginHosts: hosts,
      limits: direct
        ? { maxResources: networkBudget, maxResourceBytes: 4 * 1024 * 1024, maxTotalBytes: 24 * 1024 * 1024, maxDepth: 1, concurrency: 2, timeoutMs: 8_000, retries: 0, maxRedirects: 3, maxNetworkRequests: networkBudget, overallTimeoutMs: ARCHIVE_OVERALL_TIMEOUT_MS }
        : { maxResources: 500, maxResourceBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxDepth: 2, concurrency: 1, timeoutMs: 8_000, retries: 0, maxRedirects: 0, maxNetworkRequests: 0, overallTimeoutMs: ARCHIVE_OVERALL_TIMEOUT_MS },
    };
  };

  const isPreparedCurrent = (prepared: PreparedResourceArchive): boolean => {
    const currentWorkspace = workspacesRef.current.find((workspace) => workspace.id === workspaceIdRef.current);
    return authorizationRef.current
      && formRevisionRef.current === prepared.revision
      && workspaceIdRef.current === prepared.workspaceId
      && Boolean(currentWorkspace)
      && currentWorkspace?.name === prepared.workspaceName
      && currentWorkspace?.path === prepared.workspacePath;
  };

  const preview = async (forArchive = false): Promise<PreparedResourceArchive | null> => {
    if (operationActiveRef.current) return null;
    setGlobalError('');
    setPending(null);
    const revision = formRevisionRef.current;
    const previewAuthorized = authorizationRef.current;
    const previewWorkspaceId = workspaceIdRef.current;
    const previewWorkspace = workspacesRef.current.find((workspace) => workspace.id === previewWorkspaceId);
    if (forArchive && (!previewWorkspaceId || !previewWorkspace)) {
      setGlobalError('저장할 작업 폴더를 선택하세요.');
      return null;
    }
    let request: ResourceArchiveRequest;
    try { request = buildRequest(); } catch (error) { setGlobalError(error instanceof Error ? error.message : String(error)); return null; }
    operationActiveRef.current = true;
    setBusy('preview');
    try {
      const command = plugin.commands.includes('resource-archiver.preview') ? 'resource-archiver.preview' : 'resource-archiver.validate';
      const value = await client.call('plugins.call', { name: command, params: request });
      const currentWorkspace = workspacesRef.current.find((workspace) => workspace.id === workspaceIdRef.current);
      if (formRevisionRef.current !== revision
        || !previewAuthorized
        || !authorizationRef.current
        || workspaceIdRef.current !== previewWorkspaceId
        || currentWorkspace?.name !== previewWorkspace?.name
        || currentWorkspace?.path !== previewWorkspace?.path) {
        setGlobalError('사전 점검 중 입력 또는 작업 폴더가 변경되었습니다. 현재 값으로 다시 점검하세요.');
        return null;
      }
      onCompleted('사전 점검', value);
      return {
        request,
        revision,
        workspaceId: previewWorkspaceId,
        workspaceName: previewWorkspace?.name ?? '',
        workspacePath: previewWorkspace?.path ?? '',
      };
    } catch (error) {
      if (formRevisionRef.current === revision) setGlobalError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      operationActiveRef.current = false;
      setBusy(null);
    }
  };

  const requestArchive = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const prepared = await preview(true);
    if (!prepared) return;
    if (!isPreparedCurrent(prepared)) {
      setPending(null);
      setGlobalError('사전 점검 이후 입력 또는 작업 폴더가 변경되었습니다. 다시 점검하세요.');
      return;
    }
    setPending(prepared);
  };

  const archive = async (): Promise<void> => {
    const prepared = pending;
    if (!prepared || operationActiveRef.current) return;
    if (!isPreparedCurrent(prepared)) {
      setPending(null);
      setGlobalError('권한 확인, 입력 또는 작업 폴더가 사전 점검 이후 변경되었습니다. 다시 점검하세요.');
      return;
    }
    operationActiveRef.current = true;
    setBusy('archive');
    setGlobalError('');
    try {
      const value = await client.call('plugins.call', {
        name: 'resource-archiver.archive', params: prepared.request, workspaceId: prepared.workspaceId,
      }, 180_000);
      onCompleted('리소스 보존 완료', value);
      setPending(null);
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : String(error));
    } finally {
      operationActiveRef.current = false;
      setBusy(null);
    }
  };

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const formLocked = busy !== null;
  return (
    <form className="workbench-form" onSubmit={(event) => void requestArchive(event)}>
      <div className="workbench-mode-picker" role="radiogroup" aria-label="리소스 보존 방식">
        <button type="button" role="radio" aria-checked={mode === 'har-only'} className={mode === 'har-only' ? 'active' : ''} disabled={formLocked} onClick={() => { setMode('har-only'); invalidatePending(); }}><span>권장 · 요청 0회</span><b>HAR 응답 보존</b><small>브라우저가 이미 받은 본문만 사용</small></button>
        <button type="button" role="radio" aria-checked={mode === 'direct-bounded'} className={mode === 'direct-bounded' ? 'active' : ''} disabled={formLocked} onClick={() => { setMode('direct-bounded'); invalidatePending(); }}><span>실전 저트래픽</span><b>공개 자산 제한 수집</b><small>GET만 · 재시도 0 · 동시 2개</small></button>
      </div>
      <div className="form-grid">
        <label className="field"><span>페이지 URL</span><Input autoFocus value={pageUrl} disabled={formLocked} onChange={(event) => { setPageUrl(event.target.value); invalidatePending(); }} placeholder="https://example.com/page" inputMode="url" autoCapitalize="none" spellCheck={false} /></label>
        <label className="field"><span>저장할 작업 폴더</span><Select value={workspaceId} onChange={(event) => { workspaceIdRef.current = event.target.value; setWorkspaceId(event.target.value); invalidatePending(); }} disabled={formLocked || workspaces.length === 0}><option value="">작업 폴더를 먼저 연결하세요</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.isDefault ? '기본 · ' : ''}{workspace.name}</option>)}</Select><small className="field-hint">{selectedWorkspace?.path ?? '대화 화면의 컨텍스트에서 작업 폴더를 추가할 수 있습니다.'}</small></label>
        <label className="field"><span>ZIP 상대 경로 · 선택</span><Input value={outputPath} disabled={formLocked} onChange={(event) => { setOutputPath(event.target.value); invalidatePending(); }} placeholder="resource-archives/site.zip" autoCapitalize="none" spellCheck={false} /><small className="field-hint">작업 폴더 밖 경로와 기존 파일 덮어쓰기는 차단됩니다.</small></label>
        <label className="field"><span>허용할 교차 출처 · 선택</span><Input value={allowedHosts} disabled={formLocked} onChange={(event) => { setAllowedHosts(event.target.value); invalidatePending(); }} placeholder="cdn.example.com, static.example.net" autoCapitalize="none" spellCheck={false} /><small className="field-hint">정확한 공개 DNS 호스트만 허용하며 기본값은 같은 호스트뿐입니다.</small></label>
      </div>
      {mode === 'har-only' ? <label className="field"><span>HAR JSON</span><textarea className="input workbench-textarea" value={harText} disabled={formLocked} onChange={(event) => { setHarText(event.target.value); invalidatePending(); }} placeholder={'{\n  "log": { "entries": [ ... ] }\n}'} spellCheck={false} /><small className="field-hint">앱의 8MB IPC 전송 한도에 여유를 두어 HAR JSON은 6MB 이하만 허용합니다. 요청 헤더·쿠키·Authorization은 사용하지 않지만 공유 전 민감정보를 확인하세요.</small></label> : <div className="workbench-budget">
        <label className="field"><span>물리 네트워크 요청 상한</span><Select value={networkBudget} disabled={formLocked} onChange={(event) => { setNetworkBudget(Number(event.target.value)); invalidatePending(); }}><option value={20}>20회 · 최소</option><option value={40}>40회 · 권장</option><option value={80}>80회 · 확장</option></Select></label>
        <p><b>트래픽 가드</b><span>페이지와 1단계 의존성만, GET만, 재시도 없이, 동시 최대 2개로 가져옵니다. 물리 요청은 선택 상한을 넘지 않고 전체 실행은 최대 60초이며, 크기·리디렉션 제한과 사설망 차단도 적용됩니다.</span></p>
      </div>}
      <label className="workbench-authorization"><input type="checkbox" checked={authorized} disabled={formLocked} onChange={(event) => { authorizationRef.current = event.target.checked; setAuthorized(event.target.checked); invalidatePending(); }} /><span><b>이 페이지를 소유했거나 보존할 명시적 허가를 받았습니다.</b><small>로그인 세션이나 우회 자격증명을 사용하지 않으며 허가 범위를 벗어난 수집은 실행하지 않습니다.</small></span></label>
      {pending && <div className="workbench-confirm" role="alert"><div><span>!</span><div className="workbench-confirm-copy"><p><b>마지막 실행 확인</b><small>사전 점검한 아래 값이 정확한지 다시 확인하세요.</small></p><dl className="workbench-confirm-details"><div><dt>대상 URL</dt><dd><code>{pending.request.pageUrl}</code></dd></div><div><dt>수집 방식</dt><dd><b>{pending.request.fetchMissing ? '공개 자산 제한 직접 수집' : 'HAR 응답만 · 네트워크 0회'}</b></dd></div><div><dt>작업 폴더</dt><dd><b>{pending.workspaceName}</b><code>{pending.workspacePath}</code></dd></div><div><dt>ZIP 상대 경로</dt><dd><code>{pending.request.outputPath ?? '자동 생성'}</code></dd></div><div><dt>교차 출처 허용</dt><dd><code>{pending.request.allowedCrossOriginHosts.join(', ') || '없음 · 같은 호스트만'}</code></dd></div><div><dt>물리 네트워크 요청 상한</dt><dd><b>{pending.request.limits.maxNetworkRequests}회</b></dd></div></dl></div></div><div><Button type="button" variant="ghost" disabled={busy !== null} onClick={() => setPending(null)}>취소</Button><Button type="button" variant="danger" disabled={busy !== null} onClick={() => void archive()}>{busy === 'archive' ? '보존 중…' : '확인하고 보존'}</Button></div></div>}
      <div className="workbench-actions"><Button type="button" variant="ghost" disabled={busy !== null || !authorized} onClick={() => void preview(false)}>{busy === 'preview' ? '점검 중…' : '사전 점검만'}</Button><Button type="submit" variant="accent" disabled={busy !== null || !authorized || !workspaceId}>{busy === 'preview' ? '점검 중…' : '보존 준비'}</Button><span>사전 점검은 네트워크·파일을 변경하지 않습니다.</span></div>
    </form>
  );
}

function SslScannerPanel({ client, onCompleted, setGlobalError }: {
  client: MrRobotClient;
  onCompleted: (label: string, value: unknown) => void;
  setGlobalError: (message: string) => void;
}) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState(443);
  const [sni, setSni] = useState('');
  const [mode, setMode] = useState<SslMode>('quick');
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [engine, setEngine] = useState<Record<string, unknown> | null>(null);
  const operationActiveRef = useRef(false);

  useEffect(() => {
    let live = true;
    void client.call('plugins.call', { name: 'sslscan.status', params: {} }).then((value) => {
      if (live) setEngine(asRecord(value) ?? null);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [client]);

  const prepare = (event: FormEvent): void => {
    event.preventDefault();
    setGlobalError('');
    const cleanHost = host.trim();
    const cleanSni = sni.trim();
    const colonCount = [...cleanHost].filter((character) => character === ':').length;
    const ipv6Candidate = colonCount >= 2 && /^[0-9a-f:.]+$/i.test(cleanHost);
    if (!authorized) { setGlobalError('대상 소유 또는 명시적 점검 허가를 확인하세요.'); return; }
    if (!cleanHost || /[/\\@?#,\s]/.test(cleanHost) || cleanHost.includes('..') || (colonCount > 0 && !ipv6Candidate)) { setGlobalError('URL이나 목록이 아닌 단일 호스트 이름 또는 IP를 입력하세요.'); return; }
    if (cleanSni && /[:/\\@?#,\s]/.test(cleanSni)) { setGlobalError('SNI에는 단일 DNS 이름만 입력하세요.'); return; }
    setPending({
      host: cleanHost,
      port,
      ...(cleanSni ? { sni: cleanSni } : {}),
      authorizationConfirmed: true,
      scanMode: mode,
      maxCipherTests: mode === 'quick' ? 0 : 12,
      timeoutMs: 2_500,
      overallTimeoutMs: mode === 'quick' ? 20_000 : 40_000,
    });
  };

  const scan = async (): Promise<void> => {
    if (!pending || operationActiveRef.current) return;
    operationActiveRef.current = true;
    setBusy(true);
    setGlobalError('');
    try {
      const value = await client.call('plugins.call', { name: 'sslscan.scan', params: pending }, 90_000);
      onCompleted('TLS 점검 완료', value);
      setPending(null);
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : String(error));
    } finally {
      operationActiveRef.current = false;
      setBusy(false);
    }
  };

  return (
    <form className="workbench-form" onSubmit={prepare}>
      <div className="workbench-engine"><span className={`status-dot ${engine?.ok === true ? 'ok' : 'off'}`} /><div><b>{asString(engine?.scanner) ?? 'Mr.Robot 독립 TLS 검사기'}</b><small>{asString(engine?.engine) ?? '로컬 TLS 엔진 상태 확인 중…'}</small></div><Badge tone="accent">단일 대상</Badge></div>
      <div className="workbench-mode-picker" role="radiogroup" aria-label="TLS 검사 강도">
        <button type="button" role="radio" aria-checked={mode === 'quick'} className={mode === 'quick' ? 'active' : ''} disabled={busy} onClick={() => { setMode('quick'); setPending(null); }}><span>권장 · 최소 트래픽</span><b>빠른 점검</b><small>TLS 버전 4회 + 인증서 · 암호군 0회</small></button>
        <button type="button" role="radio" aria-checked={mode === 'standard'} className={mode === 'standard' ? 'active' : ''} disabled={busy} onClick={() => { setMode('standard'); setPending(null); }}><span>제한 탐색</span><b>표준 점검</b><small>빠른 점검 + 암호군 최대 12회</small></button>
      </div>
      <div className="form-grid">
        <label className="field"><span>허가된 단일 호스트</span><Input autoFocus value={host} disabled={busy} onChange={(event) => { setHost(event.target.value); setPending(null); }} placeholder="example.com" autoCapitalize="none" spellCheck={false} /><small className="field-hint">URL, CIDR, 여러 대상, 사설·특수 주소는 거부됩니다.</small></label>
        <label className="field"><span>TLS 포트</span><Select value={port} disabled={busy} onChange={(event) => { setPort(Number(event.target.value)); setPending(null); }}>{SSL_PORTS.map((value) => <option key={value} value={value}>{value}</option>)}</Select><small className="field-hint">직접 TLS가 일반적으로 쓰이는 제한된 포트만 제공합니다.</small></label>
        <label className="field"><span>SNI · 선택</span><Input value={sni} disabled={busy} onChange={(event) => { setSni(event.target.value); setPending(null); }} placeholder="보통 비워 둡니다" autoCapitalize="none" spellCheck={false} /><small className="field-hint">IP를 점검하며 인증서 이름을 따로 지정할 때만 사용하세요.</small></label>
      </div>
      <div className="workbench-traffic-summary"><div><b>{mode === 'quick' ? '4' : '최대 16'}</b><span>예상 TLS 연결</span></div><p><b>실전형 트래픽 제어</b><span>동시 암호군 연결 2개 이하, 소켓 2.5초, 전체 {mode === 'quick' ? '20' : '40'}초 제한입니다. 취약점 exploit 패킷이나 HTTP 요청은 보내지 않습니다.</span></p></div>
      <label className="workbench-authorization"><input type="checkbox" checked={authorized} disabled={busy} onChange={(event) => { setAuthorized(event.target.checked); setPending(null); }} /><span><b>이 호스트를 소유했거나 TLS 점검에 대한 명시적 허가를 받았습니다.</b><small>이번 실행은 화면에 입력한 단일 대상과 포트만 검사합니다.</small></span></label>
      {pending && <div className="workbench-confirm" role="alert"><div><span>!</span><p><b>{String(pending.host)}:{String(pending.port)} 실행 확인</b><small>{mode === 'quick' ? '암호군 추가 탐색 없이 TLS 버전과 인증서만 확인합니다.' : 'TLS 버전·인증서와 암호군 최대 12개를 제한 탐색합니다.'}</small></p></div><div><Button type="button" variant="ghost" disabled={busy} onClick={() => setPending(null)}>취소</Button><Button type="button" variant="danger" disabled={busy} onClick={() => void scan()}>{busy ? '점검 중…' : '확인하고 점검'}</Button></div></div>}
      <div className="workbench-actions"><Button type="submit" variant="accent" disabled={busy || !authorized}>{busy ? '점검 중…' : '점검 준비'}</Button><span>실행 전에 대상과 요청 상한을 한 번 더 보여드립니다.</span></div>
    </form>
  );
}

function GenericPluginPanel({ plugin, client, onCompleted, setGlobalError }: {
  plugin: PluginInfo;
  client: MrRobotClient;
  onCompleted: (label: string, value: unknown) => void;
  setGlobalError: (message: string) => void;
}) {
  const [busy, setBusy] = useState('');
  // Command names supplied by a third-party plugin are untrusted. Only exact,
  // reviewed read-only commands on built-ins receive a direct-run button.
  const safeCommands = useMemo(() => plugin.builtin
    ? (BUILTIN_READ_COMMANDS[plugin.id] ?? []).filter((command) => plugin.commands.includes(command))
    : [], [plugin.builtin, plugin.commands, plugin.id]);
  const run = async (command: string): Promise<void> => {
    setBusy(command); setGlobalError('');
    try {
      const value = await client.call('plugins.call', { name: command, params: {} });
      onCompleted(command, value);
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(''); }
  };
  return <div className="workbench-generic"><div className="plugin-detail-facts"><span><b>상태</b>{plugin.status === 'loaded' ? '정상 로드됨' : plugin.status}</span><span><b>이벤트</b>구독 {plugin.subscriptions} · 타이머 {plugin.timers}</span><span title={plugin.source}><b>소스</b>{plugin.source}</span></div>{plugin.capabilities.length > 0 && <div className="plugin-capabilities">{plugin.capabilities.map((capability) => <span key={capability}>{capability}</span>)}</div>}<div className="workbench-command-list"><b>검증된 조회 작업</b>{safeCommands.length > 0 ? <div>{safeCommands.map((command) => <Button key={command} variant="ghost" disabled={Boolean(busy) || !plugin.enabled} onClick={() => void run(command)}>{busy === command ? '확인 중…' : command}</Button>)}</div> : <p>{plugin.builtin ? '이 플러그인에는 매개변수 없이 실행하도록 검증된 조회 작업이 없습니다.' : '사용자 플러그인의 명령 이름은 신뢰하지 않으므로 이 화면에서 직접 실행하지 않습니다.'} 설정형 명령은 아래 목록을 참고해 대화의 승인 절차로 요청하세요.</p>}</div><details className="workbench-raw"><summary>전체 명령 {plugin.commands.length}개</summary><code>{plugin.commands.join('\n') || '등록된 명령 없음'}</code></details></div>;
}

export function PluginWorkbench({ plugin, client, initialResult, onClose, onResult }: PluginWorkbenchProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<WorkbenchResult | null>(initialResult === undefined ? null : { label: '최근 결과', value: initialResult, completedAt: Date.now() });
  const [progress, setProgress] = useState<WorkbenchProgress | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      onClose();
      window.requestAnimationFrame(() => document.getElementById(`plugin-workbench-trigger-${plugin.id}`)?.focus());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, plugin.id]);

  useEffect(() => {
    const eventName = plugin.id === 'resource-archiver'
      ? 'resource-archiver.progress'
      : plugin.id === 'sslscan-auditor' ? 'sslscan-auditor.progress' : '';
    if (!eventName) return;
    const off = client.on(eventName, (value) => setProgress(progressFromEvent(value)));
    return () => { off(); };
  }, [client, plugin.id]);

  const completed = (label: string, value: unknown): void => {
    setProgress(null);
    setResult({ label, value, completedAt: Date.now() });
    onResult?.(plugin.id, value);
  };
  const close = (): void => {
    onClose();
    window.requestAnimationFrame(() => document.getElementById(`plugin-workbench-trigger-${plugin.id}`)?.focus());
  };

  return (
    <section className="plugin-workbench" aria-labelledby="plugin-workbench-title">
      <header className="plugin-workbench-head">
        <div className="plugin-workbench-title"><span className="plugin-workbench-glyph" aria-hidden="true">{pluginGlyph(plugin.id)}</span><div><span className="eyebrow">PLUGIN WORKBENCH</span><h3 id="plugin-workbench-title" ref={headingRef} tabIndex={-1}>{plugin.name}</h3><p>{plugin.description}</p></div></div>
        <div className="plugin-workbench-head-actions"><Badge tone={plugin.enabled ? 'ok' : 'warn'}>{plugin.enabled ? '활성' : '꺼짐'}</Badge><Badge>{plugin.category === 'pentest' ? '모의해킹' : plugin.category}</Badge><Button variant="ghost" onClick={close} aria-label={`${plugin.name} 작업 화면 닫기`}>← 목록으로</Button></div>
      </header>
      {!plugin.enabled && <div className="dependency-warning">플러그인이 꺼져 있습니다. 목록에서 켠 뒤 작업을 실행하세요.</div>}
      {progress && <div className="plugin-workbench-progress" role="progressbar" aria-label={`${plugin.name} ${progressLabel(progress.phase)}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}><div><b>{progressLabel(progress.phase)}</b><span>{progress.detail ?? `${progress.percent}%`}</span></div><em>{progress.percent}%</em><i style={{ width: `${progress.percent}%` }} /></div>}
      <div className="plugin-workbench-layout">
        <div className="plugin-workbench-controls">
          {!plugin.enabled
            ? <div className="workbench-disabled"><span>○</span><div><b>작업 화면이 일시 중지되었습니다</b><p>아래 플러그인 목록에서 이 모듈을 켜면 입력과 실행 도구가 나타납니다.</p></div></div>
            : plugin.id === 'resource-archiver'
            ? <ResourceArchiverPanel client={client} plugin={plugin} onCompleted={completed} setGlobalError={setError} />
            : plugin.id === 'sslscan-auditor'
              ? <SslScannerPanel client={client} onCompleted={completed} setGlobalError={setError} />
              : <GenericPluginPanel plugin={plugin} client={client} onCompleted={completed} setGlobalError={setError} />}
          {error && <div className="gate-error workbench-error" role="alert">{error}</div>}
        </div>
        <WorkbenchResultView result={result} />
      </div>
    </section>
  );
}
