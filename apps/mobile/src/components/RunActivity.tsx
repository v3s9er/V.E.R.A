import { useEffect, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { activityLabel, AGENT_STATE_LABELS, runPresentation } from '../../../../packages/shared/src/run-presentation';
import type { ChatRunState } from '../types';
import { colors } from '../theme';

/** A compact dock with a separate sheet, so history never pushes the keyboard/composer off screen. */
export function RunActivity({ run, busy, compact = false }: { run: ChatRunState | null; busy: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!busy) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [busy]);
  useEffect(() => setOpen(false), [run?.conversationId]);
  if (!busy && !run?.phase) return null;
  const view = runPresentation({ ...run, busy }, now);
  return <>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="작업 진행 기록 펼치기" accessibilityHint={`${view.heading}. ${view.detail}`} accessibilityState={{ expanded: open }} onPress={() => setOpen(true)} style={[s.dock, compact && s.compact]}>
      <Text style={{ color: view.errors || view.state === 'failed' ? colors.err : colors.accent2 }}>{view.state === 'completed' ? (view.errors ? '!' : '✓') : '✦'}</Text>
      {!compact && <><View style={s.heading}><Text accessibilityLiveRegion="polite" style={s.title} numberOfLines={1}>{view.heading}</Text><Text style={s.detail} numberOfLines={1}>{view.detail}{run?.steeringQueued ? ` · 추가 지시 ${run.steeringQueued}개` : ''}</Text></View>
      <Text style={s.detail}>{view.elapsed}</Text><Text style={s.detail}>⌄</Text></>}
    </TouchableOpacity>
    <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
      <View style={s.backdrop}><TouchableOpacity accessibilityLabel="작업 기록 닫기" style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
        <View style={s.sheet} accessibilityViewIsModal>
          <View style={s.header}><Text style={s.title}>작업 기록</Text><TouchableOpacity accessibilityRole="button" accessibilityLabel="닫기" onPress={() => setOpen(false)} style={s.close}><Text style={s.title}>×</Text></TouchableOpacity></View>
          <ScrollView contentContainerStyle={s.content}>
            <Text style={s.title}>{view.heading} {view.elapsed}</Text><Text style={s.detail}>{view.detail}</Text>
            {run?.agents?.map(agent => <View key={agent.agentId} style={s.row}><Text style={s.title}>{agent.label} · {AGENT_STATE_LABELS[agent.state]}</Text><Text style={s.detail}>{agent.model || '모델 확인 중'}</Text><Text style={s.detail}>{agent.usage.promptTokens + agent.usage.completionTokens > 0 ? `입력 ${agent.usage.promptTokens.toLocaleString()} · 출력 ${agent.usage.completionTokens.toLocaleString()} 토큰` : '토큰 사용량 미보고'}</Text></View>)}
            {run?.activity?.map(item => <View key={item.id} style={s.row}><Text style={[s.title, item.state === 'error' && { color: colors.err }]}>{item.state === 'done' ? '✓' : item.state === 'error' ? '!' : '·'} {activityLabel(item.label)}</Text><Text style={s.detail}>{item.state === 'error' ? '오류 · ' : ''}{item.finishedAt ? `${Math.max(0, (item.finishedAt - item.startedAt) / 1000).toFixed(1)}초` : view.terminal ? '완료 미확인' : '진행 중'}</Text></View>)}
            <Text style={s.note}>실제 실행 이벤트입니다. 응답 종료가 결과 검증을 뜻하지는 않습니다.</Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  </>;
}
const s = StyleSheet.create({
  dock: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 18, paddingVertical: 8, minHeight: 48, backgroundColor: colors.bg },
  compact: { minHeight: 40, width: 40, paddingHorizontal: 0, paddingVertical: 0, justifyContent: 'center', backgroundColor: 'transparent' },
  heading: { flex: 1, minWidth: 0, gap: 3 }, title: { color: colors.text, fontSize: 12, fontWeight: '600' }, detail: { color: colors.dim, fontSize: 11 },
  backdrop: { flex: 1, backgroundColor: '#0008', justifyContent: 'flex-end' },
  sheet: { maxHeight: '75%', backgroundColor: colors.card, borderTopWidth: 1, borderColor: '#ffffff18', borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingBottom: 28 },
  header: { paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  close: { minWidth: 44, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, gap: 8 }, row: { gap: 5, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  note: { fontSize: 10, color: colors.dim, marginTop: 12, lineHeight: 16 },
});
