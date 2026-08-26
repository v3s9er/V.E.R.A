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
  secret: string;
  addedAt: number;
}

const KEY = 'mr-robot.pcs';
const LAST_KEY = 'mr-robot.lastPcId';

export function loadPcs(): SavedPc[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as SavedPc[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function savePcs(pcs: SavedPc[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pcs));
  } catch {
    /* storage unavailable */
  }
}

export function upsertPc(pcs: SavedPc[], pc: Omit<SavedPc, 'id' | 'addedAt'>): SavedPc[] {
  const existing = pcs.find((p) => p.host === pc.host && p.port === pc.port);
  if (existing) {
    return pcs.map((p) => (p.host === pc.host && p.port === pc.port ? { ...p, ...pc, id: p.id, addedAt: p.addedAt } : p));
  }
  return [...pcs, { ...pc, id: `pc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, addedAt: Date.now() }];
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
    const res = await fetch('/api/pairing', { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const info = (await res.json()) as { deviceName?: string; qrPayload: string; localSecret?: string };
    const payload = parsePairingPayload(info.qrPayload);
    if (!payload || !info.localSecret) return null;
    // Prefer the actual hostname the browser used (works for 127.0.0.1 too).
    const host = window.location.hostname && window.location.hostname !== 'localhost'
      ? window.location.hostname
      : payload.host;
    return {
      name: info.deviceName || payload.host,
      host,
      hosts: [...new Set([host, ...(payload.hosts ?? [])])],
      port: payload.port,
      secret: info.localSecret,
    };
  } catch {
    return null;
  }
}

/** Exchange a short PIN for the long-lived secret on a (possibly remote) PC. */
export async function exchangePin(hostPort: string, pin: string, deviceName = '웹 브라우저', permissionCap = 'ask'): Promise<string> {
  const target = hostPort.trim();
  const scheme = window.location.protocol === 'https:' ? 'https' : 'http';
  const base = target.startsWith('http') ? target : `${scheme}://${target}`;
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
