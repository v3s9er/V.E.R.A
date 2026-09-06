import { useEffect, useRef, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { chatFileLinks } from '../../../../packages/shared/src/chat-files';
import { downloadSecureFile } from '../secureFiles';
import type { SavedPc } from '../types';
import { colors } from '../theme';

export function ChatFiles({ text, pc, conversationId }: { text: string; pc: SavedPc; conversationId: string }) {
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const operation = useRef<AbortController | null>(null);
  useEffect(() => { setBusy(''); setNotice(''); return () => operation.current?.abort(); }, [pc.id, conversationId]);
  const download = async (path: string, name: string) => {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(path); setNotice('');
    const uri = `${FileSystem.cacheDirectory}chat-${Date.now()}-${Math.random().toString(36).slice(2)}-${name.replace(/[\\/:*?"<>|]/g, '_')}`;
    try {
      if (!await Sharing.isAvailableAsync()) throw new Error('이 기기에서 파일 저장·공유를 지원하지 않습니다.');
      await downloadSecureFile(pc, path, uri, undefined, controller.signal, conversationId);
      if (!controller.signal.aborted) await Sharing.shareAsync(uri, { dialogTitle: `${name} 저장 또는 공유` });
    } catch (error) {
      if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : '파일 다운로드 실패');
    } finally {
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      if (operation.current === controller) operation.current = null;
      if (!controller.signal.aborted) setBusy('');
    }
  };
  return <View>{chatFileLinks(text).map(file => <TouchableOpacity key={file.path} accessibilityRole="button" accessibilityLabel={`${file.name} 암호화 다운로드`} disabled={Boolean(busy)} onPress={() => void download(file.path, file.name)} style={{ padding: 12, marginTop: 8, borderRadius: 12, borderWidth: 1, borderColor: colors.accent2 }}><Text style={{ color: colors.accent2 }}>{busy === file.path ? '받는 중…' : '↓'} {file.name}</Text><Text numberOfLines={2} style={{ color: colors.faint, fontSize: 10 }}>{file.path}</Text></TouchableOpacity>)}{notice ? <Text accessibilityLiveRegion="polite" style={{ color: colors.err, marginTop: 8 }}>{notice}</Text> : null}</View>;
}
