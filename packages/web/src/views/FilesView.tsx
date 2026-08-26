import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SavedPc } from '../pcs';
import type { WorkspaceInfo } from '@mr-robot/shared';

interface SharedFileEntry { name: string; path: string; isDirectory: boolean; size: number; modifiedAt: number }
const baseOf = (pc: SavedPc): string => `http://${pc.activeHost ?? pc.host}:${pc.port}`;
const sizeOf = (size: number): string => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;

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
  const picker = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const request = async (pc: SavedPc, url: string, init: RequestInit = {}): Promise<Response> => fetch(`${baseOf(pc)}${url}`, { ...init, headers: { ...(init.headers ?? {}), 'x-mr-robot-token': pc.secret } });
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
    finally { setBusy(''); if (picker.current) picker.current.value = ''; }
  };

  const download = async (item: SharedFileEntry): Promise<void> => {
    setBusy(item.path); setNotice('');
    try {
      const endpoint = mode === 'shared'
        ? `/api/files/download?path=${encodeURIComponent(item.path)}`
        : `/api/workspaces/download?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(item.path)}`;
      const response = await request(activePc, endpoint);
      if (!response.ok) throw new Error(`다운로드 실패 (HTTP ${response.status})`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = item.name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setNotice(`${activePc.name}에서 다운로드 완료 · AI 토큰 0`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };

  const copy = async (item: SharedFileEntry, target: SavedPc): Promise<void> => {
    setBusy(`${item.path}:${target.id}`); setNotice('');
    try {
      const response = await request(target, '/api/files/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceBase: baseOf(activePc), sourceSecret: activePc.secret, sourcePath: item.path, targetPath: item.path }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setNotice(`${activePc.name} → ${target.name} PC 간 직접 전송 완료 · AI 토큰 0`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };

  const pullSync = async (target: SavedPc, source: SavedPc): Promise<void> => {
    const response = await request(target, '/api/sync/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceBase: baseOf(source), sourceSecret: source.secret }) });
    const body = await response.json() as { error?: string };
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  };
  const sync = async (target: SavedPc): Promise<void> => {
    setBusy(`sync:${target.id}`); setNotice('');
    try { await pullSync(target, activePc); await pullSync(activePc, target); setNotice(`${activePc.name} ↔ ${target.name} 대화·내 프리셋 동기화 완료 · AI 토큰 0`); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };

  const otherPcs = pcs.filter((pc) => pc.id !== activePc.id);
  const visibleItems = useMemo(() => items
    .filter((item) => !query.trim() || item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'ko')), [items, query]);
  const fileCount = items.filter((item) => !item.isDirectory).length;
  const folderCount = items.length - fileCount;
  return <div className="device-files stack">
    <section className="files-hero panel"><div><span className="eyebrow">TOKENLESS TRANSFER</span><h2>파일 전송·작업 폴더</h2><p>모바일·노트북 사이에서 AI를 호출하지 않고 원본 파일과 작업 상태를 직접 주고받습니다.</p></div>
      <div className="files-overview"><div className="files-kpis"><span><b>{folderCount}</b> 폴더</span><span><b>{fileCount}</b> 파일</span><span><b>0</b> AI 토큰</span></div><div className="files-sync">{otherPcs.map((pc) => <button key={pc.id} className="btn btn-ghost" disabled={Boolean(busy)} onClick={() => void sync(pc)}>{busy === `sync:${pc.id}` ? '동기화 중…' : `↻ ${pc.name} 작업 동기화`}</button>)}</div></div>
    </section>
    <section
      className={`panel files-panel ${dragging ? 'dragging-files' : ''}`}
      onDragEnter={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current += 1; setDragging(true); } }}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
      onDragLeave={(event) => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); dragDepth.current = 0; setDragging(false); void upload(event.dataTransfer.files); }}
    >
      {dragging && <div className="file-drop-overlay"><b>여기에 파일 놓기</b><span>{mode === 'shared' ? '기기 공유함' : '선택한 작업 폴더'}에 직접 업로드 · AI 토큰 0</span></div>}
      <div className="files-source-tabs"><button className={mode === 'shared' ? 'active' : ''} onClick={() => { setMode('shared'); setPath(''); setQuery(''); }}>기기 공유함</button><button className={mode === 'workspace' ? 'active' : ''} disabled={!workspaces.length} onClick={() => { setMode('workspace'); setPath(''); setQuery(''); }}>작업 폴더</button>{mode === 'workspace' && <select aria-label="작업 폴더" value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setPath(''); setQuery(''); }}>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select>}</div>
      <div className="files-toolbar"><button className="btn btn-ghost" disabled={!path} onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}>‹ 상위</button><b title={path}>{activePc.name} / {path || (mode === 'shared' ? '공유함' : workspaces.find((item) => item.id === workspaceId)?.name ?? '작업 폴더')}</b><label className="file-search"><span>⌕</span><input aria-label="현재 폴더 검색" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="현재 폴더 검색" /></label><button className="btn btn-ghost files-refresh" title="새로고침" aria-label="파일 목록 새로고침" disabled={busy === 'list'} onClick={() => void refresh()}>↻</button><input ref={picker} hidden type="file" multiple onChange={(event) => void upload(event.target.files)} /><button className="btn btn-primary" disabled={mode === 'workspace' && !workspaceId} onClick={() => picker.current?.click()}>＋ 파일 올리기</button></div>
      {notice && <div className="files-notice">{notice}</div>}
      <div className="files-list">{busy === 'list' && <div className="files-loading"><span className="spinner" /> 목록을 읽는 중…</div>}{busy !== 'list' && visibleItems.length === 0 && <div className="files-empty">{query ? '검색 결과가 없습니다.' : mode === 'shared' ? '기기 공유함이 비어 있습니다.' : '이 작업 폴더가 비어 있습니다.'}<small>{query ? '다른 검색어를 입력하세요.' : '위 버튼이나 드래그 앤 드롭으로 파일을 추가하세요.'}</small></div>}
        {visibleItems.map((item) => <article key={item.path} className="file-row"><button className="file-main" onClick={() => item.isDirectory ? (setPath(item.path), setQuery('')) : void download(item)}><span className="file-icon">{item.isDirectory ? '▰' : '◇'}</span><span><b>{item.name}</b><small>{item.isDirectory ? '폴더' : sizeOf(item.size)} · {new Date(item.modifiedAt).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })}</small></span><em>{item.isDirectory ? '열기' : '다운로드'}</em></button>
          {!item.isDirectory && mode === 'shared' && otherPcs.length > 0 && <div className="file-targets"><small>다른 PC로 직접 전송</small>{otherPcs.map((pc) => <button key={pc.id} disabled={Boolean(busy)} onClick={() => void copy(item, pc)}>{pc.name}</button>)}</div>}
        </article>)}
      </div>
    </section>
  </div>;
}
