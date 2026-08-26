import type { RpcMessage, RpcRequest } from '@mr-robot/shared';

type Listener = (data: unknown) => void;

/**
 * Minimal WebSocket RPC client for the Mr.Robot agent.
 * - call(): request/response with a timeout
 * - on(): server-pushed events (id 0)
 * Cleanly rejects every in-flight call on disconnect.
 */
export class MrRobotClient {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<Listener>>();
  private closedByUser = false;
  private connectionGeneration = 0;
  private authToken = '';

  connected = false;
  authed = false;
  onClose: (() => void) | null = null;
  onAuthFail: (() => void) | null = null;

  connect(url: string, secret: string, timeoutMs = 8000): Promise<void> {
    this.close();
    const generation = ++this.connectionGeneration;
    this.closedByUser = false;
    this.authToken = secret;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      const ws = new WebSocket(url);
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.close();
        finish(new Error('연결 시간 초과'));
      }, timeoutMs);

      ws.onopen = () => {
        if (generation !== this.connectionGeneration) { ws.close(); return; }
        clearTimeout(timer); // connection is up — cancel the connect timeout
        this.connected = true;
        void this.call('auth', { secret })
          .then((r) => {
            this.authed = Boolean((r as { ok?: boolean })?.ok);
            if (this.authed) finish();
            else {
              this.onAuthFail?.();
              finish(new Error('인증 실패: 시크릿이 일치하지 않습니다.'));
            }
          })
          .catch((err: Error) => finish(err));
      };
      ws.onmessage = (ev) => { if (generation === this.connectionGeneration) this.onMessage(String(ev.data)); };
      ws.onerror = () => finish(new Error('연결 오류'));
      ws.onclose = () => {
        if (generation !== this.connectionGeneration) return;
        clearTimeout(timer);
        this.connected = false;
        this.authed = false;
        this.settlePending(new Error('연결이 끊어졌습니다'));
        this.ws = null;
        if (!this.closedByUser) this.onClose?.();
        finish(new Error('연결이 닫혔습니다'));
      };
    });
  }

  get token(): string {
    return this.authToken;
  }

  call(method: string, params?: unknown, timeoutMs = 60000): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('연결되어 있지 않습니다'));
    }
    const id = this.reqId++;
    const req: RpcRequest = { id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`응답 시간 초과: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify(req));
    });
  }

  on(event: string, handler: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  close(): void {
    this.connectionGeneration++;
    this.closedByUser = true;
    this.settlePending(new Error('연결 종료'));
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private onMessage(raw: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(raw) as RpcMessage;
    } catch {
      return;
    }
    if ('event' in msg && msg.id === 0) {
      const set = this.listeners.get(msg.event);
      if (set) for (const h of [...set]) h(msg.data);
      return;
    }
    if ('ok' in msg && 'id' in msg) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error.message));
    }
  }

  private settlePending(err: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(err);
  }
}

export function wsUrlFor(hostPort: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const target = hostPort || window.location.host;
  return `${scheme}://${target}/ws`;
}

export function httpUrlFor(hostPort: string): string {
  const scheme = window.location.protocol === 'https:' ? 'https' : 'http';
  const target = hostPort || window.location.host;
  return `${scheme}://${target}`;
}

export interface PairingPayload {
  app: string;
  host: string;
  hosts?: string[];
  port: number;
  version?: number;
  pin?: string;
  secret?: string;
}

export function parsePairingPayload(raw: string): PairingPayload | null {
  try {
    const obj = JSON.parse(raw) as PairingPayload;
    if (obj?.app === 'mr-robot' && obj.host && obj.port && (obj.pin || obj.secret)) return obj;
    return null;
  } catch {
    return null;
  }
}
