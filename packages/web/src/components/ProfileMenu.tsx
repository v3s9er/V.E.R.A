import { useEffect, useId, useRef, useState } from 'react';
import { DESKTOP_LOCAL_PC_ID, type SavedPc } from '../pcs';
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
  view, onChange, deviceName, connected, pcs, activePcId, onSwitchPc, onDisconnect, onManagePcs, switchingBlocked = false, onBlockedSwitch, embedded = false, header = false, standalone = false,
}: {
  view: ViewKey;
  onChange: (v: ViewKey) => void;
  deviceName: string;
  connected: boolean;
  pcs: SavedPc[];
  activePcId?: string;
  onSwitchPc: (id: string) => void;
  onDisconnect: () => void;
  onManagePcs: () => void;
  switchingBlocked?: boolean;
  onBlockedSwitch?: () => void;
  embedded?: boolean;
  header?: boolean;
  standalone?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const desktopLocal = standalone && activePcId === DESKTOP_LOCAL_PC_ID;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    const close = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);
  useEffect(() => {
    if (!open) return;
    const focusMenu = window.requestAnimationFrame(() => popover.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus());
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusMenu);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return <div ref={root} className={`profile-menu ${embedded ? 'embedded' : header ? 'header' : 'floating'}`}>
    {embedded && <div className="profile-shortcuts" aria-label="빠른 화면 이동">{SHORTCUTS.map((item) => <button key={item.key} type="button" title={LABELS[item.key]} aria-current={view === item.key ? 'page' : undefined} onClick={() => onChange(item.key)}><span>{item.icon}</span><small>{item.label}</small></button>)}</div>}
    {open && <div ref={popover} id={menuId} className="profile-popover" role="menu" aria-label="프로필 및 실행 PC">
      <div className="profile-popover-title">Mr.Robot</div>
      {(Object.keys(LABELS) as ViewKey[]).map((key) => key === view ? null :
        <button key={key} type="button" role="menuitem" className="profile-action" onClick={() => { onChange(key); setOpen(false); }}>{LABELS[key]}</button>)}
      {pcs.length > 1 && <div className="profile-section">
        <div className="profile-section-label">실행 PC 선택</div>
        {switchingBlocked && <div className="profile-switch-locked">작업 중 · 완료 또는 중지 후 변경</div>}
        {pcs.map((pc) => <button key={pc.id} type="button" role="menuitem" disabled={switchingBlocked && pc.id !== activePcId} className={`profile-action ${pc.id === activePcId ? 'active' : ''}`} onClick={() => { if (switchingBlocked && pc.id !== activePcId) { onBlockedSwitch?.(); return; } onSwitchPc(pc.id); setOpen(false); }}>🖥️ {pc.name}{pc.id === activePcId ? ' · 현재 실행' : ''}</button>)}
      </div>}
      {desktopLocal
        ? <button type="button" role="menuitem" className="profile-action" disabled={switchingBlocked} title={switchingBlocked ? '작업 중에는 연결을 변경할 수 없습니다.' : undefined} onClick={() => { if (switchingBlocked) { onBlockedSwitch?.(); return; } onManagePcs(); setOpen(false); }}>원격 PC 추가·관리</button>
        : <button type="button" role="menuitem" className="profile-action danger" disabled={switchingBlocked} title={switchingBlocked ? '작업 중에는 연결을 변경할 수 없습니다.' : undefined} onClick={() => { if (switchingBlocked) { onBlockedSwitch?.(); return; } onDisconnect(); setOpen(false); }}>{standalone ? '로컬 PC로 돌아가기' : '연결 관리'}</button>}
    </div>}
    <button ref={trigger} type="button" className="profile-trigger" onClick={() => setOpen((value) => !value)} aria-label="프로필 및 실행 PC 메뉴" aria-haspopup="menu" aria-controls={menuId} aria-expanded={open}>
      <span className="profile-avatar">N</span>
      <span className="profile-copy"><b>{deviceName || 'Mr.Robot'}</b><small><span className={`status-dot ${connected ? 'ok' : 'off'}`} />{connected ? (desktopLocal ? '로컬 에이전트 · 준비됨' : '연결됨') : '연결 끊김'}</small></span>
      <span className="profile-more">•••</span>
    </button>
  </div>;
}
