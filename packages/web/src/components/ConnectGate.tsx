import { useCallback, useEffect, useRef, useState } from 'react';
import { MrRobotClient, wsUrlFor } from '../rpc';
import {
  connectionOrigins,
  DESKTOP_LOCAL_PC_ID,
  detectServingPc,
  exchangePin,
  getLastPcId,
  loadPcsForEnvironment,
  originForDiscoveredHost,
  parsePcEndpoint,
  pcOrigin,
  removePc,
  savePcsForEnvironment,
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
export function ConnectGate({ client, onConnected, onCancel, preferredPc = null, manageConnections = false }: { client: MrRobotClient; onConnected: (pc: SavedPc) => void; onCancel?: () => void; preferredPc?: SavedPc | null; manageConnections?: boolean }) {
  const [phase, setPhase] = useState<Phase>('auto');
  const [error, setError] = useState('');
  const [pcs, setPcs] = useState<SavedPc[]>([]);
  const [connectingPc, setConnectingPc] = useState<SavedPc | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [hostPort, setHostPort] = useState('');
  const [pin, setPin] = useState('');
  const [accessClientId, setAccessClientId] = useState('');
  const [accessClientSecret, setAccessClientSecret] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const connectAttempt = useRef(0);
  const clientOwner = useRef<number | null>(null);
  const desktopLocalMode = Boolean(window.mrRobotDesktop && !preferredPc && !manageConnections);

  const connectTo = useCallback(
    async (pc: SavedPc, persist = true): Promise<boolean> => {
      const attempt = ++connectAttempt.current;
      setPhase('connecting');
      setConnectingPc(pc);
      setError('');
      const candidates = connectionOrigins(pc);
      const isCurrent = (): boolean => attempt === connectAttempt.current;
      const ownsClient = (): boolean => clientOwner.current === attempt;
      let lastError = '연결할 주소가 없습니다.';
      for (let index = 0; index < candidates.length; index++) {
        if (!isCurrent()) return false;
        const candidate = candidates[index];
        try {
          clientOwner.current = attempt;
          await client.connect(wsUrlFor(candidate), pc.secret, index < candidates.length - 1 ? 2500 : 8000);
          if (!isCurrent() || !ownsClient()) return false;
          let refreshedHosts = pc.hosts ?? [pc.host];
          let refreshedOrigins = connectionOrigins(pc);
          try {
            const info = await client.call('pairing.info', {}) as { host?: string; hosts?: string[]; port?: number };
            if (!isCurrent() || !ownsClient()) return false;
            refreshedHosts = [...new Set([info.host, ...(info.hosts ?? []), ...refreshedHosts].filter((value): value is string => Boolean(value)))];
            const infoPort = Number.isInteger(info.port) && Number(info.port) > 0 ? Number(info.port) : pc.port;
            refreshedOrigins = [...new Set([
              candidate,
              ...refreshedOrigins,
              ...[info.host, ...(info.hosts ?? [])]
                .filter((value): value is string => Boolean(value))
                .map((host) => originForDiscoveredHost(host, infoPort)),
            ])];
          } catch { /* keep the working connection */ }
          if (!isCurrent() || !ownsClient()) return false;
          const endpoint = parsePcEndpoint(candidate, pc.port, pc.protocol ?? 'http');
          const connectedPc = { ...pc, hosts: refreshedHosts, origins: refreshedOrigins, activeHost: endpoint.host, activeOrigin: endpoint.origin };
          if (persist) {
            const registry = await loadPcsForEnvironment();
            if (!isCurrent() || !ownsClient()) return false;
            const updated = registry.some((item) => item.id === pc.id)
              ? registry.map((item) => item.id === pc.id ? connectedPc : item)
              : [...registry, connectedPc];
            await savePcsForEnvironment(updated);
            if (!isCurrent() || !ownsClient()) return false;
            setPcs(updated);
            setLastPcId(pc.id);
          }
          if (!isCurrent() || !ownsClient()) return false;
          onConnected(connectedPc);
          return true;
        } catch (err) {
          if (!isCurrent()) return false;
          if (ownsClient()) {
            client.close();
            clientOwner.current = null;
          }
          lastError = err instanceof Error ? err.message : String(err);
        }
      }
      if (!isCurrent()) return false;
      setError(`${pc.name} 연결 실패: ${lastError}. PC 주소와 네트워크 연결을 확인하세요.`);
      setConnectingPc(null);
      setPhase('list');
      return false;
    },
    [client, onConnected],
  );

  useEffect(() => {
    let cancelled = false;
    const boot = async (): Promise<void> => {
      try {
        // The Electron shell contains the local agent. It always opens this
        // loopback session directly and never needs pairing or registry I/O.
        // Opening the optional connection manager must bypass the automatic
        // loopback connection so its PC registry screen remains mounted.
        if (desktopLocalMode) {
          const serving = await detectServingPc();
          if (!serving) throw new Error('내장 로컬 에이전트를 찾을 수 없습니다.');
          const localPc: SavedPc = { ...serving, id: DESKTOP_LOCAL_PC_ID, addedAt: 0 };
          await connectTo(localPc, false);
          return;
        }

        // Browser/mobile-style clients and explicitly selected remote PCs use
        // the encrypted registry and normal reconnect flow.
        let next = await loadPcsForEnvironment();
        if (cancelled) return;
        if (!window.mrRobotDesktop) {
          const serving = await detectServingPc();
          if (cancelled) return;
          if (serving) {
            next = upsertPc(next, serving);
            await savePcsForEnvironment(next);
            if (cancelled) return;
          }
        }
        setPcs(next);
        if (manageConnections) {
          setPhase('list');
          return;
        }

        // Auto-connect the explicit choice, last used PC, or sole registry PC.
        const lastId = getLastPcId();
        const target = preferredPc ?? next.find((p) => p.id === lastId) ?? (next.length === 1 ? next[0] : null);
        if (target) {
          const ok = await connectTo(target);
          if (cancelled || ok) return;
        }
        if (!cancelled) setPhase('list');
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setPhase('list');
        }
      }
    };
    void boot();
    return () => {
      cancelled = true;
      connectAttempt.current += 1;
    };
  }, [connectTo, manageConnections, preferredPc]);

  const cancelConnect = (): void => {
    connectAttempt.current += 1;
    clientOwner.current = null;
    client.close();
    setConnectingPc(null);
    setError('');
    setPhase('list');
  };

  const addPc = async (): Promise<void> => {
    if (!hostPort.trim() || !/^(?:\d{6}|\d{12})$/.test(pin) || addBusy) return;
    setAddBusy(true);
    setError('');
    try {
      const accessId = accessClientId.trim();
      const accessSecret = accessClientSecret.trim();
      if (Boolean(accessId) !== Boolean(accessSecret)) throw new Error('Cloudflare Access Client ID와 Secret을 함께 입력하세요.');
      const secret = await exchangePin(
        hostPort,
        pin,
        name.trim() || '웹 브라우저',
        'ask',
        accessId && accessSecret ? { clientId: accessId, clientSecret: accessSecret } : undefined,
      );
      const endpoint = parsePcEndpoint(hostPort);
      const pc: Omit<SavedPc, 'id' | 'addedAt'> = {
        name: name.trim() || hostPort.trim(),
        host: endpoint.host,
        port: endpoint.port,
        protocol: endpoint.protocol,
        origins: [endpoint.origin],
        activeOrigin: endpoint.origin,
        credentialOrigin: endpoint.origin,
        ...(accessId && accessSecret ? { cloudflareAccessOrigin: endpoint.origin } : {}),
        secret,
      };
      const next = upsertPc(await loadPcsForEnvironment(), pc);
      await savePcsForEnvironment(next);
      // Electron consumes the short-lived opaque enrollment reference during
      // save and returns a vault-backed PC id. Reload before connecting so no
      // long-lived device token ever enters renderer state.
      const securedNext = window.mrRobotDesktop ? await loadPcsForEnvironment() : next;
      setPcs(securedNext);
      setName('');
      setHostPort('');
      setPin('');
      setAccessClientId('');
      setAccessClientSecret('');
      setShowAdd(false);
      const saved = securedNext.find((item) => connectionOrigins(item).includes(endpoint.origin)) ?? securedNext[securedNext.length - 1];
      if (!saved) throw new Error('저장된 PC 연결 정보를 다시 불러오지 못했습니다.');
      await connectTo(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddBusy(false);
    }
  };

  const deletePc = async (id: string): Promise<void> => {
    const next = removePc(await loadPcsForEnvironment(), id);
    await savePcsForEnvironment(next);
    setPcs(next);
    if (getLastPcId() === id) setLastPcId(null);
  };

  if (desktopLocalMode && (phase === 'auto' || phase === 'connecting')) {
    return (
      <div className="gate">
        <div className="gate-card">
          <div className="gate-brand"><Spinner size={26} /></div>
          <p className="gate-sub">로컬 에이전트를 준비하는 중…</p>
        </div>
      </div>
    );
  }

  if (desktopLocalMode && phase === 'list') {
    return (
      <div className="gate">
        <Card className="gate-card wide">
          <div className="gate-brand"><h1>Mr.Robot</h1></div>
          <p className="gate-sub">로컬 에이전트를 시작하지 못했습니다.</p>
          {error && <div className="gate-error">{error}</div>}
          <Button variant="accent" onClick={() => window.location.reload()}>다시 시도</Button>
        </Card>
      </div>
    );
  }

  if (phase === 'connecting') {
    return (
      <div className="gate">
        <div className="gate-card">
          <div className="gate-brand">
            <Spinner size={26} />
          </div>
          <p className="gate-sub">{connectingPc ? `"${connectingPc.name}"에 연결하는 중…` : '연결 중…'}</p>
          <Button variant="ghost" onClick={cancelConnect}>
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
                  {pc.activeOrigin ?? pc.origins?.[0] ?? pcOrigin(pc)}
                </div>
              </div>
            </div>
            <div className="pc-actions">
              <Button onClick={() => void connectTo(pc)}>이 PC에서 실행</Button>
              <Button variant="ghost" onClick={() => void deletePc(pc.id)} title="등록 해제">
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
              <Input value={hostPort} onChange={(e) => setHostPort(e.target.value)} placeholder="https://example.trycloudflare.com" />
            </Field>
            <Field label="연결 코드" hint="해당 PC의 6자리 PIN 또는 외출용 12자리 일회용 코드">
              <Input
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
                placeholder="6자리 또는 12자리"
                inputMode="numeric"
              />
            </Field>
            {window.mrRobotDesktop && <>
              <Field label="Cloudflare Access Client ID (선택)" hint="원격 PC가 Cloudflare Access로 보호된 경우 Service Token 값을 입력합니다.">
                <Input type="password" value={accessClientId} onChange={(e) => setAccessClientId(e.target.value)} autoComplete="off" placeholder="…access" />
              </Field>
              <Field label="Cloudflare Access Client Secret (선택)" hint="두 값은 등록 직후 Windows 보안 저장소로 이동하고 화면에서 지워집니다.">
                <Input type="password" value={accessClientSecret} onChange={(e) => setAccessClientSecret(e.target.value)} autoComplete="new-password" placeholder="Service Token Secret" />
              </Field>
            </>}
            <div className="chat-actions">
              <Button variant="ghost" onClick={() => setShowAdd(false)} disabled={addBusy}>
                취소
              </Button>
              <Button onClick={() => void addPc()} disabled={addBusy || !hostPort.trim() || !/^(?:\d{6}|\d{12})$/.test(pin)}>
                {addBusy ? '등록 중…' : '등록 및 연결'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="chat-actions">
            {onCancel && <Button variant="ghost" onClick={onCancel}>닫기</Button>}
            <Button variant="accent" onClick={() => setShowAdd(true)}>＋ PC 추가</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
