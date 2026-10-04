import { StyleSheet, Text, View } from 'react-native';
import { runPresentation, runTimeline } from '../../../../packages/shared/src/run-presentation';
import type { ChatRunState } from '../types';
import { colors } from '../theme';

/** Only actual current-run events; the reply replaces this placeholder when it arrives. */
export function RunTimeline({ run, busy }: { run: ChatRunState | null; busy: boolean }) {
  const view = runPresentation({ ...run, busy });
  const rows = runTimeline(run ?? {});
  return <View style={s.card} accessibilityLabel="실시간 작업 로그">
    <Text style={s.heading}>✦ {view.heading}</Text>
    {rows.map(row => <View key={row.id} style={s.row}>
      <Text style={[s.dot, { color: row.state === 'error' ? colors.err : row.state === 'done' ? colors.ok : colors.accent }]}>{row.state === 'done' ? '✓' : row.state === 'error' ? '!' : '·'}</Text>
      <Text style={s.label}>{row.label}</Text>
      <Text style={s.state}>{row.state === 'done' ? '완료' : row.state === 'error' ? '오류' : view.terminal ? '완료 미확인' : '실행 중'}</Text>
    </View>)}
    <Text accessibilityLiveRegion="polite" style={s.detail}>{view.detail}</Text>
    {!rows.length && <Text style={s.note}>아직 도구 실행 이벤트가 없습니다.</Text>}
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
