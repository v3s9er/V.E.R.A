export { pairingOrigins, parsePairingPayload } from './pairing';
import { cloudflareAccessHeaders } from './pcs';
import type { CloudflareAccessCredentials } from './types';

export type RpcConnectionState = 'offline' | 'connecting' | 'authenticating' | 'online';

// The mobile package is independently bundled by Expo, so keep these two
// wire constants synchronized with @mr-robot/shared without adding a Node
// workspace dependency to the APK bundle.
const WS_RPC_PROTOCOL = 'mr-robot-rpc-v1';
const WS_UPGRADE_TICKET_PROTOCOL_PREFIX = 'mr-robot-ticket.';
interface WsUpgradeTicketInfo { protocol: string; expiresAt: number }
type ReactNativeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> },
) => WebSocket;

async function publicWebSocketProtocols(
  url: string,
  secret: string,
  signal: AbortSignal,
  cloudflareAccess?: CloudflareAccessCredentials,
  cloudflareAccessOrigin?: string,
): Promise<string[] | undefined> {
  const parsed = new URL(url);
  const requestOrigin = `https://${parsed.host}`;
  const accessHeaders = cloudflareAccessHeaders(cloudflareAccess, cloudflareAccessOrigin, requestOrigin);
  if (Object.keys(accessHeaders).length && parsed.protocol !== 'wss:') {
    throw new Error('Cloudflare Access 자격증명은 WSS 연결에서만 사용할 수 있습니다.');
  }
  if (parsed.protocol !== 'wss:') return undefined;
  const endpoint = new URL('/api/ws-ticket', `https://${parsed.host}`);
  const response = await fetch(endpoint.toString(), {
    method: 'POST',
    headers: { ...accessHeaders, 'x-mr-robot-token': secret, accept: 'application/json' },
    redirect: 'error',
    signal,
  });
  if (!response.ok) throw new Error(`WebSocket 보안 티켓 발급 실패 (HTTP ${response.status})`);
  const ticket = await response.json() as WsUpgradeTicketInfo;
  if (typeof ticket.protocol !== 'string'
    || !ticket.protocol.startsWith(WS_UPGRADE_TICKET_PROTOCOL_PREFIX)
    || !/^[A-Za-z0-9_-]{43}$/.test(ticket.protocol.slice(WS_UPGRADE_TICKET_PROTOCOL_PREFIX.length))
    || !Number.isFinite(ticket.expiresAt)
    || ticket.expiresAt <= Date.now()) {
    throw new Error('WebSocket 보안 티켓 응답이 올바르지 않습니다.');
  }
  return [WS_RPC_PROTOCOL, ticket.protocol];
}

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

  connect(url: string, secret: string, timeoutMs = 8000, cloudflareAccess?: CloudflareAccessCredentials, cloudflareAccessOrigin?: string): Promise<void> {
    this.close();
    const generation = ++this.connectionGeneration;
    this.closedByUser = false;
    this.setState('connecting');

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let ws: WebSocket | null = null;
      const admissionController = new AbortController();

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        const isCurrent = generation === this.connectionGeneration && (ws === null || this.ws === ws);
        if (this.cancelConnect === cancelAttempt) this.cancelConnect = null;
        if (!isCurrent) {
          reject(error ?? new Error('새 연결 시도로 대체되었습니다.'));
          return;
        }
        if (error) {
          this.connected = false;
          this.authed = false;
          if (ws !== null && this.ws === ws) this.ws = null;
          this.setState('offline');
          try { ws?.close(); } catch { /* 이미 닫힌 소켓 */ }
          reject(error);
        } else {
          this.setState('online');
          resolve();
        }
      };

      const cancelAttempt = (error: Error): void => {
        admissionController.abort(error);
        try { ws?.close(); } catch { /* 이미 닫힌 소켓 */ }
        finish(error);
      };
      this.cancelConnect = cancelAttempt;

      timer = setTimeout(() => cancelAttempt(new Error('연결 또는 인증 시간이 초과되었습니다.')), timeoutMs);

      void publicWebSocketProtocols(url, secret, admissionController.signal, cloudflareAccess, cloudflareAccessOrigin).then((protocols) => {
        if (settled || generation !== this.connectionGeneration) return;
        const parsed = new URL(url);
        const accessHeaders = cloudflareAccessHeaders(cloudflareAccess, cloudflareAccessOrigin, `https://${parsed.host}`);
        if (Object.keys(accessHeaders).length) {
          const ReactNativeWebSocket = WebSocket as unknown as ReactNativeWebSocketConstructor;
          ws = new ReactNativeWebSocket(url, protocols, { headers: accessHeaders });
        } else {
          ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
        }
        this.ws = ws;
        ws.onopen = () => {
          if (generation !== this.connectionGeneration) { ws?.close(); return; }
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
      }).catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
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
