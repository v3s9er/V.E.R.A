import { useEffect, useRef, useState } from 'react';
import { chatFileLinks } from '@mr-robot/shared';
import { pcOrigin, type SavedPc } from '../pcs';

export function ChatFiles({ text, pc, conversationId }: { text: string; pc: SavedPc; conversationId: string }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const operation = useRef('');
  useEffect(() => () => { if (operation.current) void window.mrRobotDesktop?.cancelDownload(operation.current); }, []);
  async function download(path: string, name: string) {
    if (operation.current) return;
    const id = crypto.randomUUID(); operation.current = id; setBusy(true); setNotice('');
    try {
      if (!window.mrRobotDesktop?.downloadFile) throw new Error('PC 앱 또는 모바일 앱에서 보안 파일 다운로드를 사용해 주세요.');
      const query = new URLSearchParams({ conversationId, path });
      const result = await window.mrRobotDesktop.downloadFile({ id, url: `${pcOrigin(pc)}/api/workspaces/download?${query}`, token: pc.secret, suggestedName: name });
      setNotice(result.canceled ? '다운로드를 취소했습니다.' : '파일을 저장했습니다.');
    } catch (error) { setNotice(error instanceof Error ? error.message : '다운로드 실패'); }
    finally { operation.current = ''; setBusy(false); }
  }
  return <div className="chat-file-cards">{chatFileLinks(text).map(file => <button type="button" className="chat-file-card" key={file.path} disabled={busy} onClick={() => void download(file.path, file.name)} title={file.path}>↓ {file.name}</button>)}{busy && <button type="button" onClick={() => { if (operation.current) void window.mrRobotDesktop?.cancelDownload(operation.current); }}>전송 취소</button>}{notice && <small role="status">{notice}</small>}</div>;
}
