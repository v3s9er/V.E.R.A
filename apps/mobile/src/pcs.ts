import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type { CloudflareAccessBootstrap, CloudflareAccessCredentials, SavedPc } from './types';

const KEY = 'mr-robot.pcs';
const LAST_KEY = 'mr-robot.lastPcId';
const CREDENTIAL_BUNDLE_PREFIX = 'mr-robot.pc.credentials.';
const CREDENTIAL_BUNDLE_VERSION = 1 as const;
// Read-only migration keys from pre-v0.4 builds. New writes always use the
// single versioned bundle so a device token and its Access pair cannot split.
const SECRET_PREFIX = 'mr-robot.pc.secret.';
const CF_ACCESS_CLIENT_ID_PREFIX = 'mr-robot.pc.cloudflare-access.client-id.';
const CF_ACCESS_CLIENT_SECRET_PREFIX = 'mr-robot.pc.cloudflare-access.client-secret.';
const PAIR_RESPONSE_MAX_CHARS = 64 * 1024;
const BOOTSTRAP_TTL_MAX_MS = 10 * 60_000;

type StoredPc = Omit<SavedPc, 'secret' | 'cloudflareAccess'> & {
  secret?: string;
  /** Legacy v0.3.8 pre-release metadata; migrated immediately to SecureStore. */
  cloudflareAccess?: CloudflareAccessCredentials;
};

interface CredentialBundleV1 {
  version: typeof CREDENTIAL_BUNDLE_VERSION;
  secret: string;
  cloudflareAccess?: CloudflareAccessCredentials;
}
export type PcProtocol = 'http' | 'https';

export interface ParsedPcAddress {
  protocol: PcProtocol;
  host: string;
  port: number;
  origin: string;
}

let storageLoadComplete = false;
let storageLoadCompromised = false;
let saveQueue: Promise<void> = Promise.resolve();

const secretKey = (id: string): string => `${SECRET_PREFIX}${id}`;
const cloudflareAccessClientIdKey = (id: string): string => `${CF_ACCESS_CLIENT_ID_PREFIX}${id}`;
const cloudflareAccessClientSecretKey = (id: string): string => `${CF_ACCESS_CLIENT_SECRET_PREFIX}${id}`;
const credentialBundleKey = (id: string): string => `${CREDENTIAL_BUNDLE_PREFIX}${id}`;

function withoutCredentials(pc: SavedPc): Omit<SavedPc, 'secret' | 'cloudflareAccess'> {
  const { secret: _secret, cloudflareAccess: _cloudflareAccess, credentialStatus: _credentialStatus, ...metadata } = pc;
  return { ...metadata, cloudflareAccessConfigured: Boolean(pc.cloudflareAccess) || pc.cloudflareAccessConfigured === true };
}

export interface PairingExchangeResult {
  secret: string;
  linkId?: string;
  /** Present only after a version 5 one-time bootstrap is consumed. */
  cloudflareAccess?: CloudflareAccessCredentials;
}

function validHeaderCredential(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096 && /^[\x21-\x7E]+$/.test(value);
}

function parseCredentialBundle(raw: string): CredentialBundleV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('보안 자격증명 번들이 올바른 JSON이 아닙니다.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('보안 자격증명 번들 구조가 올바르지 않습니다.');
  }
  const candidate = value as Partial<CredentialBundleV1>;
  if (candidate.version !== CREDENTIAL_BUNDLE_VERSION || !validHeaderCredential(candidate.secret)) {
    throw new Error('지원하지 않거나 손상된 보안 자격증명 번들입니다.');
  }
  const cloudflareAccess = candidate.cloudflareAccess === undefined
    ? undefined
    : normalizeCloudflareAccess(candidate.cloudflareAccess);
  return {
    version: CREDENTIAL_BUNDLE_VERSION,
    secret: candidate.secret,
    ...(cloudflareAccess ? { cloudflareAccess } : {}),
  };
}

function serializeCredentialBundle(secret: string, access?: CloudflareAccessCredentials): string {
  if (!validHeaderCredential(secret)) throw new Error('PC 연결 자격증명이 올바르지 않습니다.');
  const cloudflareAccess = normalizeCloudflareAccess(access);
  return JSON.stringify({
    version: CREDENTIAL_BUNDLE_VERSION,
    secret,
    ...(cloudflareAccess ? { cloudflareAccess } : {}),
  } satisfies CredentialBundleV1);
}

async function deleteLegacyCredentialKeys(id: string): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(secretKey(id)),
    SecureStore.deleteItemAsync(cloudflareAccessClientIdKey(id)),
    SecureStore.deleteItemAsync(cloudflareAccessClientSecretKey(id)),
  ]);
}

export function normalizeCloudflareAccess(value?: CloudflareAccessCredentials): CloudflareAccessCredentials | undefined {
  if (!value) return undefined;
  const clientId = typeof value.clientId === 'string' ? value.clientId.trim() : '';
  const clientSecret = typeof value.clientSecret === 'string' ? value.clientSecret.trim() : '';
  if (!validHeaderCredential(clientId) || !validHeaderCredential(clientSecret)) {
    throw new Error('Cloudflare Access Client ID와 Secret을 모두 올바르게 입력하세요.');
  }
  return { clientId, clientSecret };
}

function exactHttpsOrigin(value: string): string | undefined {
  try {
    const parsed = parsePcAddress(value, 443, 'https');
    return parsed.protocol === 'https' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

export function cloudflareAccessHeaders(
  access?: CloudflareAccessCredentials,
  accessOrigin?: string,
  requestUrlOrOrigin?: string,
): Record<string, string> {
  const normalized = normalizeCloudflareAccess(access);
  const binding = accessOrigin && exactHttpsOrigin(accessOrigin);
  const requestOrigin = requestUrlOrOrigin && exactHttpsOrigin(requestUrlOrOrigin);
  if (!normalized || !binding || requestOrigin !== binding) return {};
  return normalized ? {
    'CF-Access-Client-Id': normalized.clientId,
    'CF-Access-Client-Secret': normalized.clientSecret,
  } : {};
}

function cloudflareBootstrapHeaders(
  bootstrap?: CloudflareAccessBootstrap,
  bootstrapOrigin?: string,
  requestUrlOrOrigin?: string,
): Record<string, string> {
  if (!bootstrap) return {};
  const binding = bootstrapOrigin && exactHttpsOrigin(bootstrapOrigin);
  const requestOrigin = requestUrlOrOrigin && exactHttpsOrigin(requestUrlOrOrigin);
  if (!binding || requestOrigin !== binding) {
    throw new Error('자동 보안 등록 QR의 HTTPS 주소가 일치하지 않습니다. PC에서 새 QR을 만드세요.');
  }
  if (bootstrap.type !== 'cf-authorization'
    || bootstrap.token.length < 64
    || bootstrap.token.length > 4_096
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bootstrap.token)) {
    throw new Error('자동 보안 등록 정보가 올바르지 않습니다. PC에서 새 QR을 만드세요.');
  }
  const now = Date.now();
  if (!Number.isSafeInteger(bootstrap.expiresAt)
    || bootstrap.expiresAt <= now
    || bootstrap.expiresAt > now + BOOTSTRAP_TTL_MAX_MS) {
    throw new Error('자동 보안 등록 QR이 만료되었습니다. PC에서 새 QR을 만드세요.');
  }
  // Cloudflare documents `cf-access-token` as the non-browser transport for an
  // application JWT.  Do not synthesize a Cookie here: native cookie jars can
  // retain it beyond this one enrollment request, and the token is deliberately
  // scoped to this exact origin and short TTL.
  return { 'cf-access-token': bootstrap.token };
}

function isBlockedRedirectError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /redirect[\s\S]{0,120}(?:not allowed|mode\s+is\s+['"]?error|disallowed|forbidden)/i.test(detail);
}

/**
 * Keep credential-bearing requests fail-closed while explaining the otherwise
 * opaque React Native fetch error. Never include the original response
 * Location: an Access login redirect can contain short-lived state tokens.
 */
export function explainCredentialFetchFailure(error: unknown, accessHeadersSent: boolean): Error {
  if (!isBlockedRedirectError(error)) return error instanceof Error ? error : new Error(String(error));
  return new Error(accessHeadersSent
    ? 'Cloudflare Access Client ID/Secret 헤더는 이 HTTPS 주소에 전송됐지만 Access가 승인하지 않고 로그인 화면으로 보냈습니다. 두 값, Access 애플리케이션 호스트, Service Auth 정책의 Service Token 조건을 확인하세요. 보안을 위해 리다이렉트는 따라가지 않았습니다.'
    : '이 HTTPS 주소가 Cloudflare Access 로그인 화면으로 보냈습니다. PC 추가 화면에서 Cloudflare Access Client ID와 Secret을 모두 입력하세요. 보안을 위해 리다이렉트는 따라가지 않았습니다.');
}

async function readPairingResponse(response: Response): Promise<Record<string, unknown>> {
  const advertised = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(advertised) && advertised > PAIR_RESPONSE_MAX_CHARS) {
    throw new Error('PC 등록 응답이 허용 크기를 초과했습니다.');
  }
  const raw = await response.text();
  if (raw.length > PAIR_RESPONSE_MAX_CHARS) throw new Error('PC 등록 응답이 허용 크기를 초과했습니다.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`PC 등록 응답이 올바른 JSON이 아닙니다. (HTTP ${response.status})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PC 등록 응답 구조가 올바르지 않습니다.');
  }
  return parsed as Record<string, unknown>;
}

export function pcAuthenticatedHeaders(pc: SavedPc, requestUrlOrOrigin: string, additional: Record<string, string> = {}): Record<string, string> {
  const requestOrigin = exactHttpsOrigin(requestUrlOrOrigin);
  const credentialOrigin = pc.credentialOrigin && exactHttpsOrigin(pc.credentialOrigin);
  if (!requestOrigin || !credentialOrigin || requestOrigin !== credentialOrigin) return { ...additional };
  return {
    ...cloudflareAccessHeaders(pc.cloudflareAccess, pc.cloudflareAccessOrigin, requestUrlOrOrigin),
    'x-mr-robot-token': pc.secret,
    ...additional,
  };
}

async function readStoredPcs(): Promise<StoredPc[]> {
  const raw = await readStoredPcsRaw();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as StoredPc[];
  return Array.isArray(parsed) ? parsed : [];
}

export function parsePcAddress(raw: string, defaultPort = 8787, defaultProtocol: PcProtocol = 'http'): ParsedPcAddress {
  const value = raw.trim();
  if (!value) throw new Error('PC 주소를 입력하세요.');
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `${defaultProtocol}://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('PC 주소 형식이 올바르지 않습니다. 예: https://example.trycloudflare.com');
  }
  const scheme = url.protocol.replace(':', '').toLowerCase();
  if (!['http', 'https', 'ws', 'wss'].includes(scheme)) throw new Error('PC 주소는 http, https, ws 또는 wss 주소여야 합니다.');
  const protocol: PcProtocol = scheme === 'https' || scheme === 'wss' ? 'https' : 'http';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port ? Number(url.port) : (protocol === 'https' ? 443 : defaultPort);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PC 주소 또는 포트가 올바르지 않습니다.');
  }
  return { protocol, host, port, origin: originFromParts(protocol, host, port) };
}

export function formatHostPort(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

export function originFromParts(protocol: PcProtocol, host: string, port: number): string {
  return `${protocol}://${formatHostPort(host.replace(/^\[|\]$/g, ''), port)}`;
}

/** Mobile credentials may travel only through authenticated TLS. */
export function assertSecureRemoteOrigin(value: string): string {
  // A literal 100.64/10 address does not prove that the active route belongs
  // to Tailscale. If the VPN is down, another route could receive the PIN or
  // bearer token in plaintext. Bare remote hostnames therefore default to
  // HTTPS and every non-TLS origin is rejected.
  const parsed = parsePcAddress(value, 8787, 'https');
  if (parsed.protocol !== 'https') {
    throw new Error('평문 원격 연결은 보안을 위해 차단됩니다. Cloudflare 또는 Tailscale Serve의 HTTPS 주소를 사용하세요.');
  }
  return parsed.origin;
}

function tryOrigin(value: string, defaultPort = 8787, defaultProtocol: PcProtocol = 'http'): string | null {
  try { return parsePcAddress(value, defaultPort, defaultProtocol).origin; } catch { return null; }
}

function unboundConnectionOrigins(pc: SavedPc): string[] {
  const primary = originFromParts(pc.protocol ?? 'http', pc.host, pc.port);
  const legacy = [pc.activeHost, ...(pc.hosts ?? [])]
    .filter((value): value is string => Boolean(value))
    .map((host) => originFromParts('http', host, pc.port));
  return [...new Set([
    pc.activeOrigin && tryOrigin(pc.activeOrigin, pc.port, pc.protocol ?? 'http'),
    ...(pc.origins ?? []).map((origin) => tryOrigin(origin, pc.port, pc.protocol ?? 'http')),
    primary,
    ...legacy,
  ].filter((value): value is string => Boolean(value)))]
    .filter((origin) => {
      try { assertSecureRemoteOrigin(origin); return true; } catch { return false; }
    });
}

async function readStoredPcsRaw(): Promise<string | null> {
  return AsyncStorage.getItem(KEY);
}

export function connectionOrigins(pc: SavedPc): string[] {
  const origins = unboundConnectionOrigins(pc);
  const credentialOrigin = pc.credentialOrigin && exactHttpsOrigin(pc.credentialOrigin);
  // A device bearer proves one authenticated origin, not every address that an
  // unsigned QR or discovery response happened to list. Re-enrol separately
  // before a different origin may receive it.
  return credentialOrigin && origins.includes(credentialOrigin) ? [credentialOrigin] : origins;
}

export function httpBaseForPc(pc: SavedPc): string {
  const origin = connectionOrigins(pc)[0];
  if (!origin) throw new Error('이 PC에 HTTPS 접속 주소가 없습니다. Cloudflare 또는 Tailscale Serve 주소로 다시 등록하세요.');
  return origin;
}

function normalizePc<T extends StoredPc | SavedPc>(pc: T): T {
  const protocol = pc.protocol ?? 'http';
  const origins = unboundConnectionOrigins({ ...pc, protocol, secret: 'secret' } as SavedPc);
  const requestedActive = pc.activeOrigin && tryOrigin(pc.activeOrigin, pc.port, protocol);
  const activeOrigin = requestedActive && origins.includes(requestedActive) ? requestedActive : origins[0];
  const requestedCredentialOrigin = pc.credentialOrigin && exactHttpsOrigin(pc.credentialOrigin);
  const credentialOrigin = requestedCredentialOrigin && origins.includes(requestedCredentialOrigin)
    ? requestedCredentialOrigin
    : activeOrigin;
  const cloudflareAccess = normalizeCloudflareAccess(pc.cloudflareAccess);
  const requestedAccessOrigin = pc.cloudflareAccessOrigin && exactHttpsOrigin(pc.cloudflareAccessOrigin);
  const cloudflareAccessOrigin = cloudflareAccess
    ? (requestedAccessOrigin && requestedAccessOrigin === credentialOrigin
      ? requestedAccessOrigin
      : credentialOrigin?.startsWith('https://') ? credentialOrigin : undefined)
    : undefined;
  return {
    ...pc,
    protocol,
    origins,
    activeOrigin,
    credentialOrigin,
    ...(cloudflareAccess && cloudflareAccessOrigin
      ? { cloudflareAccess, cloudflareAccessConfigured: true, cloudflareAccessOrigin }
      : {}),
  };
}

export async function loadPcs(): Promise<SavedPc[]> {
  try {
    const stored = await readStoredPcs();
    let migrated = false;
    let incomplete = false;
    let metadataMigrationBlocked = false;
    const pcs = await Promise.all(stored.map(async (rawItem) => {
      const item = normalizePc(rawItem);
      const hasPlaintextCredentials = Object.prototype.hasOwnProperty.call(item, 'secret')
        || Object.prototype.hasOwnProperty.call(item, 'cloudflareAccess');
      let bundleRaw: string | null = null;
      let legacySecureSecret: string | null = null;
      let legacyAccessClientId: string | null = null;
      let legacyAccessClientSecret: string | null = null;
      let itemUnavailable = false;
      try {
        [bundleRaw, legacySecureSecret, legacyAccessClientId, legacyAccessClientSecret] = await Promise.all([
          SecureStore.getItemAsync(credentialBundleKey(item.id)),
          SecureStore.getItemAsync(secretKey(item.id)),
          SecureStore.getItemAsync(cloudflareAccessClientIdKey(item.id)),
          SecureStore.getItemAsync(cloudflareAccessClientSecretKey(item.id)),
        ]);
      } catch {
        incomplete = true;
        itemUnavailable = true;
      }
      const legacySecret = typeof item.secret === 'string' ? item.secret : '';
      const legacyMetadataAccess = normalizeCloudflareAccess(item.cloudflareAccess);
      let bundle: CredentialBundleV1 | undefined;
      let bundlePersisted = false;
      let safeToScrubPlaintext = !hasPlaintextCredentials;

      if (!itemUnavailable && bundleRaw) {
        try {
          bundle = parseCredentialBundle(bundleRaw);
          bundlePersisted = true;
          safeToScrubPlaintext = true;
        } catch {
          incomplete = true;
          itemUnavailable = true;
        }
      }

      if (!itemUnavailable && !bundleRaw) {
        const hasLegacyAccessId = Boolean(legacyAccessClientId);
        const hasLegacyAccessSecret = Boolean(legacyAccessClientSecret);
        const legacySecureAccess = hasLegacyAccessId && hasLegacyAccessSecret
          ? normalizeCloudflareAccess({ clientId: legacyAccessClientId!, clientSecret: legacyAccessClientSecret! })
          : undefined;
        const accessExpected = item.cloudflareAccessConfigured === true
          || Boolean(legacyMetadataAccess)
          || hasLegacyAccessId
          || hasLegacyAccessSecret;
        const migrationSecret = legacySecureSecret ?? legacySecret;
        const migrationAccess = legacySecureAccess ?? legacyMetadataAccess;
        if (migrationSecret && (!accessExpected || migrationAccess)) {
          bundle = {
            version: CREDENTIAL_BUNDLE_VERSION,
            secret: migrationSecret,
            ...(migrationAccess ? { cloudflareAccess: migrationAccess } : {}),
          };
          try {
            await SecureStore.setItemAsync(
              credentialBundleKey(item.id),
              serializeCredentialBundle(bundle.secret, bundle.cloudflareAccess),
            );
            bundlePersisted = true;
            safeToScrubPlaintext = true;
            migrated = true;
          } catch {
            incomplete = true;
          }
        } else if (accessExpected || (migrationAccess && !migrationSecret)) {
          incomplete = true;
        }
      }

      const legacySecureKeysExist = Boolean(legacySecureSecret || legacyAccessClientId || legacyAccessClientSecret);
      if (!itemUnavailable && bundlePersisted && legacySecureKeysExist) {
        try {
          await deleteLegacyCredentialKeys(item.id);
          migrated = true;
        } catch {
          // The authoritative bundle is complete, but keep saves disabled until
          // a later launch can remove every obsolete duplicate.
          incomplete = true;
        }
      }
      if (hasPlaintextCredentials && !safeToScrubPlaintext) metadataMigrationBlocked = true;

      const secret = itemUnavailable ? '' : (bundle?.secret ?? '');
      const cloudflareAccess = itemUnavailable ? undefined : bundle?.cloudflareAccess;
      const accessExpected = item.cloudflareAccessConfigured === true
        || Boolean(legacyMetadataAccess)
        || Boolean(bundle?.cloudflareAccess)
        || Boolean(legacyAccessClientId || legacyAccessClientSecret);
      if (accessExpected && !cloudflareAccess) incomplete = true;
      if (cloudflareAccess && item.cloudflareAccessConfigured !== true) migrated = true;
      let cloudflareAccessOrigin = item.cloudflareAccessOrigin && exactHttpsOrigin(item.cloudflareAccessOrigin);
      if (cloudflareAccess && !cloudflareAccessOrigin) {
        cloudflareAccessOrigin = item.activeOrigin && exactHttpsOrigin(item.activeOrigin)
          || item.origins?.map((origin) => exactHttpsOrigin(origin)).find((origin): origin is string => Boolean(origin));
        if (cloudflareAccessOrigin) migrated = true;
      }
      const { secret: _legacySecret, cloudflareAccess: _legacyCloudflareAccess, ...metadata } = item;
      return {
        ...metadata,
        secret,
        ...(cloudflareAccess && cloudflareAccessOrigin
          ? { cloudflareAccess, cloudflareAccessConfigured: true, cloudflareAccessOrigin }
          : {}),
        credentialStatus: itemUnavailable ? 'unavailable' : secret ? 'ok' : 'missing',
      } as SavedPc;
    }));
    if (incomplete) storageLoadCompromised = true;
    storageLoadComplete = !incomplete && !storageLoadCompromised;
    const needsMetadataMigration = stored.some((item) => !item.protocol
      || !item.origins
      || (item.cloudflareAccessConfigured === true && !item.cloudflareAccessOrigin)
      || Object.prototype.hasOwnProperty.call(item, 'secret')
      || Object.prototype.hasOwnProperty.call(item, 'cloudflareAccess'));
    if (!metadataMigrationBlocked && (migrated || needsMetadataMigration)) {
      await AsyncStorage.setItem(KEY, JSON.stringify(pcs.map(withoutCredentials)));
    }
    return pcs;
  } catch {
    storageLoadCompromised = true;
    storageLoadComplete = false;
    return [];
  }
}

async function savePcsAtomic(pcs: SavedPc[]): Promise<void> {
  if (!storageLoadComplete) throw new Error('보안 저장소를 완전히 읽지 못했습니다. 앱을 다시 열고 자격증명을 확인해 주세요.');
  let previousRaw: string | null;
  let previous: StoredPc[];
  try {
    previousRaw = await readStoredPcsRaw();
    previous = previousRaw ? JSON.parse(previousRaw) as StoredPc[] : [];
    if (!Array.isArray(previous)) throw new Error('저장된 PC 메타데이터가 올바르지 않습니다.');
  } catch (error) {
    storageLoadCompromised = true;
    storageLoadComplete = false;
    throw error;
  }
  const normalized = pcs.map((pc) => normalizePc({ ...pc, credentialStatus: pc.secret ? 'ok' : pc.credentialStatus }));
  const actions = new Map<string, string | null>();
  for (const pc of normalized) {
    const access = normalizeCloudflareAccess(pc.cloudflareAccess);
    if (pc.cloudflareAccessConfigured && !access) {
      throw new Error(`${pc.name}: Cloudflare Access 자격증명을 보안 저장소에서 읽지 못했습니다.`);
    }
    if (access && !pc.secret) throw new Error(`${pc.name}: 기기 토큰 없이 Access 자격만 저장할 수 없습니다.`);
    if (pc.secret) {
      actions.set(credentialBundleKey(pc.id), serializeCredentialBundle(pc.secret, access));
    } else if (!pc.credentialStatus || pc.credentialStatus === 'ok') {
      actions.set(credentialBundleKey(pc.id), null);
    }
  }
  const retained = new Set(normalized.map((pc) => pc.id));
  for (const pc of previous) {
    if (!retained.has(pc.id)) actions.set(credentialBundleKey(pc.id), null);
  }
  const snapshots = new Map<string, string | null>();
  try {
    for (const key of actions.keys()) snapshots.set(key, await SecureStore.getItemAsync(key));
  } catch (error) {
    storageLoadCompromised = true;
    storageLoadComplete = false;
    throw error;
  }
  const touched: string[] = [];
  try {
    for (const [key, value] of actions) {
      touched.push(key);
      if (value === null) await SecureStore.deleteItemAsync(key);
      else await SecureStore.setItemAsync(key, value);
    }
    await AsyncStorage.setItem(KEY, JSON.stringify(normalized.map(withoutCredentials)));
  } catch (error) {
    let rollbackFailed = false;
    for (const key of touched.reverse()) {
      try {
        const previousValue = snapshots.get(key) ?? null;
        if (previousValue === null) await SecureStore.deleteItemAsync(key);
        else await SecureStore.setItemAsync(key, previousValue);
      } catch {
        rollbackFailed = true;
      }
    }
    try {
      if (previousRaw === null) await AsyncStorage.removeItem(KEY);
      else await AsyncStorage.setItem(KEY, previousRaw);
    } catch {
      rollbackFailed = true;
    }
    storageLoadCompromised = true;
    storageLoadComplete = false;
    if (rollbackFailed) {
      throw new Error('보안 저장 중 오류가 발생했고 이전 상태 복구도 완료하지 못했습니다. 앱을 다시 열어 자격증명을 확인하세요.');
    }
    throw error;
  }
}

export function savePcs(pcs: SavedPc[]): Promise<void> {
  const operation = saveQueue.then(() => savePcsAtomic(pcs));
  saveQueue = operation.catch(() => undefined);
  return operation;
}

export async function upsertPc(pcs: SavedPc[], pc: Omit<SavedPc, 'id' | 'addedAt'>): Promise<SavedPc[]> {
  const normalized = normalizePc(pc as SavedPc);
  const targetOrigins = new Set(connectionOrigins(normalized));
  const existing = pcs.find((item) => connectionOrigins(item).some((origin) => targetOrigins.has(origin)));
  if (existing) {
    return pcs.map((item) => item.id === existing.id ? normalizePc({
      ...item,
      ...normalized,
      cloudflareAccess: normalized.cloudflareAccess ?? item.cloudflareAccess,
      cloudflareAccessConfigured: Boolean(normalized.cloudflareAccess ?? item.cloudflareAccess),
      origins: [...new Set([...connectionOrigins(item), ...connectionOrigins(normalized)])],
      addedAt: item.addedAt,
      id: item.id,
    }) : item);
  }
  const created: SavedPc = { ...normalized, id: `pc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, addedAt: Date.now() };
  return [...pcs, created];
}

export async function removePc(pcs: SavedPc[], id: string): Promise<SavedPc[]> {
  return pcs.filter((pc) => pc.id !== id);
}

export async function getLastPcId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export async function setLastPcId(id: string | null): Promise<void> {
  try {
    if (id) await AsyncStorage.setItem(LAST_KEY, id);
    else await AsyncStorage.removeItem(LAST_KEY);
  } catch {
    /* 마지막 선택값은 연결 자체에 필수적이지 않다. */
  }
}

/** Exchange the 6-digit PIN for the long-lived secret. */
export async function exchangePin(
  origin: string,
  pin: string,
  deviceName = '모바일',
  permissionCap = 'ask',
  timeoutMs = 8000,
  cloudflareAccess?: CloudflareAccessCredentials,
  cloudflareAccessOrigin?: string,
  cloudflareBootstrap?: CloudflareAccessBootstrap,
  cloudflareBootstrapOrigin?: string,
): Promise<PairingExchangeResult> {
  const base = assertSecureRemoteOrigin(origin);
  if (cloudflareAccess && cloudflareBootstrap) throw new Error('장기 Access 자격과 1회성 부트스트랩을 동시에 사용할 수 없습니다.');
  const binding = cloudflareAccess ? assertSecureRemoteOrigin(cloudflareAccessOrigin ?? base) : undefined;
  const accessHeaders = cloudflareAccessHeaders(cloudflareAccess, binding, base);
  const bootstrapBinding = cloudflareBootstrap
    ? assertSecureRemoteOrigin(cloudflareBootstrapOrigin ?? base)
    : undefined;
  const bootstrapHeaders = cloudflareBootstrapHeaders(cloudflareBootstrap, bootstrapBinding, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { ...accessHeaders, ...bootstrapHeaders, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ pin: pin.trim(), deviceName, permissionCap }),
      redirect: 'error',
      credentials: 'omit',
      signal: controller.signal,
    });
    const body = await readPairingResponse(res);
    if (!res.ok) {
      const errorMessage = typeof body.error === 'string' ? body.error : '';
      const errorCode = typeof body.code === 'string' ? body.code : '';
      if (errorCode === 'PAIRING_EXPIRED' || /expired|만료/i.test(errorMessage)) {
        throw new Error('1회용 등록 코드가 만료되었습니다. PC에서 새 QR을 만드세요.');
      }
      if (errorCode === 'PAIRING_CONSUMED' || /consumed|already used|사용됨/i.test(errorMessage)) {
        throw new Error('이 1회용 등록 QR은 이미 사용되었습니다. PC에서 새 QR을 만드세요.');
      }
      throw new Error(errorMessage || `PIN 교환 실패 (HTTP ${res.status})`);
    }
    if (!validHeaderCredential(body.secret) || body.secret.length < 32) {
      throw new Error('PC 연결 자격증명 응답이 올바르지 않습니다.');
    }
    if (!cloudflareBootstrap && body.cloudflareAccess !== undefined) {
      throw new Error('요청하지 않은 Cloudflare 장기 자격증명이 반환되어 등록을 중단했습니다.');
    }
    const enrolledAccess = cloudflareBootstrap
      ? normalizeCloudflareAccess(body.cloudflareAccess as CloudflareAccessCredentials | undefined)
      : undefined;
    if (cloudflareBootstrap && !enrolledAccess) {
      throw new Error('PC가 자동 보안 등록을 완료하지 못했습니다. PC 앱을 업데이트하고 새 QR을 만드세요.');
    }
    return {
      secret: body.secret,
      ...(typeof body.linkId === 'string' && body.linkId.length > 0 && body.linkId.length <= 256 ? { linkId: body.linkId } : {}),
      ...(enrolledAccess ? { cloudflareAccess: enrolledAccess } : {}),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('PC 연결 시간이 초과되었습니다.');
    if (cloudflareBootstrap && isBlockedRedirectError(error)) {
      throw new Error('Cloudflare가 이 1회성 자동 등록 세션을 승인하지 않았습니다. QR이 만료되었거나 PC의 Access Binding Cookie 설정이 호환되지 않습니다. PC에서 새 QR을 만드세요. 보안을 위해 리다이렉트는 따라가지 않았습니다.');
    }
    throw explainCredentialFetchFailure(error, Object.keys(accessHeaders).length > 0);
  } finally {
    clearTimeout(timer);
  }
}

export async function exchangePinAcrossOrigins(
  origins: string[],
  pin: string,
  deviceName = '모바일',
  cloudflareAccess?: CloudflareAccessCredentials,
  cloudflareAccessOrigin?: string,
  cloudflareBootstrap?: CloudflareAccessBootstrap,
  cloudflareBootstrapOrigin?: string,
): Promise<{ origin: string } & PairingExchangeResult> {
  let lastError: unknown = new Error('연결 가능한 PC 주소가 없습니다.');
  for (const origin of [...new Set(origins.filter(Boolean))]) {
    try {
      const result = await exchangePin(
        origin,
        pin,
        deviceName,
        'ask',
        4500,
        cloudflareAccess,
        cloudflareAccessOrigin,
        cloudflareBootstrap,
        cloudflareBootstrapOrigin,
      );
      return { origin, ...result };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
