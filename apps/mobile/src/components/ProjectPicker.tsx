import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MrRobotClient } from '../rpc';
import type { WorkspaceInfo } from '../types';
import { colors } from '../theme';

export function ProjectPicker({ client, visible, projects, active, onClose, onSelect, onChanged }: {
  client: MrRobotClient; visible: boolean; projects: WorkspaceInfo[]; active: string;
  onClose: () => void; onSelect: (id: string) => void; onChanged: (items: WorkspaceInfo[]) => void;
}) {
  const insets = useSafeAreaInsets();
  const [editing, setEditing] = useState<WorkspaceInfo | 'new' | null>(null);
  const [name, setName] = useState(''), [path, setPath] = useState(''), [instructions, setInstructions] = useState('');
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [removing, setRemoving] = useState(false);
  const edit = (project: WorkspaceInfo | 'new') => { setEditing(project); setName(project === 'new' ? '' : project.name); setPath(project === 'new' ? '' : project.path); setInstructions(project === 'new' ? '' : project.instructions ?? ''); setError(''); setRemoving(false); };
  const close = () => { if (!saving) { setEditing(null); setError(''); onClose(); } };
  const save = async (remove = false) => {
    if (!editing || saving) return;
    setSaving(true); setError('');
    try {
      if (remove && editing !== 'new') {
        await client.call('projects.delete', { id: editing.id }); onChanged(projects.filter(p => p.id !== editing.id)); onSelect('*');
      } else {
        const project = await client.call(editing === 'new' ? 'projects.create' : 'projects.update', { id: editing === 'new' ? undefined : editing.id, name, path, instructions }) as WorkspaceInfo;
        onChanged([...projects.filter(p => p.id !== project.id), project]); onSelect(project.id);
      }
      setEditing(null); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };
  const button = (label: string, action: () => void, disabled = false) => <TouchableOpacity accessibilityRole="button" disabled={disabled} style={[s.button, disabled && { opacity: .45 }]} onPress={action}><Text style={s.text}>{label}</Text></TouchableOpacity>;
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={close} accessibilityViewIsModal>
    <KeyboardAvoidingView style={[s.backdrop, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={s.sheet}>
        <View style={s.heading}><Text style={s.title}>{editing ? editing === 'new' ? '새 프로젝트' : '프로젝트 설정' : '프로젝트'}</Text>{button('닫기', close, saving)}</View>
        <ScrollView keyboardShouldPersistTaps="handled">
          {!editing ? <>
            {button(`${active === '*' ? '✓ ' : ''}모든 대화`, () => { onSelect('*'); close(); })}
            {projects.map(project => <View key={project.id} style={s.row}><TouchableOpacity accessibilityRole="button" style={s.project} onPress={() => { onSelect(project.id); close(); }}><Text style={s.text}>{active === project.id ? '✓ ' : '▱ '}{project.name}</Text><Text style={s.hint} numberOfLines={1}>{project.path}</Text></TouchableOpacity>{client.isAdmin && button('설정', () => edit(project))}</View>)}
            {client.isAdmin && button('＋ 프로젝트 만들기', () => edit('new'))}
          </> : <>
            <Text style={s.hint}>연결된 PC의 폴더에서 작업하며 대화마다 별도 세션을 유지합니다.</Text>
            <Text style={s.label}>이름</Text><TextInput accessibilityLabel="프로젝트 이름" style={s.input} value={name} onChangeText={setName} maxLength={80} editable={!saving} />
            <Text style={s.label}>PC 폴더 경로 · 선택</Text><TextInput accessibilityLabel="프로젝트 PC 폴더" style={s.input} value={path} onChangeText={setPath} editable={!saving && editing === 'new'} placeholder="비우면 PC에 새 폴더 생성" placeholderTextColor={colors.faint} autoCapitalize="none" />
            <Text style={s.label}>프로젝트 지침 · 선택</Text><TextInput accessibilityLabel="프로젝트 지침" style={[s.input, { minHeight: 110, textAlignVertical: 'top' }]} value={instructions} onChangeText={setInstructions} maxLength={8000} multiline editable={!saving} />
            <Text style={s.hint}>프로젝트는 접근 권한을 확대하지 않습니다. PC의 현재 권한 설정을 따릅니다.</Text>
            {button(saving ? '저장 중…' : '저장', () => void save(), saving || !name.trim())}
            {editing !== 'new' && !removing && button('프로젝트 연결 해제', () => setRemoving(true), saving)}
            {removing && <><Text style={s.hint}>파일과 대화는 삭제하지 않습니다. 기존 대화는 다른 프로젝트를 지정한 뒤 실행할 수 있습니다.</Text>{button('연결 해제 확인', () => void save(true), saving)}{button('취소', () => setRemoving(false), saving)}</>}
            {button('목록으로', () => setEditing(null), saving)}
          </>}
          {!!error && <Text accessibilityLiveRegion="assertive" style={s.error}>{error}</Text>}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}
const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#0009', paddingHorizontal: 16, justifyContent: 'center' },
  sheet: { backgroundColor: '#111522', borderRadius: 20, borderWidth: 1, borderColor: '#ffffff18', padding: 18, maxHeight: '100%' },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 },
  title: { color: colors.text, fontSize: 19, fontWeight: '600' }, text: { color: colors.text, fontSize: 14 },
  hint: { color: colors.faint, fontSize: 12, lineHeight: 19, marginVertical: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 }, project: { flex: 1, paddingVertical: 12 },
  button: { paddingVertical: 12, paddingHorizontal: 12, minHeight: 44, borderRadius: 10, backgroundColor: '#ffffff09', marginVertical: 4 },
  label: { color: colors.text, fontSize: 12, marginTop: 14, marginBottom: 7 },
  input: { borderWidth: 1, borderColor: '#ffffff22', borderRadius: 10, padding: 12, color: colors.text, fontSize: 14, backgroundColor: '#090d16' },
  error: { color: '#ff9a9a', fontSize: 13, marginTop: 12, lineHeight: 20 },
});
