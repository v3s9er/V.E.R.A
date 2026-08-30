import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type {
  DependencyInfo,
  DependencyInstallResult,
  PluginInfo,
  RemoteLinkConfig,
  RemoteLinkStatus,
  SystemStatus,
} from '@mr-robot/shared';
import { useMrRobot } from '../state';
import { Badge, Button, Card, Input, Modal, Select } from '../components/ui';

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
interface QuickPairingInfo { pin?: string; pinExpiresAt?: number }
const KIND_LABEL: Record<string, string> = { integration: '연동', transport: '연결', tool: '도구', workflow: '워크플로', input: '입력' };
const DEFAULT_REMOTE_CONFIG: RemoteLinkConfig = {
  provider: 'cloudflare-quick',
  localUrl: 'http://127.0.0.1:8787',
  autoStart: false,
};

export function PluginsView() {
  const { client } = useMrRobot();
  const canManage = client.isAdmin;
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
  const [remoteStatus, setRemoteStatus] = useState<RemoteLinkStatus | null>(null);
  const [remoteConfig, setRemoteConfig] = useState<RemoteLinkConfig>(DEFAULT_REMOTE_CONFIG);
  const [remoteTunnelToken, setRemoteTunnelToken] = useState('');
  const [cloudflared, setCloudflared] = useState<DependencyInfo | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteStage, setRemoteStage] = useState('');
  const [remotePairing, setRemotePairing] = useState<{ pin: string; expiresAt?: number; qrUrl: string } | null>(null);
  const [quickLinkConfirm, setQuickLinkConfirm] = useState<PluginInfo | null>(null);
  const remoteActionRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    remoteActionRef.current = false;
    return () => {
      mountedRef.current = false;
      remoteActionRef.current = true;
    };
  }, []);

  const refreshRemotePairing = useCallback(async (status: RemoteLinkStatus | null): Promise<void> => {
    if (!status?.running || !status.publicUrl) {
      if (mountedRef.current) setRemotePairing(null);
      return;
    }
    const pairing = await client.call('pairing.info', {}) as QuickPairingInfo;
    if (!pairing.pin) {
      if (mountedRef.current) setRemotePairing(null);
      return;
    }
    const payload = JSON.stringify({
      app: 'mr-robot',
      version: 3,
      host: status.publicUrl,
      hosts: [status.publicUrl],
      protocol: 'https',
      port: 443,
      pin: pairing.pin,
    });
    const qrUrl = await QRCode.toDataURL(payload, { width: 220, margin: 1 });
    if (mountedRef.current) setRemotePairing({ pin: pairing.pin, expiresAt: pairing.pinExpiresAt, qrUrl });
  }, [client]);

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

  const refreshRemoteLink = useCallback(async (): Promise<void> => {
    setRemoteBusy(true);
    try {
      const [status, report, system] = await Promise.all([
        client.call('plugins.call', { name: 'remote-link.status', params: {} }) as Promise<RemoteLinkStatus>,
        client.call('dependencies.status', {}) as Promise<{ items: DependencyInfo[] }>,
        client.call('status', {}) as Promise<SystemStatus>,
      ]);
      setRemoteStatus(status);
      setRemoteConfig(status.running
        ? status.config
        : { ...status.config, localUrl: `http://127.0.0.1:${system.network.port}`, autoStart: false });
      setCloudflared(report.items.find((item) => item.id === 'cloudflared') ?? null);
      await refreshRemotePairing(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoteBusy(false);
    }
  }, [client, refreshRemotePairing]);

  useEffect(() => {
    void refresh();
    const off = client.on('plugins.changed', (data) => setPlugins(data as PluginInfo[]));
    const offPairing = client.on('pairing.changed', () => {
      if (canManage) void refreshRemotePairing(remoteStatus).catch(() => setRemotePairing(null));
    });
    return () => { off(); offPairing(); };
  }, [canManage, client, refresh, refreshRemotePairing, remoteStatus]);

  useEffect(() => {
    if (!canManage) return;
    if (plugins.some((plugin) => plugin.id === 'orca')) void refreshOrca();
    if (plugins.some((plugin) => plugin.id === 'voice-wake')) void client.call('plugins.call', { name: 'voice.config.get', params: {} }).then((value) => setVoiceConfig(value as VoiceConfig)).catch(() => undefined);
    if (plugins.some((plugin) => plugin.id === 'remote-link')) void refreshRemoteLink();
  }, [canManage, client, plugins, refreshOrca, refreshRemoteLink]);

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

  const togglePlugin = async (plugin: PluginInfo): Promise<void> => {
    setError('');
    try {
      if (plugin.id === 'remote-link' && plugin.enabled && remoteStatus?.running) {
        await client.call('plugins.call', { name: 'remote-link.stop', params: {} });
      }
      await client.call('plugins.setEnabled', { id: plugin.id, enabled: !plugin.enabled });
      if (plugin.id === 'remote-link') await refreshRemoteLink();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveRemoteLink = async (): Promise<void> => {
    setRemoteBusy(true); setError('');
    try {
      const saved = await client.call('plugins.call', {
        name: 'remote-link.config.set',
        params: { ...remoteConfig, tunnelToken: remoteTunnelToken.trim() || undefined },
      }) as RemoteLinkConfig;
      setRemoteConfig(saved);
      setRemoteTunnelToken('');
      setCallResult(saved.provider === 'cloudflare-named'
        ? 'Cloudflare 고정 Tunnel 설정과 암호화된 자격증명을 저장했습니다.'
        : 'Cloudflare Quick Link 설정을 저장했습니다.');
      await refreshRemoteLink();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoteBusy(false);
    }
  };

  const clearRemoteTunnelToken = async (): Promise<void> => {
    if (remoteBusy || remoteStatus?.running) return;
    setRemoteBusy(true); setError('');
    try {
      const saved = await client.call('plugins.call', {
        name: 'remote-link.config.set',
        params: { ...remoteConfig, clearTunnelToken: true, tunnelToken: undefined },
      }) as RemoteLinkConfig;
      setRemoteConfig(saved);
      setRemoteTunnelToken('');
      setCallResult('이 PC에 저장된 Cloudflare Tunnel 토큰을 삭제했습니다. Cloudflare 대시보드에서 기존 토큰도 회전하거나 폐기하세요.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoteBusy(false);
    }
  };

  const verifyRemoteLink = async (): Promise<void> => {
    if (remoteBusy || !remoteStatus?.running) return;
    setRemoteBusy(true); setError('');
    try {
      const result = await client.call('plugins.call', { name: 'remote-link.verify', params: {} }) as { message?: string };
      setCallResult(result.message || '외부 연결을 확인했습니다.');
      await refreshRemoteLink();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshRemoteLink();
    } finally {
      setRemoteBusy(false);
    }
  };

  const startRemoteLink = async (plugin: PluginInfo): Promise<void> => {
    if (remoteActionRef.current) return;
    remoteActionRef.current = true;
    if (mountedRef.current) {
      setRemoteBusy(true);
      setRemoteStage('사전 상태 확인');
      setError('');
    }
    let stage = '사전 상태 확인';
    let stageNumber = 0;
    let installedByAction = false;
    let enabledByAction = false;
    let configChanged = false;
    let originalConfig: RemoteLinkConfig | null = null;
    const advance = (number: number, label: string): void => {
      stageNumber = number;
      stage = label;
      if (mountedRef.current) setRemoteStage(label);
    };
    try {
      const [initialStatus, dependencyReport] = await Promise.all([
        client.call('plugins.call', { name: 'remote-link.status', params: {} }) as Promise<RemoteLinkStatus>,
        client.call('dependencies.status', {}) as Promise<{ items: DependencyInfo[] }>,
      ]);
      originalConfig = initialStatus.config;
      if (initialStatus.running && initialStatus.publicUrl) {
        if (mountedRef.current) {
          setRemoteStatus(initialStatus);
          setRemoteConfig(initialStatus.config);
        }
        await refreshRemotePairing(initialStatus);
        if (mountedRef.current) setCallResult(`원격 링크가 이미 실행 중입니다: ${initialStatus.publicUrl}`);
        return;
      }

      let dependency = dependencyReport.items.find((item) => item.id === 'cloudflared') ?? null;
      if (!dependency?.installed) {
        advance(1, 'cloudflared 설치');
        const result = await client.call('dependencies.install', { id: 'cloudflared' }) as DependencyInstallResult;
        if (!result.ok) throw new Error(result.output || 'cloudflared 설치 프로그램이 실패했습니다.');
        installedByAction = true;
        const refreshedReport = await client.call('dependencies.status', {}) as { items: DependencyInfo[] };
        dependency = refreshedReport.items.find((item) => item.id === 'cloudflared') ?? null;
        if (!dependency?.installed) throw new Error('설치 명령은 끝났지만 cloudflared 실행 파일을 찾지 못했습니다.');
      }
      if (mountedRef.current) setCloudflared(dependency);

      if (!plugin.enabled) {
        advance(2, '플러그인 활성화');
        await client.call('plugins.setEnabled', { id: plugin.id, enabled: true });
        enabledByAction = true;
      }

      advance(3, '원격 설정 저장');
      configChanged = true;
      await client.call('plugins.call', {
        name: 'remote-link.config.set',
        params: { ...remoteConfig, tunnelToken: remoteTunnelToken.trim() || undefined },
      });
      if (mountedRef.current) setRemoteTunnelToken('');

      advance(4, '암호화 터널 시작');
      const status = await client.call('plugins.call', { name: 'remote-link.start', params: {} }) as RemoteLinkStatus;
      if (!status.running || !status.publicUrl) throw new Error(status.lastError || '터널이 공개 HTTPS 주소를 반환하지 않았습니다.');
      if (mountedRef.current) {
        setRemoteStatus(status);
        setRemoteConfig(status.config);
      }
      advance(5, '모바일 QR 생성');
      await refreshRemotePairing(status);
      advance(6, '외부 주소 확인');
      await client.call('plugins.call', { name: 'remote-link.verify', params: {} });
      if (mountedRef.current) {
        setCallResult(`${status.temporary ? 'Quick Link' : '고정 Tunnel'} 연결 완료: ${status.publicUrl}`);
        setError('');
      }
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const recovery: string[] = [];
      let confirmedStatus: RemoteLinkStatus | null = null;
      let statusCheckFailed = false;
      if (stageNumber >= 4) {
        try {
          confirmedStatus = await client.call('plugins.call', { name: 'remote-link.status', params: {} }) as RemoteLinkStatus;
        } catch {
          statusCheckFailed = true;
        }
      }

      if (confirmedStatus?.running && confirmedStatus.publicUrl) {
        if (mountedRef.current) {
          setRemoteStatus(confirmedStatus);
          setRemoteConfig(confirmedStatus.config);
          setCallResult(`터널 실행 상태 보존: ${confirmedStatus.publicUrl}`);
          setError(`원격 링크 ${stage} 실패: ${message} 터널은 이미 실행 중이므로 안전하게 유지했습니다.`);
        }
        try { await refreshRemotePairing(confirmedStatus); } catch { /* preserve the original stage error */ }
      } else if (statusCheckFailed) {
        if (mountedRef.current) {
          setError(`원격 링크 ${stage} 실패: ${message} 터널 상태를 다시 확인할 수 없어 설치·활성화·설정을 그대로 보존했습니다. ‘상태 확인’ 후 필요하면 링크를 중지하세요.`);
        }
      } else {
        if (configChanged && originalConfig && remoteConfig.provider !== 'cloudflare-named') {
          try {
            await client.call('plugins.call', { name: 'remote-link.config.set', params: originalConfig });
            recovery.push('기존 원격 설정을 복원했습니다.');
          } catch {
            recovery.push('기존 원격 설정 복원에는 실패했습니다.');
          }
        } else if (configChanged && remoteConfig.provider === 'cloudflare-named') {
          recovery.push('입력한 고정 Tunnel 설정은 수정할 수 있도록 보존했습니다.');
        }
        if (enabledByAction) {
          try {
            await client.call('plugins.setEnabled', { id: plugin.id, enabled: false });
            recovery.push('이번에 켠 플러그인을 다시 껐습니다.');
          } catch {
            recovery.push('플러그인 활성 상태 복원에는 실패했습니다.');
          }
        }
        if (installedByAction) recovery.push('설치된 cloudflared는 다음 연결에서 재사용하도록 유지했습니다.');
        if (mountedRef.current) setError(`원격 링크 ${stage} 실패: ${message}${recovery.length ? ` ${recovery.join(' ')}` : ''}`);
      }
      await refresh();
    } finally {
      if (mountedRef.current) {
        remoteActionRef.current = false;
        setRemoteBusy(false);
        setRemoteStage('');
      }
    }
  };

  const stopRemoteLink = async (): Promise<void> => {
    setRemoteBusy(true); setError('');
    try {
      const status = await client.call('plugins.call', { name: 'remote-link.stop', params: {} }) as RemoteLinkStatus;
      setRemoteStatus(status);
      setRemotePairing(null);
      setCallResult('원격 링크를 닫았습니다. 저장된 고정 주소와 암호화 토큰은 유지됩니다.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoteBusy(false);
    }
  };

  const copyRemoteAddress = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCallResult('원격 주소를 클립보드에 복사했습니다.');
    } catch {
      setCallResult(`복사할 주소: ${value}`);
    }
  };

  const enabledCount = plugins.filter((plugin) => plugin.enabled).length;
  const healthyCount = plugins.filter((plugin) => plugin.status === 'loaded').length;

  if (!canManage) {
    return (
      <div className="stack plugin-page">
        <section className="plugin-hero panel">
          <div><span className="eyebrow">CAPABILITY LAYER</span><h2>연결된 도구 상태</h2><p>이 기기에서는 PC에 설치된 능력과 권한 범위를 안전하게 확인할 수 있습니다.</p></div>
          <div className="plugin-metrics"><span><b>{enabledCount}</b> 활성</span><span><b>{healthyCount}</b> 정상</span><span><b>{plugins.length}</b> 설치됨</span></div>
        </section>
        <div className="access-scope-banner" role="status"><span>🔒</span><div><b>플러그인 관리는 PC 전용입니다</b><p>추가·제거·설정·실행과 원격 링크 변경은 해당 PC의 데스크톱 관리자 연결에서만 가능합니다. 대화에서 이미 허용된 도구를 사용하거나 파일·일정을 조회하는 기능은 그대로 유지됩니다.</p></div></div>
        {plugins.length === 0 ? <Card className="panel empty"><p>설치된 플러그인이 없습니다.</p></Card> : (
          <div className="plugin-grid">{plugins.map((plugin) => (
            <Card key={plugin.id} className="panel plugin-card plugin-card-readonly">
              <div className="plugin-head">
                <div className="plugin-identity">
                  <span className="plugin-icon">{plugin.id === 'orca' ? '⌘' : plugin.id === 'calendar' ? '◷' : plugin.id === 'remote-link' ? '☁' : plugin.id === 'tailscale-connect' ? '↔' : plugin.id === 'docker-sandbox' ? '▣' : plugin.id === 'ctf-toolpack' ? '⌁' : plugin.id === 'mcp-host' ? '◇' : '◉'}</span>
                  <div><h3 className="plugin-name">{plugin.name} <span className="plugin-ver">v{plugin.version}</span></h3><p className="plugin-desc">{plugin.description || plugin.id}</p></div>
                </div>
                <div className="plugin-status"><span className={`status-dot ${plugin.enabled ? 'ok' : 'off'}`} /><span>{plugin.enabled ? '사용 중' : '꺼짐'}</span></div>
              </div>
              <div className="plugin-meta"><Badge tone="accent">{KIND_LABEL[plugin.kind] ?? plugin.kind}</Badge><Badge>{plugin.builtin ? '기본 모듈' : '사용자 모듈'}</Badge><Badge>읽기 전용</Badge></div>
              {plugin.capabilities.length > 0 && <div className="plugin-capabilities">{plugin.capabilities.map((capability) => <span key={capability}>{capability}</span>)}</div>}
              {plugin.permissions.length > 0 && <p className="panel-hint">요청 권한: {plugin.permissions.join(' · ')}</p>}
              {plugin.dependencies.length > 0 && <p className="panel-hint">의존성: {plugin.dependencies.map((dependency) => `${dependency.name}${dependency.required ? ' (필수)' : ''}`).join(' · ')}</p>}
            </Card>
          ))}</div>
        )}
      </div>
    );
  }

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
                <span className="plugin-icon">{p.id === 'orca' ? '⌘' : p.id === 'calendar' ? '◷' : p.id === 'remote-link' ? '☁' : p.id === 'tailscale-connect' ? '↔' : p.id === 'docker-sandbox' ? '▣' : p.id === 'ctf-toolpack' ? '⌁' : p.id === 'mcp-host' ? '◇' : '◉'}</span>
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
              {p.id !== 'voice-wake' && <Button variant={p.enabled ? 'ghost' : 'accent'} onClick={() => void togglePlugin(p)} disabled={p.id === 'remote-link' && remoteBusy}>{p.enabled ? '끄기' : '켜기'}</Button>}
              <Button variant="ghost" onClick={() => setExpanded((current) => current === p.id ? null : p.id)}>{expanded === p.id ? '설정 닫기' : '설정·상세'}</Button>
              {p.id === 'orca' ? <>
                <Button variant="ghost" onClick={() => void refreshOrca()} disabled={orcaBusy}>상태 확인</Button>
                <Button variant="ghost" onClick={() => void openOrca()} disabled={orcaBusy || orcaStatus?.installed === false}>Orca 열기</Button>
              </> : <>
                {p.id === 'remote-link'
                  ? <Button variant="ghost" onClick={() => void refreshRemoteLink()} disabled={remoteBusy}>상태 확인</Button>
                  : p.commands.filter((command) => command.endsWith('.status')).map((c) => <Button key={c} variant="ghost" onClick={() => void pluginCall(p.id, c)}>상태 확인</Button>)}
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
            {p.id === 'voice-wake' && voiceConfig && <div className="provider-add"><h4>PC 음성 호출</h4><div className="form-grid"><label className="field"><span>호출 키워드 직접 설정</span><Input value={voiceConfig.wakePhrase} onChange={(event) => setVoiceConfig({ ...voiceConfig, wakePhrase: event.target.value })} placeholder="로봇" /></label><label className="field"><span>언어</span><Input value={voiceConfig.language} onChange={(event) => setVoiceConfig({ ...voiceConfig, language: event.target.value })} /></label></div><div className="type-row"><label><input type="checkbox" checked={voiceConfig.enabled} onChange={(event) => setVoiceConfig({ ...voiceConfig, enabled: event.target.checked })} /> “{voiceConfig.wakePhrase || '로봇'}” 상시 대기</label><label><input type="checkbox" checked={voiceConfig.audibleReply !== false} onChange={(event) => setVoiceConfig({ ...voiceConfig, audibleReply: event.target.checked })} /> 음성으로 응답</label><Button onClick={() => void pluginCall(p.id, 'voice.config.set', voiceConfig)}>저장</Button></div><p className="panel-hint">오프라인 호출 감지는 AI 토큰을 사용하지 않습니다. 음성 호출은 PC에서만 동작하고 모바일은 텍스트 명령과 파일 제어에 집중합니다.</p></div>}
            {p.id === 'remote-link' && <div className="provider-add">
              <div className="provider-top">
                <Badge tone={p.enabled ? 'ok' : 'warn'}>{p.enabled ? '플러그인 켜짐' : '기본 OFF'}</Badge>
                <Badge tone={remoteStatus?.running ? 'ok' : 'warn'}>{remoteStatus?.running ? `${remoteStatus.temporary ? '임시' : '고정'} 링크 실행 중` : '링크 닫힘'}</Badge>
                <Badge tone={cloudflared?.installed ? 'ok' : 'warn'}>{cloudflared?.installed ? 'cloudflared 설치됨' : 'cloudflared 필요'}</Badge>
                <Badge tone={remoteConfig.provider === 'cloudflare-named' ? 'ok' : 'warn'}>{remoteConfig.provider === 'cloudflare-named' ? '고정 주소' : '베타 · 임시 주소'}</Badge>
                {remoteStatus?.running && <Badge tone={remoteStatus.reachable ? 'ok' : 'warn'}>{remoteStatus.reachable ? '외부 확인됨' : '외부 확인 필요'}</Badge>}
              </div>
              <div className={remoteConfig.provider === 'cloudflare-named' ? 'remote-link-notice' : 'dependency-warning'}>
                {remoteConfig.provider === 'cloudflare-named'
                  ? '고정 Tunnel은 Cloudflare 계정에 등록한 도메인을 계속 사용합니다. Agent는 loopback에만 남고 cloudflared가 outbound 연결하며, 모든 요청은 Mr.Robot 기기 토큰과 권한 상한을 다시 검사합니다.'
                  : 'Cloudflare Quick Tunnel은 테스트·개발용 임시 기능입니다. 주소는 다시 시작할 때 바뀌므로 필요한 동안만 켜고 페어링 PIN·기기 토큰을 외부에 공유하지 마세요.'}
              </div>
              <div className="form-grid">
                <label className="field"><span>원격 연결 방식</span><Select value={remoteConfig.provider} onChange={(event) => setRemoteConfig({ ...remoteConfig, provider: event.target.value as RemoteLinkConfig['provider'], autoStart: event.target.value === 'cloudflare-named' ? remoteConfig.autoStart : false })}><option value="cloudflare-quick">Cloudflare Quick Tunnel (임시·계정 불필요)</option><option value="cloudflare-named">Cloudflare 고정 Tunnel (권장)</option><option value="google-relay" disabled>Google 계정 Relay (외부 구성 필요)</option></Select></label>
                <label className="field"><span>현재 Agent 주소 (자동)</span><Input value={remoteConfig.localUrl} readOnly aria-readonly="true" /></label>
                {remoteConfig.provider === 'cloudflare-named' && <>
                  <label className="field"><span>고정 공개 호스트명</span><Input value={remoteConfig.hostname ?? ''} onChange={(event) => setRemoteConfig({ ...remoteConfig, hostname: event.target.value })} placeholder="예: pc1.v3s9er.com" autoCapitalize="none" spellCheck={false} /></label>
                  <label className="field"><span>Cloudflare Tunnel 토큰</span><Input type="password" value={remoteTunnelToken} onChange={(event) => setRemoteTunnelToken(event.target.value)} placeholder={remoteConfig.hasTunnelToken ? '저장됨 · 변경할 때만 새 토큰 입력' : 'eyJ… Connector 토큰 전체'} autoComplete="off" /></label>
                </>}
              </div>
              {remoteConfig.provider === 'cloudflare-named' && <div className="named-tunnel-setup">
                <b>Cloudflare에서 한 번만 준비</b>
                <ol><li>Networking → Tunnels에서 Tunnel을 만듭니다.</li><li>Public Hostname을 위 주소로 만들고 Service를 <code>{remoteConfig.localUrl}</code>로 지정합니다.</li><li>Add a replica에 표시되는 <code>cloudflared … --token eyJ…</code>의 토큰 부분만 붙여넣습니다.</li></ol>
                <p>토큰은 Windows DPAPI로 암호화되어 현재 Windows 사용자만 복호화할 수 있고, 상태 화면·QR·로그·명령줄에는 반환하지 않습니다. <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noreferrer">Cloudflare 대시보드 열기</a></p>
              </div>}
              <p className="panel-hint">이 방식은 시스템 VPN을 만들지 않고 cloudflared 프로세스 하나가 loopback Agent로 outbound 연결합니다. 일반적으로 금융 앱의 VPN 감지에는 영향을 주지 않지만, 기기·앱별 보안 정책은 다를 수 있습니다.</p>
              {!cloudflared?.installed && <div className="dependency-warning">첫 연결 승인 후 Windows winget으로 Cloudflare cloudflared를 자동 설치합니다. 설치 결과는 다음 연결에서도 재사용합니다.</div>}
              {remoteConfig.provider === 'cloudflare-named' && <div className="type-row remote-link-options">
                <label><input type="checkbox" checked={remoteConfig.autoStart} onChange={(event) => setRemoteConfig({ ...remoteConfig, autoStart: event.target.checked })} /> Mr.Robot 시작 시 고정 Tunnel 자동 연결</label>
                {remoteConfig.hasTunnelToken && <Button variant="danger" onClick={() => void clearRemoteTunnelToken()} disabled={remoteBusy || remoteStatus?.running}>저장 토큰 삭제</Button>}
              </div>}
              <div className="type-row">
                <Button variant="ghost" onClick={() => void saveRemoteLink()} disabled={remoteBusy || remoteStatus?.running}>설정 저장</Button>
                <Button variant="accent" onClick={() => setQuickLinkConfirm(p)} disabled={remoteBusy || remoteStatus?.running || (remoteConfig.provider === 'cloudflare-named' && (!remoteConfig.hostname?.trim() || (!remoteConfig.hasTunnelToken && !remoteTunnelToken.trim())))}>{remoteBusy ? `${remoteStage || '연결 준비 중'}…` : remoteConfig.provider === 'cloudflare-named' ? '고정 Tunnel 연결' : 'Quick Link 빠른 연결'}</Button>
                <Button variant="ghost" onClick={() => void verifyRemoteLink()} disabled={remoteBusy || !remoteStatus?.running}>외부 연결 검사</Button>
                <Button variant="danger" onClick={() => void stopRemoteLink()} disabled={remoteBusy || !remoteStatus?.running}>링크 중지</Button>
              </div>
              {remoteStatus?.publicUrl && <div className="pairing-routes">
                <span>HTTPS <b>{remoteStatus.publicUrl}</b> <Button variant="ghost" onClick={() => void copyRemoteAddress(remoteStatus.publicUrl as string)}>복사</Button></span>
                {remoteStatus.websocketUrl && <span>WSS <b>{remoteStatus.websocketUrl}</b> <Button variant="ghost" onClick={() => void copyRemoteAddress(remoteStatus.websocketUrl as string)}>복사</Button></span>}
              </div>}
              {remoteStatus?.publicUrl && remotePairing && <div className="pairing-grid quick-link-pairing">
                <div className="pairing-qr"><img src={remotePairing.qrUrl} alt="Cloudflare 모바일 연결 QR" width={220} height={220} /></div>
                <div className="pairing-info">
                  <b>모바일 원탭 연결</b>
                  <p className="panel-hint">모바일의 QR 스캔을 열고 이 코드를 비추세요. HTTPS 주소와 1회용 PIN이 함께 들어 있습니다.</p>
                  <div className="pairing-pin">PIN <b>{remotePairing.pin}</b> <span>· 5분 / 1회용</span></div>
                  {remotePairing.expiresAt && <span className="panel-hint">만료 {new Date(remotePairing.expiresAt).toLocaleTimeString()}</span>}
                </div>
              </div>}
              {remoteStatus?.publicUrl && !remotePairing && <p className="panel-hint">모바일 연결 QR을 준비하는 중입니다. 준비되지 않으면 설정 → 모바일 연결에서 PIN 재생성을 누른 뒤 다시 시도하세요.</p>}
              {remoteStatus?.lastError && <div className="gate-error">{remoteStatus.lastError}</div>}
              <p className="panel-hint">고정 Tunnel 주소는 재시작 후에도 유지되지만 PC와 Mr.Robot이 켜져 있어야 합니다. Google 계정 기반 Relay는 별도 E2EE 인프라가 없어 아직 선택할 수 없습니다.</p>
            </div>}
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

      <Modal open={quickLinkConfirm !== null} onClose={() => { if (!remoteBusy) setQuickLinkConfirm(null); }} title={`${remoteConfig.provider === 'cloudflare-named' ? '고정 Tunnel' : 'Quick Link'} 공개 연결 승인`}>
        {quickLinkConfirm && <div className="delete-dialog">
          <div className="delete-dialog-icon">!</div>
          <div>
            <b>이 PC의 Agent 로그인·페어링 화면을 {remoteConfig.provider === 'cloudflare-named' ? '사용자 도메인의 고정' : '임시'} HTTPS 주소로 엽니다.</b>
            <p>계속하면 필요한 경우 cloudflared를 설치하고 암호화 Tunnel과 5분·1회용 PIN QR을 만듭니다. 공개 주소에서는 PIN 시도 제한과 기기별 폐기 가능 토큰이 적용됩니다. {remoteConfig.provider === 'cloudflare-named' ? '고정 주소는 자동 시작을 켜면 앱 재실행 때 다시 연결되므로 Cloudflare 토큰과 등록 기기를 주기적으로 검토하세요.' : '임시 주소는 사용 후 반드시 링크를 중지하세요.'}</p>
          </div>
          <div className="modal-actions">
            <Button variant="ghost" disabled={remoteBusy} onClick={() => setQuickLinkConfirm(null)}>취소</Button>
            <Button variant="danger" disabled={remoteBusy} onClick={() => {
              const plugin = quickLinkConfirm;
              setQuickLinkConfirm(null);
              void startRemoteLink(plugin);
            }}>위험을 이해했으며 연결</Button>
          </div>
        </div>}
      </Modal>

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
