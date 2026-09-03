import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { domainToASCII } from 'node:url';

const PASSWORD_MIN_BYTES = 12;
const PASSWORD_MAX_BYTES = 256;
const SCRYPT_KEY_BYTES = 32;
const SCRYPT_COST = 32_768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const VERIFIER_PREFIX = 'scrypt-v1';

export const TOOL_PORTAL_SESSION_TTL_MS = 30 * 60_000;
export const TOOL_PORTAL_MAX_SESSIONS = 64;
export const TOOL_PORTAL_MAX_SESSIONS_PER_CLIENT = 8;
export const TOOL_PORTAL_FAILURE_WINDOW_MS = 15 * 60_000;
export const TOOL_PORTAL_MAX_FAILURES_PER_CLIENT = 5;
export const TOOL_PORTAL_MAX_GLOBAL_FAILURES = 50;
export const TOOL_PORTAL_ARTIFACT_TTL_MS = 2 * 60_000;
export const TOOL_PORTAL_MAX_ARTIFACTS = 32;
export const TOOL_PORTAL_MAX_ARTIFACTS_PER_SESSION = 4;
export const TOOL_PORTAL_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const TOOL_PORTAL_REQUEST_PROOF_HEADER = 'x-mr-robot-tool-portal-request-proof';

export type ToolPortalToolId = 'resource-archiver' | 'sslscan' | 'runtime-hook';
export type ToolPortalAction = 'validate' | 'preview' | 'archive' | 'status' | 'scan' | 'analyze' | 'observe' | 'events' | 'mutation.set' | 'stop';

export interface ToolPortalConfigData {
  enabled: boolean;
  /** Salted scrypt verifier. This value is never returned through an RPC or HTTP response. */
  passwordVerifier?: string;
  portalWorkspaceId?: string;
  /** Exact normalized hosts that the three portal tools may actively contact. */
  allowedTargetHosts: string[];
  hookMutationEnabled: boolean;
  /** Invalidates every memory-only session whenever native configuration changes. */
  revision: number;
  updatedAt?: number;
}

export interface ToolPortalConfigSnapshot {
  enabled: boolean;
  portalWorkspaceId?: string;
  workspaceConfigured: boolean;
  allowedTargetHosts: string[];
  hookMutationEnabled: boolean;
  revision: number;
  updatedAt?: number;
}

export interface ToolPortalSession {
  /** Hash of the cookie bearer value, suitable for binding artifact capabilities. */
  key: string;
  expiresAt: number;
}

export class ToolPortalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ToolPortalError';
  }
}

export interface ToolPortalResourceLimits {
  maxResources: number;
  maxNetworkRequests: number;
  maxResourceBytes: number;
  maxTotalBytes: number;
  maxDepth: number;
  concurrency: number;
  timeoutMs: number;
  retries: number;
  maxRedirects: number;
  minRequestIntervalMs: number;
  overallTimeoutMs: number;
}

function boundedPortalInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum) {
    throw new ToolPortalError(`${label} 값이 올바르지 않습니다.`, 400, 'INVALID_REQUEST');
  }
  return Math.min(Number(value), maximum);
}

/**
 * The public portal deliberately exposes a much smaller resource envelope than
 * the native workbench. Values above the envelope are clamped server-side so a
 * hand-written HTTP request cannot turn the portal into a high-traffic crawler.
 */
export function normalizeToolPortalResourceLimits(value: unknown, fetchMissing: boolean): ToolPortalResourceLimits {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new ToolPortalError('리소스 한도 형식이 올바르지 않습니다.', 400, 'INVALID_REQUEST');
  }
  const source = (value ?? {}) as Record<string, unknown>;
  return {
    maxResources: boundedPortalInteger(source.maxResources, 100, 1, 200, 'maxResources'),
    maxNetworkRequests: fetchMissing
      ? boundedPortalInteger(source.maxNetworkRequests, 12, 0, 20, 'maxNetworkRequests')
      : 0,
    maxResourceBytes: boundedPortalInteger(source.maxResourceBytes, 2 * 1024 * 1024, 1_024, 8 * 1024 * 1024, 'maxResourceBytes'),
    maxTotalBytes: boundedPortalInteger(source.maxTotalBytes, 8 * 1024 * 1024, 1_024, 16 * 1024 * 1024, 'maxTotalBytes'),
    maxDepth: boundedPortalInteger(source.maxDepth, 1, 0, 2, 'maxDepth'),
    concurrency: boundedPortalInteger(source.concurrency, 1, 1, 2, 'concurrency'),
    timeoutMs: boundedPortalInteger(source.timeoutMs, 5_000, 1_000, 15_000, 'timeoutMs'),
    retries: boundedPortalInteger(source.retries, 0, 0, 1, 'retries'),
    maxRedirects: boundedPortalInteger(source.maxRedirects, fetchMissing ? 2 : 0, 0, 2, 'maxRedirects'),
    minRequestIntervalMs: Math.max(300, boundedPortalInteger(source.minRequestIntervalMs, 300, 100, 2_000, 'minRequestIntervalMs')),
    overallTimeoutMs: boundedPortalInteger(source.overallTimeoutMs, 30_000, 1_000, 60_000, 'overallTimeoutMs'),
  };
}

/** Preview and validation are offline-only even if a hand-written client asks otherwise. */
export function toolPortalResourceFetchMissing(action: ToolPortalAction, value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new ToolPortalError('직접 수집 opt-in 값이 올바르지 않습니다.', 400, 'INVALID_REQUEST');
  }
  return action === 'archive' && value === true;
}

export function normalizeToolPortalSslScanMode(value: unknown): 'quick' | 'standard' {
  const mode = value === undefined ? 'quick' : String(value);
  if (mode !== 'quick' && mode !== 'standard') {
    throw new ToolPortalError('포털 TLS 점검 강도는 quick 또는 standard만 허용됩니다.', 400, 'INVALID_REQUEST');
  }
  return mode;
}

export function normalizeToolPortalMaxCipherTests(mode: 'quick' | 'standard', value: unknown): number {
  return mode === 'quick' ? 0 : boundedPortalInteger(value, 12, 0, 12, 'maxCipherTests');
}

function passwordBytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function assertPasswordForStorage(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new Error('포털 비밀번호를 입력하세요.');
  const bytes = passwordBytes(value);
  if (bytes < PASSWORD_MIN_BYTES || bytes > PASSWORD_MAX_BYTES || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`포털 비밀번호는 제어문자 없이 UTF-8 ${PASSWORD_MIN_BYTES}~${PASSWORD_MAX_BYTES}바이트여야 합니다.`);
  }
}

/** Derive a non-reversible password verifier suitable for persistence. */
function deriveScrypt(value: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    scrypt(value, salt, length, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
      maxmem: SCRYPT_MAX_MEMORY,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolvePromise(Buffer.from(derivedKey));
    });
  });
}

export async function createToolPortalPasswordVerifier(value: unknown): Promise<string> {
  assertPasswordForStorage(value);
  const salt = randomBytes(16);
  const digest = await deriveScrypt(value, salt, SCRYPT_KEY_BYTES);
  return [
    VERIFIER_PREFIX,
    String(SCRYPT_COST),
    String(SCRYPT_BLOCK_SIZE),
    String(SCRYPT_PARALLELIZATION),
    salt.toString('base64url'),
    digest.toString('base64url'),
  ].join('$');
}

export function isToolPortalPasswordVerifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 256) return false;
  const parts = value.split('$');
  if (parts.length !== 6 || parts[0] !== VERIFIER_PREFIX
    || parts[1] !== String(SCRYPT_COST) || parts[2] !== String(SCRYPT_BLOCK_SIZE)
    || parts[3] !== String(SCRYPT_PARALLELIZATION)) return false;
  try {
    return Buffer.from(parts[4], 'base64url').length === 16
      && Buffer.from(parts[5], 'base64url').length === SCRYPT_KEY_BYTES;
  } catch {
    return false;
  }
}

/** Verification fails closed for malformed records and oversized input. */
export async function verifyToolPortalPassword(value: unknown, verifier: unknown): Promise<boolean> {
  if (typeof value !== 'string' || passwordBytes(value) > PASSWORD_MAX_BYTES || !isToolPortalPasswordVerifier(verifier)) return false;
  try {
    const [, , , , encodedSalt, encodedDigest] = verifier.split('$');
    const salt = Buffer.from(encodedSalt, 'base64url');
    const expected = Buffer.from(encodedDigest, 'base64url');
    const actual = await deriveScrypt(value, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Normalize a single authorization target, not a URL or wildcard. DNS names
 * are IDNA-canonicalized and IP literals use URL's canonical representation.
 */
export function normalizeToolPortalTargetHost(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().replace(/\.$/, '') : '';
  if (!raw || raw.length > 512 || raw.includes('*') || /[\s\u0000-\u001f\u007f\/@?#]/.test(raw)) {
    throw new Error('검사 대상은 와일드카드나 URL이 아닌 정확한 호스트 하나여야 합니다.');
  }
  let urlHost = '';
  try { urlHost = new URL(`https://${raw}/`).hostname.replace(/^\[/, '').replace(/\]$/, ''); }
  catch { throw new Error('검사 대상 호스트가 올바르지 않습니다.'); }
  if (raw.includes(':') || /^[0-9.]+$/.test(raw) || isIP(urlHost) !== 0) {
    throw new Error('포털 검사 대상에는 IP 주소를 등록할 수 없습니다. 정확한 DNS 호스트를 사용하세요.');
  }
  const ascii = domainToASCII(raw).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.includes('.')) throw new Error('검사 대상은 정확한 공개 DNS 호스트여야 합니다.');
  if (ascii.split('.').some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error('검사 대상 호스트가 올바르지 않습니다.');
  }
  return ascii;
}

export function normalizeToolPortalTargetHosts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('검사 대상 호스트 목록은 최대 64개여야 합니다.');
  return [...new Set(value.map(normalizeToolPortalTargetHost))].sort();
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

interface SessionRecord extends ToolPortalSession {
  clientKey: string;
  requestProofHash: string;
  revision: number;
  createdAt: number;
}

interface FailureRecord {
  attempts: Array<{ id: number; at: number }>;
  lastSeen: number;
}

export interface ToolPortalSessionManagerOptions {
  now?: () => number;
  sessionTtlMs?: number;
  maxSessions?: number;
  maxSessionsPerClient?: number;
  failureWindowMs?: number;
  maxFailuresPerClient?: number;
  maxGlobalFailures?: number;
  maxFailureClients?: number;
  maxConcurrentVerifications?: number;
}

/** In-memory, fixed-expiry sessions and bounded distributed/login throttles. */
export class ToolPortalSessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly clientFailures = new Map<string, FailureRecord>();
  private globalFailures: Array<{ id: number; at: number }> = [];
  private readonly now: () => number;
  private readonly sessionTtlMs: number;
  private readonly maxSessions: number;
  private readonly maxSessionsPerClient: number;
  private readonly failureWindowMs: number;
  private readonly maxFailuresPerClient: number;
  private readonly maxGlobalFailures: number;
  private readonly maxFailureClients: number;

  constructor(
    private readonly config: () => Pick<ToolPortalConfigData, 'enabled' | 'revision'>,
    private readonly verifyPassword: (password: unknown) => boolean | Promise<boolean>,
    options: ToolPortalSessionManagerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = Math.max(1_000, Math.floor(options.sessionTtlMs ?? TOOL_PORTAL_SESSION_TTL_MS));
    this.maxSessions = Math.max(1, Math.floor(options.maxSessions ?? TOOL_PORTAL_MAX_SESSIONS));
    this.maxSessionsPerClient = Math.max(1, Math.floor(options.maxSessionsPerClient ?? TOOL_PORTAL_MAX_SESSIONS_PER_CLIENT));
    this.failureWindowMs = Math.max(1_000, Math.floor(options.failureWindowMs ?? TOOL_PORTAL_FAILURE_WINDOW_MS));
    this.maxFailuresPerClient = Math.max(1, Math.floor(options.maxFailuresPerClient ?? TOOL_PORTAL_MAX_FAILURES_PER_CLIENT));
    this.maxGlobalFailures = Math.max(1, Math.floor(options.maxGlobalFailures ?? TOOL_PORTAL_MAX_GLOBAL_FAILURES));
    this.maxFailureClients = Math.max(1, Math.floor(options.maxFailureClients ?? 1_024));
    this.maxConcurrentVerifications = Math.max(1, Math.min(4, Math.floor(options.maxConcurrentVerifications ?? 2)));
  }

  private readonly maxConcurrentVerifications: number;
  private activeVerifications = 0;
  private failureSequence = 0;

  async login(password: unknown, clientKey: string): Promise<{ token: string; requestProof: string; session: ToolPortalSession }> {
    const key = this.normalizeClientKey(clientKey);
    const now = this.now();
    this.prune(now);
    const config = this.config();
    if (!config.enabled) throw new ToolPortalError('도구 포털이 비활성화되어 있습니다.', 403, 'PORTAL_DISABLED');
    const retryAfter = this.retryAfter(key, now);
    if (retryAfter > 0) {
      throw new ToolPortalError('로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.', 429, 'LOGIN_RATE_LIMITED', Math.ceil(retryAfter / 1_000));
    }
    if (this.activeVerifications >= this.maxConcurrentVerifications) {
      throw new ToolPortalError('로그인 검증이 진행 중입니다. 잠시 후 다시 시도하세요.', 429, 'LOGIN_VERIFICATION_BUSY', 2);
    }
    // Reserve a failed-attempt slot before entering libuv. A burst therefore
    // cannot enqueue unbounded KDF jobs before the first wrong result returns.
    const reservation = this.reserveFailure(key, now);
    this.activeVerifications += 1;
    let verified = false;
    try {
      verified = await this.verifyPassword(password);
    } catch {
      verified = false;
    } finally {
      this.activeVerifications = Math.max(0, this.activeVerifications - 1);
    }
    if (!verified) {
      throw new ToolPortalError('비밀번호가 올바르지 않습니다.', 401, 'INVALID_CREDENTIALS');
    }
    this.releaseReservation(key, reservation);
    const latest = this.config();
    if (!latest.enabled || latest.revision !== config.revision) {
      throw new ToolPortalError('포털 설정이 변경되었습니다. 다시 시도하세요.', 409, 'PORTAL_CONFIGURATION_CHANGED');
    }
    this.clientFailures.delete(key);
    if (this.sessions.size >= this.maxSessions) {
      throw new ToolPortalError('활성 포털 세션 한도에 도달했습니다.', 429, 'SESSION_LIMIT_REACHED', 60);
    }
    const clientSessions = [...this.sessions.values()].filter((session) => session.clientKey === key).length;
    if (clientSessions >= this.maxSessionsPerClient) {
      throw new ToolPortalError('이 클라이언트의 활성 포털 세션 한도에 도달했습니다.', 429, 'SESSION_LIMIT_REACHED', 60);
    }
    const token = randomBytes(32).toString('base64url');
    const requestProof = randomBytes(32).toString('base64url');
    const session: SessionRecord = {
      key: tokenHash(token),
      clientKey: key,
      requestProofHash: tokenHash(requestProof),
      revision: latest.revision,
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
    };
    this.sessions.set(session.key, session);
    return { token, requestProof, session: { key: session.key, expiresAt: session.expiresAt } };
  }

  authenticate(token: unknown, requestProof: unknown): ToolPortalSession | undefined {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)
      || typeof requestProof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(requestProof)) return undefined;
    const now = this.now();
    this.prune(now);
    const record = this.sessions.get(tokenHash(token));
    const config = this.config();
    if (!record || !config.enabled || record.revision !== config.revision || record.expiresAt <= now) {
      if (record) this.sessions.delete(record.key);
      return undefined;
    }
    const candidateProofHash = Buffer.from(tokenHash(requestProof), 'hex');
    const expectedProofHash = Buffer.from(record.requestProofHash, 'hex');
    if (candidateProofHash.length !== expectedProofHash.length
      || !timingSafeEqual(candidateProofHash, expectedProofHash)) return undefined;
    return { key: record.key, expiresAt: record.expiresAt };
  }

  logout(token: unknown, requestProof: unknown): boolean {
    const session = this.authenticate(token, requestProof);
    return session ? this.sessions.delete(session.key) : false;
  }

  clear(): void {
    this.sessions.clear();
  }

  snapshot(): { sessions: number; failureClients: number; globalFailures: number } {
    this.prune(this.now());
    return { sessions: this.sessions.size, failureClients: this.clientFailures.size, globalFailures: this.globalFailures.length };
  }

  private normalizeClientKey(value: string): string {
    const candidate = value.trim();
    if (!candidate || Buffer.byteLength(candidate, 'utf8') > 256) return 'unknown';
    return candidate;
  }

  private retryAfter(key: string, now: number): number {
    const oldestGlobal = this.globalFailures.length >= this.maxGlobalFailures ? this.globalFailures[0]?.at : undefined;
    const client = this.clientFailures.get(key);
    const oldestClient = client && client.attempts.length >= this.maxFailuresPerClient ? client.attempts[0]?.at : undefined;
    return Math.max(
      oldestGlobal === undefined ? 0 : this.failureWindowMs - (now - oldestGlobal),
      oldestClient === undefined ? 0 : this.failureWindowMs - (now - oldestClient),
    );
  }

  private reserveFailure(key: string, now: number): number {
    if (!this.clientFailures.has(key) && this.clientFailures.size >= this.maxFailureClients) {
      throw new ToolPortalError('로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.', 429, 'LOGIN_RATE_LIMITED', Math.ceil(this.failureWindowMs / 1_000));
    }
    const record = this.clientFailures.get(key) ?? { attempts: [], lastSeen: now };
    const id = ++this.failureSequence;
    const reservation = { id, at: now };
    record.attempts.push(reservation);
    record.lastSeen = now;
    this.clientFailures.set(key, record);
    this.globalFailures.push(reservation);
    return id;
  }

  private releaseReservation(key: string, id: number): void {
    this.globalFailures = this.globalFailures.filter((attempt) => attempt.id !== id);
    const record = this.clientFailures.get(key);
    if (!record) return;
    // A successful password resets this client's prior failures as well.
    this.clientFailures.delete(key);
  }

  private prune(now: number): void {
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
    const cutoff = now - this.failureWindowMs;
    this.globalFailures = this.globalFailures.filter((attempt) => attempt.at > cutoff).slice(-this.maxGlobalFailures);
    for (const [key, record] of this.clientFailures) {
      record.attempts = record.attempts.filter((attempt) => attempt.at > cutoff).slice(-this.maxFailuresPerClient);
      if (!record.attempts.length) this.clientFailures.delete(key);
    }
  }
}

export interface ToolPortalArtifact {
  capability: string;
  expiresAt: number;
  name: string;
  size: number;
}

export interface ToolPortalArtifactFile {
  path: string;
  name: string;
  size: number;
  fd: number;
}

interface ArtifactRecord extends Omit<ToolPortalArtifact, 'capability'> {
  capabilityHash: string;
  sessionKey: string;
  path: string;
  workspaceRoot: string;
  createdAt: number;
}

function canonicalPath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function resolveArtifactFile(workspacePath: string, targetPath: string): Omit<ToolPortalArtifactFile, 'fd'> & { workspaceRoot: string } {
  const root = realpathSync(resolve(workspacePath));
  if (!statSync(root).isDirectory()) throw new Error('포털 작업 폴더를 사용할 수 없습니다.');
  const requested = resolve(targetPath);
  if (lstatSync(requested).isSymbolicLink()) throw new Error('심볼릭 링크 결과는 다운로드할 수 없습니다.');
  const target = realpathSync(requested);
  if (!isInside(canonicalPath(root), canonicalPath(target))) throw new Error('아카이브 결과가 포털 작업 폴더 밖에 있습니다.');
  const stat = statSync(target);
  if (!stat.isFile() || !basename(target).toLowerCase().endsWith('.zip')
    || stat.size < 4 || stat.size > TOOL_PORTAL_MAX_ARTIFACT_BYTES) {
    throw new Error('아카이브 결과 파일의 크기나 형식이 올바르지 않습니다.');
  }
  return { path: target, workspaceRoot: root, name: basename(target).replace(/[\r\n"\\/]/g, '_') || 'resource-archive.zip', size: stat.size };
}

/** Memory-only, session-bound, one-use archive download capabilities. */
export class ToolPortalArtifactStore {
  private readonly records = new Map<string, ArtifactRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(sessionKey: string, targetPath: string, workspacePath: string): ToolPortalArtifact {
    const now = this.now();
    this.prune(now);
    const file = resolveArtifactFile(workspacePath, targetPath);
    if (this.records.size >= TOOL_PORTAL_MAX_ARTIFACTS
      || [...this.records.values()].filter((record) => record.sessionKey === sessionKey).length >= TOOL_PORTAL_MAX_ARTIFACTS_PER_SESSION) {
      throw new ToolPortalError('다운로드 대기 아카이브가 너무 많습니다.', 429, 'ARTIFACT_LIMIT_REACHED', 60);
    }
    const capability = randomBytes(32).toString('base64url');
    const capabilityHash = tokenHash(capability);
    const expiresAt = now + TOOL_PORTAL_ARTIFACT_TTL_MS;
    this.records.set(capabilityHash, {
      capabilityHash,
      sessionKey,
      path: file.path,
      workspaceRoot: file.workspaceRoot,
      name: file.name,
      size: file.size,
      createdAt: now,
      expiresAt,
    });
    return { capability, expiresAt, name: file.name, size: file.size };
  }

  /** Delete before validation so concurrent or wrong-session requests cannot replay it. */
  consume(capability: unknown, sessionKey: string, currentWorkspacePath: string): ToolPortalArtifactFile {
    if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability)) {
      throw new ToolPortalError('다운로드 권한이 올바르지 않습니다.', 404, 'ARTIFACT_NOT_FOUND');
    }
    const capabilityHash = tokenHash(capability);
    const record = this.records.get(capabilityHash);
    this.records.delete(capabilityHash);
    if (!record || record.expiresAt <= this.now() || record.sessionKey !== sessionKey) {
      throw new ToolPortalError('다운로드 권한이 만료되었거나 요청과 일치하지 않습니다.', 404, 'ARTIFACT_NOT_FOUND');
    }
    const file = resolveArtifactFile(currentWorkspacePath, record.path);
    if (canonicalPath(file.workspaceRoot) !== canonicalPath(record.workspaceRoot)
      || file.name !== record.name || file.size !== record.size) {
      throw new ToolPortalError('아카이브 결과 또는 포털 작업 폴더가 변경되었습니다.', 409, 'ARTIFACT_CHANGED');
    }
    let fd: number | undefined;
    try {
      fd = openSync(file.path, 'r');
      const opened = fstatSync(fd);
      const current = statSync(file.path);
      const finalPath = realpathSync(file.path);
      const signature = Buffer.allocUnsafe(4);
      const signatureBytes = readSync(fd, signature, 0, signature.length, 0);
      const zipSignature = signatureBytes === 4 && signature[0] === 0x50 && signature[1] === 0x4b
        && ((signature[2] === 0x03 && signature[3] === 0x04)
          || (signature[2] === 0x05 && signature[3] === 0x06)
          || (signature[2] === 0x07 && signature[3] === 0x08));
      if (!opened.isFile() || opened.size !== file.size || current.size !== opened.size
        || opened.dev !== current.dev || opened.ino !== current.ino
        || canonicalPath(finalPath) !== canonicalPath(file.path)
        || !isInside(canonicalPath(file.workspaceRoot), canonicalPath(finalPath)) || !zipSignature) {
        throw new ToolPortalError('다운로드 직전에 아카이브 결과가 변경되었습니다.', 409, 'ARTIFACT_CHANGED');
      }
      return { path: finalPath, name: file.name, size: opened.size, fd };
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
      throw error;
    }
  }

  clear(): void {
    this.records.clear();
  }

  clearSession(sessionKey: string): void {
    for (const [key, record] of this.records) if (record.sessionKey === sessionKey) this.records.delete(key);
  }

  private prune(now: number): void {
    for (const [key, record] of this.records) if (record.expiresAt <= now) this.records.delete(key);
  }
}
