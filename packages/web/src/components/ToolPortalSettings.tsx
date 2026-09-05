import { useEffect, useRef, useState } from 'react';
import type { WorkspaceInfo } from '@mr-robot/shared';
import type { MrRobotClient } from '../rpc';
import { TOOL_PORTAL_ROUTES, TOOL_PORTAL_RPC, type ToolPortalConfigureRequest, type ToolPortalStatus } from '../tool-portal-contract';
import { Badge, Button, Input, Select } from './ui';
import './ToolPortalSettings.css';

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function ToolPortalSettings({ client }: { client: MrRobotClient }) {
  const [status, setStatus] = useState<ToolPortalStatus | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [allowedDomains, setAllowedDomains] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [hookMutationEnabled, setHookMutationEnabled] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [disableConfirmed, setDisableConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const generationRef = useRef(0);
  const passwordBytes = utf8ByteLength(password);
  const passwordSupplied = passwordBytes > 0;
  const passwordRequired = status?.passwordConfigured !== true;
  const passwordWithinLimits = !passwordSupplied || (passwordBytes >= 12 && passwordBytes <= 256);
  const passwordConfirmationMatches = !passwordSupplied || password === passwordConfirm;
  const passwordReady = (!passwordRequired || passwordSupplied) && passwordWithinLimits && passwordConfirmationMatches;

  const load = async (): Promise<void> => {
    const generation = ++generationRef.current;
    setPassword(''); setPasswordConfirm(''); setDisableConfirmed(false);
    setStatus(null); setWorkspaces([]); setBusy(false);
    setLoadState('loading');
    setMessage('포털 설정 불러오는 중…');
    try {
      const [next, workspaceList] = await Promise.all([
        client.call(TOOL_PORTAL_RPC.status, {}) as Promise<ToolPortalStatus>,
        client.call('workspaces.list', {}) as Promise<WorkspaceInfo[]>,
      ]);
      if (generation !== generationRef.current) return;
      setStatus(next);
      setAllowedDomains(next.allowedDomains.join(', '));
      setWorkspaceId(next.workspaceId ?? '');
      setHookMutationEnabled(next.hookMutationEnabled);
      setWorkspaces(workspaceList);
      setLoadState('ready');
      setMessage('');
    } catch (error) {
      if (generation !== generationRef.current) return;
      setStatus(null);
      setLoadState('error');
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    void load();
    return () => { generationRef.current += 1; };
  }, [client]);

  const configure = async (): Promise<void> => {
    if (busy || loadState !== 'ready' || !status) return;
    const domains = [...new Set(allowedDomains.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
    if (domains.some((host) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(host))) {
      setMessage('허가 도메인은 와일드카드·포트·경로 없는 정확한 DNS 이름만 입력하세요.'); return;
    }
    if (passwordRequired && !passwordSupplied) { setMessage('처음 활성화할 때는 UTF-8 12~256바이트의 포털 전용 비밀번호가 필요합니다.'); return; }
    if (!passwordWithinLimits) { setMessage('새 비밀번호는 UTF-8 12~256바이트여야 합니다.'); return; }
    if (!passwordConfirmationMatches) { setMessage('새 비밀번호와 확인 입력이 같아야 합니다.'); return; }
    const request: ToolPortalConfigureRequest = {
      ...(password ? { password } : {}),
      allowedDomains: domains,
      workspaceId: workspaceId || null,
      hookMutationEnabled,
    };
    setPassword(''); setPasswordConfirm('');
    const generation = generationRef.current;
    setBusy(true); setMessage('포털 설정 저장 중…');
    try {
      const next = await client.call(TOOL_PORTAL_RPC.configure, request) as ToolPortalStatus;
      if (generation !== generationRef.current) return;
      setStatus(next);
      setDisableConfirmed(false);
      setMessage('포털 설정을 저장했습니다. 새 비밀번호는 다시 표시되지 않습니다.');
    } catch (error) { if (generation === generationRef.current) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { if (generation === generationRef.current) setBusy(false); }
  };

  const disable = async (): Promise<void> => {
    if (busy || loadState !== 'ready' || !status || !disableConfirmed) return;
    const generation = generationRef.current;
    setBusy(true); setMessage('포털 중지 중…');
    try {
      const next = await client.call(TOOL_PORTAL_RPC.disable, {}) as ToolPortalStatus;
      if (generation !== generationRef.current) return;
      setStatus(next); setDisableConfirmed(false); setPassword(''); setPasswordConfirm('');
      setMessage('도구 포털을 중지하고 활성 세션을 폐기했습니다.');
    } catch (error) { if (generation === generationRef.current) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { if (generation === generationRef.current) setBusy(false); }
  };

  return <div className="portal-settings-stack">
    <section className="portal-settings-status"><div><span className={`status-dot ${loadState === 'ready' && status?.enabled ? 'ok' : 'off'}`} /><div><b>Standalone Tool Portal</b><small>{loadState === 'loading' ? '설정을 안전하게 불러오는 중' : loadState === 'error' ? '설정을 확인하지 못해 변경 기능 잠김' : status?.enabled ? '비밀번호 세션으로 제한된 도구 페이지가 활성화됨' : '기본 OFF · 외부 도구 페이지 비활성'}</small></div></div><Badge tone={loadState === 'ready' && status?.enabled ? 'ok' : 'default'}>{loadState === 'loading' ? '확인 중' : loadState === 'error' ? '오류' : status?.enabled ? '활성' : '꺼짐'}</Badge></section>
    <div className="portal-settings-routes" aria-label="도구 포털 경로">{TOOL_PORTAL_ROUTES.map((item) => <a key={item.routeId} href={`/tools/${item.routeId}`} target="_blank" rel="noreferrer"><span>{item.label}</span><code>/tools/{item.routeId}</code></a>)}</div>
    <div className="form-grid">
      <label className="field"><span>허가 대상 도메인</span><Input value={allowedDomains} disabled={busy || loadState !== 'ready'} onChange={(event) => setAllowedDomains(event.target.value)} placeholder="app.example.com, api.example.com" autoCapitalize="none" spellCheck={false} /><small className="field-hint">정확한 DNS 이름만 쉼표로 구분합니다. 와일드카드·포트·경로는 허용하지 않습니다.</small></label>
      <label className="field"><span>포털 작업 폴더</span><Select value={workspaceId} disabled={busy || loadState !== 'ready'} onChange={(event) => setWorkspaceId(event.target.value)}><option value="">파일 쓰기 없음</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.isDefault ? '기본 · ' : ''}{workspace.name}</option>)}</Select><small className="field-hint">서버가 지원하는 파일 작업도 이 폴더 밖에는 쓸 수 없습니다.</small></label>
      <label className="field"><span>{status?.passwordConfigured ? '새 포털 비밀번호 · 변경할 때만' : '포털 비밀번호'}</span><Input type="password" name="tool-portal-new-password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={password} disabled={busy || loadState !== 'ready'} onChange={(event) => { setPassword(event.target.value); setMessage(''); }} /><small className="field-hint" role="status" aria-live="polite">UTF-8 {passwordBytes}/256B · {passwordBytes === 0 ? (passwordRequired ? '필수' : '변경하지 않으면 빈 값') : passwordBytes < 12 ? `${12 - passwordBytes}B 부족` : passwordBytes > 256 ? `${passwordBytes - 256}B 초과` : '사용 가능'} · 브라우저 저장소에 보관하지 않음</small></label>
      <label className="field"><span>새 비밀번호 확인</span><Input type="password" name="tool-portal-new-password-confirm" autoComplete="off" autoCapitalize="none" spellCheck={false} value={passwordConfirm} disabled={busy || loadState !== 'ready' || !passwordSupplied || !passwordWithinLimits} onChange={(event) => { setPasswordConfirm(event.target.value); setMessage(''); }} /><small className="field-hint" role="status" aria-live="polite">{!passwordSupplied ? '비밀번호를 입력하면 확인할 수 있습니다.' : !passwordWithinLimits ? '먼저 UTF-8 바이트 범위를 맞추세요.' : passwordConfirmationMatches ? '확인 입력이 일치합니다.' : '확인 입력이 일치하지 않습니다.'}</small></label>
    </div>
    <label className="portal-settings-toggle"><input type="checkbox" checked={hookMutationEnabled} disabled={busy || loadState !== 'ready'} onChange={(event) => setHookMutationEnabled(event.target.checked)} /><span><b>포털에서 상태 변경 요청과 일회성 런타임 literal 변경 허용</b><small>POST·PUT·PATCH는 세션별 확인을, literal 변경은 평문 opt-in과 별도의 ‘다음 일치 1회’ 승인을 다시 요구합니다. DELETE는 항상 차단되며 기본값은 관찰 전용입니다.</small></span></label>
    <div className="dependency-warning"><b>인증 경계</b><br />포털은 HttpOnly 세션 쿠키와 같은 출처의 좁은 HTTP API만 사용합니다. 관리자 secret과 WebSocket 인증 토큰은 포털 페이지나 응답에 노출되지 않습니다.</div>
    {message && <div className="portal-settings-message" role={loadState === 'error' ? 'alert' : 'status'} aria-live="polite">{message}</div>}
    <div className="portal-settings-actions">{loadState === 'error' && <Button variant="ghost" disabled={busy} onClick={() => void load()}>설정 다시 불러오기</Button>}<Button variant="accent" disabled={busy || loadState !== 'ready' || !passwordReady} onClick={() => void configure()}>{busy ? '처리 중…' : status?.enabled ? '설정 저장' : '설정하고 포털 활성화'}</Button>{loadState === 'ready' && status?.enabled && <><label><input type="checkbox" checked={disableConfirmed} disabled={busy} onChange={(event) => setDisableConfirmed(event.target.checked)} /> 활성 세션 폐기 확인</label><Button variant="danger" disabled={busy || !disableConfirmed} onClick={() => void disable()}>포털 중지</Button></>}</div>
  </div>;
}
