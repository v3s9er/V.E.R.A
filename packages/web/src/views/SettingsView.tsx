import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { AppSettings, DependencyInstallResult, DependencyReport, DeviceCapability, MemoryItem, PluginInfo, ProviderInfo, ProviderSource, ProviderType, RemoteLinkStatus, RoutingPreset, RoutingSettings } from '@mr-robot/shared';
import { useMrRobot } from '../state';
import { Badge, Button, Card, Field, Input, Modal, Select, Spinner, Toggle } from '../components/ui';
import { RoutingGraphEditor } from '../components/RoutingGraphEditor';
import { DependencySetup } from '../components/DependencySetup';

interface PairingInfo {
  deviceName: string;
  host: string;
  hosts: string[];
  port: number;
  pin: string;
  pinExpiresAt?: number;
  maskedSecret?: string;
  qrPayload: string;
}

interface DeviceLink { id: string; name: string; permissionCap: AppSettings['safety']['mode']; capabilities: DeviceCapability[]; createdAt: number; revokedAt?: number }
interface RemoteHandoffInfo { pin: string; expiresAt: number }
interface VoiceConfig {
  enabled: boolean; wakePhrase: string; language: string; pcPriorityMs: number; audibleReply: boolean; sensitivity: number;
  replyPreset: 'neon-runner' | 'system' | 'custom'; voiceName: string; replyText: string; replyRate: number; replyVolume: number;
}
interface VoiceStatus extends VoiceConfig {
  listening: boolean;
  starting: boolean;
  engine?: 'windows-speech' | 'sherpa-onnx' | 'none';
  engineAvailable: boolean;
  recognitionModel?: 'hybrid-korean' | 'sensevoice' | 'windows-sapi' | 'none';
  accurateKoreanModel?: boolean;
  recognizers: Array<{ id: string; language: string; description: string }>;
  voices: Array<{ name: string; language: string; gender: string; age: string; description: string }>;
  lastError?: string;
  lastWakeAt?: number | null;
  lastText?: string;
  lastHeardAt?: number | null;
  lastHeardText?: string;
  lastRawHeardText?: string;
  lastMatchScore?: number;
  lastSpeechMs?: number;
  inputLevel?: number;
  lastAudioAt?: number | null;
  commandListening?: boolean;
  commandArmedUntil?: number | null;
  lastCommandAt?: number | null;
  lastCommandText?: string;
  canInstall: boolean;
}

const TYPE_LABEL: Record<ProviderType, string> = {
  'openai-compatible': 'OpenAI 호환 (OpenAI·Groq·DeepSeek·OpenRouter 등)',
  anthropic: 'Anthropic (Claude)',
  ollama: 'Ollama (로컬)',
  'codex-cli': 'Codex 구독 (공식 로컬 CLI)',
  'claude-cli': 'Claude 구독 (공식 로컬 CLI)',
};

const MODEL_SUGGESTIONS: Record<ProviderType, string[]> = {
  'openai-compatible': [
    'deepseek-v4-pro',
    'deepseek-chat',
    'deepseek-reasoner',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.6',
    'llama-3.3-70b-versatile',
  ],
  anthropic: ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  ollama: ['llama3.1', 'qwen2.5', 'mistral'],
  'codex-cli': ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6'],
  'claude-cli': ['fable', 'opus', 'sonnet', 'haiku', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
};

/** One-tap service presets: pick a service, only the API key is left to fill. */
const PRESETS: Array<{
  id: string;
  label: string;
  type: ProviderType;
  baseUrl: string;
  model: string;
  source: ProviderSource;
  costTier: number;
}> = [
  { id: 'deepseek', label: 'DeepSeek', type: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', source: 'api', costTier: 1 },
  { id: 'openai', label: 'OpenAI', type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-terra', source: 'api', costTier: 1 },
  { id: 'groq', label: 'Groq', type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', source: 'api', costTier: 1 },
  { id: 'openrouter', label: 'OpenRouter', type: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4-pro', source: 'api', costTier: 1 },
  { id: 'openrouter-free', label: 'OpenRouter 무료 라우터', type: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free', source: 'free', costTier: 0 },
  { id: 'claude', label: 'Anthropic Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5', source: 'api', costTier: 1 },
  { id: 'ollama', label: 'Ollama (로컬 무료)', type: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'llama3.1', source: 'local', costTier: 0 },
  { id: 'lm-studio', label: 'LM Studio (로컬 무료)', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', source: 'local', costTier: 0 },
  { id: 'codex-subscription', label: 'Codex 구독', type: 'codex-cli', baseUrl: '', model: 'gpt-5.6-terra', source: 'subscription', costTier: 1 },
  { id: 'claude-subscription', label: 'Claude 구독', type: 'claude-cli', baseUrl: '', model: 'sonnet', source: 'subscription', costTier: 1 },
  { id: 'custom', label: '직접 입력 (기타 제공사)', type: 'openai-compatible', baseUrl: '', model: '', source: 'api', costTier: 1 },
];

interface TelemetrySummary { turns: number; promptTokens: number; completionTokens: number; cachedPromptTokens: number; cacheWritePromptTokens: number; reasoningTokens: number; cacheHitRate: number; toolCalls: number; estimatedCost: number; failures: number; byModel: Array<{ model: string; turns: number }> }

interface RepairOffer { target: ProviderInfo; error: string; helpers: ProviderInfo[] }
interface DangerConfirm { title: string; message: string; confirmLabel: string; action: () => Promise<void> }
const EXECUTION_LABEL = { single: '단일 선택', pipeline: '순차 검증', vote: '그룹 투표', hybrid: '혼합형', swarm: '경쟁 스웜' } as const;

export function SettingsView({ onOpenChat }: { onOpenChat?: () => void }) {
  const { client } = useMrRobot();
  const canManage = client.isAdmin;
  const [section, setSection] = useState<'models' | 'routing' | 'dependencies' | 'voice' | 'safety' | 'memory' | 'network' | 'pairing'>('models');
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [deviceLinks, setDeviceLinks] = useState<DeviceLink[]>([]);
  const [routing, setRouting] = useState<RoutingSettings | null>(null);
  const [routingPresets, setRoutingPresets] = useState<RoutingPreset[]>([]);
  const [selectedRoutingPresetId, setSelectedRoutingPresetId] = useState('builtin:balanced');
  const [routingPresetName, setRoutingPresetName] = useState('');
  const [routingPresetStatus, setRoutingPresetStatus] = useState('');
  const [presetBrowserOpen, setPresetBrowserOpen] = useState(false);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetrySummary | null>(null);
  const [memoryText, setMemoryText] = useState('');
  const [qrUrl, setQrUrl] = useState('');
  const [remoteStatus, setRemoteStatus] = useState<RemoteLinkStatus | null>(null);
  const [remoteHandoff, setRemoteHandoff] = useState<RemoteHandoffInfo | null>(null);
  const [remoteHandoffBusy, setRemoteHandoffBusy] = useState(false);
  const [remoteHandoffMessage, setRemoteHandoffMessage] = useState('');
  const [pairingLinkBusy, setPairingLinkBusy] = useState(false);
  const [pairingLinkMessage, setPairingLinkMessage] = useState('');
  const capabilityUpdateLocks = useRef(new Set<string>());
  const [capabilityBusyIds, setCapabilityBusyIds] = useState<Set<string>>(() => new Set());

  // provider add form
  const [preset, setPreset] = useState('deepseek');
  const [label, setLabel] = useState('DeepSeek');
  const [type, setType] = useState<ProviderType>('openai-compatible');
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1');
  const [model, setModel] = useState('deepseek-v4-pro');
  const [apiKey, setApiKey] = useState('');
  const [source, setSource] = useState<ProviderSource>('api');
  const [command, setCommand] = useState('');
  const [costTier, setCostTier] = useState(1);
  const [inputPrice, setInputPrice] = useState(0);
  const [outputPrice, setOutputPrice] = useState(0);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState('');
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({});
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});
  const [repairOffer, setRepairOffer] = useState<RepairOffer | null>(null);
  const [repairBusy, setRepairBusy] = useState(false);
  const [dangerConfirm, setDangerConfirm] = useState<DangerConfirm | null>(null);
  const [dangerBusy, setDangerBusy] = useState(false);
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceMessage, setVoiceMessage] = useState('');
  const canWriteContent = Boolean(settings && client.permissionCap !== 'read-only' && settings.safety.mode !== 'read-only');

  const refreshVoice = useCallback(async (): Promise<void> => {
    if (!canManage) return;
    try {
      const [config, status] = await Promise.all([
        client.call('plugins.call', { name: 'voice.config.get', params: {} }) as Promise<VoiceConfig>,
        client.call('plugins.call', { name: 'voice.status', params: {} }) as Promise<VoiceStatus>,
      ]);
      setVoiceConfig(config);
      setVoiceStatus(status);
    } catch (error) {
      setVoiceMessage(error instanceof Error ? error.message : String(error));
    }
  }, [canManage, client]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [provs, sets, route, presets, memory, stats] = await Promise.all([
        client.call('providers.list', {}) as Promise<ProviderInfo[]>,
        client.call('settings.get', {}) as Promise<AppSettings>,
        client.call('routing.get', {}) as Promise<RoutingSettings>,
        client.call('routing.presets.list', {}) as Promise<RoutingPreset[]>,
        client.call('memory.list', {}) as Promise<MemoryItem[]>,
        client.call('telemetry.summary', {}) as Promise<TelemetrySummary>,
      ]);
      setProviders(provs);
      setModelDrafts((current) => Object.fromEntries(provs.map((provider) => [provider.id, current[provider.id] ?? provider.model])));
      setSettings(sets);
      setRouting(route);
      setRoutingPresets(presets);
      setSelectedRoutingPresetId(route.activePresetId ?? presets.find((item) => item.builtin && item.mode === route.mode)?.id ?? presets[0]?.id ?? '');
      setMemories(memory);
      setTelemetry(stats);
      if (canManage) {
        void client.call('pairing.info', {}).then((value) => setPairing(value as PairingInfo)).catch(() => setPairing(null));
        void client.call('plugins.call', { name: 'remote-link.status', params: {} }).then((value) => setRemoteStatus(value as RemoteLinkStatus)).catch(() => setRemoteStatus(null));
        void refreshVoice();
        void client.call('pairing.links', {}).then((links) => setDeviceLinks(links as DeviceLink[])).catch(() => setDeviceLinks([]));
      } else {
        setPairing(null);
        setRemoteStatus(null);
        setRemoteHandoff(null);
        setDeviceLinks([]);
        setVoiceConfig(null);
        setVoiceStatus(null);
      }
    } catch {
      /* ignore */
    }
  }, [canManage, client, refreshVoice]);

  useEffect(() => {
    void refresh();
    const offP = client.on('providers.changed', (d) => {
      const next = d as ProviderInfo[];
      setProviders(next);
      setModelDrafts((current) => Object.fromEntries(next.map((provider) => [provider.id, current[provider.id] ?? provider.model])));
    });
    const offS = client.on('settings.changed', (d) => setSettings(d as AppSettings));
    const offR = client.on('routing.changed', (d) => {
      const next = d as RoutingSettings;
      setRouting(next);
      if (next.activePresetId) setSelectedRoutingPresetId(next.activePresetId);
    });
    const offRP = client.on('routing.presets.changed', (d) => setRoutingPresets(d as RoutingPreset[]));
    const offM = client.on('memory.changed', (d) => setMemories(d as MemoryItem[]));
    const offV = client.on('voice.status', (d) => setVoiceStatus((current) => ({
      ...(current ?? { enabled: false, wakePhrase: '로봇', language: 'ko-KR', pcPriorityMs: 900, audibleReply: true, sensitivity: 0.68, replyPreset: 'neon-runner', voiceName: '', replyText: '응, 듣고 있어.', replyRate: -1, replyVolume: 88, engineAvailable: false, recognizers: [], voices: [], canInstall: true }),
      ...(d as Partial<VoiceStatus>),
    } as VoiceStatus)));
    const offPairing = client.on('pairing.changed', () => {
      setRemoteHandoff(null);
      if (canManage) void client.call('pairing.info', {}).then((value) => setPairing(value as PairingInfo)).catch(() => setPairing(null));
    });
    const offRemoteLink = client.on('remote-link.changed', (data) => {
      if (!canManage) return;
      const status = data as RemoteLinkStatus;
      setRemoteStatus(status);
      if (!status.running) setRemoteHandoff(null);
    });
    return () => {
      offP();
      offS();
      offR();
      offRP();
      offM();
      offV();
      offPairing();
      offRemoteLink();
    };
  }, [client, refresh]);

  useEffect(() => {
    if (!canManage || section !== 'routing' || providers.length === 0) return;
    let alive = true;
    void Promise.all(providers.map(async (provider): Promise<[string, string[]]> => {
      try {
        const values = await client.call('providers.models', { id: provider.id }) as string[];
        return [provider.id, [...new Set([provider.model, ...values])]];
      } catch {
        return [provider.id, [provider.model]];
      }
    })).then((entries) => { if (alive) setModelOptions((current) => ({ ...current, ...Object.fromEntries(entries) })); });
    return () => { alive = false; };
  }, [canManage, client, providers, section]);

  useEffect(() => {
    if (!canManage && (section === 'voice' || section === 'safety' || section === 'network' || section === 'pairing')) {
      setSection('models');
    }
  }, [canManage, section]);

  useEffect(() => {
    let alive = true;
    const remoteOrigin = remoteStatus?.running ? remoteStatus.publicUrl : undefined;
    const payload = remoteOrigin && pairing?.pin
      ? JSON.stringify({ app: 'mr-robot', version: 3, host: remoteOrigin, hosts: [...new Set([remoteOrigin])], protocol: 'https', port: 443, pin: pairing.pin })
      : pairing?.host !== '127.0.0.1'
        ? pairing?.qrPayload
        : undefined;
    setQrUrl('');
    if (payload) {
      void QRCode.toDataURL(payload, { width: 300, margin: 4, errorCorrectionLevel: 'M' })
        .then((url) => {
          if (alive) setQrUrl(url);
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [pairing, remoteStatus]);

  const applyPreset = (id: string): void => {
    setPreset(id);
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setType(p.type);
    setBaseUrl(p.baseUrl);
    setModel(p.model);
    setLabel(id === 'custom' ? '' : p.label);
    setSource(p.source);
    setCommand(p.type === 'codex-cli' ? 'codex' : p.type === 'claude-cli' ? 'claude' : '');
    setCostTier(p.costTier);
    setAddError('');
  };

  const addProvider = async (): Promise<void> => {
    if (!canManage || !model.trim() || addBusy) return;
    setAddBusy(true);
    setAddError('');
    try {
      await client.call('providers.add', {
        label: label.trim() || model.trim(),
        type,
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
        source,
        command: command.trim() || undefined,
        costTier,
        inputCostPerMillion: inputPrice || undefined,
        outputCostPerMillion: outputPrice || undefined,
      });
      setLabel('');
      setBaseUrl('');
      setModel('');
      setApiKey('');
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddBusy(false);
    }
  };

  const saveSettings = async (patch: Partial<AppSettings>): Promise<void> => {
    if (!canManage) return;
    try {
      await client.call('settings.set', patch);
    } catch {
      /* ignore */
    }
  };

  const startPairingQuickLink = async (): Promise<void> => {
    if (!canManage || pairingLinkBusy) return;
    setPairingLinkBusy(true);
    setPairingLinkMessage('Quick Link와 새 연결 QR을 준비하는 중입니다…');
    try {
      const [plugins, dependencyReport] = await Promise.all([
        client.call('plugins.list', {}) as Promise<PluginInfo[]>,
        client.call('dependencies.status', {}) as Promise<DependencyReport>,
      ]);
      const remotePlugin = plugins.find((plugin) => plugin.id === 'remote-link');
      if (!remotePlugin) throw new Error('Cloudflare Remote Link 플러그인을 찾지 못했습니다.');

      let cloudflared = dependencyReport.items.find((item) => item.id === 'cloudflared');
      if (!cloudflared?.installed) {
        setPairingLinkMessage('cloudflared를 설치하는 중입니다…');
        const installed = await client.call('dependencies.install', { id: 'cloudflared' }, 20 * 60_000) as DependencyInstallResult;
        if (!installed.ok || !installed.item.installed) throw new Error(installed.output || 'cloudflared 설치에 실패했습니다.');
        cloudflared = installed.item;
      }
      if (!remotePlugin.enabled) await client.call('plugins.setEnabled', { id: remotePlugin.id, enabled: true });

      let status = await client.call('plugins.call', { name: 'remote-link.status', params: {} }) as RemoteLinkStatus;
      if (!status.running || !status.publicUrl) {
        setPairingLinkMessage('암호화 Quick Link 주소를 만드는 중입니다…');
        await client.call('plugins.call', {
          name: 'remote-link.config.set',
          params: {
            provider: 'cloudflare-quick',
            localUrl: `http://127.0.0.1:${settings?.network.port ?? pairing?.port ?? 8787}`,
            autoStart: false,
          },
        });
        status = await client.call('plugins.call', { name: 'remote-link.start', params: {} }, 90_000) as RemoteLinkStatus;
      }
      if (!status.running || !status.publicUrl) throw new Error(status.lastError || 'Quick Link가 공개 HTTPS 주소를 반환하지 않았습니다.');

      await client.call('pairing.regeneratePin', {});
      const nextPairing = await client.call('pairing.info', {}) as PairingInfo;
      setRemoteStatus(status);
      setPairing(nextPairing);
      try {
        await client.call('plugins.call', { name: 'remote-link.verify', params: {} }, 30_000);
        setPairingLinkMessage('✓ Quick Link와 5분·1회용 모바일 QR을 만들었습니다.');
      } catch {
        setPairingLinkMessage('Quick Link와 QR은 만들었습니다. 주소가 막 생성되어 외부 확인은 잠시 뒤 다시 시도될 수 있습니다.');
      }
    } catch (error) {
      setPairingLinkMessage(`QR 준비 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPairingLinkBusy(false);
    }
  };

  const createRemoteHandoff = async (): Promise<void> => {
    if (remoteHandoffBusy || !remoteStatus?.running || !remoteStatus.publicUrl) return;
    setRemoteHandoffBusy(true);
    setRemoteHandoffMessage('');
    try {
      const handoff = await client.call('pairing.createRemoteHandoff', { ttlMinutes: 24 * 60 }) as RemoteHandoffInfo;
      setRemoteHandoff(handoff);
      setRemoteHandoffMessage('24시간·1회용 외출 코드를 만들었습니다.');
    } catch (error) {
      setRemoteHandoffMessage(`외출 코드 생성 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRemoteHandoffBusy(false);
    }
  };

  const copyRemoteHandoff = async (): Promise<void> => {
    if (!remoteHandoff) return;
    try {
      await navigator.clipboard.writeText(remoteHandoff.pin);
      setRemoteHandoffMessage('12자리 외출 코드를 복사했습니다.');
    } catch {
      setRemoteHandoffMessage('클립보드 복사에 실패했습니다. 화면의 코드를 직접 입력하세요.');
    }
  };

  const revokeRemoteHandoff = async (): Promise<void> => {
    try {
      await client.call('pairing.revokeRemoteHandoff', {});
      setRemoteHandoff(null);
      setRemoteHandoffMessage('외출용 일회용 코드를 폐기했습니다.');
    } catch (error) {
      setRemoteHandoffMessage(`외출 코드 폐기 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const saveVoice = async (next: VoiceConfig, message = '✓ 음성 호출 설정을 저장했습니다.'): Promise<void> => {
    if (!canManage) return;
    setVoiceBusy(true);
    setVoiceMessage('');
    try {
      await client.call('plugins.setEnabled', { id: 'voice-wake', enabled: true });
      const saved = await client.call('plugins.call', { name: 'voice.config.set', params: next }) as VoiceConfig;
      setVoiceConfig(saved);
      await client.call('settings.set', { voice: { enabled: saved.enabled, wakePhrase: saved.wakePhrase, language: saved.language, pcPriorityMs: saved.pcPriorityMs } });
      setVoiceMessage(message);
      await new Promise((resolve) => window.setTimeout(resolve, 900));
      await refreshVoice();
    } catch (error) {
      setVoiceMessage(`✕ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setVoiceBusy(false);
    }
  };

  const installSpeech = async (): Promise<boolean> => {
    if (!canManage) return false;
    setVoiceBusy(true);
    setVoiceMessage('로컬 한국어 음성 엔진을 설치하는 중입니다. 약 250MB를 한 번 내려받습니다…');
    try {
      const result = await client.call('dependencies.install', { id: 'speech-ko' }) as { ok: boolean; output: string };
      setVoiceMessage(result.ok ? '✓ 오프라인 한국어 음성 엔진을 설치했습니다.' : `✕ 설치 실패\n${result.output.slice(-1800)}`);
      await refreshVoice();
      return result.ok;
    } catch (error) {
      setVoiceMessage(`✕ ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      setVoiceBusy(false);
    }
  };

  const toggleAlwaysListening = async (enabled: boolean): Promise<void> => {
    if (!voiceConfig || voiceBusy) return;
    if (enabled && voiceStatus && !voiceStatus.engineAvailable) {
      const installed = await installSpeech();
      if (!installed) return;
    }
    await saveVoice({ ...voiceConfig, enabled }, enabled ? `✓ 상시 대기를 켰습니다. “${voiceConfig.wakePhrase || '로봇'}”이라고 불러보세요.` : '상시 대기를 껐습니다. 마이크 사용이 중지됩니다.');
  };

  const testVoiceReply = async (): Promise<void> => {
    setVoiceBusy(true);
    setVoiceMessage('확인음과 음성 응답을 시험하는 중입니다…');
    try {
      const result = await client.call('plugins.call', { name: 'voice.reply.test', params: {} }) as { ok: boolean; message: string };
      setVoiceMessage(`${result.ok ? '✓' : '✕'} ${result.message}`);
    } catch (error) {
      setVoiceMessage(`✕ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setVoiceBusy(false);
    }
  };

  const saveRouting = async (patch: Partial<RoutingSettings>): Promise<void> => {
    if (!canManage) return;
    try {
      const updated = await client.call('routing.set', patch) as RoutingSettings;
      setRouting(updated);
    } catch {
      /* ignore */
    }
  };

  const testProvider = async (id: string): Promise<void> => {
    if (!canManage) return;
    setTestResult((t) => ({ ...t, [id]: '확인 중…' }));
    try {
      const res = (await client.call('providers.test', { id })) as { ok: boolean; error?: string };
      setTestResult((t) => ({ ...t, [id]: res.ok ? '✓ 연결됨' : `✕ ${res.error ?? '실패'}` }));
      if (!res.ok) {
        const target = providers.find((provider) => provider.id === id);
        if (target) {
          const checks = await Promise.all(providers.filter((provider) => provider.id !== id).map(async (provider) => {
            try { return (await client.call('providers.test', { id: provider.id }) as { ok: boolean }).ok ? provider : null; }
            catch { return null; }
          }));
          setRepairOffer({ target, error: res.error ?? '연결에 실패했습니다.', helpers: checks.filter((provider): provider is ProviderInfo => provider !== null) });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTestResult((t) => ({ ...t, [id]: `✕ ${message}` }));
      const target = providers.find((provider) => provider.id === id);
      if (target) setRepairOffer({ target, error: message, helpers: [] });
    }
  };

  const delegateRepair = async (): Promise<void> => {
    if (!repairOffer?.helpers[0] || repairBusy) return;
    const helper = repairOffer.helpers[0];
    const target = repairOffer.target;
    setRepairBusy(true);
    try {
      const conversation = await client.call('conversations.create', {
        title: `${target.label} 연결 복구`, providerId: helper.id, providerModel: helper.model, reasoningEffort: 'high',
      }) as { id: string };
      setTestResult((current) => ({ ...current, [target.id]: `◌ ${helper.label}에게 연결 복구를 맡겼습니다` }));
      setRepairOffer(null);
      onOpenChat?.();
      window.setTimeout(() => {
        void client.call('chat.start', {
          conversationId: conversation.id,
          providerId: helper.id,
          providerModel: helper.model,
          reasoningEffort: 'high',
          text: `Mr.Robot의 '${target.label}' AI 연결을 자동으로 복구해 주세요. 대상 종류는 ${target.type}, 모델은 ${target.model}입니다. 현재 오류: ${repairOffer.error}\n\n가능한 진단과 안전한 자동 조치를 직접 수행하고 결과를 검증하세요. 비밀키를 출력하거나 새 키를 임의 생성하지 마세요. 브라우저 로그인이나 사용자 자격증명 입력처럼 본인 확인이 반드시 필요한 단계만 명확히 안내하세요.`,
        }, 10 * 60_000);
      }, 350);
    } finally {
      setRepairBusy(false);
    }
  };

  const discoverModels = async (id: string): Promise<void> => {
    if (!canManage) return;
    setTestResult((t) => ({ ...t, [id]: '모델 목록 가져오는 중…' }));
    try {
      const values = await client.call('providers.models', { id }) as string[];
      setModelOptions((current) => ({ ...current, [id]: values }));
      setTestResult((t) => ({ ...t, [id]: values.length ? `${values.length}개 모델 발견` : '모델 목록이 비어 있습니다' }));
    } catch (err) {
      setTestResult((t) => ({ ...t, [id]: `✕ ${err instanceof Error ? err.message : String(err)}` }));
    }
  };

  const updateProviderModel = async (provider: ProviderInfo): Promise<void> => {
    if (!canManage) return;
    const nextModel = (modelDrafts[provider.id] ?? provider.model).trim();
    if (!nextModel || nextModel === provider.model) return;
    setTestResult((current) => ({ ...current, [provider.id]: '모델 적용 중…' }));
    try {
      const updated = await client.call('providers.updateModel', { id: provider.id, model: nextModel }) as ProviderInfo;
      setModelDrafts((current) => ({ ...current, [provider.id]: updated.model }));
      setTestResult((current) => ({ ...current, [provider.id]: `✓ ${updated.model} 적용됨` }));
    } catch (err) {
      setTestResult((current) => ({ ...current, [provider.id]: `✕ ${err instanceof Error ? err.message : String(err)}` }));
    }
  };

  const applyRoutingPreset = async (): Promise<void> => {
    if (!canManage || !selectedRoutingPresetId) return;
    setRoutingPresetStatus('적용 중…');
    try {
      const updated = await client.call('routing.presets.apply', { id: selectedRoutingPresetId }) as RoutingSettings;
      setRouting(updated);
      setRoutingPresetStatus('✓ 프리셋을 적용했습니다.');
      setPresetBrowserOpen(false);
    } catch (err) {
      setRoutingPresetStatus(`✕ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const saveRoutingPreset = async (overwrite = false): Promise<void> => {
    if (!canManage) return;
    const selected = routingPresets.find((item) => item.id === selectedRoutingPresetId);
    const name = routingPresetName.trim() || (overwrite && selected && !selected.builtin ? selected.name : '내 의사결정 트리');
    setRoutingPresetStatus('저장 중…');
    try {
      const saved = await client.call('routing.presets.save', {
        name,
        ...(overwrite && selected && !selected.builtin ? { id: selected.id } : {}),
      }) as RoutingPreset;
      setSelectedRoutingPresetId(saved.id);
      setRoutingPresetName(saved.name);
      setRoutingPresetStatus(overwrite ? '✓ 프리셋을 덮어썼습니다.' : '✓ 새 프리셋으로 저장했습니다.');
    } catch (err) {
      setRoutingPresetStatus(`✕ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const deleteRoutingPreset = (): void => {
    if (!canManage) return;
    const selected = routingPresets.find((item) => item.id === selectedRoutingPresetId);
    if (!selected || selected.builtin) return;
    setDangerConfirm({
      title: '프리셋을 삭제할까요?',
      message: `'${selected.name}' 프리셋과 저장된 노드 구성이 영구적으로 삭제됩니다.`,
      confirmLabel: '프리셋 삭제',
      action: async () => {
        try {
          await client.call('routing.presets.delete', { id: selected.id });
          const fallback = routingPresets.find((item) => item.builtin)?.id ?? '';
          setSelectedRoutingPresetId(fallback);
          setRoutingPresetName('');
          setRoutingPresetStatus('✓ 프리셋을 삭제했습니다.');
        } catch (err) { setRoutingPresetStatus(`✕ ${err instanceof Error ? err.message : String(err)}`); }
      },
    });
  };

  const runDangerAction = async (): Promise<void> => {
    if (!dangerConfirm || dangerBusy) return;
    setDangerBusy(true);
    try { await dangerConfirm.action(); setDangerConfirm(null); }
    finally { setDangerBusy(false); }
  };

  const placeholders: Record<ProviderType, string> = {
    'openai-compatible': 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com',
    ollama: 'http://127.0.0.1:11434',
    'codex-cli': 'API 주소 불필요',
    'claude-cli': 'API 주소 불필요',
  };
  const defaultModels: Record<ProviderType, string> = {
    'openai-compatible': 'gpt-5.6-terra',
    anthropic: 'claude-sonnet-5',
    ollama: 'llama3.1',
    'codex-cli': 'gpt-5.6-terra',
    'claude-cli': 'sonnet',
  };

  const selectedRoutingPreset = routingPresets.find((item) => item.id === selectedRoutingPresetId);
  const remotePairingUrl = remoteStatus?.running ? remoteStatus.publicUrl : undefined;
  const settingsSections = [
    { id: 'models', title: '모델 및 연결', adminOnly: false },
    { id: 'routing', title: '모델 라우팅', adminOnly: false },
    { id: 'dependencies', title: '외부 도구', adminOnly: false },
    { id: 'voice', title: '음성 호출', adminOnly: true },
    { id: 'safety', title: '권한 및 안전', adminOnly: true },
    { id: 'memory', title: '기억', adminOnly: false },
    { id: 'network', title: '네트워크', adminOnly: true },
    { id: 'pairing', title: '모바일 연결', adminOnly: true },
  ] as const;

  const setDeviceCapability = async (linkId: string, capability: DeviceCapability, enabled: boolean): Promise<void> => {
    if (capabilityUpdateLocks.current.has(linkId)) return;
    capabilityUpdateLocks.current.add(linkId);
    setCapabilityBusyIds((current) => new Set(current).add(linkId));
    try {
      await client.call('pairing.link.capability.set', { id: linkId, capability, enabled });
      await refresh();
    } catch (error) {
      setPairingLinkMessage(`기기 권한 변경 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      capabilityUpdateLocks.current.delete(linkId);
      setCapabilityBusyIds((current) => {
        const next = new Set(current);
        next.delete(linkId);
        return next;
      });
    }
  };

  return (
    <div className="settings-layout">
      <aside className="settings-nav">
        <div className="settings-nav-title">설정</div>
        {settingsSections.map(({ id, title, adminOnly }) => {
          const locked = adminOnly && !canManage;
          return <button key={id} type="button" className={`settings-nav-item ${section === id ? 'active' : ''} ${locked ? 'locked' : ''}`} disabled={locked} title={locked ? '이 PC의 데스크톱 관리자 연결에서만 변경할 수 있습니다.' : undefined} onClick={() => setSection(id)}>{title}<span>{locked ? '🔒' : '›'}</span></button>;
        })}
      </aside>
      <div className="settings-content stack">
      {!canManage && <div className="access-scope-banner" role="status"><span>🔒</span><div><b>연결된 기기 · 관리 설정은 읽기 전용</b><p>모델 상태·시나리오·도구 설치 여부는 확인할 수 있습니다. 공급자 키, 플러그인, 음성, PC 네트워크와 연결 기기는 해당 PC의 데스크톱 앱에서만 변경됩니다. 대화·파일·일정은 계속 사용할 수 있습니다.</p></div></div>}
      <div className={section === 'models' ? '' : 'settings-section-hidden'}>
      <Card className="panel">
        <div className="panel-head">
          <div><h3>모델 모듈</h3>{!canManage && <p className="panel-hint">이 기기에서는 연결된 모델을 확인하고 대화에서 선택할 수 있습니다.</p>}</div>
          {!canManage && <Badge>읽기 전용</Badge>}
        </div>
        <div className="provider-grid">
          {providers.map((p) => (
            <div key={p.id} className={`provider-card ${p.isDefault ? 'default' : ''}`}>
              <div className="provider-top">
                <Badge tone="accent">{TYPE_LABEL[p.type].split(' ')[0]}</Badge>
                {p.isDefault && <Badge tone="ok">기본</Badge>}
                <Badge>{p.source === 'subscription' ? '구독' : p.source === 'local' ? '로컬' : p.source === 'free' ? '무료' : 'API'}</Badge>
                {p.source === 'api' && (p.hasKey ? <Badge>키 있음</Badge> : <Badge tone="warn">키 없음</Badge>)}
                <Badge>비용 {p.costTier}</Badge>
              </div>
              <div className="provider-name">{p.label}</div>
              <div className="provider-model-editor">
                <Input
                  aria-label={`${p.label} 모델`}
                  value={modelDrafts[p.id] ?? p.model}
                  disabled={!canManage}
                  onChange={(event) => setModelDrafts((current) => ({ ...current, [p.id]: event.target.value }))}
                  onKeyDown={(event) => { if (event.key === 'Enter') void updateProviderModel(p); }}
                  list={`provider-models-${p.id}`}
                />
                <datalist id={`provider-models-${p.id}`}>
                  {(modelOptions[p.id] ?? []).map((value) => <option key={value} value={value} />)}
                </datalist>
                <Button variant="ghost" disabled={!canManage || !(modelDrafts[p.id] ?? '').trim() || (modelDrafts[p.id] ?? p.model).trim() === p.model} onClick={() => void updateProviderModel(p)}>모델 적용</Button>
              </div>
              <div className="provider-url" title={p.baseUrl}>{p.baseUrl}</div>
              <div className="provider-url">추론: {p.supportedReasoning.join(' · ')}</div>
              {testResult[p.id] && <div className="provider-test">{testResult[p.id]}</div>}
              <div className="plugin-actions">
                <Button variant="ghost" disabled={!canManage} onClick={() => void testProvider(p.id)}>
                  연결 확인
                </Button>
                <Button variant="ghost" disabled={!canManage} onClick={() => void discoverModels(p.id)}>모델 가져오기</Button>
                {!p.isDefault && (
                  <Button variant="ghost" disabled={!canManage} onClick={() => void client.call('providers.setDefault', { id: p.id }).catch(() => undefined)}>
                    기본으로
                  </Button>
                )}
                <Button variant="danger" disabled={!canManage} onClick={() => void client.call('providers.remove', { id: p.id }).catch(() => undefined)}>
                  삭제
                </Button>
              </div>
            </div>
          ))}
          {providers.length === 0 && <p className="panel-hint">제공자가 없습니다. 아래에서 추가하세요 — 키는 이 PC의 설정 파일에만 저장됩니다.</p>}
        </div>

        <fieldset className="provider-add permission-fieldset" disabled={!canManage}>
          <div className="panel-head">
            <h3>제공자 추가</h3>
          </div>
          <Field label="서비스 (프리셋)" hint="고르면 주소·모델이 자동 입력됩니다 — API 키만 넣으면 돼요">
            <Select value={preset} onChange={(e) => applyPreset(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="form-grid">
            <Field label="종류">
              <Select value={type} onChange={(e) => setType(e.target.value as ProviderType)}>
                <option value="openai-compatible">OpenAI 호환</option>
                <option value="anthropic">Anthropic</option>
                <option value="ollama">Ollama (로컬)</option>
                <option value="codex-cli">Codex 구독 (CLI)</option>
                <option value="claude-cli">Claude 구독 (CLI)</option>
              </Select>
            </Field>
            <Field label="이름 (표시용)">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="예: 내 OpenAI" />
            </Field>
            <Field label="모델" hint={TYPE_LABEL[type]}>
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={defaultModels[type]}
                list="model-suggestions"
              />
              <datalist id="model-suggestions">
                {MODEL_SUGGESTIONS[type].map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
            <Field label="Base URL">
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={placeholders[type]} disabled={type.endsWith('-cli')} />
            </Field>
            <Field label="연결 방식">
              <Select value={source} onChange={(e) => {
                const next = e.target.value as ProviderSource;
                setSource(next);
                setCostTier(next === 'free' || next === 'local' ? 0 : Math.max(1, costTier));
              }}>
                <option value="api">유료 API</option><option value="subscription">구독 CLI</option><option value="local">로컬 무료</option><option value="free">무료 원격</option>
              </Select>
            </Field>
            <Field label="상대 비용" hint="0=무료, 숫자가 높을수록 라우터가 아껴 씁니다">
              <Input type="number" min={0} max={5} value={costTier} disabled={source === 'free' || source === 'local'} onChange={(e) => setCostTier(Number(e.target.value))} />
            </Field>
            <Field label="입력 $ / 100만 토큰" hint="비용 통계 계산용, 모르면 0"><Input type="number" min={0} step="0.01" value={inputPrice} onChange={(e) => setInputPrice(Number(e.target.value))} /></Field>
            <Field label="출력 $ / 100만 토큰"><Input type="number" min={0} step="0.01" value={outputPrice} onChange={(e) => setOutputPrice(Number(e.target.value))} /></Field>
            {type.endsWith('-cli') ? <Field label="공식 CLI 실행 파일" hint="CLI에서 먼저 정상 로그인해야 합니다">
              <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder={type === 'codex-cli' ? 'codex' : 'claude'} />
            </Field> : <Field label="API 키" hint={source === 'local' ? '로컬 연결은 비워도 됩니다' : source === 'free' ? '무료 서비스 정책에 따라 키가 필요할 수 있습니다' : '로컬 저장소에만 보관됩니다'}>
              <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
            </Field>}
          </div>
          {!model.trim() && <p className="panel-hint warn-hint">⚠️ 모델명을 입력해야 추가 버튼이 활성화됩니다 (예: deepseek-v4-pro).</p>}
          {addError && <div className="gate-error">{addError}</div>}
          <Button onClick={() => void addProvider()} disabled={addBusy || !model.trim()}>
            {addBusy ? '추가 중…' : '추가'}
          </Button>
        </fieldset>
      </Card></div>

      <div className={section === 'routing' ? '' : 'settings-section-hidden'}>
      <Card className="panel">
        <div className="panel-head">
          <div><h3>비용 최적화 모델 파이프라인</h3><p className="panel-hint">요청 복잡도와 작업 종류에 따라 가장 싼 적합 모델을 고르고, 지정한 순서대로 장애 조치합니다.</p></div>
          {routing && <Select disabled={!canManage} value={routing.mode} onChange={(e) => void saveRouting({ mode: e.target.value as RoutingSettings['mode'] })}>
            <option value="economy">절약 우선</option><option value="balanced">균형 (권장)</option><option value="quality">품질 우선</option><option value="manual">수동 지정</option>
          </Select>}
        </div>
        {!canManage && <div className="access-inline"><b>시나리오 미리보기</b><span>현재 구성과 토큰 통계는 볼 수 있습니다. 기본 라우팅과 프리셋 편집은 PC 데스크톱 관리자에서 진행하세요.</span></div>}
        <div className="routing-preset-panel">
          <Field label="모델 시나리오 프리셋" hint="목록에서 클릭하면 노드 구조를 미리보고 적용할 수 있습니다">
            <Button className="preset-browser-trigger" variant="ghost" onClick={() => setPresetBrowserOpen(true)}><span>{selectedRoutingPreset?.builtin ? '기본 프리셋' : '내 프리셋'}</span><b>{selectedRoutingPreset?.name ?? '프리셋 선택'}</b><span>목록·그래프 보기 ›</span></Button>
          </Field>
          <div className="type-row routing-preset-actions">
            <Button onClick={() => void applyRoutingPreset()} disabled={!canManage || !selectedRoutingPresetId}>선택 프리셋 적용</Button>
            <Input disabled={!canManage} value={routingPresetName} onChange={(event) => setRoutingPresetName(event.target.value)} placeholder="새 프리셋 이름" />
            <Button variant="ghost" disabled={!canManage} onClick={() => void saveRoutingPreset(false)}>현재 트리 새로 저장</Button>
            {routingPresets.some((item) => item.id === selectedRoutingPresetId && !item.builtin) && <>
              <Button variant="ghost" disabled={!canManage} onClick={() => void saveRoutingPreset(true)}>선택 프리셋 덮어쓰기</Button>
              <Button variant="danger" disabled={!canManage} onClick={deleteRoutingPreset}>삭제</Button>
            </>}
          </div>
          {routingPresets.find((item) => item.id === selectedRoutingPresetId)?.description && <p className="panel-hint">{routingPresets.find((item) => item.id === selectedRoutingPresetId)?.description}</p>}
          {routingPresetStatus && <div className="provider-test">{routingPresetStatus}</div>}
        </div>
        {telemetry && <div className="telemetry-strip">
          <div><span>최근 실행</span><b>{Number(telemetry.turns ?? 0).toLocaleString()}회</b></div>
          <div><span>입력 토큰</span><b>{Number(telemetry.promptTokens ?? 0).toLocaleString()}</b></div>
          <div><span>캐시 재사용</span><b>{Number(telemetry.cachedPromptTokens ?? 0).toLocaleString()} · {(Number(telemetry.cacheHitRate ?? 0) * 100).toFixed(1)}%</b></div>
          <div><span>출력 토큰</span><b>{Number(telemetry.completionTokens ?? 0).toLocaleString()}</b></div>
          <div><span>도구 호출</span><b>{Number(telemetry.toolCalls ?? 0).toLocaleString()}회</b></div>
          <div><span>실패</span><b>{Number(telemetry.failures ?? 0).toLocaleString()}회</b></div>
          <div><span>예상 비용</span><b>${Number(telemetry.estimatedCost ?? 0).toFixed(4)}</b></div>
        </div>}
        {routing?.graph && <RoutingGraphEditor graph={routing.graph} providers={providers} providerModels={modelOptions} onSave={canManage ? (graph) => void saveRouting({ graph }) : undefined} readOnly={!canManage} />}
        {routing && <fieldset className="form-grid routing-options permission-fieldset" disabled={!canManage}>
          <Field label="시나리오 실행 방식" hint="순차·투표는 노드 수만큼 모델 호출이 늘어납니다"><Select value={routing.executionMode ?? 'single'} onChange={(e) => void saveRouting({ executionMode: e.target.value as RoutingSettings['executionMode'] })}>
            <option value="single">단일 선택 · 한 모델만 호출</option><option value="pipeline">순차 파이프라인 · 노드별 전달</option><option value="vote">회의·투표 · 그룹별 상호 토론</option><option value="hybrid">혼합 · 분류＋그룹 회의＋검증</option><option value="swarm">경쟁 스웜 · 병렬 풀이＋공유＋성공 검증까지 재시도</option>
          </Select></Field>
          {(routing.executionMode === 'vote' || routing.executionMode === 'hybrid' || routing.executionMode === 'swarm') && <Field label="그룹 내부 회의 라운드" hint="2라운드부터 같은 그룹의 의견·증거·실패 기록을 공유합니다"><Select value={String(routing.meetingRounds ?? 2)} onChange={(e) => void saveRouting({ meetingRounds: Number(e.target.value) })}>
            <option value="1">1라운드 · 독립 의견만</option><option value="2">2라운드 · 의견 교환 + 투표 (권장)</option><option value="3">3라운드 · 재토론 + 최종 투표</option>
          </Select></Field>}
          {(routing.executionMode === 'vote' || routing.executionMode === 'hybrid') && <Field label="그룹 간 대표 회의" hint="각 그룹의 최종안을 대표 모델끼리 교환하고 재검토합니다"><Select value={String(routing.crossGroupRounds ?? 1)} onChange={(e) => void saveRouting({ crossGroupRounds: Number(e.target.value) })}><option value="0">사용 안 함</option><option value="1">1라운드 · 그룹 최종안 교환 (권장)</option><option value="2">2라운드 · 상호 반박</option><option value="3">3라운드 · 재합의</option></Select></Field>}
          {routing.executionMode === 'swarm' && <Field label="최대 경쟁 반복" hint="검증 성공 시 즉시 종료하며, 실패가 계속될 때만 이 상한까지 재도전합니다"><Input type="number" min={1} max={12} value={routing.maxIterations ?? 6} onChange={(e) => void saveRouting({ maxIterations: Number(e.target.value) })} /></Field>}
          <Field label="턴당 고비용 호출 상한"><Input type="number" min={0} max={8} value={routing.maxPremiumCalls} onChange={(e) => void saveRouting({ maxPremiumCalls: Number(e.target.value) })} /></Field>
          <Field label="어려운 요청 자동 상향"><Toggle checked={routing.escalationEnabled} onChange={(v) => void saveRouting({ escalationEnabled: v })} /></Field>
        </fieldset>}
      </Card></div>

      <div className={section === 'dependencies' ? '' : 'settings-section-hidden'}>
        <DependencySetup />
      </div>

      <div className={section === 'voice' ? '' : 'settings-section-hidden'}>
      <Card className="panel voice-settings">
        <div className="panel-head">
          <div><h3>음성 호출</h3><p className="panel-hint">Mr.Robot이 트레이에 있어도 호출어를 기다립니다. OFF하면 마이크 수신 프로세스가 즉시 종료됩니다.</p></div>
          <div className="provider-top">
            <Badge tone={voiceStatus?.accurateKoreanModel ? 'ok' : 'warn'}>{voiceStatus?.accurateKoreanModel ? '한국어 듀얼 인식' : voiceStatus?.engineAvailable ? '경량 인식 엔진' : '한국어 엔진 없음'}</Badge>
            <Badge tone={voiceStatus?.listening ? 'ok' : voiceStatus?.starting ? 'warn' : undefined}>{voiceStatus?.listening ? '상시 듣는 중' : voiceStatus?.starting ? '시작 중' : '대기 꺼짐'}</Badge>
          </div>
        </div>
        {voiceConfig && <>
          <div className="voice-master-row">
            <div><b>“{voiceConfig.wakePhrase || '로봇'}” 상시 대기</b><span>{voiceConfig.enabled ? '마이크를 사용해 호출 키워드를 기다리고 있습니다.' : '현재 마이크를 사용하지 않습니다.'}</span></div>
            <Toggle checked={voiceConfig.enabled} onChange={(value) => void toggleAlwaysListening(value)} />
          </div>
          <div className="form-grid">
            <Field label="호출 키워드 직접 설정" hint="원하는 단어나 문구를 입력하고 아래 저장 버튼을 누르세요">
              <Input value={voiceConfig.wakePhrase} onChange={(event) => setVoiceConfig({ ...voiceConfig, wakePhrase: event.target.value })} placeholder="로봇" />
            </Field>
            <Field label="인식 언어">
              <Select value={voiceConfig.language} onChange={(event) => setVoiceConfig({ ...voiceConfig, language: event.target.value })}>
                <option value="ko-KR">한국어 (대한민국)</option>
                <option value="en-US">English (United States)</option>
              </Select>
            </Field>
            <Field label="호출 감도" hint="잘 안 들리면 높음, 주변 대화에 자주 반응하면 엄격을 선택하세요">
              <Select value={String(voiceConfig.sensitivity ?? 0.68)} onChange={(event) => setVoiceConfig({ ...voiceConfig, sensitivity: Number(event.target.value) })}>
                <option value="0.55">높음</option><option value="0.68">균형 (권장)</option><option value="0.8">엄격</option>
              </Select>
            </Field>
            <Field label="호출 확인 음성" hint="호출을 들으면 ‘네, 듣고 있어요’라고 답합니다">
              <Toggle checked={voiceConfig.audibleReply !== false} onChange={(value) => setVoiceConfig({ ...voiceConfig, audibleReply: value })} />
            </Field>
            <Field label="응답 음성 스타일" hint="네온 러너는 특정 인물을 복제하지 않은 차분한 사이버펑크 기본 프리셋입니다">
              <Select value={voiceConfig.replyPreset ?? 'neon-runner'} onChange={(event) => {
                const replyPreset = event.target.value as VoiceConfig['replyPreset'];
                setVoiceConfig(replyPreset === 'neon-runner'
                  ? { ...voiceConfig, replyPreset, replyText: '응, 듣고 있어.', replyRate: -1, replyVolume: 88 }
                  : replyPreset === 'system'
                    ? { ...voiceConfig, replyPreset, replyText: '네, 듣고 있어요.', replyRate: 0, replyVolume: 100 }
                    : { ...voiceConfig, replyPreset });
              }}>
                <option value="neon-runner">네온 러너 · 낮고 차분한 톤 (기본)</option>
                <option value="system">시스템 기본 · 또렷한 안내</option>
                <option value="custom">직접 조정</option>
              </Select>
            </Field>
            <Field label="설치된 Windows 음성" hint="Windows에 추가한 언어·음성 팩도 자동으로 이 목록에 나타납니다">
              <Select value={voiceConfig.voiceName ?? ''} onChange={(event) => setVoiceConfig({ ...voiceConfig, voiceName: event.target.value, replyPreset: 'custom' })}>
                <option value="">한국어 기본 음성 자동 선택</option>
                {(voiceStatus?.voices ?? []).map((voice) => <option key={voice.name} value={voice.name}>{voice.name} · {voice.language} · {voice.gender}</option>)}
              </Select>
            </Field>
            <Field label="호출 응답 문구" hint="호출을 확인한 뒤 이 문장을 로컬에서 말합니다">
              <Input value={voiceConfig.replyText ?? ''} maxLength={120} onChange={(event) => setVoiceConfig({ ...voiceConfig, replyText: event.target.value, replyPreset: 'custom' })} placeholder="응, 듣고 있어." />
            </Field>
            <Field label="응답 속도">
              <Select value={String(voiceConfig.replyRate ?? -1)} onChange={(event) => setVoiceConfig({ ...voiceConfig, replyRate: Number(event.target.value), replyPreset: 'custom' })}>
                <option value="-3">매우 느리게</option><option value="-2">느리게</option><option value="-1">차분하게</option><option value="0">보통</option><option value="1">조금 빠르게</option><option value="2">빠르게</option>
              </Select>
            </Field>
            <Field label="응답 볼륨">
              <Select value={String(voiceConfig.replyVolume ?? 88)} onChange={(event) => setVoiceConfig({ ...voiceConfig, replyVolume: Number(event.target.value), replyPreset: 'custom' })}>
                <option value="55">55%</option><option value="70">70%</option><option value="88">88%</option><option value="100">100%</option>
              </Select>
            </Field>
          </div>
          <div className="plugin-actions">
            <Button onClick={() => void saveVoice(voiceConfig)} disabled={voiceBusy}>{voiceBusy ? '처리 중…' : '음성 설정 저장'}</Button>
            <Button variant="ghost" onClick={() => void refreshVoice()} disabled={voiceBusy}>상태 다시 확인</Button>
            <Button variant="ghost" onClick={() => void testVoiceReply()} disabled={voiceBusy}>응답음 시험</Button>
            {!voiceStatus?.accurateKoreanModel && <Button variant="ghost" onClick={() => void installSpeech()} disabled={voiceBusy || voiceStatus?.canInstall === false}>고정확도 한국어 엔진 설치</Button>}
          </div>
        </>}
        {voiceStatus?.listening && <div className="voice-input-meter"><span>마이크 입력</span><div><i style={{ width: `${Math.max(2, Math.round((voiceStatus.inputLevel ?? 0) * 100))}%` }} /></div><b>{Math.round((voiceStatus.inputLevel ?? 0) * 100)}%</b></div>}
        {voiceStatus?.lastWakeAt && <div className="voice-last-heard"><span>마지막 호출</span><b>{new Date(voiceStatus.lastWakeAt).toLocaleTimeString()} · {voiceStatus.lastText || voiceConfig?.wakePhrase}</b></div>}
        {voiceStatus?.lastHeardAt && <div className="voice-last-heard"><span>최근 음성 인식</span><b>{new Date(voiceStatus.lastHeardAt).toLocaleTimeString()} · {voiceStatus.lastHeardText || '—'} · 일치 {Math.round((voiceStatus.lastMatchScore ?? 0) * 100)}%</b></div>}
        {voiceStatus?.lastRawHeardText && voiceStatus.lastRawHeardText !== voiceStatus.lastHeardText && <div className="voice-last-heard"><span>자동 명사 보정</span><b>{voiceStatus.lastRawHeardText} → {voiceStatus.lastHeardText}</b></div>}
        {voiceStatus?.commandListening && <div className="voice-last-heard"><span>명령 수신</span><b>다음 문장을 기다리는 중 · 인식 즉시 현재 대화에서 실행</b></div>}
        {voiceStatus?.lastCommandAt && <div className="voice-last-heard"><span>마지막 음성 명령</span><b>{new Date(voiceStatus.lastCommandAt).toLocaleTimeString()} · {voiceStatus.lastCommandText || '—'}</b></div>}
        {voiceStatus?.lastError && <div className="gate-error">{voiceStatus.lastError}</div>}
        {voiceMessage && <div className={voiceMessage.startsWith('✕') ? 'gate-error' : 'dependency-output'}>{voiceMessage}</div>}
        <p className="panel-hint">한국어 전용 Zipformer가 설치되면 외래어와 명령 문장을 더 정확하게 오프라인 인식합니다. 음성 인식 자체에는 인터넷이나 AI 토큰을 사용하지 않습니다.</p>
      </Card></div>

      <div className={section === 'safety' ? '' : 'settings-section-hidden'}>
      <Card className="panel">
        <div className="panel-head">
          <h3>안전</h3>
        </div>
        {settings && (
          <div className="form-grid">
            <Field label="권한 강도" hint="모바일 토큰으로 연결된 PC 에이전트에도 동일하게 적용됩니다">
              <Select
                value={settings.safety.mode}
                onChange={(e) => void saveSettings({ safety: { ...settings.safety, mode: e.target.value as AppSettings['safety']['mode'] } })}
              >
                <option value="read-only">읽기 전용</option>
                <option value="ask">변경 전 승인 (권장)</option>
                <option value="workspace">지정 폴더는 자동, 나머지는 승인</option>
                <option value="full">전체 권한 — 확인 없이 실행</option>
              </Select>
            </Field>
            <Field label="자동 변경 허용 폴더" hint="지정 폴더 모드에서 사용. 세미콜론으로 여러 경로 구분">
              <Input value={(settings.safety.allowedRoots ?? []).join('; ')} onChange={(e) => setSettings({ ...settings, safety: { ...settings.safety, allowedRoots: e.target.value.split(';').map((x) => x.trim()).filter(Boolean) } })} onBlur={(e) => void saveSettings({ safety: { ...settings.safety, allowedRoots: e.target.value.split(';').map((x) => x.trim()).filter(Boolean) } })} placeholder="C:\\Users\\me\\Projects" />
            </Field>
            <Field label="장치 이름">
              <Input
                value={settings.deviceName}
                onChange={(e) => setSettings({ ...settings, deviceName: e.target.value })}
                onBlur={(e) => void saveSettings({ deviceName: e.target.value })}
              />
            </Field>
          </div>
        )}
      </Card></div>

      <div className={section === 'memory' ? '' : 'settings-section-hidden'}>
      <Card className="panel">
        <div className="panel-head"><div><h3>장기 기억</h3><p className="panel-hint">대화를 넘어 유지할 선호·환경·프로젝트 사실만 직접 저장합니다.</p></div></div>
        {!canWriteContent && <div className="access-inline"><b>읽기 전용 연결</b><span>저장된 기억은 볼 수 있지만 이 기기에서는 추가·삭제할 수 없습니다.</span></div>}
        <div className="type-row"><Input disabled={!canWriteContent} value={memoryText} onChange={(e) => setMemoryText(e.target.value)} placeholder="예: 기본 프로젝트 폴더는 C:\\Work 입니다" onKeyDown={(e) => { if (canWriteContent && e.key === 'Enter' && memoryText.trim()) void client.call('memory.add', { text: memoryText }).then(() => setMemoryText('')); }} /><Button disabled={!canWriteContent || !memoryText.trim()} onClick={() => void client.call('memory.add', { text: memoryText }).then(() => setMemoryText(''))}>기억 추가</Button></div>
        <div className="memory-list">{memories.map((item) => <div className="memory-item" key={item.id}><span>{item.text}</span><Button variant="danger" disabled={!canWriteContent} onClick={() => void client.call('memory.remove', { id: item.id })}>삭제</Button></div>)}{memories.length === 0 && <p className="panel-hint">저장된 장기 기억이 없습니다.</p>}</div>
      </Card></div>

      <div className={section === 'network' ? '' : 'settings-section-hidden'}>
      <Card className="panel">
        <div className="panel-head">
          <div><h3>네트워크 경계</h3><p className="panel-hint">로컬 단독 사용이 기본입니다. 다른 기기 연결은 필요한 범위만 직접 열어 주세요.</p></div>
          <Badge tone="accent">인증 토큰 필수</Badge>
        </div>
        {settings && (
          <div className="form-grid">
            <Field label="사설 Mesh 수신" hint="Tailscale 주소에서 받을 때만 사용합니다. Agent를 다시 시작한 뒤 적용됩니다.">
              <Select
                value={settings.network.host === '0.0.0.0' && settings.network.externalAccess ? 'lan' : 'local'}
                onChange={(e) => {
                  const lan = e.target.value === 'lan';
                  void saveSettings({ network: { ...settings.network, host: lan ? '0.0.0.0' : '127.0.0.1', externalAccess: lan } });
                }}
              >
                <option value="local">이 PC에서만 (권장)</option>
                <option value="lan">Tailscale 사설 Mesh 주소 수신</option>
              </Select>
            </Field>
            <Field label="포트">
              <Input
                type="number"
                value={settings.network.port}
                onChange={(e) => setSettings({ ...settings, network: { ...settings.network, port: Number(e.target.value) } })}
                onBlur={(e) => void saveSettings({ network: { ...settings.network, port: Number(e.target.value) } })}
              />
            </Field>
          </div>
        )}
        {settings?.network.host === '0.0.0.0' && settings.network.externalAccess
          ? <div className="access-inline"><b>평문 LAN 차단</b><span>일반 Wi-Fi/LAN 인증은 받지 않고 Tailscale 암호화 주소만 허용합니다. VPN 없이 쓰려면 Quick Link를 켜세요.</span></div>
          : <p className="panel-hint">127.0.0.1은 같은 PC에서만 접근할 수 있어 단독 사용에 가장 안전합니다.</p>}
        <p className="panel-hint">외부망 연결이 필요하면 플러그인에서 Cloudflare Quick Link를 필요한 동안만 켤 수 있습니다. 시스템 VPN을 만들지 않아 일반적으로 금융 앱에는 영향을 주지 않지만, 임시 베타 주소이므로 상시 운영용은 아닙니다.</p>
      </Card>
      <Card className="panel">
        <div className="panel-head"><div><h3>연결 provider 로드맵</h3><p className="panel-hint">연결 기술을 앱 핵심과 분리해 필요한 방식만 교체할 수 있습니다.</p></div></div>
        <div className="plugin-detail-facts">
          <span><b>1 · 로컬</b>loopback 기본 · 서버 불필요</span>
          <span><b>2 · 사설 Mesh</b>Tailscale 암호화 주소 · 선택 사항</span>
          <span><b>3 · 임시 원격</b>Cloudflare Quick Link · 기본 OFF</span>
          <span><b>4 · 계정 Mesh</b>Google Relay · 구성 전 비활성</span>
        </div>
        <div className="dependency-warning">Google 계정 Relay는 로그인만 붙인다고 완성되지 않습니다. Firebase 기기 directory, 공개키 기반 1회 승인, signaling, 종단간 암호화 relay가 배포된 뒤에만 활성화됩니다.</div>
      </Card></div>

      <div className={section === 'pairing' ? '' : 'settings-section-hidden'}>
      <Card className="panel">
        <div className="panel-head">
          <h3>모바일 연결</h3>
        </div>
        {pairing && (
          <div className="pairing-grid">
            {!remotePairingUrl && pairing.host === '127.0.0.1' ? <div className="pairing-remote-required">
              <span>☁</span>
              <b>Quick Link를 먼저 시작하세요</b>
              <p>현재 주소는 이 PC 안에서만 열립니다. 플러그인에서 Quick Link를 켜면 휴대폰이 인식할 HTTPS QR이 여기에 자동으로 표시됩니다.</p>
              <Button variant="accent" disabled={pairingLinkBusy} onClick={() => setDangerConfirm({
                title: 'Quick Link를 열고 QR을 만들까요?',
                message: '임시 Cloudflare HTTPS 주소로 이 PC를 외부에 공개합니다. 모든 요청에는 일회용 PIN 또는 등록 기기 인증이 필요하며, 사용 후 링크를 중지해야 합니다.',
                confirmLabel: 'Quick Link 시작·QR 만들기',
                action: startPairingQuickLink,
              })}>{pairingLinkBusy ? 'QR 준비 중…' : 'Quick Link 시작·QR 만들기'}</Button>
            </div> : <div className="pairing-qr">
              {qrUrl ? <img src={qrUrl} alt={remotePairingUrl ? 'Quick Link 페어링 QR' : '페어링 QR'} width={300} height={300} /> : <div className="qr-empty">QR 생성 중…</div>}
            </div>}
            <div className="pairing-info">
              <div className="pairing-host">
                📡 <b>{remotePairingUrl ?? `${pairing.host}:${pairing.port}`}</b>
              </div>
              <div className="pairing-routes">
                {remotePairingUrl && <span>Quick Link HTTPS <b>{remotePairingUrl}</b></span>}
                {remoteStatus?.websocketUrl && <span>Quick Link WSS <b>{remoteStatus.websocketUrl}</b></span>}
                <span>{remotePairingUrl ? 'PC 보조 접속 주소' : '보안 접속 주소'} <b>{pairing.host}:{pairing.port}</b></span>
                {pairing.hosts.filter((host) => host !== pairing.host).map((host) => <span key={host}>보조 접속 주소 <b>{host}:{pairing.port}</b></span>)}
                {pairing.host === '127.0.0.1' && !remotePairingUrl && <span className="warn">원격 보안 주소 없음 · VPN 없이 연결하려면 플러그인에서 Quick Link를 시작하세요.</span>}
              </div>
              <div className="pairing-pin">
                PIN <b>{pairing.pin}</b> <span>· 5분 / 1회용</span>
              </div>
              {pairing.maskedSecret && <div className="pairing-secret">
                시크릿 {pairing.maskedSecret}
              </div>}
              <p className="panel-hint">
                {remotePairingUrl || pairing.host !== '127.0.0.1'
                  ? <>폰의 Mr.Robot 앱에서 이 QR을 스캔하세요. {remotePairingUrl ? '실행 중인 Quick Link HTTPS 주소가 QR에 자동으로 포함됐습니다. ' : ''}PIN은 5분 만료·1회용이며 성공 즉시 새 PIN으로 회전합니다.</>
                  : <>휴대폰에서 사용할 수 있는 보안 주소가 아직 없습니다. 플러그인에서 Quick Link를 시작하면 QR과 원격 주소가 자동으로 나타납니다.</>}
              </p>
              {pairingLinkMessage && <p className="panel-hint">{pairingLinkMessage}</p>}
              <div className="plugin-actions">
                <Button variant="ghost" onClick={() => void client.call('pairing.regeneratePin', {}).then(() => void refresh())}>
                  PIN 재생성
                </Button>
                {remotePairingUrl && <Button variant="ghost" disabled={remoteHandoffBusy} onClick={() => void createRemoteHandoff()}>{remoteHandoffBusy ? '생성 중…' : '24시간·1회용 외출 코드 생성'}</Button>}
                <Button
                  variant="danger"
                  onClick={() => setDangerConfirm({ title: '모든 기기 연결을 초기화할까요?', message: '관리자 시크릿을 새로 만들면 현재 연결된 모바일과 다른 PC가 즉시 해제됩니다. 새 QR로 다시 연결해야 합니다.', confirmLabel: '시크릿 회전', action: async () => { await client.call('pairing.regenerate', {}); await refresh(); } })}
                >
                  시크릿 회전 (모든 연결 해제)
                </Button>
              </div>
              {remotePairingUrl && remoteHandoff && <div className="remote-handoff">
                <div><span>12자리 외출 코드</span><b>{remoteHandoff.pin}</b></div>
                <small>만료 {new Date(remoteHandoff.expiresAt).toLocaleString()} · 한 기기 연결 후 즉시 폐기 · 앱 재시작 시 폐기</small>
                <Button variant="ghost" onClick={() => void copyRemoteHandoff()}>코드 복사</Button>
                <Button variant="danger" onClick={() => void revokeRemoteHandoff()}>즉시 폐기</Button>
              </div>}
              {remoteHandoffMessage && <p className="panel-hint">{remoteHandoffMessage}</p>}
              <div className="linked-devices">
                <h4>연결된 기기</h4>
                {deviceLinks.filter((link) => !link.revokedAt).map((link) => <div className="linked-device" key={link.id}>
                  <div><b>{link.name}</b><span>{new Date(link.createdAt).toLocaleDateString()} 연결</span></div>
                  <div className="linked-device-policy">
                    <Select value={link.permissionCap} onChange={(e) => void client.call('pairing.link.update', { id: link.id, permissionCap: e.target.value }).then(() => void refresh())}>
                      <option value="read-only">읽기 전용</option><option value="ask">매번 승인</option><option value="workspace">작업 폴더 자동</option><option value="full">전체 권한</option>
                    </Select>
                    <Toggle
                      checked={link.capabilities?.includes('work-sync') === true}
                      disabled={capabilityBusyIds.has(link.id)}
                      label="작업 동기화"
                      onChange={(enabled) => void setDeviceCapability(link.id, 'work-sync', enabled)}
                    />
                    <Toggle
                      checked={link.capabilities?.includes('private-calendar') === true}
                      disabled={capabilityBusyIds.has(link.id)}
                      label="개인 근무 캘린더"
                      onChange={(enabled) => void setDeviceCapability(link.id, 'private-calendar', enabled)}
                    />
                  </div>
                  <Button variant="danger" onClick={() => setDangerConfirm({ title: '기기 연결을 해제할까요?', message: `${link.name} 기기의 인증이 취소되며 다시 사용하려면 새 PIN 또는 QR로 연결해야 합니다.`, confirmLabel: '연결 해제', action: async () => { await client.call('pairing.link.revoke', { id: link.id }); await refresh(); } })}>연결 해제</Button>
                </div>)}
                {deviceLinks.filter((link) => !link.revokedAt).length === 0 && <p className="panel-hint">아직 별도로 연결된 기기가 없습니다.</p>}
              </div>
            </div>
          </div>
        )}
      </Card></div>
      </div>
      <Modal open={presetBrowserOpen} onClose={() => setPresetBrowserOpen(false)} title="모델 시나리오 프리셋" size="wide">
        <div className="preset-browser">
          <aside className="preset-browser-list">
            {routingPresets.map((item) => <button key={item.id} className={item.id === selectedRoutingPresetId ? 'active' : ''} onClick={() => {
              setSelectedRoutingPresetId(item.id);
              setRoutingPresetName(item.builtin ? '' : item.name);
            }}><span>{item.builtin ? '기본' : '사용자'}</span><b>{item.name}</b><small>{item.executionMode === 'pipeline' ? '순차 검증' : item.executionMode === 'vote' ? '그룹 투표' : item.executionMode === 'hybrid' ? '혼합형' : item.executionMode === 'swarm' ? '경쟁 스웜' : '단일 선택'}</small></button>)}
          </aside>
          <section className="preset-browser-preview">
            {selectedRoutingPreset ? <>
              <div className="preset-preview-head"><div><h4>{selectedRoutingPreset.name}</h4><p>{selectedRoutingPreset.description}</p></div><div className="preset-preview-badges"><Badge tone="accent">{EXECUTION_LABEL[selectedRoutingPreset.executionMode ?? 'single']}</Badge>{(selectedRoutingPreset.executionMode === 'vote' || selectedRoutingPreset.executionMode === 'hybrid' || selectedRoutingPreset.executionMode === 'swarm') && <Badge>{selectedRoutingPreset.meetingRounds ?? 2}라운드</Badge>}{selectedRoutingPreset.executionMode === 'swarm' && <Badge>최대 {selectedRoutingPreset.maxIterations ?? 6}회</Badge>}<Badge>고비용 상한 {selectedRoutingPreset.maxPremiumCalls}</Badge></div></div>
              {selectedRoutingPreset.graph && <RoutingGraphEditor key={selectedRoutingPreset.id} graph={selectedRoutingPreset.graph} providers={providers} providerModels={modelOptions} readOnly />}
            </> : <p className="panel-hint">왼쪽에서 프리셋을 선택하세요.</p>}
            <div className="modal-actions"><Button variant="ghost" onClick={() => setPresetBrowserOpen(false)}>닫기</Button><Button variant="accent" disabled={!canManage || !selectedRoutingPreset} title={!canManage ? 'PC 데스크톱 관리자에서 적용할 수 있습니다.' : undefined} onClick={() => void applyRoutingPreset()}>이 프리셋 적용</Button></div>
          </section>
        </div>
      </Modal>
      <Modal open={repairOffer !== null} onClose={() => { if (!repairBusy) setRepairOffer(null); }} title={repairOffer?.helpers.length ? '연결 복구를 AI에게 맡길까요?' : '직접 연결이 필요합니다'}>
        {repairOffer && <div className="repair-assistant">
          <div className={`repair-orb ${repairOffer.helpers.length ? 'ready' : 'manual'}`}>{repairOffer.helpers.length ? '✦' : '!'}</div>
          <div className="repair-copy">
            <b>{repairOffer.target.label} 연결에 실패했습니다.</b>
            <p>{repairOffer.error}</p>
            {repairOffer.helpers.length > 0
              ? <p><strong>{repairOffer.helpers[0].label}</strong>이 진단부터 가능한 자동 조치와 검증까지 이어서 처리할 수 있습니다. 계정 로그인처럼 본인 확인이 필요한 단계는 사용자에게 넘깁니다.</p>
              : <p>현재 정상 연결된 AI가 하나도 없어 자동 복구를 위임할 수 없습니다. 먼저 이 연결을 직접 완료하면 이후부터 다른 AI가 복구를 도울 수 있습니다.</p>}
          </div>
          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setRepairOffer(null)} disabled={repairBusy}>{repairOffer.helpers.length ? '직접 처리' : '확인'}</Button>
            {repairOffer.helpers.length > 0 && <Button variant="accent" onClick={() => void delegateRepair()} disabled={repairBusy}>{repairBusy ? <><Spinner size={14} /> 맡기는 중…</> : `${repairOffer.helpers[0].label}에게 맡기기`}</Button>}
          </div>
        </div>}
      </Modal>
      <Modal open={dangerConfirm !== null} onClose={() => { if (!dangerBusy) setDangerConfirm(null); }} title={dangerConfirm?.title}>
        {dangerConfirm && <div className="delete-dialog"><div className="delete-dialog-icon">!</div><div><b>주의가 필요한 작업입니다.</b><p>{dangerConfirm.message}</p></div><div className="modal-actions"><Button variant="ghost" disabled={dangerBusy} onClick={() => setDangerConfirm(null)}>취소</Button><Button variant="danger" disabled={dangerBusy} onClick={() => void runDangerAction()}>{dangerBusy ? '처리 중…' : dangerConfirm.confirmLabel}</Button></div></div>}
      </Modal>
    </div>
  );
}
