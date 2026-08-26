import type { PairingPayload } from './types';

export function parsePairingPayload(raw: string): PairingPayload | null {
  try {
    const obj = JSON.parse(raw) as PairingPayload;
    if (obj?.app === 'mr-robot' && obj.host && obj.port && (obj.pin || obj.secret)) return obj;
    return null;
  } catch {
    return null;
  }
}

/**
 * WebSocket RPC client for React Native (uses RN's global WebSocket).
 * Same wire protocol as the web client: JSON {id, method, params} and
 * server events with id 0.
 */
export class MrRobotClient {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<(data: unknown) => void>>();
  private closedByUser = false;
  private connectionGeneration = 0;

  connected = false;
  authed = false;
  onClose: (() => void) | null = null;

  connect(url: string, secret: string, timeoutMs = 8000): Promise<void> {
    this.close();
    const generation = ++this.connectionGeneration;
    this.closedByUser = false;
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
            else finish(new Error('인증 실패: 시크릿이 일치하지 않습니다.'));
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
      };
    });
  }

  call(method: string, params?: unknown, timeoutMs = 60000): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) {
      return Promise.reject(new Error('연결되어 있지 않습니다'));
    }
    const id = this.reqId++;
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
      ws.send(JSON.stringify({ id, method, params }));
    });
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
    let msg: {
      id: number;
      event?: string;
      ok?: boolean;
      result?: unknown;
      error?: { message: string };
      data?: unknown;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id === 0 && msg.event) {
      const set = this.listeners.get(msg.event);
      if (set) for (const h of [...set]) h(msg.data);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error?.message ?? '오류'));
  }

  private settlePending(err: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(err);
  }
}

export function wsUrl(hostPort: string): string {
  return `ws://${hostPort}/ws`;
}
