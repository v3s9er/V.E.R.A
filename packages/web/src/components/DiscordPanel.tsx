import { useEffect, useState } from 'react';
import { useMrRobot } from '../state';
import { Button, Input } from './ui';

export function DiscordPanel() {
  const { client } = useMrRobot();
  const [directory, setDirectory] = useState('');
  const [python, setPython] = useState('');
  const [mode, setMode] = useState<'standalone' | 'legacy'>('standalone');
  const [autoStart, setAutoStart] = useState(false);
  const [status, setStatus] = useState('상태 확인 중');
  const [busy, setBusy] = useState(false);
  const call = (name: string, params = {}) => client.call('plugins.call', { name: `discord.${name}`, params });
  useEffect(() => {
    let mounted = true;
    void call('status').then((raw) => {
      if (!mounted) return;
      const s = raw as { config: { botDirectory: string; pythonPath: string; autoStart: boolean; mode?: 'standalone' | 'legacy' }; ready: boolean; running: boolean; error: string };
      setDirectory(s.config.botDirectory); setPython(s.config.pythonPath); setAutoStart(s.config.autoStart);
      setMode(s.config.mode ?? 'legacy');
      setStatus(s.error || (s.ready ? 'Discord 연결됨 · 서버 관리자 전용' : s.running ? 'Discord 로그인 중' : '연결 꺼짐'));
    }).catch(() => { if (mounted) setStatus('관리자 PC에서 설정하세요.'); });
    return () => { mounted = false; };
  }, [client]);
  async function action(name: 'start' | 'stop' | 'status' | 'workspace.setup') {
    setBusy(true);
    try {
      if (name === 'start') await call('config.set', { botDirectory: directory, pythonPath: python, autoStart, mode });
      const s = await call(name) as { ready: boolean; running: boolean; error: string; workspace?: { message: string } };
      setStatus(s.error || s.workspace?.message || (s.ready ? 'Discord 연결됨 · 서버 관리자 전용' : s.running ? '로그인 중 · 잠시 후 상태 확인을 누르세요.' : '연결 꺼짐'));
    } catch (e) { setStatus(e instanceof Error ? e.message : '연결 실패'); }
    finally { setBusy(false); }
  }
  return <div className="provider-add">
    <p>등록 서버 관리자만 사용합니다. 아래에서 ai_talk 티켓 패널을 설치하거나 Discord 채널에서 <code>/robot bind</code>를 실행하세요. ‘티켓 열기’로 제목을 입력해 요청하면 개인 스레드가 생기고 일반 채팅으로 작업합니다. PC가 켜져 있어야 합니다.</p>
    <Button disabled={busy || !client.isAdmin} onClick={() => void action('workspace.setup')}>ai_talk 티켓 패널 설치</Button>
    <p className="muted">개인 스레드별 모델·권한·대화가 유지됩니다. 목록에서 보관 해제하고, 삭제는 확인 후 실행합니다. 비공개 스레드도 서버의 스레드 관리 권한자는 볼 수 있습니다. 일반 채팅에는 Developer Portal의 Message Content Intent가 필요합니다.</p>
    <label>Discord 실행 방식<select value={mode} disabled={busy} onChange={e => setMode(e.target.value as 'standalone' | 'legacy')}>
      <option value="standalone">독립 플러그인 · 연결정보만 공유 (권장)</option>
      <option value="legacy">시큐리티봇 함께 실행 · 단일 연결 (호환)</option>
    </select></label>
    <p className="muted">{mode === 'standalone' ? 'config.json의 bot_token·server_name만 읽습니다. 기존 봇 소스·GUI·뉴스·KTX 없이 실행되며 연결정보는 복사하거나 수정하지 않습니다.' : '기존 시큐리티봇에 AI 연동부를 붙여 Discord 연결 하나로 실행합니다. 이 모드만 기존 소스가 필요하며, 연결 중지 시 함께 실행한 시큐리티봇도 종료됩니다.'}</p>
    <label>{mode === 'standalone' ? '연결정보 폴더 (config.json)' : '기존 시큐리티봇 소스 폴더'}<Input value={directory} onChange={e => setDirectory(e.target.value)} placeholder="config.json이 있는 폴더의 절대 경로" /></label>
    <label>Python 실행 파일<Input value={python} onChange={e => setPython(e.target.value)} placeholder="python.exe 절대 경로" /></label>
    <label><input type="checkbox" checked={autoStart} onChange={e => setAutoStart(e.target.checked)} /> PC 앱 시작 시 자동 연결</label>
    <p role="status">{status}</p>
    <div className="type-row"><Button disabled={busy || !client.isAdmin} onClick={() => void action('start')}>저장·연결</Button><Button disabled={busy || !client.isAdmin} onClick={() => void action('stop')}>연결 중지</Button><Button disabled={busy} onClick={() => void action('status')}>상태 확인</Button></div>
    <p className="muted">/robot access · /robot approval · /robot result · /robot stop. 기본 권한은 변경 전 확인이며, full 선택 시 전체 PC 접근·확인 없는 변경을 허용합니다. Discord 토큰 예산은 무제한입니다. 기존 봇을 먼저 종료하고 연결하세요. 같은 PC의 중복 실행은 차단하지만 다른 PC의 동일 토큰 실행은 감지하지 못합니다. Discord에도 명령과 결과가 전달되므로 비밀정보는 입력하지 마세요.</p>
  </div>;
}
