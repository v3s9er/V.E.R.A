import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import type { SavedPc, SharedFileEntry, WorkspaceInfo } from '../types';
import { loadPcs } from '../pcs';
import { colors, radius } from '../theme';

const baseOf = (pc: SavedPc): string => `http://${pc.activeHost ?? pc.host}:${pc.port}`;
const formatSize = (size: number): string => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;

export function FilesScreen({ pc }: { pc: SavedPc }) {
  const [path, setPath] = useState('');
  const [items, setItems] = useState<SharedFileEntry[]>([]);
  const [pcs, setPcs] = useState<SavedPc[]>([]);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [mode, setMode] = useState<'shared' | 'workspace'>('shared');
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    setBusy('목록 갱신'); setNotice('');
    try {
      const endpoint = mode === 'shared'
        ? `/api/files?path=${encodeURIComponent(path)}`
        : `/api/workspaces/files?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`;
      const response = await fetch(`${baseOf(pc)}${endpoint}`, { headers: { 'x-mr-robot-token': pc.secret } });
      const body = await response.json() as { items?: SharedFileEntry[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setItems(body.items ?? []);
      setPcs(await loadPcs());
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  }, [mode, path, pc, workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    void fetch(`${baseOf(pc)}/api/workspaces`, { headers: { 'x-mr-robot-token': pc.secret } }).then(async (response) => {
      const list = await response.json() as WorkspaceInfo[]; setWorkspaces(Array.isArray(list) ? list : []);
      setWorkspaceId((current) => current || list.find((item) => item.isDefault)?.id || list[0]?.id || '');
    }).catch(() => setWorkspaces([]));
  }, [pc]);

  const uploadFromPhone = async (): Promise<void> => {
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (picked.canceled) return;
    const file = picked.assets[0];
    const targetPath = [path, file.name].filter(Boolean).join('/');
    setBusy(file.name); setNotice('');
    try {
      const endpoint = mode === 'shared'
        ? `/api/files/upload?path=${encodeURIComponent(targetPath)}`
        : `/api/workspaces/upload?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(targetPath)}`;
      const result = await FileSystem.uploadAsync(`${baseOf(pc)}${endpoint}`, file.uri, {
        httpMethod: 'PUT', uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: { 'content-type': file.mimeType ?? 'application/octet-stream', 'x-mr-robot-token': pc.secret },
      });
      if (result.status < 200 || result.status >= 300) throw new Error(`업로드 실패 (HTTP ${result.status})`);
      setNotice(`${file.name} → ${pc.name} 전송 완료 · AI 토큰 0`);
      await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };

  const downloadToPhone = async (item: SharedFileEntry): Promise<void> => {
    if (!FileSystem.cacheDirectory) return;
    setBusy(item.path); setNotice('');
    try {
      const local = `${FileSystem.cacheDirectory}${Date.now()}-${item.name}`;
      const endpoint = mode === 'shared'
        ? `/api/files/download?path=${encodeURIComponent(item.path)}`
        : `/api/workspaces/download?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(item.path)}`;
      const result = await FileSystem.downloadAsync(`${baseOf(pc)}${endpoint}`, local, { headers: { 'x-mr-robot-token': pc.secret } });
      if (result.status < 200 || result.status >= 300) throw new Error(`다운로드 실패 (HTTP ${result.status})`);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(result.uri, { dialogTitle: `${item.name} 저장 또는 공유` });
      setNotice(`${pc.name} → 모바일 다운로드 완료 · AI 토큰 0`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };

  const copyToPc = async (item: SharedFileEntry, target: SavedPc): Promise<void> => {
    setBusy(`${item.path}:${target.id}`); setNotice('');
    try {
      const response = await fetch(`${baseOf(target)}/api/files/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mr-robot-token': target.secret },
        body: JSON.stringify({ sourceBase: baseOf(pc), sourceSecret: pc.secret, sourcePath: item.path, targetPath: item.path }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `직접 전송 실패 (HTTP ${response.status})`);
      setNotice(`${pc.name} → ${target.name} 직접 전송 완료 · 모바일 중계 없음 · AI 토큰 0`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };

  const pullSync = async (target: SavedPc, source: SavedPc): Promise<void> => {
    const response = await fetch(`${baseOf(target)}/api/sync/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mr-robot-token': target.secret },
      body: JSON.stringify({ sourceBase: baseOf(source), sourceSecret: source.secret }),
    });
    const body = await response.json() as { error?: string };
    if (!response.ok) throw new Error(body.error ?? `작업 동기화 실패 (HTTP ${response.status})`);
  };

  const syncWithPc = async (target: SavedPc): Promise<void> => {
    setBusy(`sync:${target.id}`); setNotice('');
    try {
      await pullSync(target, pc);
      await pullSync(pc, target);
      setNotice(`${pc.name} ↔ ${target.name} 대화·내 프리셋 양방향 동기화 완료 · AI 토큰 0`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };

  const parent = (): void => setPath(path.split('/').slice(0, -1).join('/'));

  return <View style={styles.root}>
    <View style={styles.hero}><Text style={styles.title}>파일 전송·작업 폴더</Text><Text style={styles.sub}>휴대폰과 PC 사이에서 파일 바이트만 직접 전송합니다. AI 토큰은 사용하지 않습니다.</Text>
      <View style={styles.syncRow}>{pcs.filter((target) => target.id !== pc.id).map((target) => <TouchableOpacity key={target.id} style={styles.syncBtn} onPress={() => void syncWithPc(target)} disabled={Boolean(busy)}><Text style={styles.syncText}>{busy === `sync:${target.id}` ? '동기화 중…' : `↻ ${target.name} 작업 동기화`}</Text></TouchableOpacity>)}</View>
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sourceTabs}><TouchableOpacity style={[styles.sourceBtn, mode === 'shared' && styles.sourceBtnOn]} onPress={() => { setMode('shared'); setPath(''); }}><Text style={styles.sourceText}>기기 공유함</Text></TouchableOpacity>{workspaces.map((workspace) => <TouchableOpacity key={workspace.id} style={[styles.sourceBtn, mode === 'workspace' && workspaceId === workspace.id && styles.sourceBtnOn]} onPress={() => { setMode('workspace'); setWorkspaceId(workspace.id); setPath(''); }}><Text style={styles.sourceText}>{workspace.name}</Text></TouchableOpacity>)}</ScrollView>
    <View style={styles.toolbar}>
      {path ? <TouchableOpacity style={styles.smallBtn} onPress={parent}><Text style={styles.smallText}>‹ 상위</Text></TouchableOpacity> : null}
      <View style={{ flex: 1 }}><Text style={styles.path}>{pc.name} / {path || (mode === 'shared' ? '공유함' : workspaces.find((item) => item.id === workspaceId)?.name ?? '작업 폴더')}</Text></View>
      <TouchableOpacity style={styles.smallBtn} onPress={() => void uploadFromPhone()}><Text style={styles.smallText}>모바일 파일 올리기</Text></TouchableOpacity>
    </View>
    {notice ? <Text style={styles.notice}>{notice}</Text> : null}
    <ScrollView contentContainerStyle={styles.list}>
      {busy === '목록 갱신' ? <ActivityIndicator color={colors.accent2} /> : null}
      {!busy && items.length === 0 ? <Text style={styles.empty}>{mode === 'shared' ? '공유함' : '작업 폴더'}이 비어 있습니다.{`\n`}위 버튼으로 모바일 파일을 올릴 수 있습니다.</Text> : null}
      {items.map((item) => <View key={item.path} style={styles.card}>
        <TouchableOpacity style={styles.fileMain} onPress={() => item.isDirectory ? setPath(item.path) : void downloadToPhone(item)}>
          <Text style={styles.icon}>{item.isDirectory ? '▰' : '◇'}</Text>
          <View style={{ flex: 1 }}><Text style={styles.name} numberOfLines={1}>{item.name}</Text><Text style={styles.meta}>{item.isDirectory ? '폴더' : formatSize(item.size)}</Text></View>
          {busy === item.path ? <ActivityIndicator color={colors.accent2} size="small" /> : <Text style={styles.action}>{item.isDirectory ? '열기' : '모바일로'}</Text>}
        </TouchableOpacity>
        {!item.isDirectory && mode === 'shared' && pcs.filter((target) => target.id !== pc.id).length > 0 && <View style={styles.targets}>
          <Text style={styles.targetLabel}>다른 PC로 직접:</Text>
          {pcs.filter((target) => target.id !== pc.id).map((target) => <TouchableOpacity key={target.id} style={styles.targetBtn} onPress={() => void copyToPc(item, target)} disabled={Boolean(busy)}><Text style={styles.targetText}>{target.name}</Text></TouchableOpacity>)}
        </View>}
      </View>)}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  hero: { paddingHorizontal: 18, paddingTop: 18, paddingBottom: 12 },
  title: { color: colors.text, fontSize: 21, fontWeight: '800' },
  sub: { color: colors.faint, fontSize: 12.5, lineHeight: 18, marginTop: 4 },
  syncRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 10 },
  syncBtn: { backgroundColor: 'rgba(124,92,255,.16)', borderWidth: 1, borderColor: 'rgba(124,92,255,.45)', borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 7 },
  syncText: { color: colors.text, fontSize: 11, fontWeight: '700' },
  sourceTabs: { paddingHorizontal: 14, paddingBottom: 10, gap: 7 },
  sourceBtn: { borderWidth: 1, borderColor: colors.border, borderRadius: 99, paddingHorizontal: 11, paddingVertical: 7, backgroundColor: colors.inputBg },
  sourceBtnOn: { borderColor: colors.accent, backgroundColor: 'rgba(124,92,255,.22)' },
  sourceText: { color: colors.text, fontSize: 11, fontWeight: '700' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingBottom: 10 },
  path: { color: colors.dim, fontSize: 12, fontWeight: '700' },
  smallBtn: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: colors.inputBg },
  smallText: { color: colors.text, fontSize: 11.5, fontWeight: '700' },
  notice: { color: colors.accent2, fontSize: 12, lineHeight: 17, paddingHorizontal: 18, paddingBottom: 6 },
  list: { padding: 14, paddingBottom: 50, gap: 10 },
  empty: { color: colors.faint, textAlign: 'center', marginTop: 55, lineHeight: 21 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: 'hidden' },
  fileMain: { flexDirection: 'row', gap: 11, alignItems: 'center', padding: 14 },
  icon: { color: colors.accent2, fontSize: 22 },
  name: { color: colors.text, fontSize: 14, fontWeight: '700' },
  meta: { color: colors.faint, fontSize: 11.5, marginTop: 3 },
  action: { color: colors.accent2, fontSize: 11.5, fontWeight: '700' },
  targets: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center', borderTopWidth: 1, borderTopColor: colors.border, padding: 9 },
  targetLabel: { color: colors.faint, fontSize: 10.5 },
  targetBtn: { borderWidth: 1, borderColor: 'rgba(124,92,255,.45)', borderRadius: 99, paddingHorizontal: 9, paddingVertical: 5 },
  targetText: { color: colors.dim, fontSize: 10.5, fontWeight: '700' },
});
