export { pairingOrigins, parsePairingPayload } from './pairing';

export type RpcConnectionState = 'offline' | 'connecting' | 'authenticating' | 'online';

/** WebSocket RPC client for React Native. */
export class MrRobotClient {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private listeners = new Map<string, Set<(data: unknown) => void>>();
  private closedByUser = false;
  private connectionGeneration = 0;
  private cancelConnect: ((error: Error) => void) | null = null;

  connected = false;
  authed = false;
  state: RpcConnectionState = 'offline';
  onClose: (() => void) | null = null;
  onStateChange: ((state: RpcConnectionState) => void) | null = null;

  connect(url: string, secret: string, timeoutMs = 8000): Promise<void> {
    this.close();
    const generation = ++this.connectionGeneration;
    this.closedByUser = false;
    this.setState('connecting');

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const ws = new WebSocket(url);
      this.ws = ws;

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        const isCurrent = generation === this.connectionGeneration && this.ws === ws;
        if (this.cancelConnect === cancelAttempt) this.cancelConnect = null;
        if (!isCurrent) {
          reject(error ?? new Error('새 연결 시도로 대체되었습니다.'));
          return;
        }
        if (error) {
          this.connected = false;
          this.authed = false;
          if (this.ws === ws) this.ws = null;
          this.setState('offline');
          try { ws.close(); } catch { /* 이미 닫힌 소켓 */ }
          reject(error);
        } else {
          this.setState('online');
          resolve();
        }
      };

      const cancelAttempt = (error: Error): void => finish(error);
      this.cancelConnect = cancelAttempt;

      timer = setTimeout(() => finish(new Error('연결 또는 인증 시간이 초과되었습니다.')), timeoutMs);

      ws.onopen = () => {
        if (generation !== this.connectionGeneration) { ws.close(); return; }
        this.connected = true;
        this.setState('authenticating');
        const authTimeout = Math.max(1000, timeoutMs - 250);
        void this.call('auth', { secret }, authTimeout)
          .then((result) => {
            this.authed = Boolean((result as { ok?: boolean })?.ok);
            if (!this.authed) throw new Error('인증 실패: 시크릿이 일치하지 않습니다.');
            finish();
          })
          .catch((error: Error) => finish(error));
      };
      ws.onmessage = (event) => {
        if (generation === this.connectionGeneration) this.onMessage(String(event.data));
      };
      ws.onerror = () => finish(new Error('연결 오류'));
      ws.onclose = () => {
        if (generation !== this.connectionGeneration || this.ws !== ws) return;
        const wasAuthenticated = this.authed;
        this.settlePending(new Error('연결이 끊어졌습니다.'));
        if (settled) {
          this.connected = false;
          this.authed = false;
          this.ws = null;
          this.setState('offline');
        } else {
          finish(new Error('연결이 종료되었습니다.'));
        }
        if (wasAuthenticated && !this.closedByUser) this.onClose?.();
      };
    });
  }

  call(method: string, params?: unknown, timeoutMs = 60000): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('연결되어 있지 않습니다.'));
    const id = this.reqId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`응답 시간 초과: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async healthCheck(timeoutMs = 4000): Promise<boolean> {
    if (!this.authed) return false;
    try {
      await this.call('status', {}, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  on(event: string, handler: (data: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
      if (set?.size === 0) this.listeners.delete(event);
    };
  }

  close(): void {
    this.connectionGeneration++;
    this.closedByUser = true;
    const cancelConnect = this.cancelConnect;
    this.cancelConnect = null;
    cancelConnect?.(new Error('연결 시도가 취소되었습니다.'));
    this.connected = false;
    this.authed = false;
    this.settlePending(new Error('연결 종료'));
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* 이미 닫힌 소켓 */ }
    this.setState('offline');
  }

  dispose(): void {
    this.close();
    this.listeners.clear();
    this.onClose = null;
    this.onStateChange = null;
  }

  private setState(state: RpcConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state);
  }

  private onMessage(raw: string): void {
    let message: {
      id: number;
      event?: string;
      ok?: boolean;
      result?: unknown;
      error?: { message: string };
      data?: unknown;
    };
    try { message = JSON.parse(raw); } catch { return; }
    if (message.id === 0 && message.event) {
      const set = this.listeners.get(message.event);
      if (set) {
        for (const handler of [...set]) {
          try { handler(message.data); } catch { /* 한 화면 오류가 다른 구독자를 막지 않게 한다. */ }
        }
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error?.message ?? '오류'));
  }

  private settlePending(error: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const pending of all) pending.reject(error);
  }
}

export function wsUrl(hostPort: string): string {
  const value = hostPort.trim();
  if (/^wss?:\/\//i.test(value)) return `${value.replace(/\/$/, '')}/ws`;
  if (/^https?:\/\//i.test(value)) return `${value.replace(/^http/i, 'ws').replace(/\/$/, '')}/ws`;
  return `ws://${value}/ws`;
}
