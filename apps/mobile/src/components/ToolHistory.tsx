import { useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { activityLabel } from '../../../../packages/shared/src/run-presentation';
import { colors } from '../theme';

export function ToolHistory({ tools }: { tools: { key: string; name: string; status: 'start' | 'done' | 'error' }[] }) {
  const [open, setOpen] = useState(false);
  if (!tools.length) return null;
  const errors = tools.filter(t => t.status === 'error').length;
  return <View style={{ marginTop: 6 }}>
    <TouchableOpacity accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: errors ? colors.err : colors.dim, fontSize: 12 }}>작업 내역 {tools.length}개{errors ? ` · 오류 ${errors}개` : ''} {open ? '⌃' : '⌄'}</Text></TouchableOpacity>
    {open && <ScrollView nestedScrollEnabled style={{ maxHeight: 180 }}>{tools.map(t => <Text key={t.key} style={{ paddingVertical: 6, color: t.status === 'error' ? colors.err : colors.dim, fontSize: 12 }}>{t.status === 'done' ? '✓' : t.status === 'error' ? '!' : '·'} {activityLabel(t.name)}</Text>)}</ScrollView>}
  </View>;
}
