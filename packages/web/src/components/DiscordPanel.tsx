import { useEffect, useState } from 'react';
import { useMrRobot } from '../state';
import { Button, Input } from './ui';

export function DiscordPanel() {
  const { client } = useMrRobot();
  const [directory, setDirectory] = useState('');
  const [python, setPython] = useState('');
  const [autoStart, setAutoStart] = useState(false);
  const [status, setStatus] = useState('상태 확인 중');
  const [busy, setBusy] = useState(false);
  const call = (name: string, params = {}) => client.call('plugins.call', { name: `discord.${name}`, params });
  useEffect(() => {
    let mounted = true;
    void call('status').then((raw) => {
      if (!mounted) return;
      const s = raw as { config: { botDirectory: string; pythonPath: string; autoStart: boolean }; ready: boolean; running: boolean; error: string };
      setDirectory(s.config.botDirectory); setPython(s.config.pythonPath); setAutoStart(s.config.autoStart);
      setStatus(s.error || (s.ready ? 'Discord 연결됨 · 소유자 전용' : s.running ? 'Discord 로그인 중' : '연결 꺼짐'));
    }).catch(() => { if (mounted) setStatus('관리자 PC에서 설정하세요.'); });
    return () => { mounted = false; };
  }, [client]);
  async function action(name: 'start' | 'stop' | 'status') {
    setBusy(true);
    try {
      if (name === 'start') await call('config.set', { botDirectory: directory, pythonPath: python, autoStart });
      const s = await call(name) as { ready: boolean; running: boolean; error: string };
      setStatus(s.error || (s.ready ? 'Discord 연결됨 · 소유자 전용' : s.running ? '로그인 중 · 잠시 후 상태 확인을 누르세요.' : '연결 꺼짐'));
    } catch (e) { setStatus(e instanceof Error ? e.message : '연결 실패'); }
    finally { setBusy(false); }
  }
  return <div className="provider-add">
    <p>기존 Discord 봇의 소유자만 <code>/robot ask</code>로 명령할 수 있습니다. 결과와 승인은 본인에게만 보입니다. PC가 켜져 있어야 합니다.</p>
    <label>기존 봇 폴더<Input value={directory} onChange={e => setDirectory(e.target.value)} placeholder="discordbot 폴더의 절대 경로" /></label>
    <label>Python 실행 파일<Input value={python} onChange={e => setPython(e.target.value)} placeholder="python.exe 절대 경로" /></label>
    <label><input type="checkbox" checked={autoStart} onChange={e => setAutoStart(e.target.checked)} /> PC 앱 시작 시 자동 연결</label>
    <p role="status">{status}</p>
    <div className="type-row"><Button disabled={busy || !client.isAdmin} onClick={() => void action('start')}>저장·연결</Button><Button disabled={busy || !client.isAdmin} onClick={() => void action('stop')}>연결 중지</Button><Button disabled={busy} onClick={() => void action('status')}>상태 확인</Button></div>
    <p className="muted">/robot models · /robot new · /robot stop · /robot status. 권한 상한은 변경 전 확인(ask), 토큰 정책은 adaptive입니다. 기존 봇을 중복 실행하지 마세요. Discord에도 명령과 결과가 전달되므로 비밀정보는 입력하지 마세요.</p>
  </div>;
}
