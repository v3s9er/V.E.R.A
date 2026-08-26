import { useCallback, useEffect, useState } from 'react';
import { MrRobotClient, wsUrlFor } from '../rpc';
import {
  detectServingPc,
  exchangePin,
  getLastPcId,
  loadPcs,
  removePc,
  savePcs,
  setLastPcId,
  upsertPc,
  type SavedPc,
} from '../pcs';
import { Button, Card, Field, Input, Spinner } from './ui';

type Phase = 'auto' | 'list' | 'connecting' | 'error';

/**
 * Connection gate with multi-PC support:
 *  - auto-registers the PC that serves this page (loopback pairing info),
 *  - auto-connects to the last used PC (or the only one),
 *  - lets the user register more PCs by host + PIN and switch between them.
 */
export function ConnectGate({ client, onConnected }: { client: MrRobotClient; onConnected: (pc: SavedPc) => void }) {
  const [phase, setPhase] = useState<Phase>('auto');
  const [error, setError] = useState('');
  const [pcs, setPcs] = useState<SavedPc[]>(() => loadPcs());
  const [connectingPc, setConnectingPc] = useState<SavedPc | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [hostPort, setHostPort] = useState('');
  const [pin, setPin] = useState('');
  const [addBusy, setAddBusy] = useState(false);

  const connectTo = useCallback(
    async (pc: SavedPc): Promise<boolean> => {
      setPhase('connecting');
      setConnectingPc(pc);
      setError('');
      const candidates = [...new Set([pc.activeHost, pc.host, ...(pc.hosts ?? [])].filter((value): value is string => Boolean(value)))];
      let lastError = '연결할 주소가 없습니다.';
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        try {
          await client.connect(wsUrlFor(`${candidate}:${pc.port}`), pc.secret, index < candidates.length - 1 ? 2500 : 8000);
          let refreshedHosts = pc.hosts ?? [pc.host];
          try {
            const info = await client.call('pairing.info', {}) as { host?: string; hosts?: string[] };
            refreshedHosts = [...new Set([info.host, ...(info.hosts ?? []), ...refreshedHosts].filter((value): value is string => Boolean(value)))];
          } catch { /* keep the working connection */ }
          const connectedPc = { ...pc, hosts: refreshedHosts, activeHost: candidate };
          savePcs(loadPcs().map((item) => item.id === pc.id ? connectedPc : item));
          setLastPcId(pc.id);
          onConnected(connectedPc);
          return true;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }
      setError(`${pc.name} 연결 실패: ${lastError}. PC 주소와 네트워크 연결을 확인하세요.`);
      setPhase('list');
      return false;
    },
    [client, onConnected],
  );

  useEffect(() => {
    let cancelled = false;
    const boot = async (): Promise<void> => {
      // 1. Refresh the serving PC's credentials (cheap; loopback only).
      let next = loadPcs();
      const serving = await detectServingPc();
      if (serving) {
        next = upsertPc(next, serving);
        savePcs(next);
        setPcs(next);
      }
      if (cancelled) return;

      // 2. Auto-connect: last used PC, or the only registered one.
      const lastId = getLastPcId();
      const target = next.find((p) => p.id === lastId) ?? (next.length === 1 ? next[0] : null);
      if (target) {
        const ok = await connectTo(target);
        if (cancelled || ok) return;
      }
      setPhase('list');
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, [connectTo]);

  const addPc = async (): Promise<void> => {
    if (!hostPort.trim() || pin.length !== 6 || addBusy) return;
    setAddBusy(true);
    setError('');
    try {
      const secret = await exchangePin(hostPort, pin, name.trim() || '웹 브라우저');
      const pc: Omit<SavedPc, 'id' | 'addedAt'> = {
        name: name.trim() || hostPort.trim(),
        host: hostPort.split(':')[0] || hostPort.trim(),
        port: Number(hostPort.split(':')[1] ?? 8787),
        secret,
      };
      const next = upsertPc(loadPcs(), pc);
      savePcs(next);
      setPcs(next);
      setName('');
      setHostPort('');
      setPin('');
      setShowAdd(false);
      await connectTo(next[next.length - 1]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddBusy(false);
    }
  };

  const deletePc = (id: string): void => {
    const next = removePc(loadPcs(), id);
    savePcs(next);
    setPcs(next);
    if (getLastPcId() === id) setLastPcId(null);
  };

  if (phase === 'connecting') {
    return (
      <div className="gate">
        <div className="gate-card">
          <div className="gate-brand">
            <Spinner size={26} />
          </div>
          <p className="gate-sub">{connectingPc ? `"${connectingPc.name}"에 연결하는 중…` : '연결 중…'}</p>
          <Button variant="ghost" onClick={() => setPhase('list')}>
            취소
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="gate">
      <div className="gate-glow" />
      <Card className="gate-card wide">
        <div className="gate-brand">
          <span className="brand-mark">
            <svg viewBox="0 0 100 100" width="32" height="32">
              <defs>
                <linearGradient id="lg3" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#7c5cff" />
                  <stop offset="1" stopColor="#22d3ee" />
                </linearGradient>
              </defs>
              <rect width="100" height="100" rx="24" fill="url(#lg3)" />
              <circle cx="50" cy="50" r="16" fill="white" />
              <circle cx="50" cy="26" r="8" fill="white" opacity=".7" />
            </svg>
          </span>
          <h1>Mr.Robot</h1>
        </div>
        <p className="gate-sub">연결할 PC를 선택하세요</p>

        {phase === 'auto' && (
          <div className="gate-row">
            <Spinner size={18} />
            <span>등록된 PC 확인 중…</span>
          </div>
        )}

        {error && <div className="gate-error">{error}</div>}

        {pcs.length === 0 && phase === 'list' && (
          <p className="gate-sub dim">등록된 PC가 없습니다. 아래에서 PC를 추가하세요.</p>
        )}

        {pcs.map((pc) => (
          <div key={pc.id} className="pc-row">
            <div className="pc-info">
              <span className="pc-icon">🖥️</span>
              <div>
                <div className="pc-name">{pc.name}</div>
                <div className="pc-addr">
                  {pc.host}:{pc.port}
                </div>
              </div>
            </div>
            <div className="pc-actions">
              <Button onClick={() => void connectTo(pc)}>연결</Button>
              <Button variant="ghost" onClick={() => deletePc(pc.id)} title="등록 해제">
                ✕
              </Button>
            </div>
          </div>
        ))}

        {showAdd ? (
          <div className="gate-form">
            <Field label="PC 이름 (선택)">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 서재 데스크톱" />
            </Field>
            <Field label="PC 주소" hint="해당 PC의 설정 → 모바일 연결 탭에 표시되는 주소">
              <Input value={hostPort} onChange={(e) => setHostPort(e.target.value)} placeholder="192.168.0.10:8787" />
            </Field>
            <Field label="PIN 코드" hint="해당 PC 화면에 표시되는 6자리 숫자">
              <Input
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                inputMode="numeric"
              />
            </Field>
            <div className="chat-actions">
              <Button variant="ghost" onClick={() => setShowAdd(false)}>
                취소
              </Button>
              <Button onClick={() => void addPc()} disabled={addBusy || !hostPort.trim() || pin.length !== 6}>
                {addBusy ? '등록 중…' : '등록 및 연결'}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="accent" onClick={() => setShowAdd(true)}>
            ＋ PC 추가
          </Button>
        )}
      </Card>
    </div>
  );
}
