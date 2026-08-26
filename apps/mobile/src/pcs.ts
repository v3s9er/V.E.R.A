import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SavedPc } from './types';

const KEY = 'mr-robot.pcs';
const LAST_KEY = 'mr-robot.lastPcId';

export async function loadPcs(): Promise<SavedPc[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as SavedPc[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function savePcs(pcs: SavedPc[]): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(pcs));
  } catch {
    /* ignore */
  }
}

export async function upsertPc(pcs: SavedPc[], pc: Omit<SavedPc, 'id' | 'addedAt'>): Promise<SavedPc[]> {
  const existing = pcs.find((p) => p.host === pc.host && p.port === pc.port);
  if (existing) {
    return pcs.map((p) => (p.host === pc.host && p.port === pc.port ? { ...p, ...pc, addedAt: p.addedAt, id: p.id } : p));
  }
  const created: SavedPc = { ...pc, id: `pc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, addedAt: Date.now() };
  return [...pcs, created];
}

export async function removePc(pcs: SavedPc[], id: string): Promise<SavedPc[]> {
  return pcs.filter((p) => p.id !== id);
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
    /* ignore */
  }
}

/** Exchange the 6-digit PIN for the long-lived secret. */
export async function exchangePin(hostPort: string, pin: string, deviceName = '모바일', permissionCap = 'ask'): Promise<string> {
  const target = hostPort.trim();
  const base = target.startsWith('http') ? target : `http://${target}`;
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
