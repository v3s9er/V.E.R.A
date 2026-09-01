import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type { SavedPc } from './types';

const KEY = 'mr-robot.pcs';
const LAST_KEY = 'mr-robot.lastPcId';
const SECRET_PREFIX = 'mr-robot.pc.secret.';

type StoredPc = Omit<SavedPc, 'secret'> & { secret?: string };
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

function withoutSecret(pc: SavedPc): Omit<SavedPc, 'secret'> {
  const { secret: _secret, credentialStatus: _credentialStatus, ...metadata } = pc;
  return metadata;
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

export function connectionOrigins(pc: SavedPc): string[] {
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

export function httpBaseForPc(pc: SavedPc): string {
  const origin = connectionOrigins(pc)[0];
  if (!origin) throw new Error('이 PC에 HTTPS 접속 주소가 없습니다. Cloudflare 또는 Tailscale Serve 주소로 다시 등록하세요.');
  return origin;
}

function normalizePc<T extends StoredPc | SavedPc>(pc: T): T {
  const protocol = pc.protocol ?? 'http';
  const origins = connectionOrigins({ ...pc, protocol, secret: 'secret' } as SavedPc);
  const requestedActive = pc.activeOrigin && tryOrigin(pc.activeOrigin, pc.port, protocol);
  const activeOrigin = requestedActive && origins.includes(requestedActive) ? requestedActive : origins[0];
  return { ...pc, protocol, origins, activeOrigin };
}

export async function loadPcs(): Promise<SavedPc[]> {
  try {
    const stored = await readStoredPcs();
    let migrated = false;
    let incomplete = false;
    const pcs = await Promise.all(stored.map(async (rawItem) => {
      const item = normalizePc(rawItem);
      let secureSecret: string | null = null;
      let itemUnavailable = false;
      try {
        secureSecret = await SecureStore.getItemAsync(secretKey(item.id));
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
      const { secret: _legacySecret, ...metadata } = item;
      return { ...metadata, secret, credentialStatus: itemUnavailable && !secret ? 'unavailable' : secret ? 'ok' : 'missing' } as SavedPc;
    }));
    if (incomplete) storageLoadCompromised = true;
    storageLoadComplete = !incomplete && !storageLoadCompromised;
    const needsMetadataMigration = stored.some((item) => !item.protocol || !item.origins || Object.prototype.hasOwnProperty.call(item, 'secret'));
    if (!incomplete && (migrated || needsMetadataMigration)) {
      await AsyncStorage.setItem(KEY, JSON.stringify(pcs.map(withoutSecret)));
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
  await Promise.all(normalized.map(async (pc) => {
    if (pc.secret) await SecureStore.setItemAsync(secretKey(pc.id), pc.secret);
    else if (!pc.credentialStatus || pc.credentialStatus === 'ok') await SecureStore.deleteItemAsync(secretKey(pc.id));
  }));
  await AsyncStorage.setItem(KEY, JSON.stringify(normalized.map(withoutSecret)));
  const retained = new Set(normalized.map((pc) => pc.id));
  await Promise.all(previous.filter((pc) => !retained.has(pc.id)).map((pc) => SecureStore.deleteItemAsync(secretKey(pc.id))));
}

export async function upsertPc(pcs: SavedPc[], pc: Omit<SavedPc, 'id' | 'addedAt'>): Promise<SavedPc[]> {
  const normalized = normalizePc(pc as SavedPc);
  const targetOrigins = new Set(connectionOrigins(normalized));
  const existing = pcs.find((item) => connectionOrigins(item).some((origin) => targetOrigins.has(origin)));
  if (existing) {
    return pcs.map((item) => item.id === existing.id ? normalizePc({ ...item, ...normalized, origins: [...new Set([...connectionOrigins(item), ...connectionOrigins(normalized)])], addedAt: item.addedAt, id: item.id }) : item);
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
export async function exchangePin(origin: string, pin: string, deviceName = '모바일', permissionCap = 'ask', timeoutMs = 8000): Promise<string> {
  const base = assertSecureRemoteOrigin(origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: pin.trim(), deviceName, permissionCap }),
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

export async function exchangePinAcrossOrigins(origins: string[], pin: string, deviceName = '모바일'): Promise<{ origin: string; secret: string }> {
  let lastError: unknown = new Error('연결 가능한 PC 주소가 없습니다.');
  for (const origin of [...new Set(origins.filter(Boolean))]) {
    try {
      const secret = await exchangePin(origin, pin, deviceName, 'ask', 4500);
      return { origin, secret };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
