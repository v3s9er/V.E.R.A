import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export function SecureFileEnroll({ request }: { request: (path: string, init: RequestInit) => Promise<Response> }) {
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => { if (!qr) return; const timer = setTimeout(() => setQr(''), 60_000); return () => clearTimeout(timer); }, [qr]);
  async function invite() {
    setBusy(true); setError('');
    try {
      const response = await request('/api/secure-files/invite', { method: 'POST' });
      if (!response.ok) throw new Error('PC 로컬 앱에서만 파일 암호화 QR을 만들 수 있습니다.');
      setQr(await QRCode.toDataURL(JSON.stringify(await response.json()), { width: 360, margin: 2, errorCorrectionLevel: 'M' }));
    } catch (e) { setError(e instanceof Error ? e.message : 'QR 생성 실패'); }
    finally { setBusy(false); }
  }
  return <section className="panel stack">
    <div><b>모바일 보안 파일 전송</b><p>폰을 PC에 연결한 뒤, 모바일 파일 화면의 ‘PC 파일 암호화 QR 등록’으로 스캔하세요. 파일 내용과 경로는 기기에서 암호화되며 중계 서버에 키를 전송하지 않습니다.</p></div>
    <div><button className="btn btn-primary" disabled={busy} onClick={() => void invite()}>파일 암호화 QR 표시</button>
    <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirmReset(true)}>등록 초기화</button></div>
    {confirmReset && <div role="alert"><p>모든 모바일 파일 암호화 키를 폐기합니다. 각 폰에서 새 QR 등록이 필요합니다.</p><button className="btn btn-danger" disabled={busy} onClick={() => { setBusy(true); void request('/api/secure-files/reset', { method: 'POST' }).then(r => { if (!r.ok) throw Error(); setQr(''); setConfirmReset(false); setError('파일 암호화 등록을 초기화했습니다.'); }).catch(() => setError('키 초기화 실패')).finally(() => setBusy(false)); }}>모두 폐기</button><button className="btn btn-ghost" disabled={busy} onClick={() => setConfirmReset(false)}>취소</button></div>}
    {qr && <div><img src={qr} width="300" height="300" style={{ maxWidth: '100%', height: 'auto' }} alt="모바일 파일 암호화 등록 QR" /><p>민감한 암호화 키입니다. 캡처·전달하지 마세요. 화면은 60초 후 숨겨지고 미등록 QR은 5분 후 만료됩니다.</p><button className="btn btn-ghost" onClick={() => setQr('')}>QR 숨기기</button></div>}
    {error && <p role="status">{error}</p>}
    <small>파일 전송 전용 AES-256-GCM 채널 · 파일당 96MB · 키 유효기간 90일. 대화 전체 암호화나 전방향 안전성은 제공하지 않습니다. Discord 첨부는 이 채널 밖입니다.</small>
  </section>;
}
