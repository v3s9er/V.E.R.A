export type ViewKey = 'chat' | 'files' | 'schedules' | 'plugins' | 'settings';

const ICONS: Record<ViewKey, React.ReactNode> = {
  chat: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  ),
  files: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 7h13l-3-3m3 3-3 3M17 17H4l3 3m-3-3 3-3" /></svg>
  ),
  plugins: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a4 4 0 0 0 5.4 5.4L19 13a4 4 0 1 1-6-6l1.7-1.7z" />
      <path d="M6.3 17.7a4 4 0 0 0-5.4-5.4L2 11a4 4 0 1 0 6 6l-1.7 1.7z" opacity=".55" />
    </svg>
  ),
  schedules: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

const LABELS: Record<ViewKey, string> = {
  chat: '대화',
  files: '기기 공유함',
  schedules: '예약 작업',
  plugins: '플러그인',
  settings: '설정',
};

export function Sidebar({
  view,
  onChange,
  deviceName,
  connected,
}: {
  view: ViewKey;
  onChange: (v: ViewKey) => void;
  deviceName: string;
  connected: boolean;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <svg viewBox="0 0 100 100" width="26" height="26">
            <defs>
              <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#7c5cff" />
                <stop offset="1" stopColor="#22d3ee" />
              </linearGradient>
            </defs>
            <rect width="100" height="100" rx="24" fill="url(#lg)" />
            <circle cx="50" cy="50" r="16" fill="white" />
            <circle cx="50" cy="26" r="8" fill="white" opacity=".7" />
          </svg>
        </span>
        <span className="brand-name">Mr.Robot</span>
      </div>

      <nav className="nav">
        {(Object.keys(LABELS) as ViewKey[]).map((key) => (
          <button key={key} className={`nav-item ${view === key ? 'active' : ''}`} onClick={() => onChange(key)}>
            <span className="nav-icon">{ICONS[key]}</span>
            {LABELS[key]}
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        <div className={`status-dot ${connected ? 'ok' : 'off'}`} />
        <div className="sidebar-foot-text">
          <div className="device">{deviceName || '—'}</div>
          <div className="state">{connected ? '연결됨' : '연결 끊김'}</div>
        </div>
      </div>
    </aside>
  );
}
