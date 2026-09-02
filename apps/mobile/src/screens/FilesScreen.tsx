import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import type { SavedPc, SharedFileEntry, SyncMergeResult, WorkspaceInfo } from '../types';
import { httpBaseForPc, loadPcs, pcAuthenticatedHeaders } from '../pcs';
import { colors, radius } from '../theme';

const baseOf = httpBaseForPc;
const formatSize = (size: number): string => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
const MAX_MOBILE_TRANSFER_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_FREE_STORAGE_BYTES = 128 * 1024 * 1024;
const FILE_LIST_TIMEOUT_MS = 20_000;
const TRANSFER_GRANT_TIMEOUT_MS = 15_000;
const DIRECT_COPY_TIMEOUT_MS = 30 * 60_000;
const SYNC_PULL_TIMEOUT_MS = 5 * 60_000;
const PHONE_TRANSFER_TIMEOUT_MS = 30 * 60_000;

type TransferCancelReason = 'background' | 'timeout' | 'unmount' | 'user';
type CancellableTransfer = {
  id: number;
  cancel: () => Promise<void> | void;
  tempUris: string[];
  cancelReason?: TransferCancelReason;
  cancelMessage?: (reason: TransferCancelReason) => string;
  timeout?: ReturnType<typeof setTimeout>;
};

const safeDelete = async (uri: string): Promise<void> => {
  try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch { /* best effort cache cleanup */ }
};

const safeFileName = (name: string): string => {
  const sanitized = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120);
  return sanitized || 'download';
};

const cancelNotice = (reason?: TransferCancelReason): string => reason === 'background'
  ? '앱이 백그라운드로 전환되어 전송을 안전하게 취소했습니다.'
  : reason === 'timeout'
    ? '파일 전송 시간이 초과되어 안전하게 취소했습니다. PC 연결 상태를 확인해 주세요.'
  : '파일 전송을 취소했습니다.';

const fetchJsonWithTimeout = async <T,>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutLabel: string,
  parentSignal: AbortSignal,
): Promise<{ response: Response; body: T }> => {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = (): void => controller.abort();
  if (parentSignal.aborted) controller.abort();
  else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
    const body = await response.json() as T;
    return { response, body };
  } catch (error) {
    if (timedOut) throw new Error(`${timeoutLabel} 시간이 초과되었습니다. PC 연결 상태를 확인한 뒤 다시 시도하세요.`);
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener('abort', abortFromParent);
  }
};

export function FilesScreen({ pc }: { pc: SavedPc }) {
  const [path, setPath] = useState('');
  const [items, setItems] = useState<SharedFileEntry[]>([]);
  const [pcs, setPcs] = useState<SavedPc[]>([]);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [mode, setMode] = useState<'shared' | 'workspace'>('shared');
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [transferCancelable, setTransferCancelable] = useState(false);
  const mountedRef = useRef(true);
  const operationLockRef = useRef(false);
  const operationIdRef = useRef(0);
  const operationSequenceRef = useRef(0);
  const activeTransferRef = useRef<CancellableTransfer | null>(null);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const refreshGenerationRef = useRef(0);
  const workspaceAbortRef = useRef<AbortController | null>(null);

  const beginOperation = useCallback((label: string): number | null => {
    if (operationLockRef.current) return null;
    operationLockRef.current = true;
    const id = ++operationSequenceRef.current;
    operationIdRef.current = id;
    if (mountedRef.current) { setBusy(label); setNotice(''); }
    return id;
  }, []);

  const finishOperation = useCallback((id: number): void => {
    if (operationIdRef.current !== id) return;
    operationIdRef.current = 0;
    operationLockRef.current = false;
    if (mountedRef.current) { setBusy(''); setTransferCancelable(false); }
  }, []);

  const cancelActiveTransfer = useCallback(async (reason: TransferCancelReason): Promise<void> => {
    const transfer = activeTransferRef.current;
    if (!transfer) return;
    transfer.cancelReason ??= reason;
    if (activeTransferRef.current === transfer) activeTransferRef.current = null;
    if (transfer.timeout) clearTimeout(transfer.timeout);
    let cancellation: Promise<void> | void;
    try { cancellation = transfer.cancel(); } catch { cancellation = undefined; }
    finishOperation(transfer.id);
    if (mountedRef.current && reason !== 'unmount') {
      setNotice(transfer.cancelMessage?.(reason) ?? cancelNotice(reason));
    }
    try { await cancellation; } catch { /* completion may race cancellation */ }
    await Promise.all(transfer.tempUris.map(safeDelete));
  }, [finishOperation]);

  const activateTransfer = useCallback((transfer: CancellableTransfer, timeoutMs?: number): void => {
    activeTransferRef.current = transfer;
    if (timeoutMs) {
      transfer.timeout = setTimeout(() => void cancelActiveTransfer('timeout'), timeoutMs);
    }
    if (mountedRef.current && operationIdRef.current === transfer.id) setTransferCancelable(true);
  }, [cancelActiveTransfer]);

  const releaseTransfer = useCallback((transfer: CancellableTransfer): void => {
    if (transfer.timeout) clearTimeout(transfer.timeout);
    if (activeTransferRef.current === transfer) activeTransferRef.current = null;
    if (mountedRef.current && operationIdRef.current === transfer.id) setTransferCancelable(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') void cancelActiveTransfer('background');
    });
    return () => {
      mountedRef.current = false;
      subscription.remove();
      refreshAbortRef.current?.abort();
      workspaceAbortRef.current?.abort();
      void cancelActiveTransfer('unmount');
    };
  }, [cancelActiveTransfer]);

  const refresh = useCallback(async (preserveNotice = false): Promise<void> => {
    const generation = ++refreshGenerationRef.current;
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, FILE_LIST_TIMEOUT_MS);
    refreshAbortRef.current = controller;
    if (mountedRef.current) { setRefreshing(true); if (!preserveNotice) setNotice(''); }
    try {
      const endpoint = mode === 'shared'
        ? `/api/files?path=${encodeURIComponent(path)}`
        : `/api/workspaces/files?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`;
      const requestUrl = `${baseOf(pc)}${endpoint}`;
      const response = await fetch(requestUrl, { headers: pcAuthenticatedHeaders(pc, requestUrl), redirect: 'error', signal: controller.signal });
      const body = await response.json() as { items?: SharedFileEntry[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      const storedPcs = await loadPcs();
      if (!controller.signal.aborted && refreshGenerationRef.current === generation && mountedRef.current) {
        setItems(body.items ?? []);
        setPcs(storedPcs);
      }
    } catch (error) {
      if (timedOut && refreshGenerationRef.current === generation && mountedRef.current) setNotice('파일 목록 요청 시간이 초과되었습니다. PC 연결을 확인한 뒤 다시 시도하세요.');
      else if (!controller.signal.aborted && mountedRef.current) setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
      if (refreshGenerationRef.current === generation) {
        if (refreshAbortRef.current === controller) refreshAbortRef.current = null;
        if (mountedRef.current) setRefreshing(false);
      }
    }
  }, [mode, path, pc, workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    workspaceAbortRef.current?.abort();
    const controller = new AbortController();
    workspaceAbortRef.current = controller;
    const requestUrl = `${baseOf(pc)}/api/workspaces`;
    void fetch(requestUrl, { headers: pcAuthenticatedHeaders(pc, requestUrl), redirect: 'error', signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const list = await response.json() as WorkspaceInfo[];
      if (controller.signal.aborted || workspaceAbortRef.current !== controller || !mountedRef.current) return;
      const safeList = Array.isArray(list) ? list : [];
      setWorkspaces(safeList);
      setWorkspaceId((current) => current || safeList.find((item) => item.isDefault)?.id || safeList[0]?.id || '');
    }).catch(() => {
      if (!controller.signal.aborted && mountedRef.current) setWorkspaces([]);
    });
    return () => { controller.abort(); };
  }, [pc]);

  const transferGrant = async (source: SavedPc, kind: 'file' | 'sync', signal: AbortSignal, sourcePath?: string): Promise<string> => {
    const requestUrl = `${baseOf(source)}/api/transfers/grant`;
    const { response, body } = await fetchJsonWithTimeout<{ grant?: string; error?: string }>(requestUrl, {
      method: 'POST',
      headers: pcAuthenticatedHeaders(source, requestUrl, { 'content-type': 'application/json' }),
      body: JSON.stringify({ kind, ...(sourcePath ? { path: sourcePath } : {}) }),
    }, TRANSFER_GRANT_TIMEOUT_MS, '1회성 전송권 발급', signal);
    if (!response.ok || !body.grant) throw new Error(body.error ?? `1회성 전송권 발급 실패 (HTTP ${response.status})`);
    return body.grant;
  };

  const uploadFromPhone = async (): Promise<void> => {
    const operationId = beginOperation('파일 선택 중…');
    if (operationId === null) return;
    let transfer: CancellableTransfer | null = null;
    let pickedCacheUri = '';
    try {
      const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
      if (picked.canceled) return;
      const file = picked.assets[0];
      if (!file) throw new Error('선택한 파일 정보를 읽을 수 없습니다.');
      if (FileSystem.cacheDirectory && file.uri.startsWith(FileSystem.cacheDirectory)) pickedCacheUri = file.uri;
      const info = file.size === undefined ? await FileSystem.getInfoAsync(file.uri) : null;
      const fileSize = file.size ?? (info?.exists && !info.isDirectory ? info.size : undefined);
      if (fileSize !== undefined && fileSize > MAX_MOBILE_TRANSFER_BYTES) {
        throw new Error(`모바일 파일 전송은 최대 ${formatSize(MAX_MOBILE_TRANSFER_BYTES)}까지 지원합니다.`);
      }
      if (AppState.currentState !== 'active') throw new Error(cancelNotice('background'));
      const targetPath = [path, file.name].filter(Boolean).join('/');
      if (mountedRef.current) setBusy(file.name);
      const endpoint = mode === 'shared'
        ? `/api/files/upload?path=${encodeURIComponent(targetPath)}`
        : `/api/workspaces/upload?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(targetPath)}`;
      const uploadUrl = `${baseOf(pc)}${endpoint}`;
      const task = FileSystem.createUploadTask(uploadUrl, file.uri, {
        httpMethod: 'PUT', uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: pcAuthenticatedHeaders(pc, uploadUrl, { 'content-type': file.mimeType ?? 'application/octet-stream' }),
      });
      transfer = { id: operationId, cancel: () => task.cancelAsync(), tempUris: pickedCacheUri ? [pickedCacheUri] : [] };
      activateTransfer(transfer, PHONE_TRANSFER_TIMEOUT_MS);
      const result = await task.uploadAsync();
      releaseTransfer(transfer);
      if (!result) throw new Error(cancelNotice(transfer.cancelReason));
      if (result.status < 200 || result.status >= 300) throw new Error(`업로드 실패 (HTTP ${result.status})`);
      if (mountedRef.current && operationIdRef.current === operationId) setNotice(`${file.name} → ${pc.name} 전송 완료 · AI 토큰 0`);
      await refresh(true);
    } catch (error) {
      if (mountedRef.current && operationIdRef.current === operationId) setNotice(transfer?.cancelReason ? cancelNotice(transfer.cancelReason) : error instanceof Error ? error.message : String(error));
    } finally {
      if (transfer) releaseTransfer(transfer);
      if (transfer) await Promise.all(transfer.tempUris.map(safeDelete));
      else if (pickedCacheUri) await safeDelete(pickedCacheUri);
      finishOperation(operationId);
    }
  };

  const downloadToPhone = async (item: SharedFileEntry): Promise<void> => {
    const operationId = beginOperation(item.path);
    if (operationId === null) return;
    let local = '';
    let transfer: CancellableTransfer | null = null;
    try {
      if (!FileSystem.cacheDirectory) throw new Error('이 기기에서 임시 파일 저장소를 사용할 수 없습니다.');
      if (item.size > MAX_MOBILE_TRANSFER_BYTES) {
        throw new Error(`모바일 파일 전송은 최대 ${formatSize(MAX_MOBILE_TRANSFER_BYTES)}까지 지원합니다.`);
      }
      const freeStorage = await FileSystem.getFreeDiskStorageAsync();
      if (item.size > Math.max(0, freeStorage - MIN_FREE_STORAGE_BYTES)) {
        throw new Error(`저장 공간이 부족합니다. 최소 ${formatSize(item.size + MIN_FREE_STORAGE_BYTES)}의 여유 공간이 필요합니다.`);
      }
      if (!await Sharing.isAvailableAsync()) throw new Error('이 기기에서는 파일 저장·공유 화면을 열 수 없습니다.');
      if (AppState.currentState !== 'active') throw new Error(cancelNotice('background'));
      local = `${FileSystem.cacheDirectory}${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeFileName(item.name)}`;
      const endpoint = mode === 'shared'
        ? `/api/files/download?path=${encodeURIComponent(item.path)}`
        : `/api/workspaces/download?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(item.path)}`;
      const downloadUrl = `${baseOf(pc)}${endpoint}`;
      const task = FileSystem.createDownloadResumable(downloadUrl, local, { headers: pcAuthenticatedHeaders(pc, downloadUrl) });
      transfer = { id: operationId, cancel: () => task.cancelAsync(), tempUris: [local] };
      activateTransfer(transfer, PHONE_TRANSFER_TIMEOUT_MS);
      const result = await task.downloadAsync();
      releaseTransfer(transfer);
      if (!result) throw new Error(cancelNotice(transfer.cancelReason));
      if (result.status < 200 || result.status >= 300) throw new Error(`다운로드 실패 (HTTP ${result.status})`);
      await Sharing.shareAsync(result.uri, { dialogTitle: `${item.name} 저장 또는 공유` });
      if (mountedRef.current && operationIdRef.current === operationId) setNotice(`${pc.name} → 모바일 다운로드 완료 · AI 토큰 0`);
    } catch (error) {
      if (mountedRef.current && operationIdRef.current === operationId) setNotice(transfer?.cancelReason ? cancelNotice(transfer.cancelReason) : error instanceof Error ? error.message : String(error));
    } finally {
      if (transfer) releaseTransfer(transfer);
      if (local) await safeDelete(local);
      finishOperation(operationId);
    }
  };

  const copyToPc = async (item: SharedFileEntry, target: SavedPc): Promise<void> => {
    const operationId = beginOperation(`${item.path}:${target.id}`);
    if (operationId === null) return;
    const controller = new AbortController();
    const transfer: CancellableTransfer = { id: operationId, cancel: () => controller.abort(), tempUris: [] };
    activateTransfer(transfer);
    try {
      if (AppState.currentState !== 'active') {
        await cancelActiveTransfer('background');
        return;
      }
      const sourceGrant = await transferGrant(pc, 'file', controller.signal, item.path);
      const requestUrl = `${baseOf(target)}/api/files/pull`;
      const { response, body } = await fetchJsonWithTimeout<{ error?: string }>(requestUrl, {
        method: 'POST',
        headers: pcAuthenticatedHeaders(target, requestUrl, { 'content-type': 'application/json' }),
        body: JSON.stringify({ sourceBase: baseOf(pc), sourceGrant, sourcePath: item.path, targetPath: item.path }),
      }, DIRECT_COPY_TIMEOUT_MS, `${pc.name} → ${target.name} 직접 전송`, controller.signal);
      if (!response.ok) throw new Error(body.error ?? `직접 전송 실패 (HTTP ${response.status})`);
      if (mountedRef.current && operationIdRef.current === operationId) setNotice(`${pc.name} → ${target.name} 직접 전송 완료 · 모바일 중계 없음 · AI 토큰 0`);
    } catch (error) {
      if (mountedRef.current && operationIdRef.current === operationId) {
        setNotice(transfer.cancelReason ? cancelNotice(transfer.cancelReason) : error instanceof Error ? error.message : String(error));
      }
    } finally {
      releaseTransfer(transfer);
      finishOperation(operationId);
    }
  };

  const pullSync = async (target: SavedPc, source: SavedPc, signal: AbortSignal): Promise<SyncMergeResult> => {
    const sourceGrant = await transferGrant(source, 'sync', signal);
    const requestUrl = `${baseOf(target)}/api/sync/pull`;
    const { response, body } = await fetchJsonWithTimeout<SyncMergeResult & { error?: string }>(requestUrl, {
      method: 'POST',
      headers: pcAuthenticatedHeaders(target, requestUrl, { 'content-type': 'application/json' }),
      body: JSON.stringify({ sourceBase: baseOf(source), sourceGrant }),
    }, SYNC_PULL_TIMEOUT_MS, `${source.name} → ${target.name} 작업 동기화`, signal);
    if (!response.ok) throw new Error(body.error ?? `작업 동기화 실패 (HTTP ${response.status})`);
    return body;
  };

  const syncWithPc = async (target: SavedPc): Promise<void> => {
    const operationId = beginOperation(`sync:${target.id}`);
    if (operationId === null) return;
    const controller = new AbortController();
    let completedDirections = 0;
    const partialNotice = (): string => completedDirections > 0
      ? ` ${pc.name} → ${target.name} 방향은 이미 완료됐으며 반대 방향은 다시 동기화해야 합니다.`
      : '';
    const transfer: CancellableTransfer = {
      id: operationId,
      cancel: () => controller.abort(),
      tempUris: [],
      cancelMessage: (reason) => `${cancelNotice(reason)}${partialNotice()}`,
    };
    activateTransfer(transfer);
    try {
      if (AppState.currentState !== 'active') {
        await cancelActiveTransfer('background');
        return;
      }
      const first = await pullSync(target, pc, controller.signal);
      completedDirections = 1;
      const second = await pullSync(pc, target, controller.signal);
      completedDirections = 2;
      const conflictIds = new Set([...(first.conversations?.conflictIds ?? []), ...(second.conversations?.conflictIds ?? [])]);
      const conflicts = conflictIds.size || (first.conversations?.conflicts ?? 0) + (second.conversations?.conflicts ?? 0);
      const conflictNotice = conflicts > 0 ? ` · 충돌 ${conflicts}건은 대화 목록의 '동기화 충돌 복사본'으로 보존됨` : '';
      if (mountedRef.current && operationIdRef.current === operationId) setNotice(`${pc.name} ↔ ${target.name} 대화·내 프리셋 양방향 동기화 완료${conflictNotice} · AI 토큰 0`);
    } catch (error) {
      if (mountedRef.current && operationIdRef.current === operationId) {
        const message = transfer.cancelReason ? cancelNotice(transfer.cancelReason) : error instanceof Error ? error.message : String(error);
        setNotice(`${message}${partialNotice()}`);
      }
    } finally {
      releaseTransfer(transfer);
      finishOperation(operationId);
    }
  };

  const parent = (): void => setPath(path.split('/').slice(0, -1).join('/'));
  const controlsLocked = Boolean(busy) || refreshing;
  const otherPcs = pcs.filter((target) => target.id !== pc.id);

  return <View style={styles.root}>
    <View style={styles.hero}><Text style={styles.title}>파일 전송·작업 폴더</Text><Text style={styles.sub}>휴대폰과 PC 사이에서 파일 바이트만 직접 전송합니다. AI 토큰은 사용하지 않습니다.</Text>
      <View style={styles.syncRow}>{otherPcs.map((target) => <TouchableOpacity key={target.id} style={[styles.syncBtn, controlsLocked && styles.controlDisabled]} onPress={() => void syncWithPc(target)} disabled={controlsLocked} accessibilityState={{ disabled: controlsLocked }}><Text style={styles.syncText}>{busy === `sync:${target.id}` ? '동기화 중…' : `↻ ${target.name} 작업 동기화`}</Text></TouchableOpacity>)}</View>
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sourceTabs}><TouchableOpacity style={[styles.sourceBtn, mode === 'shared' && styles.sourceBtnOn, controlsLocked && styles.controlDisabled]} onPress={() => { setMode('shared'); setPath(''); }} disabled={controlsLocked} accessibilityState={{ disabled: controlsLocked }}><Text style={styles.sourceText}>기기 공유함</Text></TouchableOpacity>{workspaces.map((workspace) => <TouchableOpacity key={workspace.id} style={[styles.sourceBtn, mode === 'workspace' && workspaceId === workspace.id && styles.sourceBtnOn, controlsLocked && styles.controlDisabled]} onPress={() => { setMode('workspace'); setWorkspaceId(workspace.id); setPath(''); }} disabled={controlsLocked} accessibilityState={{ disabled: controlsLocked }}><Text style={styles.sourceText}>{workspace.name}</Text></TouchableOpacity>)}</ScrollView>
    <View style={styles.toolbar}>
      {path ? <TouchableOpacity style={[styles.smallBtn, controlsLocked && styles.controlDisabled]} onPress={parent} disabled={controlsLocked} accessibilityState={{ disabled: controlsLocked }}><Text style={styles.smallText}>‹ 상위</Text></TouchableOpacity> : null}
      <View style={styles.pathWrap}><Text style={styles.path}>{pc.name} / {path || (mode === 'shared' ? '공유함' : workspaces.find((item) => item.id === workspaceId)?.name ?? '작업 폴더')}</Text></View>
      <TouchableOpacity style={[styles.smallBtn, controlsLocked && styles.controlDisabled]} onPress={() => void uploadFromPhone()} disabled={controlsLocked} accessibilityState={{ disabled: controlsLocked }}><Text style={styles.smallText}>모바일 파일 올리기</Text></TouchableOpacity>
    </View>
    {busy ? <View style={styles.transferStatus} accessibilityLiveRegion="polite"><ActivityIndicator color={colors.accent2} size="small" /><Text style={styles.transferStatusText} numberOfLines={2}>{busy}</Text>{transferCancelable ? <TouchableOpacity style={styles.cancelBtn} onPress={() => void cancelActiveTransfer('user')} accessibilityRole="button" accessibilityLabel="파일 전송 취소"><Text style={styles.cancelText}>전송 취소</Text></TouchableOpacity> : null}</View> : null}
    {notice ? <Text style={styles.notice} accessibilityLiveRegion="polite">{notice}</Text> : null}
    <ScrollView contentContainerStyle={styles.list}>
      {refreshing ? <ActivityIndicator color={colors.accent2} /> : null}
      {!refreshing && !busy && items.length === 0 ? <Text style={styles.empty}>{mode === 'shared' ? '공유함' : '작업 폴더'}이 비어 있습니다.{`\n`}위 버튼으로 모바일 파일을 올릴 수 있습니다.</Text> : null}
      {items.map((item) => <View key={item.path} style={styles.card}>
        <TouchableOpacity style={[styles.fileMain, controlsLocked && styles.controlDisabled]} onPress={() => item.isDirectory ? setPath(item.path) : void downloadToPhone(item)} disabled={controlsLocked} accessibilityState={{ disabled: controlsLocked }}>
          <Text style={styles.icon}>{item.isDirectory ? '▰' : '◇'}</Text>
          <View style={{ flex: 1 }}><Text style={styles.name} numberOfLines={1}>{item.name}</Text><Text style={styles.meta}>{item.isDirectory ? '폴더' : formatSize(item.size)}</Text></View>
          {busy === item.path ? <ActivityIndicator color={colors.accent2} size="small" /> : <Text style={styles.action}>{item.isDirectory ? '열기' : '모바일로'}</Text>}
        </TouchableOpacity>
        {!item.isDirectory && mode === 'shared' && otherPcs.length > 0 && <View style={styles.targets}>
          <Text style={styles.targetLabel}>다른 PC로 직접:</Text>
          {otherPcs.map((target) => <TouchableOpacity key={target.id} style={[styles.targetBtn, controlsLocked && styles.controlDisabled]} onPress={() => void copyToPc(item, target)} disabled={controlsLocked} accessibilityState={{ disabled: controlsLocked }}><Text style={styles.targetText}>{target.name}</Text></TouchableOpacity>)}
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
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingBottom: 10 },
  pathWrap: { flex: 1, minWidth: 140 },
  path: { color: colors.dim, fontSize: 12, fontWeight: '700' },
  smallBtn: { minHeight: 42, justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: colors.inputBg },
  smallText: { color: colors.text, fontSize: 11.5, fontWeight: '700' },
  transferStatus: { flexDirection: 'row', alignItems: 'center', gap: 9, marginHorizontal: 14, marginBottom: 8, paddingHorizontal: 11, paddingVertical: 8, backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  transferStatusText: { flex: 1, color: colors.dim, fontSize: 11.5, fontWeight: '700' },
  cancelBtn: { borderWidth: 1, borderColor: 'rgba(255,102,120,.55)', borderRadius: radius.sm, paddingHorizontal: 9, paddingVertical: 5 },
  cancelText: { color: '#ff8998', fontSize: 10.5, fontWeight: '800' },
  controlDisabled: { opacity: 0.45 },
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
