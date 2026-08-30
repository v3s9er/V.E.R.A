import { useEffect, useState } from 'react';
import { Keyboard, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AppConnectionState } from '../../App';
import type { MrRobotClient } from '../rpc';
import type { SavedPc } from '../types';
import { colors, radius } from '../theme';
import { ChatScreen } from './ChatScreen';
import { SchedulesScreen } from './SchedulesScreen';
import { SettingsScreen } from './SettingsScreen';
import { FilesScreen } from './FilesScreen';
import { connectionOrigins } from '../pcs';

type Tab = 'chat' | 'files' | 'schedules' | 'settings';

const TABS: Array<{ key: Tab; label: string; icon: string }> = [
  { key: 'chat', label: '대화', icon: '💬' },
  { key: 'files', label: '파일', icon: '⇄' },
  { key: 'schedules', label: '예약', icon: '⏰' },
  { key: 'settings', label: '설정', icon: '⚙️' },
];

export function HomeScreen({
  client,
  pc,
  connectionState,
  onRetryConnection,
  onSwitchPc,
}: {
  client: MrRobotClient;
  pc: SavedPc;
  connectionState: AppConnectionState;
  onRetryConnection: () => void;
  onSwitchPc: () => void;
}) {
  const [tab, setTab] = useState<Tab>('chat');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: Math.max(insets.top, 12) }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.pcName} numberOfLines={1}>
            🖥️ {pc.name}
          </Text>
          <Text style={styles.pcAddr} numberOfLines={1}>
            {connectionOrigins(pc)[0] ?? '보안 접속 주소 없음'}
          </Text>
        </View>
        <TouchableOpacity style={styles.switchBtn} onPress={onSwitchPc}>
          <Text style={styles.switchText}>PC 전환</Text>
        </TouchableOpacity>
      </View>

      {connectionState !== 'connected' && (
        <View style={styles.connectionBanner}>
          <View style={{ flex: 1 }}>
            <Text style={styles.connectionTitle}>{connectionState === 'reconnecting' ? 'PC에 다시 연결하는 중…' : 'PC 연결이 끊어졌습니다'}</Text>
            <Text style={styles.connectionCopy}>대화와 입력 내용은 유지됩니다.</Text>
          </View>
          <TouchableOpacity style={styles.retryBtn} onPress={onRetryConnection}><Text style={styles.retryText}>다시 연결</Text></TouchableOpacity>
        </View>
      )}

      <View style={styles.content}>
        {tab === 'chat' && <ChatScreen client={client} pc={pc} keyboardVisible={keyboardVisible} />}
        {tab === 'files' && <FilesScreen pc={pc} />}
        {tab === 'schedules' && <SchedulesScreen client={client} />}
        {tab === 'settings' && <SettingsScreen client={client} />}
      </View>

      {!keyboardVisible && <View style={[styles.tabbar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {TABS.map((t) => (
          <TouchableOpacity key={t.key} style={styles.tab} onPress={() => setTab(t.key)}>
            <Text style={[styles.tabIcon, tab === t.key && styles.tabActive]}>{t.icon}</Text>
            <Text style={[styles.tabLabel, tab === t.key && styles.tabActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingBottom: 12,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pcName: { color: colors.text, fontSize: 16, fontWeight: '700' },
  pcAddr: { color: colors.faint, fontSize: 12, marginTop: 2 },
  switchBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  switchText: { color: colors.dim, fontSize: 13, fontWeight: '600' },
  connectionBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 9, backgroundColor: 'rgba(251,191,36,.11)', borderBottomWidth: 1, borderBottomColor: 'rgba(251,191,36,.28)' },
  connectionTitle: { color: colors.warn, fontSize: 12.5, fontWeight: '800' },
  connectionCopy: { color: colors.dim, fontSize: 10.5, marginTop: 2 },
  retryBtn: { borderWidth: 1, borderColor: 'rgba(251,191,36,.45)', borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 7 },
  retryText: { color: colors.warn, fontSize: 11.5, fontWeight: '800' },
  content: { flex: 1 },
  tabbar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.02)',
    paddingTop: 8,
  },
  tab: { flex: 1, alignItems: 'center', gap: 3 },
  tabIcon: { fontSize: 20, opacity: 0.45 },
  tabLabel: { fontSize: 11, color: colors.faint, fontWeight: '600' },
  tabActive: { color: colors.accent, opacity: 1 },
});
