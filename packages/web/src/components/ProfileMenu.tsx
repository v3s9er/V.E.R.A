import { useEffect, useRef, useState } from 'react';
import type { SavedPc } from '../pcs';
import type { ViewKey } from './Sidebar';

const LABELS: Record<ViewKey, string> = {
  chat: '대화로 돌아가기', files: '기기 공유함', schedules: '예약 작업', plugins: '플러그인', settings: '설정',
};
const SHORTCUTS: Array<{ key: Exclude<ViewKey, 'chat'>; icon: string; label: string }> = [
  { key: 'files', icon: '↔', label: '파일' },
  { key: 'schedules', icon: '◷', label: '일정' },
  { key: 'plugins', icon: '◇', label: '플러그인' },
  { key: 'settings', icon: '⚙', label: '설정' },
];

export function ProfileMenu({
  view, onChange, deviceName, connected, pcs, activePcId, onSwitchPc, onDisconnect, embedded = false, header = false, standalone = false,
}: {
  view: ViewKey;
  onChange: (v: ViewKey) => void;
  deviceName: string;
  connected: boolean;
  pcs: SavedPc[];
  activePcId?: string;
  onSwitchPc: (id: string) => void;
  onDisconnect: () => void;
  embedded?: boolean;
  header?: boolean;
  standalone?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);

  return <div ref={root} className={`profile-menu ${embedded ? 'embedded' : header ? 'header' : 'floating'}`}>
    {embedded && <div className="profile-shortcuts">{SHORTCUTS.map((item) => <button key={item.key} type="button" title={LABELS[item.key]} onClick={() => onChange(item.key)}><span>{item.icon}</span><small>{item.label}</small></button>)}</div>}
    {open && <div className="profile-popover">
      <div className="profile-popover-title">Mr.Robot</div>
      {(Object.keys(LABELS) as ViewKey[]).map((key) => key === view ? null :
        <button key={key} className="profile-action" onClick={() => { onChange(key); setOpen(false); }}>{LABELS[key]}</button>)}
      {!standalone && pcs.length > 1 && <div className="profile-section">
        <div className="profile-section-label">연결된 PC</div>
        {pcs.map((pc) => <button key={pc.id} className={`profile-action ${pc.id === activePcId ? 'active' : ''}`} onClick={() => { onSwitchPc(pc.id); setOpen(false); }}>🖥️ {pc.name}</button>)}
      </div>}
      {!standalone && <button className="profile-action danger" onClick={() => { onDisconnect(); setOpen(false); }}>연결 관리</button>}
    </div>}
    <button className="profile-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      <span className="profile-avatar">N</span>
      <span className="profile-copy"><b>{deviceName || 'Mr.Robot'}</b><small><span className={`status-dot ${connected ? 'ok' : 'off'}`} />{standalone ? '로컬 실행' : connected ? '연결됨' : '연결 끊김'}</small></span>
      <span className="profile-more">•••</span>
    </button>
  </div>;
}
