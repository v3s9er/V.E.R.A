import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolPortalHttpClient, ToolPortalHttpError } from '../src/tool-portal-client.js';
import { TOOL_PORTAL_REQUEST_PROOF_HEADER } from '../src/tool-portal-contract.js';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const REQUEST_PROOF_STORAGE_KEY = 'mr-robot.tool-portal.request-proof.v1';
const REQUEST_PROOF = 'P'.repeat(43);

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

function installWindow(): Storage {
  const sessionStorage = new MemoryStorage();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://portal.example.com' }, sessionStorage },
  });
  return sessionStorage;
}

function restoreGlobals(): void {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
}

test('portal client preserves 401 status/code and invalidates the UI session', async () => {
  const storage = installWindow();
  storage.setItem(REQUEST_PROOF_STORAGE_KEY, REQUEST_PROOF);
  let unauthorized = 0;
  const activity: number[] = [];
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'expired', code: 'PORTAL_UNAUTHORIZED' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const client = new ToolPortalHttpClient(() => { unauthorized += 1; }, (count) => activity.push(count));
    await assert.rejects(
      client.call('sslscan', 'status', {}, { timeoutMs: 1_000 }),
      (error: unknown) => error instanceof ToolPortalHttpError
        && error.status === 401 && error.code === 'PORTAL_UNAUTHORIZED',
    );
    assert.equal(unauthorized, 1);
    assert.equal(storage.getItem(REQUEST_PROOF_STORAGE_KEY), null);
    assert.deepEqual(activity, [1, 0]);
  } finally {
    restoreGlobals();
  }
});

test('portal client abortAll cancels hidden work and releases activity state', async () => {
  const storage = installWindow();
  storage.setItem(REQUEST_PROOF_STORAGE_KEY, REQUEST_PROOF);
  const activity: number[] = [];
  globalThis.fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) { reject(new Error('missing abort signal')); return; }
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  try {
    const client = new ToolPortalHttpClient(undefined, (count) => activity.push(count));
    const pending = client.call('runtime-hook', 'events', { sessionId: 'session-1234' }, { timeoutMs: 30_000 });
    await Promise.resolve();
    client.abortAll('test cancellation');
    await assert.rejects(pending, /test cancellation|aborted/i);
    assert.deepEqual(activity, [1, 0]);
  } finally {
    restoreGlobals();
  }
});

test('background polling stays cancellable without toggling foreground activity', async () => {
  const storage = installWindow();
  storage.setItem(REQUEST_PROOF_STORAGE_KEY, REQUEST_PROOF);
  const activity: number[] = [];
  globalThis.fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) { reject(new Error('missing abort signal')); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  try {
    const client = new ToolPortalHttpClient(undefined, (count) => activity.push(count));
    const pending = client.call('runtime-hook', 'events', { sessionId: 'session-1234' }, { timeoutMs: 30_000, background: true });
    await Promise.resolve();
    client.abortAll('background cancellation');
    await assert.rejects(pending, /background cancellation|aborted/i);
    assert.deepEqual(activity, []);
  } finally {
    restoreGlobals();
  }
});

test('portal client keeps the one-time proof in sessionStorage and sends it on every authenticated request', async () => {
  const storage = installWindow();
  const seen: Array<{ path: string; proof: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const proof = new Headers(init?.headers).get(TOOL_PORTAL_REQUEST_PROOF_HEADER);
    seen.push({ path: url.pathname, proof });
    if (url.pathname === '/api/tool-portal/session' && init?.method === 'POST') {
      return new Response(JSON.stringify({
        enabled: true,
        authenticated: true,
        expiresAt: Date.now() + 60_000,
        hookMutationEnabled: false,
        requestProof: REQUEST_PROOF,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/api/tool-portal/session') {
      return new Response(JSON.stringify({ enabled: true, authenticated: true, expiresAt: Date.now() + 60_000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname.startsWith('/api/tool-portal/artifacts/')) {
      return new Response(Buffer.from('504b0506000000000000000000000000000000000000', 'hex'), {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'cache-control': 'no-store',
          'content-disposition': "attachment; filename*=UTF-8''archive.zip",
        },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = new ToolPortalHttpClient();
    const login = await client.login('correct horse portal battery');
    assert.equal(login.authenticated, true);
    assert.equal(Object.hasOwn(login as object, 'requestProof'), false);
    assert.equal(storage.getItem(REQUEST_PROOF_STORAGE_KEY), REQUEST_PROOF);
    await client.session();
    await client.call('sslscan', 'status', {});
    await client.downloadArtifact('A'.repeat(43));
    await client.logout();
    assert.equal(storage.getItem(REQUEST_PROOF_STORAGE_KEY), null);
    assert.equal(seen[0]?.proof, null);
    assert.deepEqual(seen.slice(1).map((entry) => entry.proof), [REQUEST_PROOF, REQUEST_PROOF, REQUEST_PROOF, REQUEST_PROOF]);
  } finally {
    restoreGlobals();
  }
});

test('portal client refuses cookie-backed actions when the origin-scoped proof is missing', async () => {
  installWindow();
  let fetches = 0;
  let unauthorized = 0;
  globalThis.fetch = async () => { fetches += 1; return new Response('{}'); };
  try {
    const client = new ToolPortalHttpClient(() => { unauthorized += 1; });
    await assert.rejects(
      client.call('sslscan', 'status', {}),
      (error: unknown) => error instanceof ToolPortalHttpError
        && error.status === 401 && error.code === 'PORTAL_UNAUTHORIZED',
    );
    assert.equal(fetches, 0);
    assert.equal(unauthorized, 1);
  } finally {
    restoreGlobals();
  }
});
