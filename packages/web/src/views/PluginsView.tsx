import { useCallback, useEffect, useState } from 'react';
import type { PluginInfo } from '@mr-robot/shared';
import { useMrRobot } from '../state';
import { Badge, Button, Card, Input, Select } from '../components/ui';

interface OrcaConfig {
  enabled: boolean;
  command: string;
  defaultAgent: 'codex' | 'claude';
  defaultRepo: string;
  setup: 'run' | 'skip' | 'inherit';
  autoOpen: boolean;
}

interface OrcaStatus {
  installed: boolean;
  runtimeConnected: boolean;
  version?: string;
  error?: string;
  runtimeError?: string;
}
interface VoiceConfig { enabled: boolean; wakePhrase: string; language: string; pcPriorityMs: number; audibleReply: boolean; sensitivity: number }
const KIND_LABEL: Record<string, string> = { integration: '연동', transport: '연결', tool: '도구', workflow: '워크플로', input: '입력' };

export function PluginsView() {
  const { client } = useMrRobot();
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [callResult, setCallResult] = useState('');
  const [orcaConfig, setOrcaConfig] = useState<OrcaConfig | null>(null);
  const [orcaStatus, setOrcaStatus] = useState<OrcaStatus | null>(null);
  const [orcaBusy, setOrcaBusy] = useState(false);
  const [details, setDetails] = useState<Record<string, unknown>>({});
  const [mcpId, setMcpId] = useState('');
  const [mcpCommand, setMcpCommand] = useState('');
  const [mcpArgs, setMcpArgs] = useState('');
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setPlugins((await client.call('plugins.list', {})) as PluginInfo[]);
    } catch {
      /* ignore */
    }
  }, [client]);

  const refreshOrca = useCallback(async (): Promise<void> => {
    setOrcaBusy(true);
    try {
      const status = await client.call('plugins.call', { name: 'orca.status', params: {} }) as OrcaStatus;
      setOrcaStatus(status);
      try {
        const config = await client.call('plugins.call', { name: 'orca.config.get', params: {} }) as OrcaConfig;
        setOrcaConfig(config);
      } catch {
        // A paired non-admin device may inspect status but cannot edit integration settings.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOrcaBusy(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    const off = client.on('plugins.changed', (data) => setPlugins(data as PluginInfo[]));
    return () => off();
  }, [client, refresh]);

  useEffect(() => {
    if (plugins.some((plugin) => plugin.id === 'orca')) void refreshOrca();
    if (plugins.some((plugin) => plugin.id === 'voice-wake')) void client.call('plugins.call', { name: 'voice.config.get', params: {} }).then((value) => setVoiceConfig(value as VoiceConfig)).catch(() => undefined);
  }, [plugins, refreshOrca]);

  const load = async (): Promise<void> => {
    if (!path.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await client.call('plugins.load', { path: path.trim() });
      setPath('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const unload = async (id: string): Promise<void> => {
    try {
      await client.call('plugins.unload', { id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const testCall = async (name: string): Promise<void> => {
    try {
      const result = await client.call('plugins.call', { name, params: { name: 'Mr.Robot' } });
      setCallResult(JSON.stringify(result, null, 2));
    } catch (err) {
      setCallResult(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const pluginCall = async (id: string, name: string, params: unknown = {}): Promise<void> => {
    setBusy(true); setError('');
    try {
      const result = await client.call('plugins.call', { name, params });
      setDetails((current) => ({ ...current, [id]: result }));
      setCallResult(JSON.stringify(result, null, 2));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const addMcp = async (): Promise<void> => {
    if (!mcpId.trim() || !mcpCommand.trim()) return;
    await pluginCall('mcp-host', 'mcp.servers.add', { id: mcpId.trim(), name: mcpId.trim(), command: mcpCommand.trim(), args: mcpArgs.trim() ? mcpArgs.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((value) => value.replace(/^"|"$/g, '')) ?? [] : [] });
    setMcpId(''); setMcpCommand(''); setMcpArgs('');
  };

  const saveOrca = async (): Promise<void> => {
    if (!orcaConfig || orcaBusy) return;
    setOrcaBusy(true); setError('');
    try {
      const saved = await client.call('plugins.call', { name: 'orca.config.set', params: orcaConfig }) as OrcaConfig;
      setOrcaConfig(saved);
      await refreshOrca();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOrcaBusy(false);
    }
  };

  const openOrca = async (): Promise<void> => {
    setOrcaBusy(true); setError('');
    try {
      await client.call('plugins.call', { name: 'orca.open', params: {} });
      window.setTimeout(() => void refreshOrca(), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOrcaBusy(false);
    }
  };

  const enabledCount = plugins.filter((plugin) => plugin.enabled).length;
  const healthyCount = plugins.filter((plugin) => plugin.status === 'loaded').length;

  return (
    <div className="stack plugin-page">
      <section className="plugin-hero panel">
        <div><span className="eyebrow">CAPABILITY LAYER</span><h2>필요한 능력만 연결하세요</h2><p>도구는 모델과 분리되어 있어 끄거나 교체해도 대화와 프로젝트는 그대로 유지됩니다.</p></div>
        <div className="plugin-metrics"><span><b>{enabledCount}</b> 활성</span><span><b>{healthyCount}</b> 정상</span><span><b>{plugins.length}</b> 설치됨</span></div>
      </section>
      <Card className="panel plugin-loader">
        <div className="panel-head">
          <div><h3>로컬 플러그인 추가</h3><p className="panel-hint">폴더 또는 index.js를 연결합니다. 제거할 때 리스너·타이머·명령도 함께 정리됩니다.</p></div>
        </div>
        <div className="type-row">
          <Input
            placeholder="플러그인 경로 (폴더 또는 index.js 파일)"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <Button onClick={() => void load()} disabled={busy || !path.trim()}>
            {busy ? '불러오는 중…' : '불러오기'}
          </Button>
        </div>
        {error && <div className="gate-error">{error}</div>}
        <p className="panel-hint">
          예제: <code>{'<mr-robot 설치폴더>\\examples\\plugins\\hello'}</code> — 플러그인은 언제든 떼어내도 메모리 누수가
          없습니다. (리스너·타이머·명령·모듈 캐시 자동 정리)
        </p>
      </Card>

      {plugins.length === 0 ? (
        <Card className="panel empty">
          <p>불러온 플러그인이 없습니다.</p>
        </Card>
      ) : (
        <div className="plugin-grid">{plugins.map((p) => (
          <Card key={p.id} className={`panel plugin-card ${expanded === p.id ? 'expanded' : ''}`}>
            <div className="plugin-head">
              <div className="plugin-identity">
                <span className="plugin-icon">{p.id === 'orca' ? '⌘' : p.id === 'calendar' ? '◷' : p.id === 'tailscale-connect' ? '↔' : p.id === 'docker-sandbox' ? '▣' : p.id === 'ctf-toolpack' ? '⌁' : p.id === 'mcp-host' ? '◇' : '◉'}</span>
                <div>
                <h3 className="plugin-name">
                  {p.name} <span className="plugin-ver">v{p.version}</span>
                </h3>
                <p className="plugin-desc">{p.description || p.id}</p>
                </div>
              </div>
              <div className="plugin-status"><span className={`status-dot ${p.enabled ? 'ok' : 'off'}`} /><span>{p.enabled ? '사용 중' : '꺼짐'}</span></div>
            </div>
            <div className="plugin-meta">
              <Badge tone="accent">{KIND_LABEL[p.kind] ?? p.kind}</Badge>
              <Badge>{p.builtin ? '기본 모듈' : '사용자 모듈'}</Badge>
              <Badge>명령 {p.commands.length}개</Badge>
            </div>
            <div className="plugin-actions">
              {p.id !== 'voice-wake' && <Button variant={p.enabled ? 'ghost' : 'accent'} onClick={() => void client.call('plugins.setEnabled', { id: p.id, enabled: !p.enabled }).catch((err) => setError(err instanceof Error ? err.message : String(err)))}>{p.enabled ? '끄기' : '켜기'}</Button>}
              <Button variant="ghost" onClick={() => setExpanded((current) => current === p.id ? null : p.id)}>{expanded === p.id ? '설정 닫기' : '설정·상세'}</Button>
              {p.id === 'orca' ? <>
                <Button variant="ghost" onClick={() => void refreshOrca()} disabled={orcaBusy}>상태 확인</Button>
                <Button variant="ghost" onClick={() => void openOrca()} disabled={orcaBusy || orcaStatus?.installed === false}>Orca 열기</Button>
              </> : <>
                {p.commands.filter((command) => command.endsWith('.status')).map((c) => <Button key={c} variant="ghost" onClick={() => void pluginCall(p.id, c)}>상태 확인</Button>)}
                {p.id === 'tailscale-connect' && <Button variant="ghost" onClick={() => void pluginCall(p.id, 'tailscale.peers')}>기기 목록</Button>}
                {p.id === 'docker-sandbox' && <Button onClick={() => void pluginCall(p.id, 'docker.ctf.image.ensure')} disabled={busy}>CTF 이미지 준비</Button>}
                {p.id === 'mcp-host' && <Button variant="ghost" onClick={() => void pluginCall(p.id, 'mcp.servers.list')}>연결 목록</Button>}
              </>}
              {!p.builtin && <Button variant="danger" onClick={() => void unload(p.id)}>
                제거
              </Button>}
            </div>
            {expanded === p.id && <div className="plugin-detail">
            <div className="plugin-detail-facts"><span><b>상태</b>{p.status === 'loaded' ? '정상 로드됨' : p.status}</span><span><b>이벤트</b>구독 {p.subscriptions} · 타이머 {p.timers}</span><span title={p.source}><b>소스</b>{p.source}</span></div>
            {p.capabilities.length > 0 && <div className="plugin-capabilities">{p.capabilities.map((capability) => <span key={capability}>{capability}</span>)}</div>}
            {p.permissions.length > 0 && <p className="panel-hint">권한: {p.permissions.join(' · ')}</p>}
            {p.dependencies.length > 0 && <p className="panel-hint">의존성: {p.dependencies.map((dependency) => `${dependency.name}${dependency.required ? ' (필수)' : ''}`).join(' · ')}</p>}
            {p.id === 'mcp-host' && <div className="provider-add"><h4>MCP stdio 서버 연결</h4><div className="form-grid"><label className="field"><span>서버 ID</span><Input value={mcpId} onChange={(event) => setMcpId(event.target.value)} placeholder="filesystem" /></label><label className="field"><span>실행 명령</span><Input value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} placeholder="npx" /></label><label className="field"><span>인자</span><Input value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem C:\작업" /></label></div><Button onClick={() => void addMcp()} disabled={busy || !mcpId.trim() || !mcpCommand.trim()}>권한 검토 후 연결</Button><p className="panel-hint">MCP 도구 설명은 신뢰되지 않은 입력으로 취급되며 실제 호출은 현재 PC 권한 단계와 승인 절차를 통과합니다.</p></div>}
            {p.id === 'voice-wake' && voiceConfig && <div className="provider-add"><h4>음성 호출</h4><div className="form-grid"><label className="field"><span>호출 키워드 직접 설정</span><Input value={voiceConfig.wakePhrase} onChange={(event) => setVoiceConfig({ ...voiceConfig, wakePhrase: event.target.value })} placeholder="로봇" /></label><label className="field"><span>언어</span><Input value={voiceConfig.language} onChange={(event) => setVoiceConfig({ ...voiceConfig, language: event.target.value })} /></label><label className="field"><span>PC 우선 대기 (ms)</span><Input type="number" min={300} max={3000} value={voiceConfig.pcPriorityMs} onChange={(event) => setVoiceConfig({ ...voiceConfig, pcPriorityMs: Number(event.target.value) })} /></label></div><div className="type-row"><label><input type="checkbox" checked={voiceConfig.enabled} onChange={(event) => setVoiceConfig({ ...voiceConfig, enabled: event.target.checked })} /> “{voiceConfig.wakePhrase || '로봇'}” 상시 대기</label><label><input type="checkbox" checked={voiceConfig.audibleReply !== false} onChange={(event) => setVoiceConfig({ ...voiceConfig, audibleReply: event.target.checked })} /> 음성으로 응답</label><Button onClick={() => void pluginCall(p.id, 'voice.config.set', voiceConfig)}>저장</Button></div><p className="panel-hint">오프라인 호출 감지는 AI 토큰을 사용하지 않습니다. PC와 모바일이 동시에 들으면 PC가 먼저 처리합니다.</p></div>}
            {details[p.id] !== undefined && <pre className="shell-out">{JSON.stringify(details[p.id], null, 2)}</pre>}
            {p.id === 'orca' && orcaConfig && <div className="provider-add">
              <div className="provider-top">
                <Badge tone={orcaStatus?.installed ? 'ok' : 'warn'}>{orcaStatus?.installed ? 'CLI 설치됨' : 'CLI 없음'}</Badge>
                <Badge tone={orcaStatus?.runtimeConnected ? 'ok' : 'warn'}>{orcaStatus?.runtimeConnected ? '런타임 연결됨' : '런타임 꺼짐'}</Badge>
                {orcaStatus?.version && <Badge>{orcaStatus.version}</Badge>}
              </div>
              {(orcaStatus?.error || orcaStatus?.runtimeError) && <p className="panel-hint warn-hint">{orcaStatus.error || orcaStatus.runtimeError}</p>}
              <div className="form-grid">
                <label className="field"><span>Orca 실행 파일</span><Input value={orcaConfig.command} onChange={(event) => setOrcaConfig({ ...orcaConfig, command: event.target.value })} placeholder="orca 또는 C:\\...\\orca.exe" /></label>
                <label className="field"><span>기본 저장소 selector</span><Input value={orcaConfig.defaultRepo} onChange={(event) => setOrcaConfig({ ...orcaConfig, defaultRepo: event.target.value })} placeholder="예: id:repo-id" /></label>
                <label className="field"><span>기본 코딩 에이전트</span><Select value={orcaConfig.defaultAgent} onChange={(event) => setOrcaConfig({ ...orcaConfig, defaultAgent: event.target.value as 'codex' | 'claude' })}><option value="codex">Codex</option><option value="claude">Claude</option></Select></label>
                <label className="field"><span>Worktree setup</span><Select value={orcaConfig.setup} onChange={(event) => setOrcaConfig({ ...orcaConfig, setup: event.target.value as OrcaConfig['setup'] })}><option value="inherit">저장소 설정 따름</option><option value="run">항상 실행</option><option value="skip">건너뛰기</option></Select></label>
              </div>
              <div className="type-row">
                <label><input type="checkbox" checked={orcaConfig.enabled} onChange={(event) => setOrcaConfig({ ...orcaConfig, enabled: event.target.checked })} /> Mr.Robot 코딩 위임 활성화</label>
                <label><input type="checkbox" checked={orcaConfig.autoOpen} onChange={(event) => setOrcaConfig({ ...orcaConfig, autoOpen: event.target.checked })} /> 위임할 때 Orca 자동 실행</label>
                <Button onClick={() => void saveOrca()} disabled={orcaBusy}>{orcaBusy ? '확인 중…' : '저장 및 연결 확인'}</Button>
              </div>
              <p className="panel-hint">코딩 요청에서만 Orca 도구가 모델에 노출됩니다. 작업 위임은 현재 Mr.Robot 권한 정책의 승인을 거친 뒤 새 Git worktree를 만듭니다.</p>
            </div>}
            </div>}
          </Card>
        ))}</div>
      )}

      {callResult && (
        <Card className="panel">
          <div className="panel-head">
            <h3>명령 실행 결과</h3>
          </div>
          <pre className="shell-out">{callResult}</pre>
        </Card>
      )}
    </div>
  );
}
