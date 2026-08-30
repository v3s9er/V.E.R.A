import { parsePairingPayload } from './rpc';

/**
 * Multi-PC registry stored in localStorage. Each entry holds everything
 * needed to reach one Mr.Robot agent: host, port and its pairing secret.
 * The web UI can register any number of PCs and switch between them.
 */

export interface SavedPc {
  id: string;
  name: string;
  host: string;
  hosts?: string[];
  activeHost?: string;
  port: number;
  protocol?: 'http' | 'https';
  /** Canonical HTTP(S) origins, each retaining its own scheme and port. */
  origins?: string[];
  /** Last origin that completed an authenticated WebSocket connection. */
  activeOrigin?: string;
  secret: string;
  addedAt: number;
}

export type DesktopPcLoadResult =
  | { ok: true; value: SavedPc[]; recovered?: boolean }
  | { ok: false; error: string };

export type PcProtocol = 'http' | 'https';

export interface ParsedPcEndpoint {
  host: string;
  port: number;
  protocol: PcProtocol;
  origin: string;
}

const KEY = 'mr-robot.pcs';
const LAST_KEY = 'mr-robot.lastPcId';

export function loadPcs(): SavedPc[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as SavedPc[];
    if (!Array.isArray(arr)) return [];
    const normalized = arr.filter(isSavedPcLike).map(normalizePc);
    if (JSON.stringify(arr) !== JSON.stringify(normalized)) savePcs(normalized);
    return normalized;
  } catch {
    return [];
  }
}

export function savePcs(pcs: SavedPc[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pcs.map(normalizePc)));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Electron keeps long-lived device credentials in Windows safeStorage.
 * Browsers retain the legacy local registry because they do not expose an OS
 * credential vault. Existing desktop entries are migrated on first launch.
 */
export async function loadPcsForEnvironment(): Promise<SavedPc[]> {
  if (!window.mrRobotDesktop?.loadPcs) return loadPcs();
  // A secure-registry read failure is not an empty registry. Never overwrite
  // or legacy-migrate after failure because that could destroy recoverable
  // credentials in the primary/previous encrypted files.
  const loaded = await window.mrRobotDesktop.loadPcs();
  const result: DesktopPcLoadResult = Array.isArray(loaded)
    ? { ok: true, value: loaded }
    : loaded;
  if (!result.ok) throw new Error(result.error || '암호화된 PC 연결 정보를 읽지 못했습니다.');
  const encrypted = result.value.filter(isSavedPcLike).map(normalizePc);
  if (encrypted.length) {
    if (JSON.stringify(result.value) !== JSON.stringify(encrypted)) await window.mrRobotDesktop.savePcs(encrypted);
    return encrypted;
  }
  const legacy = loadPcs();
  if (legacy.length) {
    await window.mrRobotDesktop.savePcs(legacy);
    try { localStorage.removeItem(KEY); } catch { /* best effort migration */ }
  }
  return legacy;
}

export async function savePcsForEnvironment(pcs: SavedPc[]): Promise<void> {
  const normalized = pcs.map(normalizePc);
  if (window.mrRobotDesktop?.savePcs) {
    const saved = await window.mrRobotDesktop.savePcs(normalized);
    if (!saved?.ok) throw new Error('암호화된 PC 연결 정보를 저장하지 못했습니다.');
    return;
  }
  savePcs(normalized);
}

export function upsertPc(pcs: SavedPc[], pc: Omit<SavedPc, 'id' | 'addedAt'>): SavedPc[] {
  const normalized = normalizePc(pc as SavedPc);
  const incomingOrigins = new Set(connectionOrigins(normalized));
  const existing = pcs.find((item) => connectionOrigins(item).some((origin) => incomingOrigins.has(origin)));
  if (existing) {
    return pcs.map((item) => item.id === existing.id
      ? normalizePc({ ...item, ...normalized, origins: [...new Set([...connectionOrigins(item), ...connectionOrigins(normalized)])], id: item.id, addedAt: item.addedAt })
      : normalizePc(item));
  }
  return [...pcs.map(normalizePc), { ...normalized, id: `pc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, addedAt: Date.now() }];
}

export function removePc(pcs: SavedPc[], id: string): SavedPc[] {
  return pcs.filter((p) => p.id !== id);
}

export function getLastPcId(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export function setLastPcId(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_KEY, id);
    else localStorage.removeItem(LAST_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Detect the agent that is serving this page (same origin). Works when the
 * page is opened on the PC itself or through the dev proxy; returns null
 * from remote browsers (pairing info is loopback-only).
 */
export async function detectServingPc(): Promise<Omit<SavedPc, 'id' | 'addedAt'> | null> {
  try {
    if (window.mrRobotDesktop) {
      const local = await window.mrRobotDesktop.getLocalConnection();
      const origin = originFromParts('http', local.host, local.port);
      return { ...local, hosts: [local.host], protocol: 'http', origins: [origin], activeOrigin: origin };
    }
    const res = await fetch('/api/pairing', { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const info = (await res.json()) as { deviceName?: string; qrPayload: string; localSecret?: string };
    const payload = parsePairingPayload(info.qrPayload);
    if (!payload || !info.localSecret) return null;
    // Prefer the actual hostname the browser used (works for 127.0.0.1 too).
    const host = window.location.hostname && window.location.hostname !== 'localhost'
      ? window.location.hostname
      : payload.host;
    const protocol = window.location.protocol === 'https:' ? 'https' : 'http';
    const primary = originFromParts(protocol, host, payload.port);
    const lanOrigins = (payload.hosts ?? []).map((item) => originForDiscoveredHost(item, payload.port));
    return {
      name: info.deviceName || payload.host,
      host,
      hosts: [...new Set([host, ...(payload.hosts ?? [])])],
      port: payload.port,
      protocol,
      origins: [...new Set([primary, ...lanOrigins])],
      activeOrigin: primary,
      secret: info.localSecret,
    };
  } catch {
    return null;
  }
}

function isPrivateOrLocalHost(value: string): boolean {
  const host = value.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.')) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return true;
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
}

export function formatHostPort(host: string, port: number): string {
  const literal = host.replace(/^\[|\]$/g, '');
  return `${literal.includes(':') ? `[${literal}]` : literal}:${port}`;
}

export function originFromParts(protocol: PcProtocol, host: string, port: number): string {
  return `${protocol}://${formatHostPort(host, port)}`;
}

function isLoopbackHost(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

function isTailnetHost(host: string): boolean {
  const octets = host.replace(/^\[|\]$/g, '').split('.').map(Number);
  return octets.length === 4
    && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    && octets[0] === 100
    && octets[1] >= 64
    && octets[1] <= 127;
}

export function assertSecurePcOrigin(origin: string): string {
  const endpoint = parsePcEndpoint(origin);
  if (endpoint.protocol !== 'https' && !isLoopbackHost(endpoint.host) && !isTailnetHost(endpoint.host)) {
    throw new Error('평문 LAN 인증은 차단됩니다. Cloudflare Quick Link(HTTPS) 또는 Tailscale 주소를 사용하세요.');
  }
  return endpoint.origin;
}

export function parsePcEndpoint(value: string, defaultPort = 8787, defaultProtocol?: PcProtocol): ParsedPcEndpoint {
  const raw = value.trim();
  if (!raw) throw new Error('PC 주소를 입력하세요.');
  const explicitScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw);
  const probe = new URL(explicitScheme ? raw : `http://${raw}`);
  const pageProtocol: PcProtocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'https' : 'http';
  const fallback = isPrivateOrLocalHost(probe.hostname)
    ? 'http'
    : defaultProtocol ?? pageProtocol;
  const parsed = new URL(explicitScheme ? raw : `${fallback}://${raw}`);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('HTTP 또는 HTTPS 주소만 사용할 수 있습니다.');
  if (parsed.username || parsed.password) throw new Error('주소에 사용자 이름이나 비밀번호를 넣을 수 없습니다.');
  const protocol = parsed.protocol.slice(0, -1) as 'http' | 'https';
  const port = Number(parsed.port || (protocol === 'https' ? 443 : defaultPort));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('포트 번호가 올바르지 않습니다.');
  return { host: parsed.hostname.replace(/^\[|\]$/g, ''), port, protocol, origin: originFromParts(protocol, parsed.hostname, port) };
}

function tryOrigin(value: string, defaultPort = 8787, defaultProtocol?: PcProtocol): string | null {
  try { return parsePcEndpoint(value, defaultPort, defaultProtocol).origin; } catch { return null; }
}

export function originForDiscoveredHost(value: string, port: number): string {
  if (/^https?:\/\//i.test(value)) return parsePcEndpoint(value, port).origin;
  return originFromParts('http', value, port);
}

export function connectionOrigins(pc: Pick<SavedPc, 'host' | 'hosts' | 'activeHost' | 'port' | 'protocol' | 'origins' | 'activeOrigin'>): string[] {
  const protocol = pc.protocol ?? 'http';
  const primary = originFromParts(protocol, pc.host, pc.port);
  const legacy = [pc.activeHost, ...(pc.hosts ?? [])]
    .filter((value): value is string => Boolean(value))
    .map((host) => /^https?:\/\//i.test(host) ? tryOrigin(host, pc.port, protocol) : originForDiscoveredHost(host, pc.port));
  return [...new Set([
    pc.activeOrigin && tryOrigin(pc.activeOrigin, pc.port, protocol),
    ...(pc.origins ?? []).map((origin) => tryOrigin(origin, pc.port, protocol)),
    primary,
    ...legacy,
  ].filter((value): value is string => Boolean(value)))]
    .filter((origin) => {
      try { assertSecurePcOrigin(origin); return true; } catch { return false; }
    });
}

export function pcOrigin(pc: Pick<SavedPc, 'host' | 'hosts' | 'activeHost' | 'port' | 'protocol' | 'origins' | 'activeOrigin'>, candidate?: string): string {
  if (candidate) {
    const origin = /^https?:\/\//i.test(candidate)
      ? parsePcEndpoint(candidate, pc.port, pc.protocol ?? 'http').origin
      : originForDiscoveredHost(candidate, pc.port);
    return assertSecurePcOrigin(origin);
  }
  const origin = connectionOrigins(pc)[0];
  if (!origin) throw new Error('이 PC에 보안 접속 주소가 없습니다. Quick Link 또는 Tailscale로 다시 등록하세요.');
  return origin;
}

function isSavedPcLike(value: unknown): value is SavedPc {
  const pc = value as Partial<SavedPc> | null;
  return Boolean(pc && typeof pc === 'object' && typeof pc.id === 'string' && typeof pc.name === 'string'
    && typeof pc.host === 'string' && Number.isInteger(pc.port) && typeof pc.secret === 'string');
}

function normalizePc<T extends SavedPc>(pc: T): T {
  const protocol = pc.protocol ?? 'http';
  const origins = connectionOrigins({ ...pc, protocol });
  const requestedActive = pc.activeOrigin && tryOrigin(pc.activeOrigin, pc.port, protocol);
  const activeOrigin = requestedActive && origins.includes(requestedActive) ? requestedActive : origins[0];
  return { ...pc, protocol, origins, activeOrigin };
}

/** Exchange a short PIN for the long-lived secret on a (possibly remote) PC. */
export async function exchangePin(hostPort: string, pin: string, deviceName = '웹 브라우저', permissionCap = 'ask'): Promise<string> {
  const base = assertSecurePcOrigin(parsePcEndpoint(hostPort).origin);
  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: pin.trim(), deviceName, permissionCap }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `PIN 교환 실패 (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { secret: string };
  return body.secret;
}
