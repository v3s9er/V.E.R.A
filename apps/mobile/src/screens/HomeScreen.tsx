import { useEffect, useState } from 'react';
import { Keyboard, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AppConnectionState } from '../../App';
import type { MrRobotClient } from '../rpc';
import type { ChatRunState, SavedPc } from '../types';
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
  pcs,
  connectionState,
  onRetryConnection,
  onSelectPc,
  onManagePcs,
}: {
  client: MrRobotClient;
  pc: SavedPc;
  pcs: SavedPc[];
  connectionState: AppConnectionState;
  onRetryConnection: () => void;
  onSelectPc: (pc: SavedPc) => void;
  onManagePcs: () => void;
}) {
  const [tab, setTab] = useState<Tab>('chat');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [showPcPicker, setShowPcPicker] = useState(false);
  const [executionBusy, setExecutionBusy] = useState(false);
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const compact = width < 390 || fontScale > 1.25;
  const authenticated = connectionState === 'connected' && client.authed;

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    const refreshRuns = async (): Promise<void> => {
      try {
        const runs = await client.call('chat.runs', {}, 5000) as ChatRunState[];
        if (active) setExecutionBusy(runs.some((run) => run.running));
      } catch {
        // Retain the last known state until this PC can be authenticated again.
      }
    };
    void refreshRuns();
    const offStatus = client.on('chat.status', () => setExecutionBusy(true));
    const offDone = client.on('chat.done', () => void refreshRuns());
    const offError = client.on('chat.error', () => void refreshRuns());
    return () => { active = false; offStatus(); offDone(); offError(); };
  }, [authenticated, client, pc.id]);

  return (
    <View style={[styles.root, { paddingLeft: insets.left, paddingRight: insets.right }]}>
      {!keyboardVisible && <View style={[styles.header, compact && styles.headerCompact, { paddingTop: Math.max(insets.top, 12) }]}>
        <View style={styles.headerText}>
          <Text style={styles.pcName} numberOfLines={1}>
            실행 PC · {pc.name}
          </Text>
          <Text style={styles.pcAddr} numberOfLines={1}>
            {connectionOrigins(pc)[0] ?? '보안 접속 주소 없음'}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.switchBtn, compact && styles.switchBtnCompact]}
          onPress={() => setShowPcPicker(true)}
          accessibilityRole="button"
          accessibilityLabel="실행 PC 선택"
          accessibilityHint="등록된 다른 PC로 명령 실행 대상을 바꿉니다."
        >
          <Text style={styles.switchText}>변경⌄</Text>
        </TouchableOpacity>
      </View>}

      {connectionState !== 'connected' && (
        <View style={styles.connectionBanner} accessibilityLiveRegion="polite">
          <View style={{ flex: 1 }}>
            <Text style={styles.connectionTitle}>{connectionState === 'reconnecting' ? 'PC에 다시 연결하는 중…' : 'PC 연결이 끊어졌습니다'}</Text>
            <Text style={styles.connectionCopy}>대화와 입력 내용은 유지됩니다.</Text>
          </View>
          <TouchableOpacity style={styles.retryBtn} onPress={onRetryConnection} accessibilityRole="button" accessibilityLabel="PC 다시 연결"><Text style={styles.retryText}>다시 연결</Text></TouchableOpacity>
        </View>
      )}

      <View style={styles.content}>
        {tab === 'chat' && <ChatScreen client={client} pc={pc} keyboardVisible={keyboardVisible} onExecutionBusyChange={(value) => { if (value) setExecutionBusy(true); }} />}
        {tab === 'files' && <FilesScreen pc={pc} />}
        {tab === 'schedules' && (
          <SchedulesScreen client={client} privateWorkAuthenticated={authenticated} />
        )}
        {tab === 'settings' && <SettingsScreen client={client} />}
      </View>

      {!keyboardVisible && <View style={[styles.tabbar, { paddingBottom: Math.max(insets.bottom, 8) }]} accessibilityRole="tablist">
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.key}
            style={styles.tab}
            onPress={() => setTab(t.key)}
            accessibilityRole="tab"
            accessibilityLabel={t.label}
            accessibilityState={{ selected: tab === t.key }}
          >
            <Text style={[styles.tabIcon, tab === t.key && styles.tabActive]}>{t.icon}</Text>
            <Text style={[styles.tabLabel, tab === t.key && styles.tabActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>}

      <Modal visible={showPcPicker} transparent animationType="fade" onRequestClose={() => setShowPcPicker(false)} accessibilityViewIsModal>
        <View style={[styles.pickerBackdrop, compact && styles.pickerBackdropCompact, { paddingTop: Math.max(12, insets.top), paddingBottom: Math.max(12, insets.bottom), paddingLeft: Math.max(compact ? 10 : 18, insets.left + 8), paddingRight: Math.max(compact ? 10 : 18, insets.right + 8) }]}>
          <View style={styles.pickerCard} accessibilityRole="summary">
            <View style={styles.pickerHeading}>
              <View style={{ flex: 1 }}>
                <Text style={styles.pickerTitle}>실행 PC 선택</Text>
                <Text style={styles.pickerCopy}>고정된 모체 PC 없이, 지금 명령을 처리할 에이전트를 선택합니다.</Text>
              </View>
              <TouchableOpacity style={styles.pickerClose} onPress={() => setShowPcPicker(false)} accessibilityRole="button" accessibilityLabel="실행 PC 선택 닫기"><Text style={styles.pickerCloseText}>×</Text></TouchableOpacity>
            </View>
            {executionBusy && <View style={styles.pickerBusyNotice}><Text style={styles.pickerBusyTitle}>현재 PC에서 작업 중입니다</Text><Text style={styles.pickerBusyCopy}>작업을 중지하거나 완료한 뒤 실행 PC를 변경하세요. 연결만 끊고 작업을 백그라운드에 남기지 않습니다.</Text></View>}
            <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent} keyboardShouldPersistTaps="handled">
              {pcs.length === 0 && <Text style={styles.pickerEmpty}>등록된 PC가 없습니다. 아래 버튼에서 PC를 추가하세요.</Text>}
              {pcs.map((candidate) => {
                const selected = candidate.id === pc.id;
                return <TouchableOpacity
                  key={candidate.id}
                   style={[styles.pickerPc, selected && styles.pickerPcSelected]}
                  disabled={selected || executionBusy}
                   accessibilityState={{ selected, disabled: selected || executionBusy }}
                   accessibilityRole="button"
                   accessibilityLabel={`${candidate.name}, ${selected ? '현재 실행 PC' : '실행 PC로 선택'}`}
                  onPress={() => {
                    setShowPcPicker(false);
                    onSelectPc(candidate);
                  }}
                >
                  <View style={styles.pickerPcIcon}><Text>🖥️</Text></View>
                  <View style={styles.pickerPcInfo}><Text style={styles.pickerPcName} numberOfLines={1}>{candidate.name}</Text><Text style={styles.pickerPcRoute} numberOfLines={2}>{connectionOrigins(candidate)[0] ?? '보안 접속 주소 없음'}</Text></View>
                  <Text style={[styles.pickerPcState, selected && styles.pickerPcStateSelected]}>{selected ? '현재 실행' : executionBusy ? '작업 후 선택' : '선택'}</Text>
                </TouchableOpacity>;
              })}
            </ScrollView>
            <TouchableOpacity style={[styles.manageBtn, executionBusy && styles.manageBtnDisabled]} disabled={executionBusy} accessibilityRole="button" accessibilityState={{ disabled: executionBusy }} onPress={() => { setShowPcPicker(false); onManagePcs(); }}><Text style={styles.manageBtnText}>{executionBusy ? '작업 완료 후 연결 관리 가능' : '＋ PC 추가·연결 관리'}</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  headerCompact: { paddingHorizontal: 12 },
  headerText: { flex: 1, minWidth: 0 },
  pcName: { color: colors.text, fontSize: 16, fontWeight: '700' },
  pcAddr: { color: colors.faint, fontSize: 12, marginTop: 2 },
  switchBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minHeight: 44,
    justifyContent: 'center',
  },
  switchBtnCompact: { paddingHorizontal: 10 },
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
  tab: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 3 },
  tabIcon: { fontSize: 20, opacity: 0.45 },
  tabLabel: { fontSize: 11, color: colors.faint, fontWeight: '600' },
  tabActive: { color: colors.accent, opacity: 1 },
  pickerBackdrop: { flex: 1, justifyContent: 'center', paddingHorizontal: 18, backgroundColor: 'rgba(2,5,12,.78)' },
  pickerBackdropCompact: { paddingHorizontal: 10 },
  pickerCard: { width: '100%', maxWidth: 560, maxHeight: '94%', alignSelf: 'center', padding: 16, gap: 14, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: '#111729' },
  pickerHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  pickerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  pickerCopy: { marginTop: 5, color: colors.dim, fontSize: 12, lineHeight: 17 },
  pickerClose: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  pickerCloseText: { color: colors.dim, fontSize: 22, lineHeight: 24 },
  pickerBusyNotice: { padding: 11, borderWidth: 1, borderColor: 'rgba(251,191,36,.35)', borderRadius: radius.md, backgroundColor: 'rgba(251,191,36,.08)' },
  pickerBusyTitle: { color: colors.warn, fontSize: 12.5, fontWeight: '800' },
  pickerBusyCopy: { marginTop: 4, color: colors.dim, fontSize: 11, lineHeight: 16 },
  pickerList: { flexGrow: 0 },
  pickerListContent: { gap: 8 },
  pickerEmpty: { color: colors.dim, fontSize: 13, lineHeight: 19, textAlign: 'center', paddingVertical: 18 },
  pickerPc: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: 'rgba(255,255,255,.025)' },
  pickerPcSelected: { borderColor: 'rgba(124,92,255,.72)', backgroundColor: 'rgba(124,92,255,.14)' },
  pickerPcIcon: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, backgroundColor: 'rgba(124,92,255,.12)' },
  pickerPcInfo: { flex: 1, minWidth: 0 },
  pickerPcName: { color: colors.text, fontSize: 14, fontWeight: '700' },
  pickerPcRoute: { marginTop: 3, color: colors.faint, fontSize: 10.5 },
  pickerPcState: { color: colors.accent2, fontSize: 11, fontWeight: '800', flexShrink: 0 },
  pickerPcStateSelected: { color: colors.accent },
  manageBtn: { alignItems: 'center', padding: 12, borderWidth: 1, borderColor: 'rgba(34,211,238,.38)', borderRadius: radius.md, backgroundColor: 'rgba(34,211,238,.08)' },
  manageBtnDisabled: { opacity: 0.5, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,.025)' },
  manageBtnText: { color: colors.accent2, fontSize: 13, fontWeight: '800' },
});
