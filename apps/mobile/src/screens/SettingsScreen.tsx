import { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { MrRobotClient } from '../rpc';
import type { AppSettings, ProviderInfo, ProviderType, SystemStatus } from '../types';
import { colors, radius } from '../theme';

const TYPE_LABEL: Record<ProviderType, string> = {
  'openai-compatible': 'OpenAI 호환',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
  'codex-cli': 'Codex 구독',
  'claude-cli': 'Claude 구독',
};

/** One-tap service presets: pick a service, only the API key is left to fill. */
const SERVICE_PRESETS: Array<{ label: string; type: ProviderType; baseUrl: string; model: string }> = [
  { label: 'DeepSeek', type: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' },
  { label: 'OpenAI', type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-terra' },
  { label: 'Groq', type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { label: 'Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5' },
  { label: 'Ollama', type: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'llama3.1' },
];

export function SettingsScreen({ client }: { client: MrRobotClient }) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // provider form
  const [label, setLabel] = useState('');
  const [type, setType] = useState<ProviderType>('openai-compatible');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [s, p, set] = await Promise.all([
        client.call('status', {}) as Promise<SystemStatus>,
        client.call('providers.list', {}) as Promise<ProviderInfo[]>,
        client.call('settings.get', {}) as Promise<AppSettings>,
      ]);
      setStatus(s);
      setProviders(p);
      setSettings(set);
    } catch {
      /* ignore */
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    const offP = client.on('providers.changed', (d) => setProviders(d as ProviderInfo[]));
    const offS = client.on('settings.changed', (d) => setSettings(d as AppSettings));
    return () => {
      offP();
      offS();
    };
  }, [client, refresh]);

  const addProvider = async (): Promise<void> => {
    if (busy || !model.trim()) return;
    setBusy(true);
    setError('');
    try {
      await client.call('providers.add', {
        label: label.trim() || model.trim(),
        type,
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
      });
      setShowAdd(false);
      setLabel('');
      setBaseUrl('');
      setModel('');
      setApiKey('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async (patch: Partial<AppSettings>): Promise<void> => {
    try {
      await client.call('settings.set', patch);
    } catch {
      /* ignore */
    }
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      {status && (
        <View style={styles.card}>
          <Text style={styles.title}>PC 정보</Text>
          <Text style={styles.dim}>
            {status.hostname} · {status.platform} · v{status.version}
          </Text>
          <Text style={styles.dim}>
            제공자 {status.providers}개 · 플러그인 {status.plugins}개
          </Text>
        </View>
      )}

      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.title}>AI 제공자</Text>
          <TouchableOpacity style={styles.smallBtn} onPress={() => setShowAdd(true)}>
            <Text style={styles.smallBtnText}>＋ 추가</Text>
          </TouchableOpacity>
        </View>
        {providers.length === 0 && <Text style={styles.dim}>제공자가 없습니다. API 키를 추가하세요.</Text>}
        {providers.map((p) => (
          <View key={p.id} style={styles.providerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.providerName}>
                {p.label} {p.isDefault ? '· 기본' : ''}
              </Text>
              <Text style={styles.dim} numberOfLines={1}>
                {TYPE_LABEL[p.type]} · {p.model}
              </Text>
              <Text style={styles.faint} numberOfLines={1}>
                {p.baseUrl}
              </Text>
            </View>
            <View style={{ gap: 6 }}>
              {!p.isDefault && (
                <TouchableOpacity style={styles.smallBtn} onPress={() => void client.call('providers.setDefault', { id: p.id }).catch(() => undefined)}>
                  <Text style={styles.smallBtnText}>기본으로</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.smallBtn, styles.dangerBtn]}
                onPress={() => void client.call('providers.remove', { id: p.id }).catch(() => undefined)}
              >
                <Text style={[styles.smallBtnText, { color: colors.err }]}>삭제</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </View>

      {settings && (
        <View style={styles.card}>
          <Text style={styles.title}>접근 권한 단계</Text>
          <Text style={styles.faint}>모델 종류와 무관하게 PC 에이전트·MCP·플러그인에 같은 상한이 적용됩니다.</Text>
          <View style={styles.chipRow}>{([
            ['read-only', '읽기 전용'], ['ask', '매번 승인'], ['workspace', '작업 폴더'], ['full', '전체 허용'],
          ] as const).map(([value, text]) => <TouchableOpacity key={value} style={[styles.chip, settings.safety.mode === value && styles.chipOn]} onPress={() => void saveSettings({ safety: { ...settings.safety, mode: value } })}><Text style={[styles.chipText, settings.safety.mode === value && styles.chipTextOn]}>{text}</Text></TouchableOpacity>)}</View>
          <Text style={styles.faint}>{settings.safety.mode === 'read-only' ? '조회만 허용합니다.' : settings.safety.mode === 'ask' ? '변경 작업마다 승인을 요청합니다.' : settings.safety.mode === 'workspace' ? '선택한 작업 폴더 안의 변경만 자동 허용합니다.' : '모든 작업을 자동 허용합니다. 신뢰할 수 있는 환경에서만 사용하세요.'}</Text>
          <Text style={styles.label}>장치 이름</Text>
          <TextInput
            style={styles.input}
            value={settings.deviceName}
            onChangeText={(t) => setSettings({ ...settings, deviceName: t })}
            onBlur={() => void saveSettings({ deviceName: settings.deviceName })}
            placeholderTextColor={colors.faint}
          />
        </View>
      )}

      <Modal visible={showAdd} animationType="slide" transparent onRequestClose={() => setShowAdd(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modal}>
            <Text style={styles.title}>제공자 추가</Text>
            <Text style={styles.faint}>서비스를 고르면 주소·모델이 자동 입력됩니다 — 키만 넣으세요.</Text>
            <View style={styles.chipRow}>
              {SERVICE_PRESETS.map((p) => (
                <TouchableOpacity
                  key={p.label}
                  style={styles.chip}
                  onPress={() => {
                    setLabel(p.label);
                    setType(p.type);
                    setBaseUrl(p.baseUrl);
                    setModel(p.model);
                  }}
                >
                  <Text style={styles.chipText}>{p.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.chipRow}>
              {(['openai-compatible', 'anthropic', 'ollama'] as const).map((t) => (
                <TouchableOpacity key={t} style={[styles.chip, type === t && styles.chipOn]} onPress={() => setType(t)}>
                  <Text style={[styles.chipText, type === t && styles.chipTextOn]}>{TYPE_LABEL[t]}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.label}>이름</Text>
            <TextInput style={styles.input} value={label} onChangeText={setLabel} placeholder="예: 내 OpenAI" placeholderTextColor={colors.faint} />
            <Text style={styles.label}>모델</Text>
            <TextInput
              style={styles.input}
              value={model}
              onChangeText={setModel}
              placeholder={type === 'anthropic' ? 'claude-sonnet-5' : type === 'ollama' ? 'llama3.1' : 'gpt-5.6-terra'}
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
            />
            <Text style={styles.label}>Base URL (선택)</Text>
            <TextInput
              style={styles.input}
              value={baseUrl}
              onChangeText={setBaseUrl}
              placeholder={type === 'anthropic' ? 'https://api.anthropic.com' : type === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1'}
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
            />
            <Text style={styles.label}>API 키</Text>
            <TextInput style={styles.input} value={apiKey} onChangeText={setApiKey} placeholder="sk-…" placeholderTextColor={colors.faint} secureTextEntry autoCapitalize="none" />
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.smallBtn, { flex: 1, paddingVertical: 12 }]} onPress={() => setShowAdd(false)}>
                <Text style={styles.smallBtnText}>취소</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.addBtn, { flex: 1 }, (busy || !model.trim()) && { opacity: 0.5 }]}
                onPress={() => void addProvider()}
                disabled={busy || !model.trim()}
              >
                <Text style={styles.smallBtnText}>{busy ? '추가 중…' : '추가'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 14, gap: 12, paddingBottom: 30 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 14, gap: 10 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: colors.text, fontSize: 15, fontWeight: '700' },
  dim: { color: colors.dim, fontSize: 13, lineHeight: 19 },
  faint: { color: colors.faint, fontSize: 12, lineHeight: 17 },
  label: { color: colors.dim, fontSize: 13, fontWeight: '600', marginTop: 4 },
  input: {
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: 13,
    paddingVertical: 10,
    fontSize: 14,
  },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 10,
  },
  providerName: { color: colors.text, fontWeight: '700', fontSize: 14 },
  smallBtn: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 7, alignItems: 'center' },
  smallBtnText: { color: colors.text, fontWeight: '700', fontSize: 12.5 },
  dangerBtn: { borderColor: 'rgba(248,113,113,0.4)', backgroundColor: 'rgba(248,113,113,0.1)' },
  addBtn: { backgroundColor: colors.accent, borderRadius: radius.sm, paddingVertical: 12, alignItems: 'center' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  chipRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: colors.inputBg },
  chipOn: { backgroundColor: 'rgba(124,92,255,0.3)', borderColor: colors.accent },
  chipText: { color: colors.dim, fontSize: 12.5, fontWeight: '600' },
  chipTextOn: { color: '#fff' },
  errorText: { color: colors.err, fontSize: 13 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(4,6,12,0.7)', justifyContent: 'center', padding: 24 },
  modal: { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 20, gap: 8 },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 12 },
});
