import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { DependencyReport, SystemStatus } from '@mr-robot/shared';
import { MrRobotClient } from './rpc';
import { MrRobotContext } from './state';
import { DESKTOP_LOCAL_PC_ID, loadPcsForEnvironment, setLastPcId, type SavedPc } from './pcs';
import { ConnectGate } from './components/ConnectGate';
import type { ViewKey } from './components/Sidebar';
import { ProfileMenu } from './components/ProfileMenu';
import { ChatView } from './views/ChatView';
import { DependencySetup } from './components/DependencySetup';

const SchedulesView = lazy(() => import('./views/SchedulesView').then((module) => ({ default: module.SchedulesView })));
const PluginsView = lazy(() => import('./views/PluginsView').then((module) => ({ default: module.PluginsView })));
const SettingsView = lazy(() => import('./views/SettingsView').then((module) => ({ default: module.SettingsView })));
const FilesView = lazy(() => import('./views/FilesView').then((module) => ({ default: module.FilesView })));

export function App() {
  const client = useMemo(() => new MrRobotClient(), []);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<ViewKey>('chat');
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [activePc, setActivePc] = useState<SavedPc | null>(null);
  const [pcList, setPcList] = useState<SavedPc[]>([]);
  const [preferredPc, setPreferredPc] = useState<SavedPc | null>(null);
  const [managingConnections, setManagingConnections] = useState(false);
  const [showDependencySetup, setShowDependencySetup] = useState(false);
  const [voiceCommands, setVoiceCommands] = useState<Array<{ id: number; text: string }>>([]);
  const voiceCommandId = useRef(0);
  const desktopStandalone = Boolean(window.mrRobotDesktop);
  const desktopLocalActive = desktopStandalone && activePc?.id === DESKTOP_LOCAL_PC_ID;

  useEffect(() => {
    let active = true;
    void loadPcsForEnvironment()
      .then((items) => { if (active) setPcList(items); })
      .catch(() => { if (active) setPcList([]); });
    return () => { active = false; };
  }, []);

  useEffect(() => window.mrRobotDesktop?.onNavigate?.((target) => {
    if (target === 'chat' || target === 'files' || target === 'schedules' || target === 'plugins' || target === 'settings') setView(target);
  }), []);

  useEffect(() => {
    // On an unexpected drop, return to the connect gate so it can auto-reconnect.
    const onDrop = (): void => {
      setConnected(false);
      setStatus(null);
      setReady(false);
    };
    client.onClose = onDrop;
    client.onAuthFail = onDrop;
    return () => client.dispose();
  }, [client]);

  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let timer: number | undefined;
    const refresh = async (): Promise<void> => {
      if (disposed || document.visibilityState === 'hidden') return;
      try {
        const s = (await client.call('status')) as SystemStatus;
        if (!disposed) setStatus(s);
      } catch {
        /* disconnected */
      }
      if (!disposed && document.visibilityState === 'visible') timer = window.setTimeout(() => void refresh(), 10000);
    };
    const resume = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState === 'visible' && navigator.onLine) void refresh();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    resume();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
    };
  }, [client, ready]);

  useEffect(() => {
    if (!ready) return;
    return client.on('voice.command', (data) => {
      const command = data as { kind?: string; text?: string };
      const text = command.text?.trim();
      if (command.kind !== 'pc' || !text) return;
      setVoiceCommands((queued) => [...queued, { id: ++voiceCommandId.current, text }]);
      setView('chat');
    });
  }, [client, ready]);

  useEffect(() => {
    if (!ready) return;
    if (!client.isAdmin) {
      setShowDependencySetup(false);
      return;
    }
    void client.call('dependencies.status', {})
      .then((value) => setShowDependencySetup((value as DependencyReport).wizardVersion < 5))
      .catch(() => setShowDependencySetup(false));
  }, [client, ready]);

  const switchPc = (id: string): void => {
    const pc = pcList.find((p) => p.id === id);
    if (!pc || pc.id === activePc?.id) return;
    const local = pc.id === DESKTOP_LOCAL_PC_ID;
    setManagingConnections(false);
    setPreferredPc(local ? null : pc);
    setLastPcId(local ? null : pc.id);
    client.close();
    setConnected(false);
    setStatus(null);
    setReady(false);
  };

  const disconnect = (): void => {
    setManagingConnections(false);
    setPreferredPc(null);
    setLastPcId(null);
    client.close();
    setConnected(false);
    setStatus(null);
    setReady(false);
  };

  const openConnectionManager = (): void => {
    setManagingConnections(true);
    setPreferredPc(null);
    client.close();
    setConnected(false);
    setStatus(null);
    setReady(false);
  };

  const viewMeta: Record<Exclude<ViewKey, 'chat'>, { title: string; eyebrow: string; description: string }> = {
    files: { title: '기기 공유함', eyebrow: 'DEVICE MESH', description: 'PC와 모바일 사이의 파일·작업 동기화' },
    schedules: { title: '일정과 자동화', eyebrow: 'AUTOMATION', description: '캘린더 일정과 예약 에이전트 작업' },
    plugins: { title: '플러그인', eyebrow: 'CAPABILITIES', description: '도구·연결·샌드박스 모듈 관리' },
    settings: { title: '설정', eyebrow: 'CONTROL CENTER', description: '모델·라우팅·기기·보안 구성' },
  };

  if (!ready) {
    return (
      <ConnectGate
        client={client}
        preferredPc={preferredPc}
        manageConnections={managingConnections}
        onCancel={desktopStandalone ? () => setManagingConnections(false) : undefined}
        onConnected={(pc) => {
          setManagingConnections(false);
          setActivePc(pc);
          void loadPcsForEnvironment()
            .then((items) => setPcList((current) => {
              const local = pc.id === DESKTOP_LOCAL_PC_ID
                ? pc
                : current.find((item) => item.id === DESKTOP_LOCAL_PC_ID);
              return local ? [local, ...items.filter((item) => item.id !== local.id)] : items;
            }))
            .catch(() => setPcList([pc]));
          setConnected(true);
          setReady(true);
        }}
      />
    );
  }

  return (
    <MrRobotContext.Provider value={{ client }}>
      <div className="shell">
        <main className="content">
          {view !== 'chat' && <header className="workspace-header">
            <div className="workspace-header-main">
              <button className="workspace-brand" type="button" onClick={() => setView('chat')} title="대화로 돌아가기">
                <span className="workspace-brand-mark">✦</span>
                <span><b>Mr.Robot</b><small>{viewMeta[view].eyebrow}</small></span>
              </button>
              <div className="workspace-heading"><h1>{viewMeta[view].title}</h1><p>{viewMeta[view].description}</p></div>
              <div className="topbar-meta">
              {pcList.length > 0 && (
                <select
                  className="input pc-switch"
                  value={activePc?.id ?? ''}
                  onChange={(e) => switchPc(e.target.value)}
                  title="PC 전환"
                >
                  {pcList.map((pc) => (
                    <option key={pc.id} value={pc.id}>
                      🖥️ {pc.name} · {pc.activeOrigin ?? pc.origins?.[0] ?? `${pc.host}:${pc.port}`}
                    </option>
                  ))}
                </select>
              )}
              {status && (
                <>
                  <span className="topbar-chip">
                    {status.platform} · {status.network.port} 포트
                  </span>
                  {status.defaultProviderId ? (
                    <span className="topbar-chip ok">AI 연결됨</span>
                  ) : (
                    <span className="topbar-chip warn">AI 미설정</span>
                  )}
                </>
              )}
              {!client.isAdmin && <span className="topbar-chip locked" title="PC 관리 설정은 데스크톱 관리자 연결에서만 변경할 수 있습니다.">🔒 연결 기기 · 관리 제한</span>}
              <button className="btn btn-ghost" onClick={desktopLocalActive ? openConnectionManager : disconnect} title={desktopLocalActive ? '선택 기능: 원격 PC 추가·관리' : '현재 원격 연결을 닫고 로컬 PC로 돌아가기'}>
                {desktopLocalActive ? '원격 PC' : desktopStandalone ? '로컬 PC로' : '연결 해제'}
              </button>
                <ProfileMenu standalone={desktopStandalone} header view={view} onChange={setView} deviceName={activePc?.name ?? ''} connected={connected} pcs={pcList} activePcId={activePc?.id} onSwitchPc={switchPc} onDisconnect={disconnect} onManagePcs={openConnectionManager} />
              </div>
            </div>
            <nav className="workspace-nav" aria-label="주요 화면">
              {([['chat', '대화'], ['files', '파일'], ['schedules', '일정'], ['plugins', '플러그인'], ['settings', '설정']] as Array<[ViewKey, string]>).map(([key, label]) => <button key={key} type="button" className={view === key ? 'active' : ''} onClick={() => setView(key)}>{label}</button>)}
            </nav>
          </header>}
          {view === 'chat' && <ChatView
            activePc={activePc}
            profile={<ProfileMenu standalone={desktopStandalone} embedded view={view} onChange={setView} deviceName={activePc?.name ?? ''} connected={connected} pcs={pcList} activePcId={activePc?.id} onSwitchPc={switchPc} onDisconnect={disconnect} onManagePcs={openConnectionManager} />}
            voiceCommand={voiceCommands[0] ?? null}
            onVoiceCommandHandled={(id) => setVoiceCommands((queued) => queued.filter((command) => command.id !== id))}
          />}
          {view !== 'chat' && <Suspense fallback={<div className="view-loading" role="status"><span className="spinner" /> 화면을 준비하는 중…</div>}>
            {view === 'schedules' && <SchedulesView />}
            {view === 'files' && activePc && <FilesView activePc={activePc} pcs={pcList} />}
            {view === 'plugins' && <PluginsView />}
            {view === 'settings' && <SettingsView onOpenChat={() => setView('chat')} />}
          </Suspense>}
        </main>
        {showDependencySetup && <DependencySetup modal onComplete={() => setShowDependencySetup(false)} />}
      </div>
    </MrRobotContext.Provider>
  );
}
