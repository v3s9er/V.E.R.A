import assert from 'node:assert/strict';
import { connectionOrigins, loadPcsForEnvironment, upsertPc, type DesktopPcLoadResult, type SavedPc } from '../src/pcs';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

const KEY = 'mr-robot.pcs';
const local = new MemoryStorage();
const session = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: session });

const pc: SavedPc = {
  id: 'remote-1',
  name: 'Remote',
  host: 'robot.example.com',
  port: 443,
  protocol: 'https',
  origins: ['https://robot.example.com'],
  activeOrigin: 'https://robot.example.com',
  secret: 'test-device-bearer',
  addedAt: 1,
};

async function loadWith(result: DesktopPcLoadResult, saves: SavedPc[][]): Promise<SavedPc[]> {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      mrRobotDesktop: {
        loadPcs: async () => result,
        savePcs: async (value: SavedPc[]) => { saves.push(value); return { ok: true }; },
      },
    },
  });
  return await loadPcsForEnvironment();
}

{
  local.setItem(KEY, JSON.stringify([{ ...pc, secret: 'stale-local-bearer' }]));
  session.setItem(KEY, JSON.stringify([{ ...pc, secret: 'stale-session-bearer' }]));
  const loaded = await loadWith({ ok: true, value: [pc] }, []);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.secret, pc.secret);
  assert.equal(local.getItem(KEY), null, 'secure desktop load must erase stale durable browser bearer');
  assert.equal(session.getItem(KEY), null, 'secure desktop load must erase stale session bearer');
}

{
  local.setItem(KEY, JSON.stringify([pc]));
  const saves: SavedPc[][] = [];
  const loaded = await loadWith({ ok: true, value: [] }, saves);
  assert.equal(loaded.length, 1, 'legacy remote entry should migrate into safeStorage');
  assert.equal(saves.length, 1);
  assert.equal(saves[0]?.[0]?.secret, pc.secret);
  assert.equal(local.getItem(KEY), null);
  assert.equal(session.getItem(KEY), null);
}

{
  local.setItem(KEY, JSON.stringify([pc]));
  session.setItem(KEY, JSON.stringify([pc]));
  await assert.rejects(() => loadWith({ ok: false, error: 'vault unavailable' }, []), /vault unavailable/);
  assert.notEqual(local.getItem(KEY), null, 'failed secure read must preserve recoverable legacy state');
  assert.notEqual(session.getItem(KEY), null, 'failed secure read must preserve recoverable session state');
}

{
  const secondOrigin = 'https://laptop.example.com:443';
  const mesh = upsertPc([pc], {
    name: 'Laptop',
    host: 'laptop.example.com',
    port: 443,
    protocol: 'https',
    origins: [secondOrigin],
    activeOrigin: secondOrigin,
    credentialOrigin: secondOrigin,
    secret: 'second-device-bearer',
  });
  assert.equal(mesh.length, 2, 'a controller must retain two independent execution PCs');
  assert.deepEqual(mesh.map((item) => connectionOrigins(item)[0]), [
    'https://robot.example.com:443',
    secondOrigin,
  ]);

  const updated = upsertPc(mesh, {
    name: 'Laptop renamed',
    host: 'laptop.example.com',
    port: 443,
    protocol: 'https',
    origins: [secondOrigin],
    activeOrigin: secondOrigin,
    credentialOrigin: secondOrigin,
    secret: 'rotated-second-device-bearer',
  });
  assert.equal(updated.length, 2, 'updating one execution PC must not replace another host');
  assert.equal(updated[1]?.id, mesh[1]?.id, 'host selection identity must remain stable after re-pairing');
}

console.log('web PC credential-storage tests passed');
