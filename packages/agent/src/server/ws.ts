import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { RPC, type RpcMessage } from '@mr-robot/shared';
import type { Logger } from '../logger.js';
import { ChatSession } from './chat.js';
import { ScreenStreamController } from './stream.js';
import type { PermissionMode } from '@mr-robot/shared';

export interface AuthContext { isAdmin: boolean; linkId?: string; permissionCap: PermissionMode }

export interface WsClientState {
  authed: boolean;
  auth: AuthContext | null;
  chat: ChatSession;
  stream: ScreenStreamController | null;
}

export class WsClient {
  readonly id = randomUUID();
  readonly remoteAddress: string;
  readonly state: WsClientState = {
    authed: false,
    auth: null,
    chat: new ChatSession(),
    stream: null,
  };

  constructor(
    readonly socket: WebSocket,
    remoteAddress: string,
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
 * the pairing secret, or a `?token=` query param); everything else is
 * rejected with ERROR_UNAUTHORIZED until then.
 */
export class WsHub {
  private readonly wss: WebSocketServer;
  readonly clients = new Set<WsClient>();

  constructor(
    server: Server,
    private readonly handlers: Map<string, RpcHandler>,
    private readonly authenticate: (secret: string) => AuthContext | null,
    private readonly logger: Logger,
  ) {
    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: 96 * 1024 * 1024 });
    this.wss.on('connection', (socket, req) => this.onConnection(socket, req));
  }

  broadcast(event: string, data: unknown): void {
    for (const client of this.clients) {
      if (client.state.authed) client.sendEvent(event, data);
    }
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

  private onConnection(socket: WebSocket, req: import('node:http').IncomingMessage): void {
    const remote = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    const client = new WsClient(socket, remote);
    this.clients.add(client);
    this.logger.info(`ws connected: ${remote} (${this.clients.size} clients)`);

    // Allow token via query string (used by the desktop shell and simple clients).
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const token = url.searchParams.get('token');
      const auth = token ? this.authenticate(token) : null;
      if (auth) { client.state.authed = true; client.state.auth = auth; }
    } catch {
      /* malformed url — fall through to auth message */
    }

    socket.on('message', (raw: Buffer | string) => {
      void this.onMessage(client, raw.toString());
    });
    socket.on('close', () => {
      client.state.stream?.stop();
      client.state.chat.reset();
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
      client.state.auth = typeof p.secret === 'string' ? this.authenticate(p.secret) : null;
      client.state.authed = client.state.auth !== null;
      client.send({ id, ok: true, result: { ok: client.state.authed } });
      if (client.state.authed) this.logger.info(`ws authenticated: ${client.remoteAddress}`);
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

    try {
      const result = await handler(params, client);
      client.send({ id, ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      client.send({ id, ok: false, error: { code: RPC.ERROR_INTERNAL, message } });
    }
  }
}
