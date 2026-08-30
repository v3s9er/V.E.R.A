import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isIP } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type {
  AppSettings,
  PermissionMode,
  PluginInfo,
  ProviderAddInput,
  ProviderInfo,
  SystemStatus,
  SyncMergeResult,
  WorkspaceInfo,
} from '@mr-robot/shared';
import { mrRobotHome } from '../config.js';
import type { AuthContext } from './ws.js';

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SYNC_BYTES = 64 * 1024 * 1024;
const PAIR_WINDOW_MS = 5 * 60_000;
const PAIR_MAX_FAILURES = 5;
const TRANSFER_GRANT_TTL_MS = 90_000;
const MAX_TRANSFER_GRANTS = 1_024;

type TransferGrant = {
  kind: 'file' | 'sync';
  path?: string;
  expiresAt: number;
};

class PayloadTooLargeError extends Error {}

export function createByteLimitStream(maxBytes: number, message: string): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new PayloadTooLargeError(message));
        return;
      }
      callback(null, chunk);
    },
  });
}

function assertAdvertisedLength(value: string | null | undefined, maxBytes: number, message: string): void {
  if (value === undefined || value === null || value === '') return;
  if (!/^\d+$/.test(value)) throw new Error('Content-Length가 올바르지 않습니다.');
  if (Number(value) > maxBytes) throw new PayloadTooLargeError(message);
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

function isAllowedPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 127
    || parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

/**
 * Direct peer pull is intentionally limited to loopback/private device
 * addresses and the two known encrypted transport suffixes. General public
 * URLs, cloud metadata/link-local IPs, redirects and embedded credentials are
 * rejected before a server-side request is made.
 */
export function normalizePeerBase(value: unknown): URL {
  let input: URL;
  try {
    input = new URL(String(value ?? ''));
  } catch {
    throw new Error('원본 PC 주소가 올바르지 않습니다.');
  }
  if (!['http:', 'https:'].includes(input.protocol) || input.username || input.password) throw new Error('원본 PC 주소가 올바르지 않습니다.');
  if ((input.pathname && input.pathname !== '/') || input.search || input.hash) throw new Error('원본 PC 주소에는 origin만 입력할 수 있습니다.');
  const hostname = stripIpv6Brackets(input.hostname);
  const ipVersion = isIP(hostname);
  const privateAddress = ipVersion === 4
    ? isAllowedPrivateIpv4(hostname)
    : ipVersion === 6 && (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd'));
  const localName = hostname === 'localhost' || /^[a-z0-9][a-z0-9-]{0,62}\.local$/i.test(hostname);
  const encryptedKnownRelay = input.protocol === 'https:'
    && (/^[a-z0-9-]+\.trycloudflare\.com$/i.test(hostname) || /^[a-z0-9.-]+\.ts\.net$/i.test(hostname));
  if (!privateAddress && !localName && !encryptedKnownRelay) {
    throw new Error('등록 가능한 사설 PC 주소 또는 지원되는 HTTPS 원격 링크만 사용할 수 있습니다.');
  }
  const port = Number(input.port || (input.protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('원본 PC 포트가 올바르지 않습니다.');
  return new URL(input.origin);
}

export function browserOriginAllowed(origin: string | undefined, hostHeader: string | undefined, remote: string, cloudflareRay?: string): boolean {
  if (!origin) return true;
  if (origin === 'null') return isLoopback(remote);
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
  if (parsed.host.toLowerCase() === String(hostHeader ?? '').toLowerCase()) return true;
  const originHost = stripIpv6Brackets(parsed.hostname);
  const loopbackOrigin = originHost === 'localhost' || originHost === '127.0.0.1' || originHost === '::1';
  if (isLoopback(remote) && loopbackOrigin) return true;
  return isLoopback(remote)
    && typeof cloudflareRay === 'string'
    && /^[a-f0-9-]{8,}(?:-[a-z]{3})?$/i.test(cloudflareRay)
    && parsed.protocol === 'https:'
    && /^[a-z0-9-]+\.trycloudflare\.com$/i.test(originHost);
}

function containedBy(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

/**
 * Resolve a client-supplied relative path beneath a trusted root without
 * following symlinks or Windows junctions. Existing ancestors are checked
 * component-by-component so a reparse point cannot redirect a subsequent
 * read, write or delete outside the configured root. Missing suffixes are
 * safe for upload creation once every existing parent has passed the check.
 */
export function resolveConfinedPath(rootValue: string, value: unknown): string {
  const root = resolve(rootValue);
  const rootReal = realpathSync(root);
  const requested = String(value ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
  const target = resolve(root, requested);
  if (!containedBy(root, target)) throw new Error('허용된 폴더 밖의 경로는 사용할 수 없습니다.');

  const rel = relative(root, target);
  let cursor = root;
  for (const component of rel.split(/[\\/]+/).filter(Boolean)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) break;
    const entry = lstatSync(cursor);
    if (entry.isSymbolicLink()) throw new Error('심볼릭 링크나 junction을 통한 경로는 사용할 수 없습니다.');
    if (!containedBy(rootReal, realpathSync(cursor))) throw new Error('허용된 폴더 밖의 경로는 사용할 수 없습니다.');
  }
  return target;
}

function assertRegularFileDestination(rootValue: string, targetValue: string): string {
  const root = resolve(rootValue);
  const target = resolveConfinedPath(root, relative(root, targetValue));
  if (target === root) throw new Error('공유/작업 폴더 루트에는 파일을 쓸 수 없습니다. 파일 이름을 지정하세요.');
  if (existsSync(target) && !lstatSync(target).isFile()) throw new Error('대상은 일반 파일이어야 합니다. 폴더나 링크에는 쓸 수 없습니다.');
  return target;
}

function prepareFileDestination(rootValue: string, targetValue: string, operation: 'upload' | 'pull'): { target: string; temp: string } {
  const root = resolve(rootValue);
  let target = assertRegularFileDestination(root, targetValue);
  mkdirSync(dirname(target), { recursive: true });
  // Re-check after mkdir because an existing parent may have been exchanged
  // for a junction while the directory tree was being created.
  target = assertRegularFileDestination(root, target);
  const tempName = `.${basename(target)}.${operation}-${randomUUID()}.tmp`;
  const temp = resolveConfinedPath(root, relative(root, join(dirname(target), tempName)));
  if (dirname(temp) !== dirname(target)) throw new Error('임시 파일 경로가 대상 폴더를 벗어났습니다.');
  return { target, temp };
}

function revalidateDestination(rootValue: string, target: string, temp: string): void {
  const root = resolve(rootValue);
  assertRegularFileDestination(root, target);
  const checkedTemp = resolveConfinedPath(root, relative(root, temp));
  if (checkedTemp !== temp || !lstatSync(checkedTemp).isFile()) throw new Error('전송 임시 파일이 안전한 일반 파일이 아닙니다.');
}

function transferAbort(req: Request, res: Response, activeTransfers?: Set<AbortController>): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  activeTransfers?.add(controller);
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error('클라이언트 연결이 끊어져 전송을 중단했습니다.'));
  };
  const abortOnResponseClose = (): void => { if (!res.writableEnded) abort(); };
  req.once('aborted', abort);
  res.once('close', abortOnResponseClose);
  return {
    signal: controller.signal,
    cleanup: () => {
      req.off('aborted', abort);
      res.off('close', abortOnResponseClose);
      activeTransfers?.delete(controller);
    },
  };
}

async function readJsonResponseLimited(response: globalThis.Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error('원본 PC 응답 본문이 없습니다.');
  assertAdvertisedLength(response.headers.get('content-length'), maxBytes, '동기화 데이터가 허용 크기를 초과합니다.');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of Readable.fromWeb(response.body as never)) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > maxBytes) throw new PayloadTooLargeError('동기화 데이터가 허용 크기를 초과합니다.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('원본 PC가 올바른 JSON을 반환하지 않았습니다.');
  }
}

export interface PairingInfo {
  deviceName: string;
  host: string;
  hosts: string[];
  port: number;
  pin?: string;
  pinExpiresAt?: number;
  maskedSecret: string;
  qrPayload?: string;
  localSecret?: string;
}

/** What the HTTP layer needs from the agent core (implemented by AgentServer). */
export interface HttpApiHost {
  authenticate(secret: string): AuthContext | null;
  verifySecret(secret: string): boolean;
  isAdminSecret(secret: string): boolean;
  isSyncSecret(secret: string): boolean;
  pairingInfo(includeLocalSecret?: boolean, includePairingCode?: boolean): PairingInfo;
  exchangePin(pin: string, deviceName?: string, permissionCap?: PermissionMode, clientKey?: string): { ok: boolean; secret?: string; linkId?: string; error?: string };
  status(): SystemStatus;
  getSettings(): AppSettings;
  updateSettings(patch: Partial<AppSettings>): AppSettings;
  providersList(): ProviderInfo[];
  providersAdd(input: ProviderAddInput): ProviderInfo;
  providersRemove(id: string): void;
  providersSetDefault(id: string): void;
  providersTest(id: string): Promise<{ ok: boolean; error?: string }>;
  pluginsList(): PluginInfo[];
  pluginsLoad(source: string): Promise<PluginInfo>;
  pluginsUnload(id: string): Promise<boolean>;
  pluginsCall(name: string, params: unknown, auth: AuthContext): Promise<unknown>;
  chatOnce(text: string, auth: AuthContext): Promise<{ text: string }>;
  syncSnapshot(): { version: number; deviceName: string; exportedAt: number; conversations: unknown[]; routingPresets: unknown[] };
  mergeSyncSnapshot(snapshot: unknown): SyncMergeResult;
  workspacesList(): WorkspaceInfo[];
  fileAccess(secret: string, write: boolean): boolean;
  sharedFileAccess(secret: string, write: boolean): boolean;
}

export function isLoopback(remote: string): boolean {
  const r = remote.replace(/^::ffff:/, '');
  return r === '127.0.0.1' || r === '::1' || r === 'localhost';
}

export function isTailnetAddress(remote: string): boolean {
  const octets = remote.replace(/^::ffff:/, '').split('.').map(Number);
  return octets.length === 4
    && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    && octets[0] === 100
    && octets[1] >= 64
    && octets[1] <= 127;
}

/**
 * Express routing is case-insensitive unless explicitly configured. Keep the
 * transport boundary independent of that setting so a mixed-case `/API/...`
 * request can never skip the plaintext-LAN refusal while matching an API
 * handler now or after a future router configuration change.
 */
export function requiresSecureApiTransport(pathname: string): boolean {
  const normalized = pathname.toLowerCase();
  return normalized.startsWith('/api/') && normalized !== '/api/ping';
}

function remoteOf(req: Request): string {
  return String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
}

export function createHttpApi(host: HttpApiHost, webDir?: string, activeTransfers?: Set<AbortController>): Express {
  const app = express();
  app.disable('x-powered-by');
  // Authentication and transport policy are path-sensitive. Reject
  // case-variant route aliases instead of relying on Express's permissive
  // default, then keep the normalized middleware check below as defence in
  // depth.
  app.set('case sensitive routing', true);
  const sharedRoot = resolve(mrRobotHome(), 'shared');
  mkdirSync(sharedRoot, { recursive: true });
  const transferGrants = new Map<string, TransferGrant>();

  const pruneTransferGrants = (): void => {
    const now = Date.now();
    for (const [token, grant] of transferGrants) {
      if (grant.expiresAt <= now) transferGrants.delete(token);
    }
    if (transferGrants.size < MAX_TRANSFER_GRANTS) return;
    const overflow = transferGrants.size - MAX_TRANSFER_GRANTS + 1;
    const oldest = [...transferGrants.entries()]
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
      .slice(0, overflow);
    for (const [token] of oldest) transferGrants.delete(token);
  };
  const issueTransferGrant = (grant: Omit<TransferGrant, 'expiresAt'>): { grant: string; expiresAt: number } => {
    pruneTransferGrants();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + TRANSFER_GRANT_TTL_MS;
    transferGrants.set(token, { ...grant, expiresAt });
    return { grant: token, expiresAt };
  };
  const consumeTransferGrant = (req: Request, kind: TransferGrant['kind'], path?: string): void => {
    const token = String(req.header('x-mr-robot-transfer') ?? '');
    if (token.length < 32 || token.length > 256) throw new Error('1회성 전송 권한이 필요합니다.');
    const grant = transferGrants.get(token);
    // Delete before validation so concurrent requests and wrong-path probes
    // cannot reuse a capability that was already presented once.
    transferGrants.delete(token);
    if (!grant || grant.expiresAt <= Date.now() || grant.kind !== kind || (kind === 'file' && grant.path !== path)) {
      throw new Error('1회성 전송 권한이 만료되었거나 요청과 일치하지 않습니다.');
    }
  };

  // Native clients send no Origin. Browser clients are restricted to the
  // actual served origin, local Electron/dev origins, or a verified
  // TryCloudflare hop. The token remains mandatory independently of CORS.
  app.use((req, res, next) => {
    const origin = req.header('origin');
    if (!browserOriginAllowed(origin, req.header('host'), remoteOf(req), req.header('cf-ray'))) {
      res.status(403).json({ error: 'browser origin not allowed' });
      return;
    }
    res.vary('Origin');
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'content-type, content-length, x-mr-robot-token, x-mr-robot-transfer');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'content-disposition, content-length, x-mr-robot-file-name');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
    ].join('; '));
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // Browsers only honor HSTS on HTTPS responses. Cloudflare forwards this
    // header to the public HTTPS client while loopback/Tailscale HTTP clients
    // safely ignore it.
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.toLowerCase().startsWith('/api/')) {
      // Pairing responses and authenticated data must not land in a browser,
      // proxy, or service-worker cache.
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
    }
    if (req.header('access-control-request-private-network') === 'true') {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.vary('Access-Control-Request-Private-Network');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
  // The listener itself is HTTP. Quick Link wraps loopback in HTTPS and
  // Tailscale encrypts the 100.64/10 transport. Refuse every credential,
  // pairing, and transfer API from an ordinary LAN so long-lived device
  // tokens are never sent over a sniffable Wi-Fi segment.
  app.use((req, res, next) => {
    if (!requiresSecureApiTransport(req.path)) { next(); return; }
    const remote = remoteOf(req);
    if (isLoopback(remote) || isTailnetAddress(remote)) { next(); return; }
    res.status(426).json({
      error: '보안 전송이 필요합니다. Cloudflare HTTPS 원격 링크 또는 Tailscale 연결을 사용하세요.',
    });
  });
  app.use(express.json({ limit: MAX_JSON_BYTES, strict: true }));
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    const detail = error as { type?: string; status?: number; message?: string };
    if (detail.type === 'entity.too.large' || detail.status === 413) {
      res.status(413).json({ error: 'JSON 요청은 최대 1MB까지 허용됩니다.' });
      return;
    }
    next(error);
  });

  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const auth = host.authenticate(String(req.header('x-mr-robot-token') ?? ''));
    if (auth) {
      res.locals.mrRobotAuth = auth;
      next();
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
  };
  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    if (host.isAdminSecret(String(req.header('x-mr-robot-token') ?? ''))) { next(); return; }
    res.status(403).json({ error: 'administrator permission required' });
  };
  const requireSync = (req: Request, res: Response, next: NextFunction): void => {
    if (host.isSyncSecret(String(req.header('x-mr-robot-token') ?? ''))) { next(); return; }
    res.status(403).json({ error: '이 기기의 작업 동기화 권한이 꺼져 있거나 읽기 전용 정책으로 제한되어 있습니다. PC의 연결 기기 설정에서 작업 동기화를 허용하세요.' });
  };
  const requestAuth = (res: Response): AuthContext => res.locals.mrRobotAuth as AuthContext;
  const pairAttempts = new Map<string, { failures: number; windowStartedAt: number; blockedUntil: number; lastSeen: number }>();
  const pairClientKey = (req: Request): string => {
    const direct = remoteOf(req);
    const forwarded = String(req.header('cf-connecting-ip') ?? '').trim();
    const ray = String(req.header('cf-ray') ?? '');
    if (isLoopback(direct) && isIP(forwarded) > 0 && /^[a-f0-9-]{8,}(?:-[a-z]{3})?$/i.test(ray)) return `cloudflare:${forwarded}`;
    return `direct:${direct || 'unknown'}`;
  };
  const pairRetryAfter = (key: string): number => {
    const now = Date.now();
    const state = pairAttempts.get(key);
    if (!state) return 0;
    state.lastSeen = now;
    if (state.blockedUntil > now) return state.blockedUntil - now;
    if (now - state.windowStartedAt >= PAIR_WINDOW_MS) pairAttempts.delete(key);
    return 0;
  };
  const recordPairFailure = (key: string): void => {
    const now = Date.now();
    const previous = pairAttempts.get(key);
    const state = !previous || now - previous.windowStartedAt >= PAIR_WINDOW_MS
      ? { failures: 0, windowStartedAt: now, blockedUntil: 0, lastSeen: now }
      : previous;
    state.failures += 1;
    state.lastSeen = now;
    if (state.failures >= PAIR_MAX_FAILURES) state.blockedUntil = now + PAIR_WINDOW_MS;
    pairAttempts.set(key, state);
    if (pairAttempts.size > 4_096) {
      const oldest = [...pairAttempts.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen).slice(0, 2_048);
      for (const [oldKey] of oldest) pairAttempts.delete(oldKey);
    }
  };

  app.get('/api/ping', (_req, res) => {
    res.json({ ok: true, app: 'mr-robot' });
  });

  // Never return the administrator secret over HTTP. Electron receives its
  // local bootstrap secret through isolated IPC, not through this route.
  app.get('/api/pairing', requireAuth, (_req, res) => {
    const { localSecret: _discarded, ...safe } = host.pairingInfo(false);
    res.json(safe);
  });

  // Exchange the short PIN for a per-device token. Rate limiting is scoped to
  // the direct client (or Cloudflare's asserted edge client IP) so one remote
  // attacker cannot cheaply lock every legitimate device out at this layer.
  app.post('/api/pair', (req, res) => {
    const key = pairClientKey(req);
    const retryAfterMs = pairRetryAfter(key);
    if (retryAfterMs > 0) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      res.status(429).json({ error: 'too many pairing attempts' });
      return;
    }
    const pin = String(req.body?.pin ?? '').trim();
    const name = String(req.body?.deviceName ?? '연결된 기기').trim().slice(0, 120) || '연결된 기기';
    const rawPermission = String(req.body?.permissionCap ?? 'ask');
    const requested: PermissionMode = ['read-only', 'ask', 'workspace', 'full'].includes(rawPermission)
      ? rawPermission as PermissionMode
      : 'ask';
    const result = host.exchangePin(pin, name, requested, key);
    if (!result.ok) {
      recordPairFailure(key);
      res.status(400).json({ error: result.error });
      return;
    }
    pairAttempts.delete(key);
    res.json({ secret: result.secret, linkId: result.linkId });
  });

  app.get('/api/status', requireAuth, (_req, res) => {
    res.json(host.status());
  });

  const sharedPath = (value: unknown): string => resolveConfinedPath(sharedRoot, value);
  const workspacePath = (workspaceId: unknown, value: unknown): { workspace: WorkspaceInfo; root: string; target: string } => {
    const workspace = host.workspacesList().find((item) => item.id === String(workspaceId ?? ''));
    if (!workspace) throw new Error('작업 폴더를 찾을 수 없습니다.');
    const root = resolve(workspace.path);
    const target = resolveConfinedPath(root, value);
    return { workspace, root, target };
  };
  const requireWorkspaceFileAccess = (write: boolean) => (req: Request, res: Response, next: NextFunction): void => {
    const token = String(req.header('x-mr-robot-token') ?? '');
    if (host.fileAccess(token, write)) { next(); return; }
    res.status(403).json({ error: write ? '이 기기에는 작업 폴더 쓰기 권한이 없습니다.' : '이 기기에는 작업 폴더 읽기 권한이 없습니다.' });
  };
  const requireSharedFileAccess = (write: boolean) => (req: Request, res: Response, next: NextFunction): void => {
    const token = String(req.header('x-mr-robot-token') ?? '');
    if (host.sharedFileAccess(token, write)) { next(); return; }
    res.status(403).json({ error: write ? '이 기기에는 기기 간 공유 폴더 쓰기 권한이 없습니다.' : '이 기기에는 기기 간 공유 폴더 읽기 권한이 없습니다.' });
  };
  const sendRouteError = (res: Response, error: unknown, fallbackStatus = 400): void => {
    if (res.destroyed || res.headersSent) return;
    res.status(error instanceof PayloadTooLargeError ? 413 : fallbackStatus)
      .json({ error: error instanceof Error ? error.message : String(error) });
  };
  const assertPeer = async (base: URL): Promise<void> => {
    const pingUrl = new URL('/api/ping', base);
    const response = await fetch(pingUrl, {
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`원본 주소에서 Mr.Robot Agent를 확인할 수 없습니다. (HTTP ${response.status})`);
    const ping = await readJsonResponseLimited(response, 16 * 1024) as { ok?: unknown; app?: unknown };
    if (ping.ok !== true || ping.app !== 'mr-robot') throw new Error('원본 주소가 Mr.Robot Agent로 확인되지 않았습니다.');
  };
  const sourceGrant = (value: unknown): string => {
    const grant = String(value ?? '');
    if (grant.length < 32 || grant.length > 256) throw new Error('원본 PC의 1회성 전송 권한이 올바르지 않습니다.');
    return grant;
  };

  app.get('/api/workspaces', requireAuth, (_req, res) => res.json(host.workspacesList()));
  app.get('/api/workspaces/files', requireWorkspaceFileAccess(false), (req, res) => {
    try {
      const { workspace, target } = workspacePath(req.query.workspaceId, req.query.path);
      if (!statSync(target).isDirectory()) throw new Error('폴더가 아닙니다.');
      const items = readdirSync(target, { withFileTypes: true }).filter((entry) => !entry.isSymbolicLink()).map((entry) => {
        const full = join(target, entry.name); const stat = statSync(full);
        return { name: entry.name, path: relative(workspace.path, full).replaceAll('\\', '/'), isDirectory: entry.isDirectory(), size: entry.isFile() ? stat.size : 0, modifiedAt: stat.mtimeMs };
      }).sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
      res.json({ workspace, path: relative(workspace.path, target).replaceAll('\\', '/'), items });
    } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
  });
  app.get('/api/workspaces/download', requireWorkspaceFileAccess(false), (req, res) => {
    const transfer = transferAbort(req, res, activeTransfers);
    try {
      const { target } = workspacePath(req.query.workspaceId, req.query.path); const stat = statSync(target);
      if (!stat.isFile()) throw new Error('다운로드할 파일이 아닙니다.');
      const name = basename(target).replace(/[\r\n"]/g, '_');
      res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      void pipeline(createReadStream(target), res, { signal: transfer.signal })
        .catch(() => { if (!res.destroyed) res.destroy(); })
        .finally(transfer.cleanup);
    } catch (err) { transfer.cleanup(); res.status(404).json({ error: err instanceof Error ? err.message : String(err) }); }
  });
  app.put('/api/workspaces/upload', requireWorkspaceFileAccess(true), async (req, res) => {
    let temp = '';
    const transfer = transferAbort(req, res, activeTransfers);
    try {
      assertAdvertisedLength(req.header('content-length'), MAX_FILE_BYTES, '파일은 최대 2GB까지 전송할 수 있습니다.');
      const { workspace, root, target: requestedTarget } = workspacePath(req.query.workspaceId, req.query.path);
      const prepared = prepareFileDestination(root, requestedTarget, 'upload');
      const target = prepared.target; temp = prepared.temp;
      await pipeline(req, createByteLimitStream(MAX_FILE_BYTES, '파일은 최대 2GB까지 전송할 수 있습니다.'), createWriteStream(temp, { flags: 'wx' }), { signal: transfer.signal });
      revalidateDestination(root, target, temp); renameSync(temp, target);
      res.json({ ok: true, name: basename(target), path: relative(workspace.path, target).replaceAll('\\', '/'), size: statSync(target).size });
    } catch (err) { if (temp && existsSync(temp)) unlinkSync(temp); sendRouteError(res, err); }
    finally { transfer.cleanup(); }
  });

  // Token-free AI usage: these routes stream bytes directly between paired devices.
  // They intentionally expose only ~/.mr-robot/shared, never the whole PC filesystem.
  app.get('/api/files', requireSharedFileAccess(false), (req, res) => {
    try {
      const dir = sharedPath(req.query.path);
      const items = readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.isSymbolicLink()).map((entry) => {
        const full = join(dir, entry.name);
        const stat = statSync(full);
        return {
          name: entry.name,
          path: relative(sharedRoot, full).replaceAll('\\', '/'),
          isDirectory: entry.isDirectory(),
          size: entry.isFile() ? stat.size : 0,
          modifiedAt: stat.mtimeMs,
        };
      }).sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
      res.json({ root: 'Mr.Robot 공유함', path: relative(sharedRoot, dir).replaceAll('\\', '/'), items });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/transfers/grant', requireAuth, (req, res) => {
    try {
      const token = String(req.header('x-mr-robot-token') ?? '');
      const kind = String(req.body?.kind ?? '');
      if (kind === 'file') {
        if (!host.sharedFileAccess(token, false)) throw new Error('이 기기에는 공유 파일 읽기 권한이 없습니다.');
        const file = sharedPath(req.body?.path);
        if (!statSync(file).isFile()) throw new Error('전송할 일반 파일을 찾을 수 없습니다.');
        const path = relative(sharedRoot, file).replaceAll('\\', '/');
        res.json(issueTransferGrant({ kind, path }));
        return;
      }
      if (kind === 'sync') {
        if (!host.isSyncSecret(token)) throw new Error('이 기기에는 작업 동기화 전송권이 없습니다. PC의 연결 기기 설정을 확인하세요.');
        res.json(issueTransferGrant({ kind }));
        return;
      }
      throw new Error('지원되지 않는 전송 권한 종류입니다.');
    } catch (err) {
      res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/files/download', (req, res) => {
    const transfer = transferAbort(req, res, activeTransfers);
    try {
      const file = sharedPath(req.query.path);
      const stat = statSync(file);
      if (!stat.isFile()) throw new Error('다운로드할 파일이 아닙니다.');
      const path = relative(sharedRoot, file).replaceAll('\\', '/');
      const token = String(req.header('x-mr-robot-token') ?? '');
      if (!host.sharedFileAccess(token, false)) consumeTransferGrant(req, 'file', path);
      const name = basename(file).replace(/[\r\n"]/g, '_');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.setHeader('X-Mr-Robot-File-Name', encodeURIComponent(name));
      void pipeline(createReadStream(file), res, { signal: transfer.signal })
        .catch(() => { if (!res.destroyed) res.destroy(); })
        .finally(transfer.cleanup);
    } catch (err) {
      transfer.cleanup();
      res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put('/api/files/upload', requireSharedFileAccess(true), async (req, res) => {
    let temp = '';
    const transfer = transferAbort(req, res, activeTransfers);
    try {
      assertAdvertisedLength(req.header('content-length'), MAX_FILE_BYTES, '파일은 최대 2GB까지 전송할 수 있습니다.');
      const prepared = prepareFileDestination(sharedRoot, sharedPath(req.query.path), 'upload');
      const file = prepared.target; temp = prepared.temp;
      await pipeline(req, createByteLimitStream(MAX_FILE_BYTES, '파일은 최대 2GB까지 전송할 수 있습니다.'), createWriteStream(temp, { flags: 'wx' }), { signal: transfer.signal });
      revalidateDestination(sharedRoot, file, temp);
      renameSync(temp, file);
      const stat = statSync(file);
      res.json({ ok: true, name: basename(file), path: relative(sharedRoot, file).replaceAll('\\', '/'), size: stat.size });
    } catch (err) {
      if (temp && existsSync(temp)) unlinkSync(temp);
      sendRouteError(res, err);
    } finally { transfer.cleanup(); }
  });

  app.post('/api/files/pull', requireSharedFileAccess(true), async (req, res) => {
    let temp = '';
    const transfer = transferAbort(req, res, activeTransfers);
    try {
      const sourceBase = normalizePeerBase(req.body?.sourceBase);
      const grant = sourceGrant(req.body?.sourceGrant);
      await assertPeer(sourceBase);
      const sourcePath = String(req.body?.sourcePath ?? '');
      const prepared = prepareFileDestination(sharedRoot, sharedPath(req.body?.targetPath || basename(sourcePath)), 'pull');
      const target = prepared.target; temp = prepared.temp;
      const sourceUrl = new URL('/api/files/download', sourceBase);
      sourceUrl.searchParams.set('path', sourcePath);
      const upstream = await fetch(sourceUrl, {
        headers: { 'x-mr-robot-transfer': grant },
        redirect: 'error',
        signal: AbortSignal.any([transfer.signal, AbortSignal.timeout(30 * 60_000)]),
      });
      if (!upstream.ok || !upstream.body) throw new Error(`원본 PC 파일을 열 수 없습니다. (HTTP ${upstream.status})`);
      assertAdvertisedLength(upstream.headers.get('content-length'), MAX_FILE_BYTES, '파일은 최대 2GB까지 전송할 수 있습니다.');
      await pipeline(
        Readable.fromWeb(upstream.body as never),
        createByteLimitStream(MAX_FILE_BYTES, '파일은 최대 2GB까지 전송할 수 있습니다.'),
        createWriteStream(temp, { flags: 'wx' }),
        { signal: transfer.signal },
      );
      revalidateDestination(sharedRoot, target, temp);
      renameSync(temp, target);
      const stat = statSync(target);
      res.json({ ok: true, path: relative(sharedRoot, target).replaceAll('\\', '/'), size: stat.size, transport: 'direct-device-stream' });
    } catch (err) {
      if (temp && existsSync(temp)) unlinkSync(temp);
      sendRouteError(res, err);
    } finally { transfer.cleanup(); }
  });

  app.get('/api/sync/snapshot', (req, res) => {
    try {
      const token = String(req.header('x-mr-robot-token') ?? '');
      if (!host.isSyncSecret(token)) consumeTransferGrant(req, 'sync');
      res.json(host.syncSnapshot());
    } catch (err) {
      res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // The target token must carry the narrow work-sync capability. Conversation
  // merge preserves divergent branches as conflict copies; access/workspace
  // decisions remain destination-local and the read-only ceilings still win.
  app.post('/api/sync/pull', requireSync, async (req, res) => {
    const transfer = transferAbort(req, res, activeTransfers);
    try {
      const sourceBase = normalizePeerBase(req.body?.sourceBase);
      const grant = sourceGrant(req.body?.sourceGrant);
      await assertPeer(sourceBase);
      const sourceUrl = new URL('/api/sync/snapshot', sourceBase);
      const upstream = await fetch(sourceUrl, {
        headers: { 'x-mr-robot-transfer': grant },
        redirect: 'error',
        signal: AbortSignal.any([transfer.signal, AbortSignal.timeout(2 * 60_000)]),
      });
      if (!upstream.ok) throw new Error(`원본 PC 동기화 데이터를 읽을 수 없습니다. (HTTP ${upstream.status})`);
      const result = host.mergeSyncSnapshot(await readJsonResponseLimited(upstream, MAX_SYNC_BYTES));
      res.json({ ok: true, ...result, transport: 'direct-device-sync', aiTokens: 0 });
    } catch (err) {
      sendRouteError(res, err);
    } finally { transfer.cleanup(); }
  });

  app.delete('/api/files', requireSharedFileAccess(true), (req, res) => {
    try {
      const file = sharedPath(req.query.path);
      if (!statSync(file).isFile()) throw new Error('파일만 삭제할 수 있습니다.');
      unlinkSync(file);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.get('/api/settings', requireAuth, (_req, res) => {
    res.json(host.getSettings());
  });
  app.put('/api/settings', requireAdmin, (req, res) => {
    res.json(host.updateSettings(req.body ?? {}));
  });

  app.get('/api/providers', requireAuth, (_req, res) => {
    res.json(host.providersList());
  });
  app.post('/api/providers', requireAdmin, (req, res) => {
    res.json(host.providersAdd(req.body ?? {}));
  });
  app.delete('/api/providers/:id', requireAdmin, (req, res) => {
    host.providersRemove(String(req.params.id));
    res.json({ ok: true });
  });
  app.post('/api/providers/:id/default', requireAdmin, (req, res) => {
    host.providersSetDefault(String(req.params.id));
    res.json({ ok: true });
  });
  app.get('/api/providers/test/:id', requireAdmin, async (req, res) => {
    res.json(await host.providersTest(String(req.params.id)));
  });

  app.get('/api/plugins', requireAuth, (_req, res) => {
    res.json(host.pluginsList());
  });
  app.post('/api/plugins/load', requireAdmin, async (req, res) => {
    try {
      res.json(await host.pluginsLoad(String(req.body?.path ?? '')));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post('/api/plugins/unload', requireAdmin, async (req, res) => {
    res.json({ ok: await host.pluginsUnload(String(req.body?.id ?? '')) });
  });
  app.post('/api/plugins/call', requireAuth, async (req, res) => {
    try {
      res.json(await host.pluginsCall(String(req.body?.name ?? ''), req.body?.params, requestAuth(res)));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/chat', requireAuth, async (req, res) => {
    try {
      res.json(await host.chatOnce(String(req.body?.text ?? ''), requestAuth(res)));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Static web UI (built packages/web). SPA fallback for non-API GETs.
  if (webDir && existsSync(join(webDir, 'index.html'))) {
    app.use(express.static(webDir));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api')) {
        res.sendFile(join(webDir, 'index.html'));
        return;
      }
      next();
    });
  } else {
    app.get('/', (_req, res) => {
      res
        .status(200)
        .type('text/plain')
        .send('Mr.Robot agent is running. Build packages/web for the UI, or connect with the mobile app.');
    });
  }

  return app;
}
