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
interface RemoteHandoffInfo { pin: string; expiresAt: number }
interface RemotePairingInfo { remoteHandoff?: RemoteHandoffInfo }
interface RemotePairingQr {
  pin: string;
  expiresAt?: number;
  qrUrl: string;
  requiresManualAccess: boolean;
  revealExpiresAt?: number;
}
const KIND_LABEL: Record<string, string> = { integration: '연동', transport: '연결', tool: '도구', workflow: '워크플로', input: '입력' };
const ACCESS_QR_REVEAL_MS = 60_000;
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
  const [remoteAccessClientId, setRemoteAccessClientId] = useState('');
  const [remoteAccessClientSecret, setRemoteAccessClientSecret] = useState('');
  const [cloudflared, setCloudflared] = useState<DependencyInfo | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteStage, setRemoteStage] = useState('');
  const [remotePairing, setRemotePairing] = useState<RemotePairingQr | null>(null);
  const [remoteHandoff, setRemoteHandoff] = useState<RemoteHandoffInfo | null>(null);
  const [quickLinkConfirm, setQuickLinkConfirm] = useState<PluginInfo | null>(null);
  const [namedQrConfirm, setNamedQrConfirm] = useState(false);
  const [namedQrBusy, setNamedQrBusy] = useState(false);
  const remoteActionRef = useRef(false);
  const remoteStatusRef = useRef<RemoteLinkStatus | null>(null);
  const remotePairingEpochRef = useRef(0);
  const remotePairingTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const clearRemotePairingQr = useCallback((): void => {
    remotePairingEpochRef.current += 1;
    if (remotePairingTimerRef.current !== null) {
      window.clearTimeout(remotePairingTimerRef.current);
      remotePairingTimerRef.current = null;
    }
    if (mountedRef.current) setRemotePairing(null);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    remoteActionRef.current = false;
    return () => {
      mountedRef.current = false;
      remoteActionRef.current = true;
      remotePairingEpochRef.current += 1;
      if (remotePairingTimerRef.current !== null) window.clearTimeout(remotePairingTimerRef.current);
      remotePairingTimerRef.current = null;
    };
  }, []);

  const commitRemoteStatus = useCallback((status: RemoteLinkStatus | null): void => {
    remoteStatusRef.current = status;
    if (mountedRef.current) setRemoteStatus(status);
  }, []);

  const refreshRemotePairing = useCallback(async (status: RemoteLinkStatus | null): Promise<void> => {
    clearRemotePairingQr();
    const pairingEpoch = remotePairingEpochRef.current;
    if (!status?.running || !status.publicUrl) {
      if (mountedRef.current) setRemoteHandoff(null);
      return;
    }
    const pairing = await client.call('pairing.info', {}) as RemotePairingInfo;
    const handoff = pairing.remoteHandoff;
    if (!handoff) {
      if (mountedRef.current) setRemoteHandoff(null);
      return;
    }
    if (mountedRef.current) setRemoteHandoff(handoff);
    // Named-tunnel handoff stays behind an explicit reveal even though the
    // long-lived Cloudflare credential is deliberately omitted from the QR.
    if (status.provider === 'cloudflare-named') return;
    const payload = JSON.stringify({
      app: 'mr-robot',
      version: 3,
      host: status.publicUrl,
      hosts: [...new Set([status.publicUrl])],
      protocol: 'https',
      port: 443,
      pin: handoff.pin,
    });
    const qrUrl = await QRCode.toDataURL(payload, { width: 300, margin: 4, errorCorrectionLevel: 'M' });
    if (mountedRef.current && pairingEpoch === remotePairingEpochRef.current) {
      setRemotePairing({ pin: handoff.pin, expiresAt: handoff.expiresAt, qrUrl, requiresManualAccess: false });
    }
  }, [clearRemotePairingQr, client]);

  const revealNamedPairingQr = async (): Promise<void> => {
    const status = remoteStatusRef.current;
    if (namedQrBusy || !status?.running || status.provider !== 'cloudflare-named' || !status.publicUrl) return;
    setNamedQrBusy(true);
    setError('');
    clearRemotePairingQr();
    try {
      const pairing = await client.call('pairing.info', {}) as RemotePairingInfo;
      const handoff = pairing.remoteHandoff;
      if (!handoff) throw new Error('먼저 12자리 일회용 외출 코드를 만드세요.');
      const payload = await client.call('plugins.call', {
        name: 'remote-link.pairing.payload',
        params: { host: status.publicUrl, pin: handoff.pin, expiresAt: handoff.expiresAt },
      }) as string;
      const qrUrl = await QRCode.toDataURL(payload, { width: 300, margin: 4, errorCorrectionLevel: 'M' });
      const latestPairing = await client.call('pairing.info', {}) as RemotePairingInfo;
      const currentStatus = remoteStatusRef.current;
      if (!mountedRef.current
        || !currentStatus?.running
        || currentStatus.provider !== 'cloudflare-named'
        || currentStatus.accessProtected !== true
        || currentStatus.publicUrl !== status.publicUrl
        || latestPairing.remoteHandoff?.pin !== handoff.pin
        || latestPairing.remoteHandoff?.expiresAt !== handoff.expiresAt) return;
      const revealEpoch = remotePairingEpochRef.current;
      const revealExpiresAt = Date.now() + ACCESS_QR_REVEAL_MS;
      setRemoteHandoff(handoff);
      setRemotePairing({
        pin: handoff.pin,
        expiresAt: handoff.expiresAt,
        qrUrl,
        requiresManualAccess: true,
        revealExpiresAt,
      });
      remotePairingTimerRef.current = window.setTimeout(() => {
        if (remotePairingEpochRef.current !== revealEpoch) return;
        remotePairingEpochRef.current += 1;
        remotePairingTimerRef.current = null;
        if (mountedRef.current) setRemotePairing(null);
      }, ACCESS_QR_REVEAL_MS);
      setCallResult('장기 자격증명을 제외한 1회용 QR을 60초간 표시합니다. Access 값은 휴대폰에서 직접 입력하세요.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      clearRemotePairingQr();
    } finally {
      if (mountedRef.current) setNamedQrBusy(false);
    }
  };

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setPlugins((await client.call('plugins.list', {})) as PluginInfo[]);
    } catch {
      /* ignore */
    }
  }, [client]);

  const refreshOrca = useCallback(async (interactive = false): Promise<void> => {
    if (interactive) setOrcaBusy(true);
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
      if (interactive) setOrcaBusy(false);
    }
  }, [client]);

  const refreshRemoteLink = useCallback(async (interactive = false): Promise<void> => {
    if (interactive) setRemoteBusy(true);
    try {
      const [status, report, system] = await Promise.all([
        client.call('plugins.call', { name: 'remote-link.status', params: {} }) as Promise<RemoteLinkStatus>,
        client.call('dependencies.status', {}) as Promise<{ items: DependencyInfo[] }>,
        client.call('status', {}) as Promise<SystemStatus>,
      ]);
      commitRemoteStatus(status);
      setRemoteConfig(status.running
        ? status.config
        : { ...status.config, localUrl: `http://127.0.0.1:${system.network.port}` });
      setCloudflared(report.items.find((item) => item.id === 'cloudflared') ?? null);
      await refreshRemotePairing(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (interactive) setRemoteBusy(false);
    }
  }, [client, commitRemoteStatus, refreshRemotePairing]);

  useEffect(() => {
    void refresh();
    const off = client.on('plugins.changed', (data) => setPlugins(data as PluginInfo[]));
    const offPairing = client.on('pairing.changed', () => {
      clearRemotePairingQr();
      setRemoteHandoff(null);
      if (canManage) void refreshRemotePairing(remoteStatusRef.current).catch(() => setRemotePairing(null));
    });
    const offRemoteLink = client.on('remote-link.changed', (data) => {
      if (!canManage) return;
      clearRemotePairingQr();
      const status = data as RemoteLinkStatus;
      commitRemoteStatus(status);
      if (status.running) setRemoteConfig(status.config);
      else setRemoteHandoff(null);
      void refreshRemotePairing(status).catch(() => setRemotePairing(null));
    });
    return () => { off(); offPairing(); offRemoteLink(); };
  }, [canManage, clearRemotePairingQr, client, commitRemoteStatus, refresh, refreshRemotePairing]);

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
      await refreshOrca(false);
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
      window.setTimeout(() => void refreshOrca(false), 1200);
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
        params: {
          ...remoteConfig,
          tunnelToken: remoteTunnelToken.trim() || undefined,
          accessClientId: remoteAccessClientId.trim() || undefined,
          accessClientSecret: remoteAccessClientSecret.trim() || undefined,
        },
      }) as RemoteLinkConfig;
      setRemoteConfig(saved);
      setRemoteTunnelToken('');
      setRemoteAccessClientId('');
      setRemoteAccessClientSecret('');
      setCallResult(saved.provider === 'cloudflare-named'
        ? `Cloudflare 고정 Tunnel 설정을 저장했습니다.${saved.hasAccessCredentials ? ' Access 서비스 자격증명은 Windows DPAPI로 보호됩니다.' : ''}`
        : 'Cloudflare Quick Link 설정을 저장했습니다.');
      await refreshRemoteLink();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoteBusy(false);
    }
  };

  const clearRemoteAccessCredentials = async (): Promise<void> => {
    if (remoteBusy || remoteStatus?.running) return;
    clearRemotePairingQr();
    setRemoteBusy(true); setError('');
    try {
      const saved = await client.call('plugins.call', {
        name: 'remote-link.config.set',
        params: { ...remoteConfig, clearAccessCredentials: true, accessClientId: undefined, accessClientSecret: undefined },
      }) as RemoteLinkConfig;
      setRemoteConfig(saved);
      setRemoteAccessClientId('');
      setRemoteAccessClientSecret('');
      setCallResult('이 PC의 Cloudflare Access 서비스 자격증명을 삭제했습니다. Cloudflare에서도 해당 Service Token을 폐기하세요.');
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

  const installCloudflared = async (): Promise<void> => {
    if (remoteBusy) return;
    setRemoteBusy(true);
    setRemoteStage('cloudflared 설치');
    setError('');
    try {
      const result = await client.call(
        'dependencies.install',
        { id: 'cloudflared' },
        20 * 60_000,
      ) as DependencyInstallResult;
      if (!result.ok || !result.item.installed) {
        throw new Error(result.output || 'cloudflared 설치 프로그램이 실패했습니다.');
      }
      setCloudflared(result.item);
      setCallResult(`${result.item.version ?? 'cloudflared'} 설치 완료 · Quick Link를 사용할 수 있습니다.`);
      await refreshRemoteLink(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoteBusy(false);
      setRemoteStage('');
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
          commitRemoteStatus(initialStatus);
          setRemoteConfig(initialStatus.config);
        }
        await refreshRemotePairing(initialStatus);
        if (mountedRef.current) setCallResult(`원격 링크가 이미 실행 중입니다: ${initialStatus.publicUrl}`);
        return;
      }

      let dependency = dependencyReport.items.find((item) => item.id === 'cloudflared') ?? null;
      if (!dependency?.installed) {
        advance(1, 'cloudflared 설치');
        const result = await client.call('dependencies.install', { id: 'cloudflared' }, 20 * 60_000) as DependencyInstallResult;
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
        params: {
          ...remoteConfig,
          tunnelToken: remoteTunnelToken.trim() || undefined,
          accessClientId: remoteAccessClientId.trim() || undefined,
          accessClientSecret: remoteAccessClientSecret.trim() || undefined,
        },
      });
      if (mountedRef.current) {
        setRemoteTunnelToken('');
        setRemoteAccessClientId('');
        setRemoteAccessClientSecret('');
      }

      advance(4, '암호화 터널 시작');
      const status = await client.call('plugins.call', { name: 'remote-link.start', params: {} }) as RemoteLinkStatus;
      if (!status.running || !status.publicUrl) throw new Error(status.lastError || '터널이 공개 HTTPS 주소를 반환하지 않았습니다.');
      if (mountedRef.current) {
        commitRemoteStatus(status);
        setRemoteConfig(status.config);
      }
      advance(5, '원격 신규 연결 잠금 확인');
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
          commitRemoteStatus(confirmedStatus);
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
    clearRemotePairingQr();
    setRemoteBusy(true); setError('');
    try {
      const status = await client.call('plugins.call', { name: 'remote-link.stop', params: {} }) as RemoteLinkStatus;
      commitRemoteStatus(status);
      setRemoteHandoff(null);
      setCallResult('원격 링크를 닫았습니다. 저장된 고정 주소와 암호화 토큰은 유지됩니다.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoteBusy(false);
    }
  };

  const createRemoteHandoff = async (): Promise<void> => {
    if (remoteBusy || !remoteStatus?.running || !remoteStatus.publicUrl) return;
    clearRemotePairingQr();
    setRemoteBusy(true);
    setError('');
    try {
      if (remoteStatus.provider === 'cloudflare-named') {
        await client.call('plugins.call', { name: 'remote-link.verify', params: {} }, 30_000);
      }
      const handoff = await client.call('pairing.createRemoteHandoff', { ttlMinutes: 24 * 60 }) as RemoteHandoffInfo;
      setRemoteHandoff(handoff);
      await refreshRemotePairing(remoteStatus);
      setCallResult(remoteStatus.provider === 'cloudflare-named'
        ? '24시간·1회용 외출 코드를 만들었습니다. 장기 Access 자격증명을 제외한 QR을 60초간 표시할 수 있습니다.'
        : '24시간·1회용 외출 코드를 만들었습니다. 한 기기가 연결되거나 앱이 재시작되면 즉시 폐기됩니다.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoteBusy(false);
    }
  };

  const copyRemoteHandoffPin = async (): Promise<void> => {
    if (!remoteHandoff) return;
    try {
      await navigator.clipboard.writeText(remoteHandoff.pin);
      setCallResult('12자리 외출 코드를 클립보드에 복사했습니다.');
    } catch {
      setCallResult('클립보드 복사에 실패했습니다. 화면의 코드를 직접 입력하세요.');
    }
  };

  const revokeRemoteHandoff = async (): Promise<void> => {
    clearRemotePairingQr();
    try {
      await client.call('pairing.revokeRemoteHandoff', {});
      setRemoteHandoff(null);
      setCallResult('외출용 일회용 코드를 폐기했습니다.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
                <Button variant="ghost" onClick={() => void refreshOrca(true)} disabled={orcaBusy}>상태 확인</Button>
                <Button variant="ghost" onClick={() => void openOrca()} disabled={orcaBusy || orcaStatus?.installed === false}>Orca 열기</Button>
              </> : <>
                {p.id === 'remote-link'
                  ? <Button variant="ghost" onClick={() => void refreshRemoteLink(true)} disabled={remoteBusy}>상태 확인</Button>
                  : p.commands.filter((command) => command.endsWith('.status')).map((c) => <Button key={c} variant="ghost" onClick={() => void pluginCall(p.id, c)}>상태 확인</Button>)}
                {p.id === 'tailscale-connect' && <Button variant="ghost" onClick={() => void pluginCall(p.id, 'tailscale.peers')}>기기 목록</Button>}
                {p.id === 'docker-sandbox' && <Button onClick={() => void pluginCall(p.id, 'docker.ctf.image.ensure')} disabled={busy}>CTF 이미지 준비</Button>}
                {p.id === 'mcp-host' && <Button variant="ghost" onClick={() => void pluginCall(p.id, 'mcp.servers.list')}>연결 목록</Button>}
              </>}
              {!p.builtin && <Button variant="danger" onClick={() => void unload(p.id)}>
                제거
              </Button>}
            </div>
            {p.id === 'remote-link' && remoteStatus?.publicUrl && expanded !== p.id && <div className="plugin-live-route">
              <span>HTTPS</span>
              <b title={remoteStatus.publicUrl}>{remoteStatus.publicUrl}</b>
              <Button variant="ghost" onClick={() => void copyRemoteAddress(remoteStatus.publicUrl as string)}>복사</Button>
            </div>}
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
                {remoteConfig.provider === 'cloudflare-named' && <Badge tone={remoteConfig.hasAccessCredentials ? 'ok' : 'warn'}>{remoteConfig.hasAccessCredentials ? 'Access 자격증명 저장됨' : 'Access 자격증명 없음'}</Badge>}
                {remoteStatus?.running && <Badge tone={remoteStatus.reachable ? 'ok' : 'warn'}>{remoteStatus.provider === 'cloudflare-named' && remoteStatus.accessProtected ? 'Access 보호 검증됨' : remoteStatus.reachable ? '외부 확인됨' : '외부 확인 필요'}</Badge>}
              </div>
              <div className={remoteConfig.provider === 'cloudflare-named' ? 'remote-link-notice' : 'dependency-warning'}>
                {remoteConfig.provider === 'cloudflare-named'
                  ? '고정 Tunnel은 Cloudflare 계정에 등록한 도메인을 계속 사용합니다. 앱은 Connector 토큰을 로컬 최소 권한 자격증명으로 바꾸고 지정 호스트 → loopback Agent 한 경로만 허용하며 나머지는 404로 차단합니다.'
                  : 'Cloudflare Quick Tunnel은 테스트·개발용 임시 기능입니다. 주소는 다시 시작할 때 바뀌므로 필요한 동안만 켜고 페어링 PIN·기기 토큰을 외부에 공유하지 마세요.'}
              </div>
              <div className="form-grid">
                <label className="field"><span>원격 연결 방식</span><Select value={remoteConfig.provider} onChange={(event) => setRemoteConfig({ ...remoteConfig, provider: event.target.value as RemoteLinkConfig['provider'], autoStart: event.target.value === 'cloudflare-named' ? remoteConfig.autoStart : false })}><option value="cloudflare-quick">Cloudflare Quick Tunnel (임시·계정 불필요)</option><option value="cloudflare-named">Cloudflare 고정 Tunnel (권장)</option><option value="google-relay" disabled>Google 계정 Relay (외부 구성 필요)</option></Select></label>
                <label className="field"><span>현재 Agent 주소 (자동)</span><Input value={remoteConfig.localUrl} readOnly aria-readonly="true" /></label>
                {remoteConfig.provider === 'cloudflare-named' && <>
                  <label className="field"><span>고정 공개 호스트명</span><Input value={remoteConfig.hostname ?? ''} onChange={(event) => setRemoteConfig({ ...remoteConfig, hostname: event.target.value })} placeholder="예: pc1.v3s9er.com" autoCapitalize="none" spellCheck={false} /></label>
                  <label className="field"><span>PC 간 전송 허용 호스트</span><Input value={(remoteConfig.peerHostnames ?? []).join(', ')} onChange={(event) => setRemoteConfig({ ...remoteConfig, peerHostnames: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} placeholder="예: pc2.v3s9er.com, laptop.v3s9er.com" autoCapitalize="none" spellCheck={false} /></label>
                  <p className="panel-hint">PC마다 고유한 호스트명·전용 Tunnel을 사용하세요. 같은 호스트명을 두 PC Connector가 공유하면 요청 대상이 섞일 수 있습니다. 서로 다른 PC 주소 사이에서 파일·작업을 직접 가져올 때만 허용 호스트를 추가하며, 목록 밖 주소에는 Access 자격증명을 보내지 않습니다.</p>
                  <label className="field"><span>Cloudflare Tunnel 토큰</span><Input type="password" value={remoteTunnelToken} onChange={(event) => setRemoteTunnelToken(event.target.value)} placeholder={remoteConfig.hasTunnelToken ? '저장됨 · 변경할 때만 새 토큰 입력' : 'eyJ… Connector 토큰 전체'} autoComplete="off" /></label>
                  <label className="field"><span>Access Service Token Client ID</span><Input type="password" value={remoteAccessClientId} onChange={(event) => setRemoteAccessClientId(event.target.value)} placeholder={remoteConfig.hasAccessCredentials ? '저장됨 · 변경할 때만 새 ID 입력' : '…access'} autoComplete="off" autoCapitalize="none" spellCheck={false} /></label>
                  <label className="field"><span>Access Service Token Client Secret</span><Input type="password" value={remoteAccessClientSecret} onChange={(event) => setRemoteAccessClientSecret(event.target.value)} placeholder={remoteConfig.hasAccessCredentials ? '저장됨 · 변경할 때만 새 Secret 입력' : 'Cloudflare에서 한 번만 표시되는 Secret'} autoComplete="new-password" autoCapitalize="none" spellCheck={false} /></label>
                </>}
              </div>
              {remoteConfig.provider === 'cloudflare-named' && <div className="named-tunnel-setup">
                <b>Cloudflare에서 한 번만 준비</b>
                <ol><li>Networking → Tunnels에서 이 PC 전용 Tunnel을 만들고 Public Hostname을 위 주소로 등록합니다.</li><li>Access → Applications에서 정확한 호스트의 Self-hosted 앱을 만듭니다.</li><li>본인 이메일만 허용하는 Allow 정책과, 정확한 Service Token만 허용하는 Service Auth 정책을 추가합니다. Bypass·Everyone은 사용하지 않습니다.</li><li>Service credentials에서 만든 Client ID와 Secret, 그리고 Tunnel의 Connector 토큰을 이 화면에 저장합니다.</li><li>외부 연결 검사를 눌러 익명 요청 차단과 Service Token 통과를 모두 확인합니다.</li></ol>
                <p>Tunnel·Access 자격증명은 Windows DPAPI로 암호화됩니다. 앱은 실행 때만 필요한 자격증명을 사용하고 상태·로그·명령줄·QR에는 반환하지 않습니다. 휴대폰에는 Cloudflare 값을 직접 입력하며 Android 보안 저장소에만 보관합니다. <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noreferrer">Cloudflare 대시보드 열기</a></p>
              </div>}
              <p className="panel-hint">이 방식은 시스템 VPN을 만들지 않고 cloudflared 프로세스 하나가 loopback Agent로 outbound 연결합니다. 일반적으로 금융 앱의 VPN 감지에는 영향을 주지 않지만, 기기·앱별 보안 정책은 다를 수 있습니다.</p>
              {!cloudflared?.installed && <div className="dependency-warning">cloudflared가 없습니다. 아래 설치 버튼 또는 첫 연결 승인 시 Windows winget 사용자 범위로 설치하며 다음 연결에서도 재사용합니다.</div>}
              {remoteConfig.provider === 'cloudflare-named' && <div className="type-row remote-link-options">
                <label><input type="checkbox" checked={remoteConfig.autoStart} onChange={(event) => setRemoteConfig({ ...remoteConfig, autoStart: event.target.checked })} /> Mr.Robot 시작 시 고정 Tunnel 자동 연결</label>
                {remoteConfig.hasTunnelToken && <Button variant="danger" onClick={() => void clearRemoteTunnelToken()} disabled={remoteBusy || remoteStatus?.running}>저장 토큰 삭제</Button>}
                {remoteConfig.hasAccessCredentials && <Button variant="danger" onClick={() => void clearRemoteAccessCredentials()} disabled={remoteBusy || remoteStatus?.running}>Access 자격증명 삭제</Button>}
              </div>}
              <div className="type-row">
                {!cloudflared?.installed && <Button variant="accent" onClick={() => void installCloudflared()} disabled={remoteBusy}>{remoteBusy ? `${remoteStage || '설치 준비 중'}…` : 'cloudflared 설치'}</Button>}
                <Button variant="ghost" onClick={() => void saveRemoteLink()} disabled={remoteBusy || remoteStatus?.running}>설정 저장</Button>
                <Button variant="accent" onClick={() => setQuickLinkConfirm(p)} disabled={remoteBusy || remoteStatus?.running || (remoteConfig.provider === 'cloudflare-named' && (!remoteConfig.hostname?.trim() || (!remoteConfig.hasTunnelToken && !remoteTunnelToken.trim())))}>{remoteBusy ? `${remoteStage || '연결 준비 중'}…` : remoteConfig.provider === 'cloudflare-named' ? '고정 Tunnel 연결' : 'Quick Link 빠른 연결'}</Button>
                {remoteStatus?.running && remoteStatus.publicUrl && <Button variant="ghost" onClick={() => void createRemoteHandoff()} disabled={remoteBusy}>24시간·1회용 외출 코드 생성</Button>}
                {remoteStatus?.running && remoteStatus.publicUrl && remoteStatus.provider === 'cloudflare-named' && remoteHandoff && <Button variant="danger" onClick={() => setNamedQrConfirm(true)} disabled={remoteBusy || namedQrBusy}>{namedQrBusy ? 'QR 준비 중…' : '보안 QR 60초 표시'}</Button>}
                <Button variant="ghost" onClick={() => void verifyRemoteLink()} disabled={remoteBusy || !remoteStatus?.running}>외부 연결 검사</Button>
                <Button variant="danger" onClick={() => void stopRemoteLink()} disabled={remoteBusy || !remoteStatus?.running}>링크 중지</Button>
              </div>
              {remoteStatus?.publicUrl && <div className="pairing-routes">
                <span>HTTPS <b>{remoteStatus.publicUrl}</b> <Button variant="ghost" onClick={() => void copyRemoteAddress(remoteStatus.publicUrl as string)}>복사</Button></span>
                {remoteStatus.websocketUrl && <span>WSS <b>{remoteStatus.websocketUrl}</b> <Button variant="ghost" onClick={() => void copyRemoteAddress(remoteStatus.websocketUrl as string)}>복사</Button></span>}
              </div>}
              {remoteStatus?.publicUrl && remoteHandoff && <div className="remote-handoff">
                <div><span>12자리 외출 코드</span><b>{remoteHandoff.pin}</b></div>
                <small>만료 {new Date(remoteHandoff.expiresAt).toLocaleString()} · 한 기기 연결 후 즉시 폐기 · 앱 재시작 시 폐기</small>
                <Button variant="ghost" onClick={() => void copyRemoteHandoffPin()}>코드 복사</Button>
                <Button variant="danger" onClick={() => void revokeRemoteHandoff()}>즉시 폐기</Button>
              </div>}
              {remoteStatus?.publicUrl && remotePairing && <div className="pairing-grid quick-link-pairing">
                <div className="pairing-qr"><img src={remotePairing.qrUrl} alt="Cloudflare 모바일 연결 QR" width={300} height={300} /></div>
                <div className="pairing-info">
                  <b>모바일 원탭 연결</b>
                  {remotePairing.requiresManualAccess
                    ? <><p className="panel-hint warn-hint"><b>1회용 QR · 60초 후 자동 숨김</b><br />이 QR에는 주소와 12자리 외출 코드만 있으며 장기 Cloudflare 자격증명은 없습니다. 스캔 뒤 휴대폰에서 Access Client ID와 Secret을 직접 입력하세요.</p><Button variant="ghost" onClick={clearRemotePairingQr}>QR 지금 숨기기</Button></>
                    : <p className="panel-hint">모바일의 QR 스캔을 열고 이 코드를 비추세요. Quick Link HTTPS 주소와 강한 12자리 외출 코드가 들어 있습니다. QR을 공유하지 마세요.</p>}
                  <div className="pairing-pin">외출 코드 <b>{remotePairing.pin}</b> <span>· 최대 24시간 / 1회용</span></div>
                  {remotePairing.expiresAt && <span className="panel-hint">만료 {new Date(remotePairing.expiresAt).toLocaleString()}</span>}
                  {remotePairing.revealExpiresAt && <span className="panel-hint">QR 자동 숨김 {new Date(remotePairing.revealExpiresAt).toLocaleTimeString()}</span>}
                </div>
              </div>}
              {remoteStatus?.publicUrl && !remotePairing && <p className="panel-hint">{remoteStatus.provider === 'cloudflare-named' && remoteHandoff ? '장기 Access 자격증명은 QR로 내보내지 않습니다. ‘보안 QR 60초 표시’ 후 휴대폰에서 Access 값을 직접 입력하세요.' : '기존 등록 기기는 바로 연결됩니다. 새 기기를 연결할 때만 위의 ‘24시간·1회용 외출 코드 생성’을 눌러 보안 QR을 만드세요. 일반 6자리 PIN은 공개 주소에서 거부됩니다.'}</p>}
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

      <Modal open={namedQrConfirm} onClose={() => { if (!namedQrBusy) setNamedQrConfirm(false); }} title="Cloudflare 보안 QR 60초 표시">
        <div className="delete-dialog">
          <div className="delete-dialog-icon">!</div>
          <div>
            <b>장기 Cloudflare 자격증명은 QR에 넣지 않습니다.</b>
            <p>이 QR은 주소와 12자리 일회용 외출 코드만 담고 60초 뒤 숨깁니다. 저장된 Service Token은 renderer로 반환되지 않습니다.</p>
            <p><b>휴대폰 단계:</b> 스캔 뒤 Android 입력 화면에서 Access Client ID와 Secret을 직접 입력하세요. 값은 Android 보안 저장소에만 보관됩니다.</p>
          </div>
          <div className="modal-actions">
            <Button variant="ghost" disabled={namedQrBusy} onClick={() => setNamedQrConfirm(false)}>취소</Button>
            <Button variant="danger" disabled={namedQrBusy} onClick={() => {
              setNamedQrConfirm(false);
              void revealNamedPairingQr();
            }}>{namedQrBusy ? 'QR 준비 중…' : '이 휴대폰으로 60초 표시'}</Button>
          </div>
        </div>
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
