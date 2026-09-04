import {
  WS_RPC_PROTOCOL,
  WS_UPGRADE_TICKET_PROTOCOL_PREFIX,
  type PermissionMode,
  type RpcMessage,
  type RpcRequest,
  type WsUpgradeTicketInfo,
} from '@mr-robot/shared';

type Listener = (data: unknown) => void;
export const DESKTOP_LOCAL_AUTH_TOKEN = 'electron-main-process-managed-session';
export const DESKTOP_REMOTE_AUTH_PREFIX = 'electron-main-process-pc:';

function isDesktopManagedAuthToken(value: string): boolean {
  return value === DESKTOP_LOCAL_AUTH_TOKEN || value.startsWith(DESKTOP_REMOTE_AUTH_PREFIX);
}

async function publicWebSocketProtocols(url: string, secret: string, signal: AbortSignal): Promise<string[] | undefined> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'wss:') return undefined;
  const endpoint = new URL('/api/ws-ticket', `https://${parsed.host}`);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'x-mr-robot-token': secret, accept: 'application/json' },
    signal,
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'error',
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
  private cancelConnecting: ((reason: Error) => void) | null = null;
  private desktopLocal = false;
  private desktopUnsubscribeEvent: (() => void) | null = null;
  private desktopUnsubscribeClose: (() => void) | null = null;

  connected = false;
  authed = false;
  isAdmin = false;
  canUseAuditOnly = false;
  permissionCap: PermissionMode = 'read-only';
  onClose: (() => void) | null = null;
  onAuthFail: (() => void) | null = null;

  connect(url: string, secret: string, timeoutMs = 8000): Promise<void> {
    if (isDesktopManagedAuthToken(secret) && window.mrRobotDesktop?.connectLocalRpc) {
      return this.connectDesktopManaged(url, secret);
    }
    this.close();
    const generation = ++this.connectionGeneration;
    this.closedByUser = false;
    this.authToken = secret;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancelAttempt: ((reason: Error) => void) | null = null;
      let ws: WebSocket | null = null;
      const admissionController = new AbortController();
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (this.cancelConnecting === cancelAttempt) this.cancelConnecting = null;
        if (err) reject(err);
        else resolve();
      };
      cancelAttempt = (reason) => {
        admissionController.abort(reason);
        try { ws?.close(); } catch { /* best effort */ }
        finish(reason);
      };
      this.cancelConnecting = cancelAttempt;
      timer = setTimeout(() => {
        cancelAttempt?.(new Error('연결 시간 초과'));
      }, timeoutMs);

      void publicWebSocketProtocols(url, secret, admissionController.signal).then((protocols) => {
        if (settled || generation !== this.connectionGeneration) return;
        ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
        this.ws = ws;
        ws.onopen = () => {
          if (generation !== this.connectionGeneration) { ws?.close(); return; }
          this.connected = true;
          void this.call('auth', { secret })
            .then((r) => {
              const auth = r as { ok?: boolean; isAdmin?: boolean; canUseAuditOnly?: boolean; permissionCap?: PermissionMode };
              this.authed = Boolean(auth?.ok);
              this.isAdmin = auth?.isAdmin === true;
              this.canUseAuditOnly = auth?.canUseAuditOnly === true;
              this.permissionCap = auth?.permissionCap ?? 'read-only';
              if (this.authed) finish();
              else {
                this.onAuthFail?.();
                ws?.close();
                finish(new Error('인증 실패: 시크릿이 일치하지 않습니다.'));
              }
            })
            .catch((err: Error) => { ws?.close(); finish(err); });
        };
        ws.onmessage = (ev) => { if (generation === this.connectionGeneration) this.onMessage(String(ev.data)); };
        ws.onerror = () => { ws?.close(); finish(new Error('연결 오류')); };
        ws.onclose = () => {
          if (generation !== this.connectionGeneration) return;
          if (timer !== undefined) clearTimeout(timer);
          this.connected = false;
          this.authed = false;
          this.isAdmin = false;
          this.canUseAuditOnly = false;
          this.permissionCap = 'read-only';
          this.settlePending(new Error('연결이 끊어졌습니다'));
          this.ws = null;
          if (!this.closedByUser) this.onClose?.();
          finish(new Error('연결이 닫혔습니다'));
        };
      }).catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  get token(): string {
    return this.authToken;
  }

  call(method: string, params?: unknown, timeoutMs = 60000): Promise<unknown> {
    if (this.desktopLocal) {
      const bridge = window.mrRobotDesktop?.callLocalRpc;
      return bridge ? bridge(method, params, timeoutMs) : Promise.reject(new Error('로컬 RPC 브리지를 사용할 수 없습니다.'));
    }
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
      try {
        ws.send(JSON.stringify(req));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
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
      if (set?.size === 0) this.listeners.delete(event);
    };
  }

  close(): void {
    this.connectionGeneration++;
    this.closedByUser = true;
    const cancelConnecting = this.cancelConnecting;
    this.cancelConnecting = null;
    cancelConnecting?.(new Error('연결을 취소했습니다'));
    this.settlePending(new Error('연결 종료'));
    const wasDesktopLocal = this.desktopLocal;
    this.desktopLocal = false;
    this.desktopUnsubscribeEvent?.();
    this.desktopUnsubscribeEvent = null;
    this.desktopUnsubscribeClose?.();
    this.desktopUnsubscribeClose = null;
    if (wasDesktopLocal) window.mrRobotDesktop?.closeLocalRpc?.();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.authToken = '';
    this.connected = false;
    this.authed = false;
    this.isAdmin = false;
    this.canUseAuditOnly = false;
    this.permissionCap = 'read-only';
  }

  dispose(): void {
    this.close();
    this.listeners.clear();
    this.onClose = null;
    this.onAuthFail = null;
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

  private async connectDesktopManaged(url: string, credentialRef: string): Promise<void> {
    this.close();
    const generation = ++this.connectionGeneration;
    this.closedByUser = false;
    this.authToken = credentialRef;
    const bridge = window.mrRobotDesktop;
    if (!bridge?.connectLocalRpc || !bridge.onLocalRpcEvent || !bridge.onLocalRpcClose) throw new Error('로컬 RPC 브리지를 사용할 수 없습니다.');
    this.desktopUnsubscribeEvent = bridge.onLocalRpcEvent((message) => {
      if (generation !== this.connectionGeneration || !this.desktopLocal || !message || typeof message.event !== 'string') return;
      const set = this.listeners.get(message.event);
      if (set) for (const handler of [...set]) handler(message.data);
    });
    this.desktopUnsubscribeClose = bridge.onLocalRpcClose(() => {
      if (generation !== this.connectionGeneration || !this.desktopLocal) return;
      this.desktopLocal = false;
      this.connected = false;
      this.authed = false;
      this.isAdmin = false;
      this.canUseAuditOnly = false;
      this.permissionCap = 'read-only';
      this.settlePending(new Error('연결이 끊어졌습니다'));
      if (!this.closedByUser) this.onClose?.();
    });
    this.desktopLocal = true;
    try {
      const auth = await bridge.connectLocalRpc({ url, credentialRef });
      if (generation !== this.connectionGeneration) throw new Error('연결이 취소되었습니다.');
      this.connected = true;
      this.authed = auth?.ok === true;
      this.isAdmin = auth?.isAdmin === true;
      this.canUseAuditOnly = auth?.canUseAuditOnly === true;
      this.permissionCap = auth?.permissionCap ?? 'read-only';
      if (!this.authed || (credentialRef === DESKTOP_LOCAL_AUTH_TOKEN && !this.isAdmin)) throw new Error('PC 인증에 실패했습니다.');
    } catch (error) {
      if (generation === this.connectionGeneration) this.close();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private settlePending(err: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(err);
  }
}

function endpointFallback(value: string): 'http' | 'https' {
  try {
    const host = new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const octets = host.split('.').map(Number);
    const privateIpv4 = octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && (
      octets[0] === 10 || octets[0] === 127 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
    );
    if (host === 'localhost' || host.endsWith('.local') || !host.includes('.') || host === '::1' || privateIpv4) return 'http';
  } catch { /* URL constructor below reports the actual error */ }
  return typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'https' : 'http';
}

export function wsUrlFor(hostPort: string): string {
  const target = hostPort || window.location.host;
  const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(target) ? target : `${endpointFallback(target)}://${target}`);
  const scheme = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'wss' : 'ws';
  return `${scheme}://${parsed.host}/ws`;
}

export function httpUrlFor(hostPort: string): string {
  const target = hostPort || window.location.host;
  const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(target) ? target : `${endpointFallback(target)}://${target}`);
  const scheme = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'https' : 'http';
  return `${scheme}://${parsed.host}`;
}

export interface PairingPayload {
  app: 'mr-robot';
  host: string;
  hosts?: string[];
  protocol?: 'http' | 'https';
  port: number;
  version: 3;
  pin: string;
}

function isLoopbackPairingHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function assertSecurePairingHost(value: string, port: number, protocol: 'http' | 'https'): void {
  const input = value.trim();
  const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `${protocol}://${input}:${port}`);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) throw new Error('unsupported pairing protocol');
  if (parsed.username || parsed.password) throw new Error('pairing URLs cannot contain credentials');
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'wss:' && !isLoopbackPairingHost(parsed.hostname)) {
    throw new Error('remote pairing requires HTTPS');
  }
}

export function parsePairingPayload(raw: string): PairingPayload | null {
  try {
    const obj = JSON.parse(raw) as Partial<PairingPayload>;
    if (obj?.app !== 'mr-robot' || obj.version !== 3) return null;
    if (typeof obj.host !== 'string' || !obj.host.trim() || obj.host.length > 2_048) return null;
    if (!Number.isInteger(obj.port) || Number(obj.port) < 1 || Number(obj.port) > 65_535) return null;
    if (typeof obj.pin !== 'string' || !/^(?:\d{6}|\d{12})$/.test(obj.pin)) return null;
    if (obj.protocol !== undefined && obj.protocol !== 'http' && obj.protocol !== 'https') return null;
    if (obj.hosts !== undefined && (!Array.isArray(obj.hosts)
      || obj.hosts.length > 8
      || obj.hosts.some((host) => typeof host !== 'string' || !host.trim() || host.length > 2_048))) return null;
    const payload: PairingPayload = {
      app: 'mr-robot',
      version: 3,
      host: obj.host.trim(),
      hosts: obj.hosts?.map((host) => host.trim()),
      protocol: obj.protocol,
      port: Number(obj.port),
      pin: obj.pin,
    };
    const protocol = payload.protocol ?? 'http';
    for (const host of [payload.host, ...(payload.hosts ?? [])]) assertSecurePairingHost(host, payload.port, protocol);
    return payload;
  } catch {
    return null;
  }
}
