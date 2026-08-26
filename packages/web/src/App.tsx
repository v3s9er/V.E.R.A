import { useEffect, useMemo, useRef, useState } from 'react';
import type { DependencyReport, SystemStatus } from '@mr-robot/shared';
import { MrRobotClient, wsUrlFor } from './rpc';
import { MrRobotContext } from './state';
import { loadPcs, setLastPcId, type SavedPc } from './pcs';
import { ConnectGate } from './components/ConnectGate';
import type { ViewKey } from './components/Sidebar';
import { ProfileMenu } from './components/ProfileMenu';
import { ChatView } from './views/ChatView';
import { SchedulesView } from './views/SchedulesView';
import { PluginsView } from './views/PluginsView';
import { SettingsView } from './views/SettingsView';
import { DependencySetup } from './components/DependencySetup';
import { FilesView } from './views/FilesView';
import { Spinner } from './components/ui';

export function App() {
  const client = useMemo(() => new MrRobotClient(), []);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<ViewKey>('chat');
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [activePc, setActivePc] = useState<SavedPc | null>(null);
  const [pcList, setPcList] = useState<SavedPc[]>(() => loadPcs());
  const [showDependencySetup, setShowDependencySetup] = useState(false);
  const [desktopBootError, setDesktopBootError] = useState('');
  const [voiceCommands, setVoiceCommands] = useState<Array<{ id: number; text: string }>>([]);
  const voiceCommandId = useRef(0);
  const desktopStandalone = Boolean(window.mrRobotDesktop);

  useEffect(() => {
    // On an unexpected drop, return to the connect gate so it can auto-reconnect.
    const onDrop = (): void => {
      setConnected(false);
      setStatus(null);
      setReady(false);
    };
    client.onClose = onDrop;
    client.onAuthFail = onDrop;
    return () => client.close();
  }, [client]);

  useEffect(() => {
    if (!desktopStandalone || ready) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    const connectLocal = async (): Promise<void> => {
      try {
        const local = await window.mrRobotDesktop!.getLocalConnection();
        await client.connect(wsUrlFor(`${local.host}:${local.port}`), local.secret, 8000);
        if (cancelled) { client.close(); return; }
        const pc: SavedPc = { ...local, id: 'desktop-local', addedAt: 0, hosts: [local.host], activeHost: local.host };
        setActivePc(pc);
        setPcList([pc]);
        setConnected(true);
        setDesktopBootError('');
        setReady(true);
      } catch (error) {
        if (cancelled) return;
        setDesktopBootError(error instanceof Error ? error.message : String(error));
        retryTimer = window.setTimeout(() => void connectLocal(), 1200);
      }
    };
    void connectLocal();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [client, desktopStandalone, ready]);

  useEffect(() => {
    if (!ready) return;
    const refresh = async (): Promise<void> => {
      try {
        const s = (await client.call('status')) as SystemStatus;
        setStatus(s);
      } catch {
        /* disconnected */
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
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
    void client.call('dependencies.status', {})
      .then((value) => setShowDependencySetup((value as DependencyReport).wizardVersion < 4))
      .catch(() => setShowDependencySetup(false));
  }, [client, ready]);

  const switchPc = (id: string): void => {
    const pc = pcList.find((p) => p.id === id);
    if (!pc || pc.id === activePc?.id) return;
    setLastPcId(pc.id);
    client.close();
    setConnected(false);
    setStatus(null);
    setReady(false);
  };

  const disconnect = (): void => {
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
    if (desktopStandalone) {
      return <div className="gate"><div className="gate-card"><div className="gate-brand"><Spinner size={26} /></div><p className="gate-sub">내장 로컬 에이전트를 시작하는 중…</p>{desktopBootError && <p className="gate-sub dim">자동 재시도 중 · {desktopBootError}</p>}</div></div>;
    }
    return (
      <ConnectGate
        client={client}
        onConnected={(pc) => {
          setActivePc(pc);
          setPcList(loadPcs());
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
              {!desktopStandalone && pcList.length > 0 && (
                <select
                  className="input pc-switch"
                  value={activePc?.id ?? ''}
                  onChange={(e) => switchPc(e.target.value)}
                  title="PC 전환"
                >
                  {pcList.map((pc) => (
                    <option key={pc.id} value={pc.id}>
                      🖥️ {pc.name} · {pc.host}:{pc.port}
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
              {!desktopStandalone && <button className="btn btn-ghost" onClick={disconnect} title="연결 해제 / PC 관리">
                연결 해제
              </button>}
                <ProfileMenu standalone={desktopStandalone} header view={view} onChange={setView} deviceName={activePc?.name ?? ''} connected={connected} pcs={pcList} activePcId={activePc?.id} onSwitchPc={switchPc} onDisconnect={disconnect} />
              </div>
            </div>
            <nav className="workspace-nav" aria-label="주요 화면">
              {([['chat', '대화'], ['files', '파일'], ['schedules', '일정'], ['plugins', '플러그인'], ['settings', '설정']] as Array<[ViewKey, string]>).map(([key, label]) => <button key={key} type="button" className={view === key ? 'active' : ''} onClick={() => setView(key)}>{label}</button>)}
            </nav>
          </header>}
          {view === 'chat' && <ChatView
            profile={<ProfileMenu standalone={desktopStandalone} embedded view={view} onChange={setView} deviceName={activePc?.name ?? ''} connected={connected} pcs={pcList} activePcId={activePc?.id} onSwitchPc={switchPc} onDisconnect={disconnect} />}
            voiceCommand={voiceCommands[0] ?? null}
            onVoiceCommandHandled={(id) => setVoiceCommands((queued) => queued.filter((command) => command.id !== id))}
          />}
          {view === 'schedules' && <SchedulesView />}
          {view === 'files' && activePc && <FilesView activePc={activePc} pcs={pcList} />}
          {view === 'plugins' && <PluginsView />}
          {view === 'settings' && <SettingsView onOpenChat={() => setView('chat')} />}
        </main>
        {showDependencySetup && <DependencySetup modal onComplete={() => setShowDependencySetup(false)} />}
      </div>
    </MrRobotContext.Provider>
  );
}
