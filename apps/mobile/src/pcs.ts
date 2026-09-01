import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type { CloudflareAccessCredentials, SavedPc } from './types';

const KEY = 'mr-robot.pcs';
const LAST_KEY = 'mr-robot.lastPcId';
const SECRET_PREFIX = 'mr-robot.pc.secret.';
const CF_ACCESS_CLIENT_ID_PREFIX = 'mr-robot.pc.cloudflare-access.client-id.';
const CF_ACCESS_CLIENT_SECRET_PREFIX = 'mr-robot.pc.cloudflare-access.client-secret.';

type StoredPc = Omit<SavedPc, 'secret' | 'cloudflareAccess'> & {
  secret?: string;
  /** Legacy v0.3.8 pre-release metadata; migrated immediately to SecureStore. */
  cloudflareAccess?: CloudflareAccessCredentials;
};
export type PcProtocol = 'http' | 'https';

export interface ParsedPcAddress {
  protocol: PcProtocol;
  host: string;
  port: number;
  origin: string;
}

let storageLoadComplete = false;
let storageLoadCompromised = false;

const secretKey = (id: string): string => `${SECRET_PREFIX}${id}`;
const cloudflareAccessClientIdKey = (id: string): string => `${CF_ACCESS_CLIENT_ID_PREFIX}${id}`;
const cloudflareAccessClientSecretKey = (id: string): string => `${CF_ACCESS_CLIENT_SECRET_PREFIX}${id}`;

function withoutCredentials(pc: SavedPc): Omit<SavedPc, 'secret' | 'cloudflareAccess'> {
  const { secret: _secret, cloudflareAccess: _cloudflareAccess, credentialStatus: _credentialStatus, ...metadata } = pc;
  return { ...metadata, cloudflareAccessConfigured: Boolean(pc.cloudflareAccess) || pc.cloudflareAccessConfigured === true };
}

function validHeaderCredential(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096 && /^[\x21-\x7E]+$/.test(value);
}

export function normalizeCloudflareAccess(value?: CloudflareAccessCredentials): CloudflareAccessCredentials | undefined {
  if (!value) return undefined;
  const clientId = value.clientId.trim();
  const clientSecret = value.clientSecret.trim();
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
  const raw = await AsyncStorage.getItem(KEY);
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
    const pcs = await Promise.all(stored.map(async (rawItem) => {
      const item = normalizePc(rawItem);
      let secureSecret: string | null = null;
      let secureAccessClientId: string | null = null;
      let secureAccessClientSecret: string | null = null;
      let itemUnavailable = false;
      try {
        [secureSecret, secureAccessClientId, secureAccessClientSecret] = await Promise.all([
          SecureStore.getItemAsync(secretKey(item.id)),
          SecureStore.getItemAsync(cloudflareAccessClientIdKey(item.id)),
          SecureStore.getItemAsync(cloudflareAccessClientSecretKey(item.id)),
        ]);
      } catch {
        incomplete = true;
        itemUnavailable = true;
      }
      const legacySecret = typeof item.secret === 'string' ? item.secret : '';
      const secret = secureSecret ?? legacySecret;
      if (!secureSecret && legacySecret && !itemUnavailable) {
        try {
          await SecureStore.setItemAsync(secretKey(item.id), legacySecret);
          migrated = true;
        } catch {
          incomplete = true;
        }
      }
      const legacyAccess = normalizeCloudflareAccess(item.cloudflareAccess);
      let cloudflareAccess = secureAccessClientId && secureAccessClientSecret
        ? normalizeCloudflareAccess({ clientId: secureAccessClientId, clientSecret: secureAccessClientSecret })
        : legacyAccess;
      if (legacyAccess && (!secureAccessClientId || !secureAccessClientSecret) && !itemUnavailable) {
        try {
          await Promise.all([
            SecureStore.setItemAsync(cloudflareAccessClientIdKey(item.id), legacyAccess.clientId),
            SecureStore.setItemAsync(cloudflareAccessClientSecretKey(item.id), legacyAccess.clientSecret),
          ]);
          cloudflareAccess = legacyAccess;
          migrated = true;
        } catch {
          incomplete = true;
        }
      }
      const accessExpected = item.cloudflareAccessConfigured === true || Boolean(legacyAccess) || Boolean(secureAccessClientId || secureAccessClientSecret);
      if (accessExpected && !cloudflareAccess) incomplete = true;
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
        credentialStatus: itemUnavailable && !secret ? 'unavailable' : secret ? 'ok' : 'missing',
      } as SavedPc;
    }));
    if (incomplete) storageLoadCompromised = true;
    storageLoadComplete = !incomplete && !storageLoadCompromised;
    const needsMetadataMigration = stored.some((item) => !item.protocol
      || !item.origins
      || (item.cloudflareAccessConfigured === true && !item.cloudflareAccessOrigin)
      || Object.prototype.hasOwnProperty.call(item, 'secret')
      || Object.prototype.hasOwnProperty.call(item, 'cloudflareAccess'));
    if (!incomplete && (migrated || needsMetadataMigration)) {
      await AsyncStorage.setItem(KEY, JSON.stringify(pcs.map(withoutCredentials)));
    }
    return pcs;
  } catch {
    storageLoadCompromised = true;
    storageLoadComplete = false;
    return [];
  }
}

export async function savePcs(pcs: SavedPc[]): Promise<void> {
  if (!storageLoadComplete) throw new Error('보안 저장소를 완전히 읽지 못했습니다. 앱을 다시 열고 자격증명을 확인해 주세요.');
  const previous = await readStoredPcs();
  const normalized = pcs.map((pc) => normalizePc({ ...pc, credentialStatus: pc.secret ? 'ok' : pc.credentialStatus }));
  try {
    await Promise.all(normalized.map(async (pc) => {
      if (pc.secret) await SecureStore.setItemAsync(secretKey(pc.id), pc.secret);
      else if (!pc.credentialStatus || pc.credentialStatus === 'ok') await SecureStore.deleteItemAsync(secretKey(pc.id));
      if (pc.cloudflareAccess) {
        const access = normalizeCloudflareAccess(pc.cloudflareAccess)!;
        await Promise.all([
          SecureStore.setItemAsync(cloudflareAccessClientIdKey(pc.id), access.clientId),
          SecureStore.setItemAsync(cloudflareAccessClientSecretKey(pc.id), access.clientSecret),
        ]);
      } else if (pc.cloudflareAccessConfigured) {
        throw new Error(`${pc.name}: Cloudflare Access 자격증명을 보안 저장소에서 읽지 못했습니다.`);
      } else {
        await Promise.all([
          SecureStore.deleteItemAsync(cloudflareAccessClientIdKey(pc.id)),
          SecureStore.deleteItemAsync(cloudflareAccessClientSecretKey(pc.id)),
        ]);
      }
    }));
    await AsyncStorage.setItem(KEY, JSON.stringify(normalized.map(withoutCredentials)));
    const retained = new Set(normalized.map((pc) => pc.id));
    await Promise.all(previous.filter((pc) => !retained.has(pc.id)).flatMap((pc) => [
      SecureStore.deleteItemAsync(secretKey(pc.id)),
      SecureStore.deleteItemAsync(cloudflareAccessClientIdKey(pc.id)),
      SecureStore.deleteItemAsync(cloudflareAccessClientSecretKey(pc.id)),
    ]));
  } catch (error) {
    storageLoadCompromised = true;
    storageLoadComplete = false;
    throw error;
  }
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
): Promise<string> {
  const base = assertSecureRemoteOrigin(origin);
  const binding = cloudflareAccess ? assertSecureRemoteOrigin(cloudflareAccessOrigin ?? base) : undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { ...cloudflareAccessHeaders(cloudflareAccess, binding, base), 'content-type': 'application/json' },
      body: JSON.stringify({ pin: pin.trim(), deviceName, permissionCap }),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `PIN 교환 실패 (HTTP ${res.status})`);
    }
    const body = (await res.json()) as { secret: string };
    return body.secret;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('PC 연결 시간이 초과되었습니다.');
    throw error;
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
): Promise<{ origin: string; secret: string }> {
  let lastError: unknown = new Error('연결 가능한 PC 주소가 없습니다.');
  for (const origin of [...new Set(origins.filter(Boolean))]) {
    try {
      const secret = await exchangePin(origin, pin, deviceName, 'ask', 4500, cloudflareAccess, cloudflareAccessOrigin);
      return { origin, secret };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
