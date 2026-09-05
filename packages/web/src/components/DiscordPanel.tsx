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
      setStatus(s.error || (s.ready ? 'Discord 연결됨 · 서버 관리자 전용' : s.running ? 'Discord 로그인 중' : '연결 꺼짐'));
    }).catch(() => { if (mounted) setStatus('관리자 PC에서 설정하세요.'); });
    return () => { mounted = false; };
  }, [client]);
  async function action(name: 'start' | 'stop' | 'status' | 'workspace.setup') {
    setBusy(true);
    try {
      if (name === 'start') await call('config.set', { botDirectory: directory, pythonPath: python, autoStart });
      const s = await call(name) as { ready: boolean; running: boolean; error: string; workspace?: { message: string } };
      setStatus(s.error || s.workspace?.message || (s.ready ? 'Discord 연결됨 · 서버 관리자 전용' : s.running ? '로그인 중 · 잠시 후 상태 확인을 누르세요.' : '연결 꺼짐'));
    } catch (e) { setStatus(e instanceof Error ? e.message : '연결 실패'); }
    finally { setBusy(false); }
  }
  return <div className="provider-add">
    <p>등록 서버 관리자만 사용합니다. 아래에서 ai_talk 티켓 패널을 설치하거나 Discord 채널에서 <code>/robot bind</code>를 실행하세요. ‘티켓 열기’로 제목을 입력해 요청하면 개인 스레드가 생기고 일반 채팅으로 작업합니다. PC가 켜져 있어야 합니다.</p>
    <Button disabled={busy || !client.isAdmin} onClick={() => void action('workspace.setup')}>ai_talk 티켓 패널 설치</Button>
    <p className="muted">개인 스레드별 모델·권한·대화가 유지됩니다. 목록에서 보관 해제하고, 삭제는 확인 후 실행합니다. 비공개 스레드도 서버의 스레드 관리 권한자는 볼 수 있습니다. 일반 채팅에는 Developer Portal의 Message Content Intent가 필요합니다.</p>
    <label>기존 봇 폴더<Input value={directory} onChange={e => setDirectory(e.target.value)} placeholder="discordbot 폴더의 절대 경로" /></label>
    <label>Python 실행 파일<Input value={python} onChange={e => setPython(e.target.value)} placeholder="python.exe 절대 경로" /></label>
    <label><input type="checkbox" checked={autoStart} onChange={e => setAutoStart(e.target.checked)} /> PC 앱 시작 시 자동 연결</label>
    <p role="status">{status}</p>
    <div className="type-row"><Button disabled={busy || !client.isAdmin} onClick={() => void action('start')}>저장·연결</Button><Button disabled={busy || !client.isAdmin} onClick={() => void action('stop')}>연결 중지</Button><Button disabled={busy} onClick={() => void action('status')}>상태 확인</Button></div>
    <p className="muted">/robot access · /robot approval · /robot result · /robot stop. 기본 권한은 변경 전 확인이며, full 선택 시 전체 PC 접근·확인 없는 변경을 허용합니다. Discord 토큰 예산은 무제한입니다. 기존 봇을 중복 실행하지 마세요. Discord에도 명령과 결과가 전달되므로 비밀정보는 입력하지 마세요.</p>
  </div>;
}
