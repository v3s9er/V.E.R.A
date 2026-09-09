import { useEffect, useState } from 'react';
import { useMrRobot } from '../state';
import { Button } from './ui';

type Status = { running: boolean; supported: boolean; state: string; error: string };
const labels: Record<string, string> = { off: '꺼짐', starting: '덮개 감지 준비 중', ready: '덮개 상태 대기 중 · 열고 닫으면 작동', open: '덮개 열림 · 원래 화면 사용 중', closed: '덮개 닫힘 · 다음 열림부터 감지', disconnected: '외부 화면 출력 해제됨 · PC 작업은 계속', restored: '화면 복구됨 · 다음 덮개 닫힘부터 적용', restoring: '화면 복구 후 종료 중', stopped: '복구 완료', error: '확인 필요' };
export function LidDisplayPanel() {
  const { client } = useMrRobot();
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const off = client.on('lid-display.changed', value => { if (live) setStatus(value as Status); });
    void client.call('plugins.call', { name: 'lid-display.status', params: {} }).then(value => { if (live) setStatus(value as Status); }).catch(() => { if (live) setError('관리자 PC에서 설정하세요.'); });
    return () => { live = false; off(); };
  }, [client]);
  async function action(name: string) {
    setBusy(true); setError('');
    try { setStatus(await client.call('plugins.call', { name: `lid-display.${name}`, params: {} }) as Status); }
    catch (e) { setError(e instanceof Error ? e.message : '요청 실패'); }
    finally { setBusy(false); }
  }
  return <div className="provider-add">
    <p role="status">{labels[status?.state ?? 'off'] ?? '상태 확인 중'}</p>
    {(error || status?.error) && <p className="error" role="alert">{error || status?.error}</p>}
    <p>위의 <b>켜기</b>를 누른 후 덮개를 열었다 닫으세요. 닫을 때 외부 화면 출력을 해제하고 열면 해상도·배치를 복구합니다. 끄거나 앱을 정상 종료해도 화면을 복구합니다.</p>
    <p className="muted">Windows의 ‘덮개를 닫을 때 → 아무것도 안 함’을 유지하세요. 절전·최대 절전 설정과 모니터 전원은 변경하지 않습니다. 내장 화면·그래픽 드라이버가 전환을 지원해야 하며, HDMI 오디오도 함께 끊길 수 있습니다. PC 앱이 실행 중이어야 합니다.</p>
    <div className="type-row">
      <Button disabled={busy || !client.isAdmin || !status?.running} onClick={() => void action('restore')}>지금 화면 복구</Button>
      <Button disabled={busy || !client.isAdmin || status?.running} onClick={() => void action('retry')}>감지 다시 시작</Button>
    </div>
    <p className="muted">화면이 돌아오지 않으면 덮개를 열고 Win+P → 확장을 선택하세요. 전원 강제 종료나 도킹 장치 교체 시에는 기존 배치를 완전히 복구하지 못할 수 있습니다.</p>
  </div>;
}
