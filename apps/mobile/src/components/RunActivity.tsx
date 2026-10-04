import { useEffect, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { activityLabel, agentActivityLabel, AGENT_STATE_LABELS, executionPresentation, runPresentation } from '../../../../packages/shared/src/run-presentation';
import type { RoutingExecutionMode } from '../../../../packages/shared/src/protocol';
import type { ChatRunState } from '../types';
import { colors } from '../theme';

/** A compact dock with a separate sheet, so history never pushes the keyboard/composer off screen. */
export function RunActivity({ run, busy, compact = false, executionMode }: { run: ChatRunState | null; busy: boolean; compact?: boolean; executionMode?: RoutingExecutionMode }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!busy) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [busy]);
  useEffect(() => setOpen(false), [run?.conversationId]);
  if (!busy && !run?.phase) return null;
  const view = runPresentation({ ...run, busy }, now);
  const execution = executionPresentation(executionMode, run?.agents);
  return <>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={compact && view.observationNotice ? '작업 진행 기록 펼치기 · 일부 도구 기록 제공 안 됨' : '작업 진행 기록 펼치기'} accessibilityHint={`${view.heading}. ${view.detail}. ${view.observationNotice}`} accessibilityState={{ expanded: open }} onPress={() => setOpen(true)} style={[s.dock, compact && s.compact]}>
      <Text style={{ color: view.hasErrors || view.state === 'failed' ? colors.err : colors.accent2 }}>{view.state === 'completed' ? (view.hasErrors ? '!' : '✓') : '✦'}</Text>
      {!compact && <><View style={s.heading}><Text accessibilityLiveRegion="polite" style={s.title} numberOfLines={1}>{view.heading}</Text><Text style={s.detail} numberOfLines={1}>{view.detail}{run?.steeringQueued ? ` · 추가 지시 ${run.steeringQueued}개` : ''}</Text>{view.observationNotice && <Text style={s.detail}>{view.observationNotice}</Text>}</View>
      <Text style={s.detail}>{view.elapsed}</Text><Text style={s.detail}>⌄</Text></>}
      {compact && view.observationNotice && <Text style={s.limitedBadge} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">i</Text>}
    </TouchableOpacity>
    <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
      <View style={s.backdrop}><TouchableOpacity accessibilityLabel="작업 기록 닫기" style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
        <View style={s.sheet} accessibilityViewIsModal>
          <View style={s.header}><Text style={s.title}>작업 기록</Text><TouchableOpacity accessibilityRole="button" accessibilityLabel="닫기" onPress={() => setOpen(false)} style={s.close}><Text style={s.title}>×</Text></TouchableOpacity></View>
          <ScrollView contentContainerStyle={s.content}>
            <Text style={s.title}>{view.heading} {view.elapsed}</Text><Text style={s.detail}>{view.detail}</Text>
            {view.observationNotice && <Text style={s.detail}>{view.observationNotice}</Text>}
            <Text style={s.detail}>{execution.selected} · {execution.detail}</Text><Text style={s.detail}>{execution.observed}</Text>
            {run?.agents?.map(agent => <View key={agent.agentId} style={s.row}><Text style={s.title}>{agentActivityLabel(agent.label)} · {AGENT_STATE_LABELS[agent.state]}</Text><Text style={s.detail}>{agent.model || '모델 확인 중'}</Text><Text style={s.detail}>{agent.usage.promptTokens + agent.usage.completionTokens > 0 ? `입력 ${agent.usage.promptTokens.toLocaleString()} · 출력 ${agent.usage.completionTokens.toLocaleString()} 토큰` : '토큰 사용량 미보고'}</Text></View>)}
            {run?.activity?.map(item => <View key={item.id} style={s.row}><Text style={[s.title, item.state === 'error' && { color: colors.err }]}>{item.state === 'done' ? '✓' : item.state === 'error' ? '!' : '·'} {activityLabel(item.label)}</Text><Text style={s.detail}>{item.state === 'error' ? '오류 · ' : ''}{item.finishedAt ? `${Math.max(0, (item.finishedAt - item.startedAt) / 1000).toFixed(1)}초` : view.terminal ? '완료 미확인' : '진행 중'}</Text></View>)}
            <Text style={s.note}>{view.historyNotice && `${view.historyNotice}. `}실제 실행 이벤트입니다. 응답 종료가 결과 검증을 뜻하지는 않습니다.</Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  </>;
}
const s = StyleSheet.create({
  dock: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 18, paddingVertical: 8, minHeight: 48, backgroundColor: colors.bg },
  compact: { minHeight: 40, width: 40, paddingHorizontal: 0, paddingVertical: 0, justifyContent: 'center', backgroundColor: 'transparent' },
  limitedBadge: { position: 'absolute', top: 1, right: 2, fontSize: 10, color: colors.dim },
  heading: { flex: 1, minWidth: 0, gap: 3 }, title: { color: colors.text, fontSize: 12, fontWeight: '600' }, detail: { color: colors.dim, fontSize: 11 },
  backdrop: { flex: 1, backgroundColor: '#0008', justifyContent: 'flex-end' },
  sheet: { maxHeight: '75%', backgroundColor: colors.card, borderTopWidth: 1, borderColor: '#ffffff18', borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingBottom: 28 },
  header: { paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  close: { minWidth: 44, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, gap: 8 }, row: { gap: 5, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  note: { fontSize: 10, color: colors.dim, marginTop: 12, lineHeight: 16 },
});
