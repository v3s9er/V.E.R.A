import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, statfsSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createConnection, isIP, type Socket } from 'node:net';
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
import { authPrincipal, webSocketTicketBinding, WsUpgradeTicketAdmissionError, type AuthContext, type WsUpgradeTickets } from './ws.js';
import { isEncryptedTailnetTransport, isLoopback, isSecurePlainPeerTransport, isTailnetAddress, tailscaleInterfaceAddresses } from './transport.js';
import { FileTransferAdmission, FileTransferAdmissionError, type FileTransferLease } from './transfer-admission.js';
import {
  CLOUDFLARE_ACCESS_BOOTSTRAP_COOKIE,
  CLOUDFLARE_ACCESS_BOOTSTRAP_PROBE,
  CLOUDFLARE_ACCESS_PAIR_PROBE_ERROR,
  cloudflareAccessBootstrapChallenge,
  isCloudflareAccessPairProbe,
} from '../access-probe.js';

export { isEncryptedTailnetTransport, isLoopback, isSecurePlainPeerTransport, isTailnetAddress } from './transport.js';

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PUBLIC_FILE_BYTES = 96 * 1024 * 1024;
const MAX_SYNC_BYTES = 64 * 1024 * 1024;
const MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;
const SHARED_ROOT_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_STORAGE_SCAN_ENTRIES = 100_000;
const DISK_RECHECK_BYTES = 16 * 1024 * 1024;
const PAIR_WINDOW_MS = 5 * 60_000;
const PAIR_MAX_FAILURES = 5;
const TRANSFER_GRANT_TTL_MS = 90_000;
const MAX_TRANSFER_GRANTS = 1_024;
const MAX_TRANSFER_GRANTS_PER_PRINCIPAL = 16;
const TRANSFER_GRANT_ISSUE_WINDOW_MS = 10_000;
const MAX_TRANSFER_GRANT_ISSUES_PER_WINDOW = 32;

type TransferGrant = {
  kind: 'file' | 'sync';
  path?: string;
  principal: string;
  expiresAt: number;
};

class PayloadTooLargeError extends Error {}
class InsufficientStorageError extends Error {}

export type MeteredByteLimitStream = Transform & { readonly transferredBytes: number };

export function createByteLimitStream(maxBytes: number, message: string, diskGuard?: () => void): MeteredByteLimitStream {
  let bytes = 0;
  let nextDiskCheck = DISK_RECHECK_BYTES;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new PayloadTooLargeError(message));
        return;
      }
      if (diskGuard && bytes >= nextDiskCheck) {
        try {
          diskGuard();
          while (nextDiskCheck <= bytes) nextDiskCheck += DISK_RECHECK_BYTES;
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      callback(null, chunk);
    },
  });
  Object.defineProperty(stream, 'transferredBytes', { enumerable: true, get: () => bytes });
  return stream as MeteredByteLimitStream;
}

function assertAdvertisedLength(value: string | null | undefined, maxBytes: number, message: string): void {
  if (value === undefined || value === null || value === '') return;
  if (!/^\d+$/.test(value)) throw new Error('Content-Length가 올바르지 않습니다.');
  if (Number(value) > maxBytes) throw new PayloadTooLargeError(message);
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

/**
 * Direct peer pull accepts plaintext HTTP only on loopback or a literal
 * Tailscale 100.64/10 address. Ordinary private-LAN HTTP is deliberately
 * rejected: otherwise a Wi-Fi observer can race a short-lived transfer grant.
 * HTTPS accepts local/known relays and user-owned DNS hostnames. Custom public
 * names are resolved once, rejected if any answer is non-public, then pinned to
 * the reviewed address while TLS still validates the original hostname.
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
  const encryptedKnownRelay = input.protocol === 'https:'
    && isKnownEncryptedPeerRelay(hostname);
  const encryptedCustomDomain = input.protocol === 'https:' && ipVersion === 0 && isDnsPeerHostname(hostname);
  const safePlaintext = input.protocol === 'http:'
    && (isLoopback(hostname) || (ipVersion === 4 && isTailnetAddress(hostname)));
  const safeHttps = input.protocol === 'https:' && (encryptedKnownRelay || encryptedCustomDomain);
  if (!safePlaintext && !safeHttps) {
    throw new Error('평문 연결은 이 PC 또는 Tailscale 주소만 허용됩니다. 일반 LAN은 HTTPS 원격 링크를 사용하세요.');
  }
  const port = Number(input.port || (input.protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('원본 PC 포트가 올바르지 않습니다.');
  if (safeHttps && port !== 443) throw new Error('HTTPS 원본 PC는 표준 443 포트만 사용할 수 있습니다.');
  return new URL(input.origin);
}

function assertDiskReserve(path: string, incomingBytes: number): void {
  const stats = statfsSync(path, { bigint: true });
  const available = stats.bavail * stats.bsize;
  const required = BigInt(MIN_FREE_DISK_BYTES) + BigInt(Math.max(0, incomingBytes));
  if (available < required) {
    throw new InsufficientStorageError('안전 여유 공간 2GB를 남길 수 없어 전송을 중단했습니다. 디스크 공간을 확보해 주세요.');
  }
}

function boundedDirectoryBytes(root: string, stopAfter = SHARED_ROOT_QUOTA_BYTES): number {
  const pending = [root];
  let entries = 0;
  let bytes = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_STORAGE_SCAN_ENTRIES) {
        throw new InsufficientStorageError('공유 폴더 항목이 너무 많아 안전하게 용량을 확인할 수 없습니다. 정리 후 다시 시도하세요.');
      }
      if (entry.isSymbolicLink()) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) bytes += lstatSync(full).size;
      if (bytes > stopAfter) return bytes;
    }
  }
  return bytes;
}

function ipv4Number(address: string): number | null {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function ipv4InCidr(value: number, network: string, prefix: number): boolean {
  const base = ipv4Number(network);
  if (base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

/** True only for an address safe to use as a pinned public HTTPS peer. */
export function isPublicPeerAddress(address: string): boolean {
  const hostname = stripIpv6Brackets(address);
  const version = isIP(hostname);
  if (version === 4) {
    const value = ipv4Number(hostname);
    if (value === null) return false;
    const blocked: Array<[string, number]> = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4],
    ];
    return !blocked.some(([network, prefix]) => ipv4InCidr(value, network, prefix));
  }
  if (version !== 6) return false;
  const lower = hostname.toLowerCase();
  if (lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('ff')) return false;
  if (/^fe[89ab]/.test(lower) || lower.startsWith('2001:db8:') || lower === '2001:db8::') return false;
  if (lower.startsWith('::ffff:')) return isPublicPeerAddress(lower.slice('::ffff:'.length));
  return true;
}

function isKnownEncryptedPeerRelay(hostname: string): boolean {
  return /^[a-z0-9-]+\.trycloudflare\.com$/i.test(hostname) || /^[a-z0-9.-]+\.ts\.net$/i.test(hostname);
}

function isDnsPeerHostname(hostname: string): boolean {
  if (hostname.length > 253 || !hostname.includes('.') || hostname.endsWith('.') || hostname.endsWith('.local')) return false;
  return hostname.split('.').every((label) => label.length >= 1 && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

class OneShotHttpAgent extends HttpAgent {
  private pendingSocket: Socket | undefined;

  constructor(socket: Socket) {
    super({ keepAlive: false, maxSockets: 1 });
    this.pendingSocket = socket;
  }

  override createConnection(): Socket {
    const socket = this.pendingSocket;
    this.pendingSocket = undefined;
    if (!socket) throw new Error('검증된 원본 PC 연결은 한 번만 사용할 수 있습니다.');
    return socket;
  }
}

async function connectVerifiedPlainPeer(base: URL, signal: AbortSignal): Promise<Socket> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('원본 PC 연결이 취소되었습니다.');
  const hostname = stripIpv6Brackets(base.hostname);
  const tailnetRequested = isTailnetAddress(hostname);
  const trustedTailnetAddresses = tailscaleInterfaceAddresses();
  const localAddress = tailnetRequested ? [...trustedTailnetAddresses][0] : undefined;
  if (tailnetRequested && !localAddress) {
    throw new Error('Tailscale 주소를 사용하려면 이 PC의 Tailscale 어댑터가 연결되어 있어야 합니다.');
  }

  const socket = createConnection({
    host: hostname,
    port: Number(base.port || 80),
    ...(localAddress ? { localAddress } : {}),
  });
  return await new Promise<Socket>((resolveSocket, rejectSocket) => {
    let settled = false;
    const timeout = setTimeout(() => fail(new Error('원본 PC 연결 시간이 초과되었습니다.')), 8_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      socket.off('connect', onConnect);
      socket.off('error', fail);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      rejectSocket(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = (): void => fail(signal.reason instanceof Error ? signal.reason : new Error('원본 PC 연결이 취소되었습니다.'));
    const onConnect = (): void => {
      if (settled) return;
      const remote = String(socket.remoteAddress ?? '');
      const local = String(socket.localAddress ?? '');
      const expectedTransport = tailnetRequested
        ? isEncryptedTailnetTransport(remote, local, trustedTailnetAddresses)
        : isLoopback(hostname) && isSecurePlainPeerTransport(remote, local, trustedTailnetAddresses);
      if (!expectedTransport) {
        fail(new Error('원본 PC의 실제 네트워크 경로가 loopback/Tailscale 보안 조건과 일치하지 않습니다.'));
        return;
      }
      settled = true;
      cleanup();
      resolveSocket(socket);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('connect', onConnect);
    socket.once('error', fail);
  });
}

export async function fetchVerifiedPlainPeer(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<globalThis.Response> {
  const socket = await connectVerifiedPlainPeer(url, signal);
  const agent = new OneShotHttpAgent(socket);
  return await new Promise<globalThis.Response>((resolveResponse, rejectResponse) => {
    const rejectAndDestroy = (error: unknown): void => {
      agent.destroy();
      socket.destroy();
      rejectResponse(error instanceof Error ? error : new Error(String(error)));
    };
    const request = httpRequest(url, { agent, headers, method: 'GET', signal }, (upstream) => {
      try {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(upstream.headers)) {
          for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
            responseHeaders.append(name, String(item));
          }
        }
        const status = upstream.statusCode ?? 502;
        const cleanup = (): void => agent.destroy();
        upstream.once('end', cleanup);
        upstream.once('close', cleanup);

        // Fetch responses for these statuses must never expose a body. Passing
        // the IncomingMessage stream to Response would synchronously throw for
        // a valid 204/205/304 response inside this event callback, escaping the
        // promise as an uncaught exception. Destroy a protocol-violating body
        // promptly rather than buffering it, while preserving status/headers.
        if (status === 204 || status === 205 || status === 304) {
          upstream.destroy();
          agent.destroy();
          socket.destroy();
          resolveResponse(new globalThis.Response(null, {
            status,
            statusText: upstream.statusMessage,
            headers: responseHeaders,
          }));
          return;
        }

        resolveResponse(new globalThis.Response(Readable.toWeb(upstream) as never, {
          status,
          statusText: upstream.statusMessage,
          headers: responseHeaders,
        }));
      } catch (error) {
        upstream.destroy();
        rejectAndDestroy(error);
      }
    });
    request.once('error', rejectAndDestroy);
    request.end();
  });
}

async function fetchPinnedPublicHttpsPeer(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<globalThis.Response> {
  const hostname = stripIpv6Brackets(url.hostname);
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => !isPublicPeerAddress(entry.address))) {
    throw new Error('원본 PC 도메인이 공인 HTTPS 주소로만 확인되지 않았습니다.');
  }
  // Prefer IPv4 when both families are public; many Windows hosts publish an
  // IPv6 route that is not actually usable outside the LAN.
  const selected = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
  return await new Promise<globalThis.Response>((resolveResponse, rejectResponse) => {
    let settled = false;
    let request: ReturnType<typeof httpsRequest>;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      request?.destroy();
      rejectResponse(error instanceof Error ? error : new Error(String(error)));
    };
    request = httpsRequest({
      protocol: 'https:',
      hostname: selected.address,
      port: Number(url.port || 443),
      servername: hostname,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: { ...headers, host: url.host, connection: 'close' },
      rejectUnauthorized: true,
      signal,
    }, (upstream) => {
      try {
        const status = upstream.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          upstream.destroy();
          fail(new Error('원본 PC HTTPS 리디렉션은 허용되지 않습니다.'));
          return;
        }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(upstream.headers)) {
          for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
            responseHeaders.append(name, String(item));
          }
        }
        if (status === 204 || status === 205 || status === 304) {
          settled = true;
          upstream.destroy();
          resolveResponse(new globalThis.Response(null, {
            status,
            statusText: upstream.statusMessage,
            headers: responseHeaders,
          }));
          return;
        }
        settled = true;
        resolveResponse(new globalThis.Response(Readable.toWeb(upstream) as never, {
          status,
          statusText: upstream.statusMessage,
          headers: responseHeaders,
        }));
      } catch (error) {
        upstream.destroy();
        fail(error);
      }
    });
    request.setTimeout(8_000, () => fail(new Error('원본 PC HTTPS 연결 시간이 초과되었습니다.')));
    request.once('error', fail);
    request.end();
  });
}

async function fetchPeer(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<globalThis.Response> {
  if (url.protocol === 'http:') return await fetchVerifiedPlainPeer(url, headers, signal);
  const hostname = stripIpv6Brackets(url.hostname);
  if (isIP(hostname) === 0 && !isKnownEncryptedPeerRelay(hostname)) {
    return await fetchPinnedPublicHttpsPeer(url, headers, signal);
  }
  return await fetch(url, { headers, redirect: 'error', signal });
}

async function cancelResponseBody(response: globalThis.Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* best-effort socket cleanup */ }
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
  remoteHandoff?: { pin: string; expiresAt: number };
  maskedSecret?: string;
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
  consumeRemoteBootstrapChallenge(challenge: string, assertion: string, origin: string): boolean;
  exchangePin(
    pin: string,
    deviceName?: string,
    permissionCap?: PermissionMode,
    clientKey?: string,
    remoteProof?: { assertion: string; origin: string },
  ): {
    ok: boolean;
    secret?: string;
    linkId?: string;
    cloudflareAccess?: { clientId: string; clientSecret: string };
    code?: 'PAIRING_CONSUMED' | 'PAIRING_EXPIRED';
    error?: string;
  };
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
  /** Host-only Cloudflare Access headers for an exact configured peer origin. */
  peerRequestHeaders(url: URL): Record<string, string>;
  chatOnce(text: string, auth: AuthContext): Promise<{ text: string }>;
  syncSnapshot(): { version: number; deviceName: string; exportedAt: number; conversations: unknown[]; routingPresets: unknown[] };
  mergeSyncSnapshot(snapshot: unknown): SyncMergeResult;
  workspacesList(): WorkspaceInfo[];
  fileAccess(secret: string, write: boolean): boolean;
  sharedFileAccess(secret: string, write: boolean): boolean;
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

function localOf(req: Request): string {
  return String(req.socket.localAddress ?? '').replace(/^::ffff:/, '');
}

export function createHttpApi(
  host: HttpApiHost,
  webDir: string | undefined,
  activeTransfers: Set<AbortController> | undefined,
  upgradeTickets: WsUpgradeTickets,
): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('env', 'production');
  // Authentication and transport policy are path-sensitive. Reject
  // case-variant route aliases instead of relying on Express's permissive
  // default, then keep the normalized middleware check below as defence in
  // depth.
  app.set('case sensitive routing', true);
  const sharedRoot = resolve(mrRobotHome(), 'shared');
  mkdirSync(sharedRoot, { recursive: true });
  const transferGrants = new Map<string, TransferGrant>();
  const transferGrantIssues = new Map<string, number[]>();
  const transferAdmission = new FileTransferAdmission();
  let sharedWriteReserved = 0;

  const reserveSharedWrite = (bytes: number): (() => void) => {
    assertDiskReserve(sharedRoot, bytes);
    const used = boundedDirectoryBytes(sharedRoot);
    if (used + sharedWriteReserved + bytes > SHARED_ROOT_QUOTA_BYTES) {
      throw new InsufficientStorageError('Mr.Robot 공유 폴더는 최대 10GB까지 사용할 수 있습니다. 기존 파일을 정리해 주세요.');
    }
    sharedWriteReserved += bytes;
    let reserved = true;
    return () => {
      if (!reserved) return;
      reserved = false;
      sharedWriteReserved = Math.max(0, sharedWriteReserved - bytes);
    };
  };

  const pruneTransferGrants = (): void => {
    const now = Date.now();
    for (const [token, grant] of transferGrants) {
      if (grant.expiresAt <= now) transferGrants.delete(token);
    }
    const cutoff = now - TRANSFER_GRANT_ISSUE_WINDOW_MS;
    for (const [principal, issues] of transferGrantIssues) {
      const retained = issues.filter((issuedAt) => issuedAt > cutoff);
      if (retained.length) transferGrantIssues.set(principal, retained);
      else transferGrantIssues.delete(principal);
    }
  };
  const issueTransferGrant = (grant: Omit<TransferGrant, 'expiresAt'>): { grant: string; expiresAt: number } => {
    pruneTransferGrants();
    const outstanding = [...transferGrants.values()].filter((item) => item.principal === grant.principal).length;
    if (outstanding >= MAX_TRANSFER_GRANTS_PER_PRINCIPAL) {
      throw new FileTransferAdmissionError('이 기기의 미사용 1회성 전송권이 너무 많습니다.');
    }
    const issues = transferGrantIssues.get(grant.principal) ?? [];
    if (issues.length >= MAX_TRANSFER_GRANT_ISSUES_PER_WINDOW) {
      throw new FileTransferAdmissionError('이 기기가 1회성 전송권을 너무 자주 요청했습니다.');
    }
    if (transferGrants.size >= MAX_TRANSFER_GRANTS) {
      // Never evict a grant owned by another principal. Global saturation is a
      // transient admission failure, not authority to break another transfer.
      throw new FileTransferAdmissionError('1회성 전송권 저장소가 찼습니다. 잠시 후 다시 시도하세요.');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + TRANSFER_GRANT_TTL_MS;
    transferGrants.set(token, { ...grant, expiresAt });
    issues.push(Date.now());
    transferGrantIssues.set(grant.principal, issues);
    return { grant: token, expiresAt };
  };
  const consumeTransferGrant = (req: Request, kind: TransferGrant['kind'], path?: string): TransferGrant => {
    const token = String(req.header('x-mr-robot-transfer') ?? '');
    if (token.length < 32 || token.length > 256) throw new Error('1회성 전송 권한이 필요합니다.');
    const grant = transferGrants.get(token);
    // Delete before validation so concurrent requests and wrong-path probes
    // cannot reuse a capability that was already presented once.
    transferGrants.delete(token);
    if (!grant || grant.expiresAt <= Date.now() || grant.kind !== kind || (kind === 'file' && grant.path !== path)) {
      throw new Error('1회성 전송 권한이 만료되었거나 요청과 일치하지 않습니다.');
    }
    return grant;
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
    if (isLoopback(remote) || isEncryptedTailnetTransport(remote, localOf(req))) { next(); return; }
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
    if (detail.type === 'entity.parse.failed' || (detail.status === 400 && error instanceof SyntaxError)) {
      res.status(400).json({ error: 'JSON 요청 형식이 올바르지 않습니다.' });
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
    const token = String(req.header('x-mr-robot-token') ?? '');
    const auth = host.authenticate(token);
    if (auth && host.isSyncSecret(token)) { res.locals.mrRobotAuth = auth; next(); return; }
    res.status(403).json({ error: '이 기기의 작업 동기화 권한이 꺼져 있거나 읽기 전용 정책으로 제한되어 있습니다. PC의 연결 기기 설정에서 작업 동기화를 허용하세요.' });
  };
  const requestAuth = (res: Response): AuthContext => res.locals.mrRobotAuth as AuthContext;
  const pairAttempts = new Map<string, { failures: number; windowStartedAt: number; blockedUntil: number; lastSeen: number }>();
  const cloudflarePairClient = (req: Request): string | undefined => {
    const direct = remoteOf(req);
    const forwarded = String(req.header('cf-connecting-ip') ?? '').trim();
    const ray = String(req.header('cf-ray') ?? '');
    if (isLoopback(direct) && isIP(forwarded) > 0 && /^[a-f0-9-]{8,}(?:-[a-z]{3})?$/i.test(ray)) return forwarded;
    return undefined;
  };
  const cloudflareRequestOrigin = (req: Request): string | undefined => {
    if (!cloudflarePairClient(req)) return undefined;
    const rawHost = String(req.header('host') ?? '').trim().toLowerCase();
    if (!rawHost || /[\s/@\\]/.test(rawHost)) return undefined;
    try {
      const parsed = new URL(`https://${rawHost}`);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password
        || (parsed.port && parsed.port !== '443') || parsed.pathname !== '/'
        || parsed.search || parsed.hash) return undefined;
      return parsed.origin;
    } catch {
      return undefined;
    }
  };
  const preventCredentialCaching = (res: Response): void => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  };
  const pairClientKey = (req: Request): string => {
    const forwarded = cloudflarePairClient(req);
    if (forwarded) return `cloudflare:${forwarded}`;
    return `direct:${remoteOf(req) || 'unknown'}`;
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

  // Public WebSockets are admitted only after this authenticated HTTPS step.
  // The returned capability is memory-only, source/host/principal-bound,
  // expires quickly and is deleted before its first upgrade completes.
  app.post('/api/ws-ticket', requireAuth, (req, res) => {
    try {
      const binding = webSocketTicketBinding({
        directRemote: remoteOf(req),
        directLocal: localOf(req),
        hostHeader: req.header('host'),
        cloudflareConnectingIp: req.header('cf-connecting-ip'),
        cloudflareRay: req.header('cf-ray'),
      });
      res.json(upgradeTickets.issue(binding.source, binding.audience, authPrincipal(requestAuth(res))));
    } catch (error) {
      if (!(error instanceof WsUpgradeTicketAdmissionError)) throw error;
      res.setHeader('Retry-After', '2');
      res.status(error.status).json({ error: error.message });
    }
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
    preventCredentialCaching(res);
    // Cloudflare deployments commonly keep a strict allowlist for the
    // established pairing endpoint. Reuse that already-audited POST surface
    // for the exact bootstrap schema instead of requiring a second public
    // route or weakening an existing WAF rule. A pre-registered, one-use
    // challenge lets the trusted desktop process obtain the short application
    // assertion without exposing it to page JavaScript. The desktop reads the
    // HttpOnly response cookie directly, then proves it again with Cloudflare's
    // documented cf-access-token header.
    const bootstrapChallenge = cloudflareAccessBootstrapChallenge(req.body);
    if (bootstrapChallenge) {
      const assertion = String(req.header('cf-access-jwt-assertion') ?? '').trim();
      const requestOrigin = cloudflareRequestOrigin(req);
      if (!requestOrigin
        || assertion.length < 64 || assertion.length > 4_096
        || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(assertion)
        || !host.consumeRemoteBootstrapChallenge(bootstrapChallenge, assertion, requestOrigin)) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.setHeader('Set-Cookie', `${CLOUDFLARE_ACCESS_BOOTSTRAP_COOKIE}=${assertion}; Max-Age=60; Path=/; Secure; HttpOnly; SameSite=Strict`);
      res.json({
        app: 'mr-robot',
        probe: CLOUDFLARE_ACCESS_BOOTSTRAP_PROBE,
        challenge: bootstrapChallenge,
      });
      return;
    }
    // Cloudflare Access verification uses one fixed, intentionally invalid
    // schema. Reject it before deriving a client key, touching rate-limit
    // state, reading a PIN, or calling exchangePin. This makes repeated
    // fail-closed checks safe and incapable of registering a device.
    if (isCloudflareAccessPairProbe(req.body)) {
      res.status(400).json({
        error: CLOUDFLARE_ACCESS_PAIR_PROBE_ERROR,
        app: 'mr-robot',
      });
      return;
    }
    const key = pairClientKey(req);
    const retryAfterMs = pairRetryAfter(key);
    if (retryAfterMs > 0) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      res.status(429).json({ error: 'too many pairing attempts' });
      return;
    }
    const pin = String(req.body?.pin ?? '').trim();
    // The ordinary six-digit PIN is designed for supervised LAN/Tailnet
    // enrollment.  A public Cloudflare hostname is continuously reachable,
    // so exposing that small search space would make distributed guessing
    // possible even with per-IP throttling.  Remote enrollment must use the
    // separate 12-digit, memory-only, single-use handoff code instead.
    if (cloudflarePairClient(req) && !/^\d{12}$/.test(pin)) {
      recordPairFailure(key);
      res.status(400).json({ error: '원격 연결에는 PC에서 만든 12자리 1회용 외출 코드가 필요합니다.' });
      return;
    }
    const name = String(req.body?.deviceName ?? '연결된 기기').trim().slice(0, 120) || '연결된 기기';
    const rawPermission = String(req.body?.permissionCap ?? 'ask');
    const requested: PermissionMode = ['read-only', 'ask', 'workspace', 'full'].includes(rawPermission)
      ? rawPermission as PermissionMode
      : 'ask';
    const assertion = String(req.header('cf-access-jwt-assertion') ?? '').trim();
    const proofOrigin = cloudflareRequestOrigin(req);
    const remoteProof = proofOrigin && assertion
      ? { assertion, origin: proofOrigin }
      : undefined;
    const result = host.exchangePin(pin, name, requested, key, remoteProof);
    if (!result.ok) {
      recordPairFailure(key);
      const status = result.code === 'PAIRING_EXPIRED' ? 410 : result.code === 'PAIRING_CONSUMED' ? 409 : 400;
      res.status(status).json({ error: result.error, ...(result.code ? { code: result.code } : {}) });
      return;
    }
    pairAttempts.delete(key);
    res.json({
      secret: result.secret,
      linkId: result.linkId,
      ...(result.cloudflareAccess ? { cloudflareAccess: result.cloudflareAccess } : {}),
    });
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
    const auth = host.authenticate(token);
    if (auth && host.fileAccess(token, write)) { res.locals.mrRobotAuth = auth; next(); return; }
    res.status(403).json({ error: write ? '이 기기에는 작업 폴더 쓰기 권한이 없습니다.' : '이 기기에는 작업 폴더 읽기 권한이 없습니다.' });
  };
  const requireSharedFileAccess = (write: boolean) => (req: Request, res: Response, next: NextFunction): void => {
    const token = String(req.header('x-mr-robot-token') ?? '');
    const auth = host.authenticate(token);
    if (auth && host.sharedFileAccess(token, write)) { res.locals.mrRobotAuth = auth; next(); return; }
    res.status(403).json({ error: write ? '이 기기에는 기기 간 공유 폴더 쓰기 권한이 없습니다.' : '이 기기에는 기기 간 공유 폴더 읽기 권한이 없습니다.' });
  };
  const sendRouteError = (res: Response, error: unknown, fallbackStatus = 400): void => {
    if (res.destroyed || res.headersSent) return;
    const status = error instanceof PayloadTooLargeError ? 413
      : error instanceof InsufficientStorageError ? 507
        : error instanceof FileTransferAdmissionError ? error.status
          : fallbackStatus;
    if (error instanceof FileTransferAdmissionError) res.setHeader('Retry-After', '30');
    res.status(status)
      .json({ error: error instanceof Error ? error.message : String(error) });
  };
  const transferPrincipal = (res: Response): string => authPrincipal(requestAuth(res));
  const incomingFileLimit = (req: Request): number => cloudflarePairClient(req) ? MAX_PUBLIC_FILE_BYTES : MAX_FILE_BYTES;
  const fileLimitMessage = (limit: number): string => limit === MAX_PUBLIC_FILE_BYTES
    ? '공개 원격 업로드는 파일 하나당 최대 96MB입니다. 더 큰 파일은 로컬 또는 검증된 PC 간 전송을 사용하세요.'
    : '파일은 최대 2GB까지 전송할 수 있습니다.';
  const outboundPeerHeaders = (url: URL, headers: Record<string, string>): Record<string, string> => {
    const access = host.peerRequestHeaders(url);
    const clientId = access['CF-Access-Client-Id'];
    const clientSecret = access['CF-Access-Client-Secret'];
    return {
      ...(clientId && clientSecret ? {
        'CF-Access-Client-Id': clientId,
        'CF-Access-Client-Secret': clientSecret,
      } : {}),
      ...headers,
    };
  };
  const assertPeer = async (base: URL): Promise<void> => {
    const pingUrl = new URL('/api/ping', base);
    const response = await fetchPeer(pingUrl, outboundPeerHeaders(pingUrl, { accept: 'application/json' }), AbortSignal.timeout(8_000));
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error(`원본 주소에서 Mr.Robot Agent를 확인할 수 없습니다. (HTTP ${response.status})`);
    }
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
    let transfer: ReturnType<typeof transferAbort> | undefined;
    let lease: FileTransferLease | undefined;
    try {
      const { target } = workspacePath(req.query.workspaceId, req.query.path); const stat = statSync(target);
      if (!stat.isFile()) throw new Error('다운로드할 파일이 아닙니다.');
      if (stat.size > MAX_FILE_BYTES) throw new PayloadTooLargeError('다운로드는 파일 하나당 최대 2GB입니다.');
      lease = transferAdmission.acquire(transferPrincipal(res), stat.size);
      transfer = transferAbort(req, res, activeTransfers);
      const name = basename(target).replace(/[\r\n"]/g, '_');
      res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      void pipeline(createReadStream(target), res, { signal: transfer.signal })
        .catch(() => { if (!res.destroyed) res.destroy(); })
        .finally(() => { transfer?.cleanup(); lease?.settle(stat.size); });
    } catch (err) {
      transfer?.cleanup(); lease?.settle(0); sendRouteError(res, err, 404);
    }
  });
  app.put('/api/workspaces/upload', requireWorkspaceFileAccess(true), async (req, res) => {
    let temp = '';
    let transfer: ReturnType<typeof transferAbort> | undefined;
    let lease: FileTransferLease | undefined;
    let meter: MeteredByteLimitStream | undefined;
    try {
      const limit = incomingFileLimit(req);
      const limitMessage = fileLimitMessage(limit);
      assertAdvertisedLength(req.header('content-length'), limit, limitMessage);
      lease = transferAdmission.acquire(transferPrincipal(res), limit);
      transfer = transferAbort(req, res, activeTransfers);
      const { workspace, root, target: requestedTarget } = workspacePath(req.query.workspaceId, req.query.path);
      assertDiskReserve(root, limit);
      const prepared = prepareFileDestination(root, requestedTarget, 'upload');
      const target = prepared.target; temp = prepared.temp;
      meter = createByteLimitStream(limit, limitMessage, () => assertDiskReserve(dirname(temp), 0));
      await pipeline(req, meter, createWriteStream(temp, { flags: 'wx' }), { signal: transfer.signal });
      revalidateDestination(root, target, temp); renameSync(temp, target);
      res.json({ ok: true, name: basename(target), path: relative(workspace.path, target).replaceAll('\\', '/'), size: statSync(target).size });
    } catch (err) { if (temp && existsSync(temp)) unlinkSync(temp); sendRouteError(res, err); }
    finally { transfer?.cleanup(); lease?.settle(meter?.transferredBytes ?? 0); }
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
        res.json(issueTransferGrant({ kind, path, principal: authPrincipal(requestAuth(res)) }));
        return;
      }
      if (kind === 'sync') {
        if (!host.isSyncSecret(token)) throw new Error('이 기기에는 작업 동기화 전송권이 없습니다. PC의 연결 기기 설정을 확인하세요.');
        res.json(issueTransferGrant({ kind, principal: authPrincipal(requestAuth(res)) }));
        return;
      }
      throw new Error('지원되지 않는 전송 권한 종류입니다.');
    } catch (err) {
      sendRouteError(res, err, 403);
    }
  });

  app.get('/api/files/download', (req, res) => {
    let transfer: ReturnType<typeof transferAbort> | undefined;
    let lease: FileTransferLease | undefined;
    try {
      const file = sharedPath(req.query.path);
      const stat = statSync(file);
      if (!stat.isFile()) throw new Error('다운로드할 파일이 아닙니다.');
      if (stat.size > MAX_FILE_BYTES) throw new PayloadTooLargeError('다운로드는 파일 하나당 최대 2GB입니다.');
      const path = relative(sharedRoot, file).replaceAll('\\', '/');
      const token = String(req.header('x-mr-robot-token') ?? '');
      const auth = host.authenticate(token);
      const principal = auth && host.sharedFileAccess(token, false)
        ? authPrincipal(auth)
        : consumeTransferGrant(req, 'file', path).principal;
      lease = transferAdmission.acquire(principal, stat.size);
      transfer = transferAbort(req, res, activeTransfers);
      const name = basename(file).replace(/[\r\n"]/g, '_');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.setHeader('X-Mr-Robot-File-Name', encodeURIComponent(name));
      void pipeline(createReadStream(file), res, { signal: transfer.signal })
        .catch(() => { if (!res.destroyed) res.destroy(); })
        .finally(() => { transfer?.cleanup(); lease?.settle(stat.size); });
    } catch (err) {
      transfer?.cleanup();
      lease?.settle(0);
      sendRouteError(res, err, 403);
    }
  });

  app.put('/api/files/upload', requireSharedFileAccess(true), async (req, res) => {
    let temp = '';
    let transfer: ReturnType<typeof transferAbort> | undefined;
    let lease: FileTransferLease | undefined;
    let releaseShared: (() => void) | undefined;
    let meter: MeteredByteLimitStream | undefined;
    try {
      const limit = incomingFileLimit(req);
      const limitMessage = fileLimitMessage(limit);
      assertAdvertisedLength(req.header('content-length'), limit, limitMessage);
      lease = transferAdmission.acquire(transferPrincipal(res), limit);
      releaseShared = reserveSharedWrite(limit);
      transfer = transferAbort(req, res, activeTransfers);
      const prepared = prepareFileDestination(sharedRoot, sharedPath(req.query.path), 'upload');
      const file = prepared.target; temp = prepared.temp;
      meter = createByteLimitStream(limit, limitMessage, () => assertDiskReserve(dirname(temp), 0));
      await pipeline(req, meter, createWriteStream(temp, { flags: 'wx' }), { signal: transfer.signal });
      revalidateDestination(sharedRoot, file, temp);
      renameSync(temp, file);
      const stat = statSync(file);
      res.json({ ok: true, name: basename(file), path: relative(sharedRoot, file).replaceAll('\\', '/'), size: stat.size });
    } catch (err) {
      if (temp && existsSync(temp)) unlinkSync(temp);
      sendRouteError(res, err);
    } finally {
      transfer?.cleanup();
      releaseShared?.();
      lease?.settle(meter?.transferredBytes ?? 0);
    }
  });

  app.post('/api/files/pull', requireSharedFileAccess(true), async (req, res) => {
    let temp = '';
    let transfer: ReturnType<typeof transferAbort> | undefined;
    let lease: FileTransferLease | undefined;
    let releaseShared: (() => void) | undefined;
    let meter: MeteredByteLimitStream | undefined;
    try {
      const limit = incomingFileLimit(req);
      const limitMessage = fileLimitMessage(limit);
      lease = transferAdmission.acquire(transferPrincipal(res), limit);
      releaseShared = reserveSharedWrite(limit);
      transfer = transferAbort(req, res, activeTransfers);
      const sourceBase = normalizePeerBase(req.body?.sourceBase);
      const grant = sourceGrant(req.body?.sourceGrant);
      await assertPeer(sourceBase);
      const sourcePath = String(req.body?.sourcePath ?? '');
      const prepared = prepareFileDestination(sharedRoot, sharedPath(req.body?.targetPath || basename(sourcePath)), 'pull');
      const target = prepared.target; temp = prepared.temp;
      const sourceUrl = new URL('/api/files/download', sourceBase);
      sourceUrl.searchParams.set('path', sourcePath);
      const upstream = await fetchPeer(
        sourceUrl,
        outboundPeerHeaders(sourceUrl, { 'x-mr-robot-transfer': grant }),
        AbortSignal.any([transfer.signal, AbortSignal.timeout(30 * 60_000)]),
      );
      if (!upstream.ok || !upstream.body) {
        await cancelResponseBody(upstream);
        throw new Error(`원본 PC 파일을 열 수 없습니다. (HTTP ${upstream.status})`);
      }
      assertAdvertisedLength(upstream.headers.get('content-length'), limit, limitMessage);
      meter = createByteLimitStream(limit, limitMessage, () => assertDiskReserve(dirname(temp), 0));
      await pipeline(
        Readable.fromWeb(upstream.body as never),
        meter,
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
    } finally {
      transfer?.cleanup();
      releaseShared?.();
      lease?.settle(meter?.transferredBytes ?? 0);
    }
  });

  app.get('/api/sync/snapshot', (req, res) => {
    let lease: FileTransferLease | undefined;
    try {
      const token = String(req.header('x-mr-robot-token') ?? '');
      const auth = host.authenticate(token);
      const principal = auth && host.isSyncSecret(token)
        ? authPrincipal(auth)
        : consumeTransferGrant(req, 'sync').principal;
      const serialized = JSON.stringify(host.syncSnapshot());
      const bytes = Buffer.byteLength(serialized, 'utf8');
      if (bytes > MAX_SYNC_BYTES) throw new PayloadTooLargeError('동기화 데이터가 허용 크기를 초과합니다.');
      lease = transferAdmission.acquire(principal, bytes);
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        lease?.settle(bytes);
      };
      res.once('finish', settle);
      res.once('close', settle);
      res.type('application/json').send(serialized);
    } catch (err) {
      lease?.settle(0);
      sendRouteError(res, err, 403);
    }
  });

  // The target token must carry the narrow work-sync capability. Conversation
  // merge preserves divergent branches as conflict copies; access/workspace
  // decisions remain destination-local and the read-only ceilings still win.
  app.post('/api/sync/pull', requireSync, async (req, res) => {
    let transfer: ReturnType<typeof transferAbort> | undefined;
    let lease: FileTransferLease | undefined;
    let transferredBytes = 0;
    try {
      lease = transferAdmission.acquire(transferPrincipal(res), MAX_SYNC_BYTES);
      transfer = transferAbort(req, res, activeTransfers);
      const sourceBase = normalizePeerBase(req.body?.sourceBase);
      const grant = sourceGrant(req.body?.sourceGrant);
      await assertPeer(sourceBase);
      const sourceUrl = new URL('/api/sync/snapshot', sourceBase);
      const upstream = await fetchPeer(
        sourceUrl,
        outboundPeerHeaders(sourceUrl, { 'x-mr-robot-transfer': grant }),
        AbortSignal.any([transfer.signal, AbortSignal.timeout(2 * 60_000)]),
      );
      if (!upstream.ok) {
        await cancelResponseBody(upstream);
        throw new Error(`원본 PC 동기화 데이터를 읽을 수 없습니다. (HTTP ${upstream.status})`);
      }
      const snapshot = await readJsonResponseLimited(upstream, MAX_SYNC_BYTES);
      transferredBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
      const result = host.mergeSyncSnapshot(snapshot);
      res.json({ ok: true, ...result, transport: 'direct-device-sync', aiTokens: 0 });
    } catch (err) {
      sendRouteError(res, err);
    } finally { transfer?.cleanup(); lease?.settle(transferredBytes); }
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

  // Never let Express's development error page disclose stack traces,
  // absolute install paths, dependency versions, or request internals through
  // the public tunnel. Route-specific safe errors above remain unchanged.
  app.use((_error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      if (!res.destroyed) res.destroy();
      return;
    }
    const requestId = randomUUID();
    res.status(500).json({ error: '요청을 처리하지 못했습니다.', requestId, path: req.path.startsWith('/api/') ? undefined : 'redacted' });
  });

  return app;
}
