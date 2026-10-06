import { StyleSheet, Text, View } from 'react-native';
import { executionPresentation, runPresentation, runTimeline, timelineStateLabel } from '../../../../packages/shared/src/run-presentation';
import type { RoutingExecutionMode } from '../../../../packages/shared/src/protocol';
import type { ChatRunState } from '../types';
import { colors } from '../theme';

/** Only actual current-run events; the reply replaces this placeholder when it arrives. */
export function RunTimeline({ run, busy, executionMode }: { run: ChatRunState | null; busy: boolean; executionMode?: RoutingExecutionMode }) {
  const view = runPresentation({ ...run, busy });
  const rows = runTimeline(run ?? {});
  const execution = executionPresentation(executionMode, run?.agents, run?.activity);
  return <View style={s.card} accessibilityLabel="실시간 작업 로그">
    <Text style={s.heading}>✦ {view.heading}</Text>
    <View accessibilityLabel="선택한 실행 방식과 실제 보조 작업"><Text style={s.detail}>{execution.selected}</Text><Text style={s.note}>{execution.detail}</Text><Text style={s.note}>{execution.observed}</Text></View>
    {rows.map(row => <View key={row.id} style={s.row}>
      <Text style={[s.dot, { color: row.state === 'error' ? colors.err : row.state === 'done' ? colors.ok : colors.accent }]}>{row.state === 'done' ? '✓' : row.state === 'error' ? '!' : row.state === 'cancelled' ? '−' : '·'}</Text>
      <Text style={s.label}>{row.label}</Text>
      <Text style={s.state}>{timelineStateLabel(row.state, view.terminal)}</Text>
    </View>)}
    <Text accessibilityLiveRegion="polite" style={s.detail}>{view.detail}</Text>
    {view.workNotice && <Text style={s.note}>{view.workNotice}</Text>}
    {!rows.length && <Text style={s.note}>아직 도구·보조 실행 이벤트가 없습니다.</Text>}
  </View>;
}
const s = StyleSheet.create({
  card: { alignSelf: 'stretch', borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 12, backgroundColor: '#ffffff03', gap: 8 },
  heading: { color: colors.text, fontSize: 12, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingVertical: 3 },
  dot: { width: 14, fontSize: 12 }, label: { flex: 1, color: colors.dim, fontSize: 12 },
  state: { color: colors.faint, fontSize: 10 }, detail: { color: colors.dim, fontSize: 12, lineHeight: 18 },
  note: { color: colors.faint, fontSize: 10, lineHeight: 15 },
});
