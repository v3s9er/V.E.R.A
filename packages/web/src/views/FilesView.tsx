import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pcOrigin, type SavedPc } from '../pcs';
import type { SyncMergeResult, WorkspaceInfo } from '@mr-robot/shared';

interface SharedFileEntry { name: string; path: string; isDirectory: boolean; size: number; modifiedAt: number }
const baseOf = (pc: SavedPc): string => pcOrigin(pc);
const sizeOf = (size: number): string => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
const TRANSFER_GRANT_TIMEOUT_MS = 15_000;
const DIRECT_COPY_TIMEOUT_MS = 30 * 60_000;
const SYNC_PULL_TIMEOUT_MS = 5 * 60_000;

type PeerTransferCancelReason = 'context' | 'timeout' | 'unmount' | 'user';
type PeerTransfer = {
  id: number;
  controller: AbortController;
  cancelReason?: PeerTransferCancelReason;
  cancelMessage?: (reason: PeerTransferCancelReason) => string;
};

const peerCancelNotice = (reason: PeerTransferCancelReason): string => {
  if (reason === 'context') return '활성 PC가 바뀌어 진행 중이던 직접 전송을 취소했습니다.';
  if (reason === 'timeout') return '직접 전송 시간이 초과되어 안전하게 취소했습니다. PC 연결 상태를 확인해 주세요.';
  return '직접 전송을 취소했습니다.';
};

export function FilesView({ activePc, pcs }: { activePc: SavedPc; pcs: SavedPc[] }) {
  const [path, setPath] = useState('');
  const [items, setItems] = useState<SharedFileEntry[]>([]);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [mode, setMode] = useState<'shared' | 'workspace'>('shared');
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState('');
  const [downloadId, setDownloadId] = useState('');
  const [peerTransferCancelable, setPeerTransferCancelable] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const operationLock = useRef(false);
  const downloadIdRef = useRef('');
  const mountedRef = useRef(true);
  const peerOperationIdRef = useRef(0);
  const peerOperationSequenceRef = useRef(0);
  const activePeerTransferRef = useRef<PeerTransfer | null>(null);
  const activePcIdRef = useRef(activePc.id);

  const beginPeerOperation = useCallback((label: string): number | null => {
    if (operationLock.current) return null;
    operationLock.current = true;
    const id = ++peerOperationSequenceRef.current;
    peerOperationIdRef.current = id;
    if (mountedRef.current) { setBusy(label); setNotice(''); setPeerTransferCancelable(true); }
    return id;
  }, []);

  const finishPeerOperation = useCallback((id: number): void => {
    if (peerOperationIdRef.current !== id) return;
    peerOperationIdRef.current = 0;
    operationLock.current = false;
    if (mountedRef.current) { setBusy(''); setPeerTransferCancelable(false); }
  }, []);

  const cancelPeerTransfer = useCallback((reason: PeerTransferCancelReason): void => {
    const transfer = activePeerTransferRef.current;
    if (!transfer) return;
    transfer.cancelReason ??= reason;
    activePeerTransferRef.current = null;
    transfer.controller.abort();
    finishPeerOperation(transfer.id);
    if (mountedRef.current && reason !== 'unmount') {
      setNotice(transfer.cancelMessage?.(reason) ?? peerCancelNotice(reason));
    }
  }, [finishPeerOperation]);

  const releasePeerTransfer = useCallback((transfer: PeerTransfer): void => {
    if (activePeerTransferRef.current === transfer) activePeerTransferRef.current = null;
    if (mountedRef.current && peerOperationIdRef.current === transfer.id) setPeerTransferCancelable(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelPeerTransfer('unmount');
      if (downloadIdRef.current) void window.mrRobotDesktop?.cancelDownload(downloadIdRef.current);
    };
  }, [cancelPeerTransfer]);

  useEffect(() => {
    if (activePcIdRef.current !== activePc.id) {
      cancelPeerTransfer('context');
      activePcIdRef.current = activePc.id;
    }
  }, [activePc.id, cancelPeerTransfer]);

  const request = async (pc: SavedPc, url: string, init: RequestInit = {}): Promise<Response> => fetch(`${baseOf(pc)}${url}`, { ...init, headers: { ...(init.headers ?? {}), 'x-mr-robot-token': pc.secret } });
  const requestJsonWithTimeout = async <T,>(
    pc: SavedPc,
    url: string,
    init: RequestInit,
    controller: AbortController,
    timeoutMs: number,
    timeoutLabel: string,
  ): Promise<{ response: Response; body: T }> => {
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await request(pc, url, { ...init, signal: controller.signal });
      const body = await response.json() as T;
      return { response, body };
    } catch (error) {
      if (timedOut) throw new Error(`${timeoutLabel} 시간이 초과되었습니다. PC 연결 상태를 확인한 뒤 다시 시도하세요.`);
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  };
  const transferGrant = async (source: SavedPc, kind: 'file' | 'sync', controller: AbortController, sourcePath?: string): Promise<string> => {
    const { response, body } = await requestJsonWithTimeout<{ grant?: string; error?: string }>(source, '/api/transfers/grant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, ...(sourcePath ? { path: sourcePath } : {}) }),
    }, controller, TRANSFER_GRANT_TIMEOUT_MS, '1회성 전송권 발급');
    if (!response.ok || !body.grant) throw new Error(body.error ?? `1회성 전송권 발급 실패 (HTTP ${response.status})`);
    return body.grant;
  };
  const refresh = useCallback(async (): Promise<void> => {
    setBusy('list');
    try {
      const response = await request(activePc, mode === 'shared'
        ? `/api/files?path=${encodeURIComponent(path)}`
        : `/api/workspaces/files?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`);
      const body = await response.json() as { items?: SharedFileEntry[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setItems(body.items ?? []);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  }, [activePc, mode, path, workspaceId]);
  useEffect(() => {
    void request(activePc, '/api/workspaces').then(async (response) => {
      const list = await response.json() as WorkspaceInfo[];
      setWorkspaces(Array.isArray(list) ? list : []);
      setWorkspaceId((current) => current || list.find((item) => item.isDefault)?.id || list[0]?.id || '');
    }).catch(() => setWorkspaces([]));
  }, [activePc]);
  useEffect(() => { void refresh(); }, [refresh]);

  const upload = async (files: FileList | File[] | null): Promise<void> => {
    const picked = Array.from(files ?? []).slice(0, 50); if (!picked.length) return;
    if (operationLock.current) return;
    operationLock.current = true;
    setBusy(`upload:${picked.length}`); setNotice('');
    try {
      for (const file of picked) {
        const target = [path, file.name].filter(Boolean).join('/');
        const endpoint = mode === 'shared'
          ? `/api/files/upload?path=${encodeURIComponent(target)}`
          : `/api/workspaces/upload?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(target)}`;
        const response = await request(activePc, endpoint, { method: 'PUT', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
        const body = await response.json() as { error?: string };
        if (!response.ok) throw new Error(`${file.name}: ${body.error ?? `HTTP ${response.status}`}`);
      }
      setNotice(`${picked.length}개 파일 업로드 완료 · AI 토큰 0`); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { operationLock.current = false; setBusy(''); if (picker.current) picker.current.value = ''; }
  };

  const download = async (item: SharedFileEntry): Promise<void> => {
    if (operationLock.current) return;
    operationLock.current = true;
    setBusy(item.path); setNotice('');
    try {
      const endpoint = mode === 'shared'
        ? `/api/files/download?path=${encodeURIComponent(item.path)}`
        : `/api/workspaces/download?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(item.path)}`;
      if (window.mrRobotDesktop?.downloadFile) {
        const id = globalThis.crypto?.randomUUID?.() ?? `download-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        downloadIdRef.current = id;
        setDownloadId(id);
        const result = await window.mrRobotDesktop.downloadFile({
          id,
          url: `${baseOf(activePc)}${endpoint}`,
          token: activePc.secret,
          suggestedName: item.name,
        });
        setNotice(result.canceled ? '다운로드를 취소했습니다.' : `${activePc.name}에서 저장 완료 · AI 토큰 0`);
        return;
      }
      const response = await request(activePc, endpoint);
      if (!response.ok) throw new Error(`다운로드 실패 (HTTP ${response.status})`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = item.name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setNotice(`${activePc.name}에서 다운로드 완료 · AI 토큰 0`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { operationLock.current = false; downloadIdRef.current = ''; setBusy(''); setDownloadId(''); }
  };

  const copy = async (item: SharedFileEntry, target: SavedPc): Promise<void> => {
    const operationId = beginPeerOperation(`${item.path}:${target.id}`);
    if (operationId === null) return;
    const transfer: PeerTransfer = { id: operationId, controller: new AbortController() };
    activePeerTransferRef.current = transfer;
    try {
      const sourceGrant = await transferGrant(activePc, 'file', transfer.controller, item.path);
      const { response, body } = await requestJsonWithTimeout<{ error?: string }>(target, '/api/files/pull', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceBase: baseOf(activePc), sourceGrant, sourcePath: item.path, targetPath: item.path }),
      }, transfer.controller, DIRECT_COPY_TIMEOUT_MS, `${activePc.name} → ${target.name} PC 간 직접 전송`);
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      if (mountedRef.current && peerOperationIdRef.current === operationId) {
        setNotice(`${activePc.name} → ${target.name} PC 간 직접 전송 완료 · AI 토큰 0`);
      }
    } catch (error) {
      if (mountedRef.current && peerOperationIdRef.current === operationId) {
        setNotice(transfer.cancelReason ? peerCancelNotice(transfer.cancelReason) : error instanceof Error ? error.message : String(error));
      }
    } finally {
      releasePeerTransfer(transfer);
      finishPeerOperation(operationId);
    }
  };

  const pullSync = async (target: SavedPc, source: SavedPc, controller: AbortController): Promise<SyncMergeResult> => {
    const sourceGrant = await transferGrant(source, 'sync', controller);
    const { response, body } = await requestJsonWithTimeout<SyncMergeResult & { error?: string }>(target, '/api/sync/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceBase: baseOf(source), sourceGrant }),
    }, controller, SYNC_PULL_TIMEOUT_MS, `${source.name} → ${target.name} 작업 동기화`);
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    return body;
  };
  const sync = async (target: SavedPc): Promise<void> => {
    const operationId = beginPeerOperation(`sync:${target.id}`);
    if (operationId === null) return;
    let completedDirections = 0;
    const partialNotice = (): string => completedDirections > 0
      ? ` ${activePc.name} → ${target.name} 방향은 이미 완료됐으며 반대 방향은 다시 동기화해야 합니다.`
      : '';
    const transfer: PeerTransfer = {
      id: operationId,
      controller: new AbortController(),
      cancelMessage: (reason) => `${peerCancelNotice(reason)}${partialNotice()}`,
    };
    activePeerTransferRef.current = transfer;
    try {
      const first = await pullSync(target, activePc, transfer.controller);
      completedDirections = 1;
      const second = await pullSync(activePc, target, transfer.controller);
      completedDirections = 2;
      const conflictIds = new Set([...(first.conversations?.conflictIds ?? []), ...(second.conversations?.conflictIds ?? [])]);
      const conflicts = conflictIds.size || (first.conversations?.conflicts ?? 0) + (second.conversations?.conflicts ?? 0);
      const conflictNotice = conflicts > 0 ? ` · 충돌 ${conflicts}건은 대화 목록의 '동기화 충돌 복사본'으로 보존됨` : '';
      if (mountedRef.current && peerOperationIdRef.current === operationId) {
        setNotice(`${activePc.name} ↔ ${target.name} 대화·내 프리셋 동기화 완료${conflictNotice} · AI 토큰 0`);
      }
    } catch (error) {
      if (mountedRef.current && peerOperationIdRef.current === operationId) {
        const message = transfer.cancelReason ? peerCancelNotice(transfer.cancelReason) : error instanceof Error ? error.message : String(error);
        setNotice(`${message}${partialNotice()}`);
      }
    } finally {
      releasePeerTransfer(transfer);
      finishPeerOperation(operationId);
    }
  };

  const otherPcs = pcs.filter((pc) => pc.id !== activePc.id);
  const visibleItems = useMemo(() => items
    .filter((item) => !query.trim() || item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'ko')), [items, query]);
  const fileCount = items.filter((item) => !item.isDirectory).length;
  const folderCount = items.length - fileCount;
  const controlsLocked = Boolean(busy) || Boolean(downloadId);
  const peerTransferStatus = busy.startsWith('sync:')
    ? '두 PC의 작업 상태를 양방향으로 직접 동기화하는 중입니다…'
    : 'PC 간에 파일을 직접 전송하는 중입니다…';
  return <div className="device-files stack">
    <section className="files-hero panel"><div><span className="eyebrow">TOKENLESS TRANSFER</span><h2>파일 전송·작업 폴더</h2><p>모바일·노트북 사이에서 AI를 호출하지 않고 원본 파일과 작업 상태를 직접 주고받습니다.</p></div>
      <div className="files-overview"><div className="files-kpis"><span><b>{folderCount}</b> 폴더</span><span><b>{fileCount}</b> 파일</span><span><b>0</b> AI 토큰</span></div><div className="files-sync">{otherPcs.map((pc) => <button key={pc.id} className="btn btn-ghost" disabled={Boolean(busy)} onClick={() => void sync(pc)}>{busy === `sync:${pc.id}` ? '동기화 중…' : `↻ ${pc.name} 작업 동기화`}</button>)}</div></div>
    </section>
    <section
      className={`panel files-panel ${dragging ? 'dragging-files' : ''}`}
      onDragEnter={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current += 1; setDragging(true); } }}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
      onDragLeave={(event) => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); dragDepth.current = 0; setDragging(false); if (!controlsLocked) void upload(event.dataTransfer.files); }}
    >
      {dragging && <div className="file-drop-overlay"><b>여기에 파일 놓기</b><span>{mode === 'shared' ? '기기 공유함' : '선택한 작업 폴더'}에 직접 업로드 · AI 토큰 0</span></div>}
      <div className="files-source-tabs"><button className={mode === 'shared' ? 'active' : ''} disabled={controlsLocked} onClick={() => { setMode('shared'); setPath(''); setQuery(''); }}>기기 공유함</button><button className={mode === 'workspace' ? 'active' : ''} disabled={controlsLocked || !workspaces.length} onClick={() => { setMode('workspace'); setPath(''); setQuery(''); }}>작업 폴더</button>{mode === 'workspace' && <select aria-label="작업 폴더" value={workspaceId} disabled={controlsLocked} onChange={(event) => { setWorkspaceId(event.target.value); setPath(''); setQuery(''); }}>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select>}</div>
      <div className="files-toolbar"><button className="btn btn-ghost" disabled={controlsLocked || !path} onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}>‹ 상위</button><b title={path}>{activePc.name} / {path || (mode === 'shared' ? '공유함' : workspaces.find((item) => item.id === workspaceId)?.name ?? '작업 폴더')}</b><label className="file-search"><span>⌕</span><input aria-label="현재 폴더 검색" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="현재 폴더 검색" /></label><button className="btn btn-ghost files-refresh" title="새로고침" aria-label="파일 목록 새로고침" disabled={controlsLocked} onClick={() => void refresh()}>↻</button><input ref={picker} hidden type="file" multiple onChange={(event) => void upload(event.target.files)} /><button className="btn btn-primary" disabled={controlsLocked || (mode === 'workspace' && !workspaceId)} onClick={() => picker.current?.click()}>＋ 파일 올리기</button></div>
      {(notice || downloadId || peerTransferCancelable) && <div className="files-notice" role="status" aria-live="polite">{downloadId ? '파일을 디스크에 직접 저장하는 중입니다…' : peerTransferCancelable ? peerTransferStatus : notice}{downloadId && <button type="button" className="btn btn-ghost" onClick={() => void window.mrRobotDesktop?.cancelDownload(downloadId)}>다운로드 중지</button>}{peerTransferCancelable && <button type="button" className="btn btn-ghost" onClick={() => cancelPeerTransfer('user')}>전송 취소</button>}</div>}
      <div className="files-list">{busy === 'list' && <div className="files-loading"><span className="spinner" /> 목록을 읽는 중…</div>}{busy !== 'list' && visibleItems.length === 0 && <div className="files-empty">{query ? '검색 결과가 없습니다.' : mode === 'shared' ? '기기 공유함이 비어 있습니다.' : '이 작업 폴더가 비어 있습니다.'}<small>{query ? '다른 검색어를 입력하세요.' : '위 버튼이나 드래그 앤 드롭으로 파일을 추가하세요.'}</small></div>}
        {visibleItems.map((item) => <article key={item.path} className="file-row"><button className="file-main" disabled={controlsLocked} onClick={() => item.isDirectory ? (setPath(item.path), setQuery('')) : void download(item)}><span className="file-icon">{item.isDirectory ? '▰' : '◇'}</span><span><b>{item.name}</b><small>{item.isDirectory ? '폴더' : sizeOf(item.size)} · {new Date(item.modifiedAt).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })}</small></span><em>{item.isDirectory ? '열기' : '다운로드'}</em></button>
          {!item.isDirectory && mode === 'shared' && otherPcs.length > 0 && <div className="file-targets"><small>다른 PC로 직접 전송</small>{otherPcs.map((pc) => <button key={pc.id} disabled={Boolean(busy)} onClick={() => void copy(item, pc)}>{pc.name}</button>)}</div>}
        </article>)}
      </div>
    </section>
  </div>;
}
