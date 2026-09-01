import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { isIP } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import {
  RPC,
  WS_RPC_PROTOCOL,
  WS_UPGRADE_TICKET_PROTOCOL_PREFIX,
  type PermissionMode,
  type RpcMessage,
  type WsUpgradeTicketInfo,
} from '@mr-robot/shared';
import type { Logger } from '../logger.js';
import { ChatSession } from './chat.js';
import { ScreenStreamController } from './stream.js';
import { isEncryptedTailnetTransport, isLoopback } from './transport.js';

const WS_AUTH_TIMEOUT_MS = 10_000;
const WS_MAX_CLIENTS = 64;
const WS_MAX_UNAUTHENTICATED_CLIENTS = 16;
const WS_MAX_CLIENTS_PER_SOURCE = 8;
const WS_MAX_CLIENTS_PER_DEVICE = 4;
const WS_PRE_AUTH_MAX_BYTES = 4 * 1024;
const WS_MESSAGE_WINDOW_MS = 10_000;
const WS_MAX_MESSAGES_PER_WINDOW = 120;
const WS_MAX_BYTES_PER_WINDOW = 8 * 1024 * 1024;
const WS_MAX_IN_FLIGHT_REQUESTS = 16;
const WS_MAX_GLOBAL_IN_FLIGHT_REQUESTS = 64;
const WS_MAX_DEVICE_IN_FLIGHT_REQUESTS = 16;
const WS_HEARTBEAT_MS = 30_000;
const WS_UPGRADE_TICKET_TTL_MS = 30_000;
const WS_MAX_UPGRADE_TICKETS = 512;
const WS_MAX_UPGRADE_TICKETS_PER_SOURCE = 8;
const WS_MAX_UPGRADE_TICKETS_PER_PRINCIPAL = 8;
const WS_UPGRADE_TICKET_ISSUE_WINDOW_MS = 10_000;
const WS_MAX_UPGRADE_TICKET_ISSUES_PER_WINDOW = 16;
const CLOUDFLARE_RAY = /^[a-f0-9-]{8,}(?:-[a-z]{3})?$/i;

export interface AuthContext { isAdmin: boolean; linkId?: string; permissionCap: PermissionMode }

export interface WsTicketBinding {
  source: string;
  audience: string;
  requiresTicket: boolean;
  trustedCloudflare: boolean;
}

interface WsUpgradeTicketGrant {
  source: string;
  audience: string;
  principal: string;
  expiresAt: number;
  issuedAt: number;
}

function normalizedAddress(value: string | undefined): string {
  return String(value ?? 'unknown').replace(/^::ffff:/, '').toLowerCase();
}

function normalizedHostAudience(hostHeader: string | undefined, https: boolean): string {
  const raw = String(hostHeader ?? '').trim().slice(0, 512);
  if (!raw) return 'missing-host';
  try {
    return new URL(`${https ? 'https' : 'http'}://${raw}`).host.toLowerCase().replace(/\.$/, '');
  } catch {
    return 'invalid-host';
  }
}

function loopbackHostHeader(hostHeader: string | undefined): boolean {
  try {
    const hostname = new URL(`http://${String(hostHeader ?? '')}`).hostname.replace(/^\[|\]$/g, '');
    return isLoopback(hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve the security identity used by both the authenticated HTTP ticket
 * issuer and the subsequent WebSocket upgrade. Public reverse-proxy traffic
 * needs admission even if Cloudflare headers are absent; a public Host routed
 * to loopback must never inherit the direct-Electron exemption.
 */
export function webSocketTicketBinding(input: {
  directRemote?: string;
  directLocal?: string;
  hostHeader?: string;
  cloudflareConnectingIp?: string;
  cloudflareRay?: string;
}): WsTicketBinding {
  const directRemote = normalizedAddress(input.directRemote);
  const directLocal = normalizedAddress(input.directLocal);
  const loopback = isLoopback(directRemote);
  const forwarded = String(input.cloudflareConnectingIp ?? '').trim().toLowerCase();
  const trustedCloudflare = loopback && isIP(forwarded) > 0 && CLOUDFLARE_RAY.test(String(input.cloudflareRay ?? ''));
  const tailnet = isEncryptedTailnetTransport(directRemote, directLocal);
  const requiresTicket = trustedCloudflare || (!tailnet && (!loopback || !loopbackHostHeader(input.hostHeader)));
  return {
    source: trustedCloudflare ? `cloudflare:${forwarded}` : `direct:${directRemote}`,
    audience: normalizedHostAudience(input.hostHeader, trustedCloudflare),
    requiresTicket,
    trustedCloudflare,
  };
}

export function authPrincipal(auth: AuthContext): string {
  return auth.isAdmin ? 'administrator' : `device:${String(auth.linkId ?? 'missing')}`;
}

export class WsUpgradeTicketAdmissionError extends Error {
  readonly status = 429;
}

/** Memory-only, bounded, single-use capability store for public WS admission. */
export class WsUpgradeTickets {
  private readonly grants = new Map<string, WsUpgradeTicketGrant>();
  private readonly principalIssues = new Map<string, number[]>();

  constructor(private readonly ttlMs = WS_UPGRADE_TICKET_TTL_MS) {}

  issue(source: string, audience: string, principal: string, now = Date.now()): WsUpgradeTicketInfo {
    this.prune(now);
    const sourceOutstanding = [...this.grants.values()].filter((grant) => grant.source === source).length;
    const principalOutstanding = [...this.grants.values()].filter((grant) => grant.principal === principal).length;
    if (sourceOutstanding >= WS_MAX_UPGRADE_TICKETS_PER_SOURCE) {
      throw new WsUpgradeTicketAdmissionError('이 네트워크의 미사용 WebSocket 연결권이 너무 많습니다.');
    }
    if (principalOutstanding >= WS_MAX_UPGRADE_TICKETS_PER_PRINCIPAL) {
      throw new WsUpgradeTicketAdmissionError('이 기기의 미사용 WebSocket 연결권이 너무 많습니다.');
    }
    const issues = this.principalIssues.get(principal) ?? [];
    if (issues.length >= WS_MAX_UPGRADE_TICKET_ISSUES_PER_WINDOW) {
      throw new WsUpgradeTicketAdmissionError('이 기기가 WebSocket 연결권을 너무 자주 요청했습니다.');
    }
    // Capacity belonging to another principal is never evicted. Rejecting is
    // fail-closed and prevents one stolen device token from starving admin or
    // other-device tickets by rotating through many source IPs.
    if (this.grants.size >= WS_MAX_UPGRADE_TICKETS) {
      throw new WsUpgradeTicketAdmissionError('WebSocket 연결권 저장소가 찼습니다. 잠시 후 다시 시도하세요.');
    }
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = now + this.ttlMs;
    this.grants.set(ticket, { source, audience, principal, expiresAt, issuedAt: now });
    issues.push(now);
    this.principalIssues.set(principal, issues);
    return { protocol: `${WS_UPGRADE_TICKET_PROTOCOL_PREFIX}${ticket}`, expiresAt };
  }

  /** Returns the principal bound to a valid grant and destroys it before use. */
  consume(protocolHeader: string | string[] | undefined, source: string, audience: string, now = Date.now()): string | null {
    this.prune(now);
    const offered = (Array.isArray(protocolHeader) ? protocolHeader.join(',') : String(protocolHeader ?? ''))
      .split(',')
      .map((value) => value.trim());
    if (!offered.includes(WS_RPC_PROTOCOL)) return null;
    const ticketProtocol = offered.find((value) => value.startsWith(WS_UPGRADE_TICKET_PROTOCOL_PREFIX));
    if (!ticketProtocol) return null;
    const ticket = ticketProtocol.slice(WS_UPGRADE_TICKET_PROTOCOL_PREFIX.length);
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
    const grant = this.grants.get(ticket);
    this.grants.delete(ticket);
    if (!grant || grant.expiresAt <= now || grant.source !== source || grant.audience !== audience) return null;
    return grant.principal;
  }

  clear(): void {
    this.grants.clear();
    this.principalIssues.clear();
  }

  private prune(now: number): void {
    for (const [ticket, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(ticket);
    const cutoff = now - WS_UPGRADE_TICKET_ISSUE_WINDOW_MS;
    for (const [principal, issues] of this.principalIssues) {
      const retained = issues.filter((issuedAt) => issuedAt > cutoff);
      if (retained.length) this.principalIssues.set(principal, retained);
      else this.principalIssues.delete(principal);
    }
  }
}

export interface WsClientState {
  authed: boolean;
  auth: AuthContext | null;
  chat: ChatSession;
  stream: ScreenStreamController | null;
}

/** A socket is only a view/controller; an active run survives reconnect. */
export function cleanupDisconnectedClientState(state: Pick<WsClientState, 'chat' | 'stream'>): void {
  state.stream?.stop();
  if (state.chat.busy === false) state.chat.reset();
}

export class WsClient {
  readonly id = randomUUID();
  readonly remoteAddress: string;
  messageWindowStartedAt = Date.now();
  messagesInWindow = 0;
  bytesInWindow = 0;
  preAuthFrames = 0;
  inFlightRequests = 0;
  heartbeatAlive = true;
  readonly state: WsClientState = {
    authed: false,
    auth: null,
    chat: new ChatSession(),
    stream: null,
  };

  constructor(
    readonly socket: WebSocket,
    remoteAddress: string,
    readonly admissionPrincipal?: string,
  ) {
    this.remoteAddress = remoteAddress;
  }

  send(msg: RpcMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(msg));
      } catch {
        /* socket dying */
      }
    }
  }

  sendEvent(event: string, data: unknown): void {
    this.send({ id: 0, event, data });
  }
}

export type RpcHandler = (params: unknown, client: WsClient) => unknown | Promise<unknown>;

/**
 * WebSocket RPC hub. Every request is answered exactly once (ok/error), and
 * server pushes use id 0 events. Clients must authenticate first (`auth` with
 * the pairing/device secret); everything else is
 * rejected with ERROR_UNAUTHORIZED until then.
 */
export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly admittedPrincipals = new WeakMap<IncomingMessage, string>();
  readonly clients = new Set<WsClient>();

  constructor(
    server: Server,
    private readonly handlers: Map<string, RpcHandler>,
    private readonly authenticate: (secret: string) => AuthContext | null,
    private readonly logger: Logger,
    private readonly upgradeTickets: WsUpgradeTickets,
  ) {
    // File payloads use streaming HTTP endpoints; RPC never needs huge frames.
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      maxPayload: 2 * 1024 * 1024,
      handleProtocols: (protocols) => protocols.has(WS_RPC_PROTOCOL) ? WS_RPC_PROTOCOL : false,
      verifyClient: (info, done) => {
        const binding = webSocketTicketBinding({
          directRemote: info.req.socket.remoteAddress,
          directLocal: info.req.socket.localAddress,
          hostHeader: info.req.headers.host,
          cloudflareConnectingIp: String(info.req.headers['cf-connecting-ip'] ?? ''),
          cloudflareRay: String(info.req.headers['cf-ray'] ?? ''),
        });
        if (!binding.requiresTicket) {
          done(true);
          return;
        }
        const principal = this.upgradeTickets.consume(
          info.req.headers['sec-websocket-protocol'],
          binding.source,
          binding.audience,
        );
        if (!principal) {
          this.logger.warn(`ws rejected missing, expired, or mismatched upgrade ticket: ${binding.source}`);
          done(false, 401, 'authenticated WebSocket upgrade ticket required', { 'Cache-Control': 'no-store' });
          return;
        }
        this.admittedPrincipals.set(info.req, principal);
        done(true);
      },
    });
    this.wss.on('connection', (socket, req) => this.onConnection(socket, req));
  }

  broadcast(event: string, data: unknown): void {
    for (const client of this.clients) {
      if (client.state.authed) client.sendEvent(event, data);
    }
  }

  /** Broadcast to an explicitly authorized subset of authenticated clients. */
  broadcastWhere(event: string, data: unknown, predicate: (auth: AuthContext) => boolean): void {
    for (const client of this.clients) {
      const auth = client.state.auth;
      if (client.state.authed && auth && predicate(auth)) client.sendEvent(event, data);
    }
  }

  /** Control-plane/log/voice events are visible only to the local administrator. */
  broadcastAdmin(event: string, data: unknown): void {
    for (const client of this.clients) {
      if (client.state.authed && client.state.auth?.isAdmin === true) client.sendEvent(event, data);
    }
  }

  /** Immediately invalidate every live socket authenticated as one device link. */
  disconnectLink(linkId: string, reason = 'device authorization changed'): number {
    return this.disconnectMatching((client) => client.state.auth?.linkId === linkId, reason);
  }

  /** Immediately invalidate all authenticated sockets after global credential rotation. */
  disconnectAuthenticated(reason = 'credentials rotated'): number {
    return this.disconnectMatching((client) => client.state.authed, reason);
  }

  close(): void {
    for (const client of this.clients) {
      client.state.stream?.stop();
      client.state.chat.reset();
      client.socket.close();
    }
    this.clients.clear();
    this.wss.close();
  }

  private disconnectMatching(predicate: (client: WsClient) => boolean, reason: string): number {
    let disconnected = 0;
    for (const client of this.clients) {
      if (!predicate(client)) continue;
      disconnected++;
      // Revoke the in-memory authorization before beginning the WebSocket
      // close handshake so messages racing with close fail closed.
      client.state.authed = false;
      client.state.auth = null;
      cleanupDisconnectedClientState(client.state);
      try { client.socket.close(4003, reason.slice(0, 120)); }
      catch { try { client.socket.terminate(); } catch { /* already gone */ } }
    }
    return disconnected;
  }

  private onConnection(socket: WebSocket, req: import('node:http').IncomingMessage): void {
    const directRemote = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    const directLocal = (req.socket.localAddress ?? 'unknown').replace(/^::ffff:/, '');
    const tailnet = isEncryptedTailnetTransport(directRemote, directLocal);
    const loopback = isLoopback(directRemote);
    if (loopback === false && tailnet === false) {
      this.logger.warn(`ws rejected unencrypted LAN peer: ${directRemote}`);
      socket.close(1008, 'secure transport required');
      return;
    }
    const forwarded = String(req.headers['cf-connecting-ip'] ?? '').trim();
    const ray = String(req.headers['cf-ray'] ?? '');
    const trustedCloudflare = loopback && isIP(forwarded) > 0 && /^[a-f0-9-]{8,}(?:-[a-z]{3})?$/i.test(ray);
    const remote = trustedCloudflare ? `cloudflare:${forwarded}` : directRemote;
    const origin = String(req.headers.origin ?? '').trim();
    if (origin) {
      let sameOrigin = false;
      try {
        const parsedOrigin = new URL(origin);
        // Cloudflare may preserve an explicit :443 Host. Parse it as HTTPS so
        // default-port normalization matches the native client's Origin.
        const parsedHost = new URL(`${trustedCloudflare ? 'https' : 'http'}://${String(req.headers.host ?? '')}`);
        const hostMatches = Boolean(parsedOrigin.hostname)
          && parsedOrigin.hostname.toLowerCase() === parsedHost.hostname.toLowerCase()
          && (!parsedHost.port || parsedOrigin.port === parsedHost.port);
        // The local desktop UI may intentionally control another registered
        // PC. Its browser Origin remains loopback while the destination is a
        // trusted Cloudflare/Tailnet hop; bearer authentication still applies.
        const localController = parsedOrigin.protocol === 'http:'
          && isLoopback(parsedOrigin.hostname)
          && (trustedCloudflare || tailnet);
        sameOrigin = hostMatches || localController;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) {
        this.logger.warn(`ws rejected foreign browser origin from ${remote}`);
        socket.close(1008, 'origin not allowed');
        return;
      }
    }
    if (this.clients.size >= WS_MAX_CLIENTS) {
      this.logger.warn(`ws rejected at connection cap: ${remote}`);
      socket.close(1013, 'server connection limit');
      return;
    }
    const fromSameSource = [...this.clients].reduce((count, candidate) => count + (candidate.remoteAddress === remote ? 1 : 0), 0);
    if (fromSameSource >= WS_MAX_CLIENTS_PER_SOURCE) {
      this.logger.warn(`ws rejected at per-source connection cap: ${remote}`);
      socket.close(1013, 'source connection limit');
      return;
    }
    const unauthenticated = [...this.clients].reduce((count, candidate) => count + (candidate.state.authed ? 0 : 1), 0);
    if (unauthenticated >= WS_MAX_UNAUTHENTICATED_CLIENTS) {
      this.logger.warn(`ws rejected at unauthenticated connection cap: ${remote}`);
      socket.close(1013, 'authentication connection limit');
      return;
    }
    const admissionPrincipal = this.admittedPrincipals.get(req);
    this.admittedPrincipals.delete(req);
    const client = new WsClient(socket, remote, admissionPrincipal);
    this.clients.add(client);
    this.logger.info(`ws connected: ${remote} (${this.clients.size} clients)`);

    const authTimer = setTimeout(() => {
      if (client.state.authed || socket.readyState !== WebSocket.OPEN) return;
      this.logger.warn(`ws authentication timeout: ${remote}`);
      try { socket.close(4001, 'authentication timeout'); }
      catch { try { socket.terminate(); } catch { /* already gone */ } }
    }, WS_AUTH_TIMEOUT_MS);
    authTimer.unref();

    const heartbeatTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!client.heartbeatAlive) {
        this.logger.warn(`ws heartbeat timeout: ${remote}`);
        try { socket.terminate(); } catch { /* already gone */ }
        return;
      }
      client.heartbeatAlive = false;
      try { socket.ping(); } catch { try { socket.terminate(); } catch { /* already gone */ } }
    }, WS_HEARTBEAT_MS);
    heartbeatTimer.unref();
    socket.on('pong', () => { client.heartbeatAlive = true; });

    socket.on('message', (raw: Buffer | string, isBinary: boolean) => {
      const byteLength = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;
      if (!client.state.authed) {
        client.preAuthFrames += 1;
        if (client.preAuthFrames !== 1 || isBinary || byteLength > WS_PRE_AUTH_MAX_BYTES) {
          this.logger.warn(`ws rejected invalid pre-auth frame: ${remote}`);
          try { socket.close(1008, 'first frame must be a small text auth request'); }
          catch { try { socket.terminate(); } catch { /* already gone */ } }
          return;
        }
      }
      const now = Date.now();
      if (now - client.messageWindowStartedAt >= WS_MESSAGE_WINDOW_MS) {
        client.messageWindowStartedAt = now;
        client.messagesInWindow = 0;
        client.bytesInWindow = 0;
      }
      client.messagesInWindow += 1;
      client.bytesInWindow += byteLength;
      if (client.messagesInWindow > WS_MAX_MESSAGES_PER_WINDOW || client.bytesInWindow > WS_MAX_BYTES_PER_WINDOW) {
        this.logger.warn(`ws message rate exceeded: ${remote}`);
        client.state.authed = false;
        client.state.auth = null;
        cleanupDisconnectedClientState(client.state);
        try { socket.close(1008, 'message rate limit'); }
        catch { try { socket.terminate(); } catch { /* already gone */ } }
        return;
      }
      void this.onMessage(client, raw.toString()).then(() => {
        if (client.state.authed) clearTimeout(authTimer);
      });
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(heartbeatTimer);
      cleanupDisconnectedClientState(client.state);
      this.clients.delete(client);
      this.logger.info(`ws disconnected: ${remote} (${this.clients.size} clients)`);
    });
    socket.on('error', (err) => {
      this.logger.warn(`ws error: ${err.message}`);
    });
  }

  private async onMessage(client: WsClient, raw: string): Promise<void> {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(raw) as RpcMessage;
    } catch {
      client.sendEvent('rpc.error', { message: 'invalid JSON' });
      return;
    }

    // Client-sent events/responses are not part of the protocol.
    if (!('method' in msg) || typeof msg.method !== 'string') return;
    const { id, method, params } = msg;

    if (method === 'auth') {
      const p = (params ?? {}) as { secret?: string };
      let authenticated = typeof p.secret === 'string' ? this.authenticate(p.secret) : null;
      // A public upgrade ticket is admission for exactly the credential that
      // obtained it. It cannot be lent to another device token or used to turn
      // one low-privilege link into an anonymous connection-slot sponsor.
      if (authenticated && client.admissionPrincipal
        && authPrincipal(authenticated) !== client.admissionPrincipal) authenticated = null;
      const sameDeviceConnections = authenticated?.linkId
        ? [...this.clients].reduce((count, candidate) => count + (
          candidate !== client && candidate.state.authed && candidate.state.auth?.linkId === authenticated.linkId ? 1 : 0
        ), 0)
        : 0;
      client.state.auth = sameDeviceConnections >= WS_MAX_CLIENTS_PER_DEVICE ? null : authenticated;
      client.state.authed = client.state.auth !== null;
      client.send({
        id,
        ok: true,
        result: {
          ok: client.state.authed,
          isAdmin: client.state.auth?.isAdmin === true,
          permissionCap: client.state.auth?.permissionCap ?? 'read-only',
        },
      });
      if (client.state.authed) {
        this.logger.info(`ws authenticated: ${client.remoteAddress}`);
      } else {
        const closeTimer = setTimeout(() => {
          try { client.socket.close(4003, 'authentication failed'); }
          catch { try { client.socket.terminate(); } catch { /* already gone */ } }
        }, 25);
        closeTimer.unref();
      }
      return;
    }

    if (!client.state.authed) {
      client.send({ id, ok: false, error: { code: RPC.ERROR_UNAUTHORIZED, message: 'unauthorized: call auth first' } });
      return;
    }

    const handler = this.handlers.get(method);
    if (!handler) {
      client.send({ id, ok: false, error: { code: RPC.ERROR_NOT_FOUND, message: `unknown method: ${method}` } });
      return;
    }

    if (client.inFlightRequests >= WS_MAX_IN_FLIGHT_REQUESTS) {
      client.send({ id, ok: false, error: { code: RPC.ERROR_INTERNAL, message: 'too many concurrent requests' } });
      return;
    }

    const globalInFlight = [...this.clients].reduce((sum, candidate) => sum + candidate.inFlightRequests, 0);
    const deviceInFlight = client.state.auth?.linkId
      ? [...this.clients].reduce((sum, candidate) => sum + (
        candidate.state.auth?.linkId === client.state.auth?.linkId ? candidate.inFlightRequests : 0
      ), 0)
      : 0;
    if (globalInFlight >= WS_MAX_GLOBAL_IN_FLIGHT_REQUESTS || deviceInFlight >= WS_MAX_DEVICE_IN_FLIGHT_REQUESTS) {
      client.send({ id, ok: false, error: { code: RPC.ERROR_INTERNAL, message: 'server request budget is busy; retry shortly' } });
      return;
    }

    client.inFlightRequests += 1;
    try {
      const result = await handler(params, client);
      client.send({ id, ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      client.send({ id, ok: false, error: { code: RPC.ERROR_INTERNAL, message } });
    } finally {
      client.inFlightRequests = Math.max(0, client.inFlightRequests - 1);
    }
  }
}
