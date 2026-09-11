import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DiscordAttachmentStore, DiscordAttachmentError } from '../src/server/discord-attachment-store.js';
import { SafeFetchError, type fetchPublicResource } from '../src/plugins/resource-archiver/security.js';

const source = { id: '22', name: 'fixture.png', size: 11840, url: 'https://cdn.discordapp.com/attachments/11/22/fixture.png?ex=synthetic&hm=not-a-secret' };
const vault = { protect: (value: string) => `fixture:${value}`, unprotect: (value: string) => value.slice(8) };
const response = (body: Buffer) => ({ body, status: 200, mimeType: 'image/png', headers: {}, finalUrl: source.url });
type Fetcher = typeof fetchPublicResource;
function fixture(t: any, fetcher: Fetcher, timeout = 60000, keyVault = vault) {
  const root = mkdtempSync(join(tmpdir(), 'mrrobot-download-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, store: new DiscordAttachmentStore(root, keyVault as any, Date.now, fetcher, timeout) };
}
function hasCode(code: string) { return (error: unknown) => error instanceof DiscordAttachmentError && error.code === code; }

test('CDN representation size differs: store actual bytes, hash, encrypted metadata and budget', async t => {
  const bytes = Buffer.alloc(14734, 42);
  const { root, store } = fixture(t, async (_url, policy, limits, signal) => {
    assert.equal(policy.pageHost, 'cdn.discordapp.com');
    assert.equal(policy.allowedCrossOriginHosts.size, 0);
    assert.equal(limits.maxRedirects, 0);
    assert.equal(limits.maxResourceBytes, 25 * 1024 ** 2);
    assert.equal(signal?.aborted, false);
    return response(bytes);
  });
  const budget = { remaining: 50 * 1024 ** 2 };
  const saved = await store.receive('ticket', source, undefined, budget);
  assert.equal(saved.size, 14734);
  assert.equal(saved.id, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(budget.remaining, 50 * 1024 ** 2 - bytes.length);
  assert.deepEqual(store.get('ticket', saved.id).data, bytes);
  assert.throws(() => store.get('other-ticket', saved.id));
  const record = readdirSync(root).find(name => name.endsWith('.bin'))!;
  assert.ok(!readFileSync(join(root, record)).includes(bytes));
  const restarted = new DiscordAttachmentStore(root, vault as any);
  assert.deepEqual(restarted.get('ticket', saved.id).data, bytes);
});

test('smaller CDN representation is also accepted; zero-byte files remain valid', async t => {
  const { store } = fixture(t, async () => response(Buffer.from('smaller')));
  assert.equal((await store.receive('ticket', source)).size, 7);
  const empty = fixture(t, async () => response(Buffer.alloc(0)));
  assert.equal((await empty.store.receive('ticket', { ...source, size: 0 })).size, 0);
});

test('actual per-request bytes, not declared sizes, constrain following attachments', async t => {
  const limitsSeen: number[] = [];
  const { store, root } = fixture(t, async (_url, _policy, limits) => {
    limitsSeen.push(limits.maxResourceBytes);
    return response(Buffer.alloc(20, limitsSeen.length));
  });
  const budget = { remaining: 32 };
  await store.receive('ticket', { ...source, size: 1 }, undefined, budget);
  assert.equal(budget.remaining, 12);
  await assert.rejects(store.receive('ticket', { ...source, size: 1 }, undefined, budget), hasCode('DOWNLOAD_SIZE'));
  assert.deepEqual(limitsSeen, [32, 12]);
  assert.equal(readdirSync(root).filter(name => name.endsWith('.bin')).length, 1);
});

test('actual file size over 25MiB fails even if Discord advertises a small size', async t => {
  const { store, root } = fixture(t, async () => response(Buffer.alloc(25 * 1024 ** 2 + 1)));
  await assert.rejects(store.receive('ticket', source), hasCode('DOWNLOAD_SIZE'));
  assert.equal(readdirSync(root).length, 0);
});

test('transient DNS/network/server failures retry only download, with fresh byte budgets', async t => {
  let calls = 0;
  const { store } = fixture(t, async (_url, _policy, _limits, _signal, budget) => {
    assert.equal(budget?.remaining, 25 * 1024 ** 2);
    if (++calls < 3) {
      budget!.remaining -= 9;
      throw new SafeFetchError('synthetic', true, calls === 1 ? 'dns' : 'http', calls === 2 ? 503 : undefined);
    }
    return response(Buffer.from('complete'));
  });
  assert.equal((await store.receive('ticket', source)).size, 8);
  assert.equal(calls, 3);
});

test('repeated transient failures stop after three attempts and expose only safe diagnostics', async t => {
  let calls = 0;
  const { store } = fixture(t, async () => { calls++; throw new SafeFetchError(source.url, true, 'network'); });
  await assert.rejects(store.receive('ticket', source), (e: any) => {
    assert.equal(e.code, 'DOWNLOAD_NETWORK'); assert.equal(e.attempts, 3);
    assert.ok(!e.message.includes('https:') && !e.message.includes('hm='));
    return true;
  });
  assert.equal(calls, 3);
});

for (const status of [403, 404, 410]) test(`HTTP ${status} is not retried or confused with disk failure`, async t => {
  let calls = 0;
  const { store } = fixture(t, async () => { calls++; throw new SafeFetchError(source.url, false, 'http', status); });
  await assert.rejects(store.receive('ticket', source), hasCode(`HTTP_${status}`));
  assert.equal(calls, 1);
});

test('policy failures remain closed and do not retry', async t => {
  let calls = 0;
  const { store } = fixture(t, async () => { calls++; throw new SafeFetchError('redirect blocked'); });
  await assert.rejects(store.receive('ticket', source), hasCode('DOWNLOAD_POLICY'));
  assert.equal(calls, 1);
  await assert.rejects(store.receive('ticket', { ...source, url: 'https://example.test/attachments/11/22/a' }));
  assert.equal(calls, 1);
});

test('incomplete response never enters the store, even if partial size matches metadata', async t => {
  const { store, root } = fixture(t, async () => { throw new SafeFetchError('partial response', true, 'body'); });
  await assert.rejects(store.receive('ticket', source), hasCode('DOWNLOAD_BODY'));
  assert.equal(readdirSync(root).length, 0);
});

test('caller cancellation remains cancellation, not a download failure or retry', async t => {
  let calls = 0;
  const stop = new AbortController(), reason = new Error('user cancelled');
  const { store, root } = fixture(t, async () => { calls++; stop.abort(reason); throw new SafeFetchError('network', true, 'network'); });
  await assert.rejects(store.receive('ticket', source, stop.signal), error => error === reason);
  assert.equal(calls, 1);
  assert.equal(readdirSync(root).length, 0);
  await assert.rejects(store.receive('ticket', source, stop.signal), error => error === reason);
  assert.equal(calls, 1);
});

test('whole-intake deadline aborts in-flight download and is reported as timeout', async t => {
  const { store } = fixture(t, async (_url, _policy, _limits, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }), 15);
  // Keep the test process alive; production network handles keep their own lifecycle.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(store.receive('ticket', source), hasCode('DOWNLOAD_TIMEOUT')); }
  finally { clearTimeout(keepAlive); }
});

for (const [raw, expected] of [['ENOSPC', 'STORAGE_SPACE'], ['EPERM', 'STORAGE_PERMISSION'], ['unknown', 'STORAGE_WRITE']]) {
  test(`storage failure ${raw} is distinct and never re-downloads`, async t => {
    let calls = 0;
    const { store } = fixture(t, async () => { calls++; return response(Buffer.from('complete')); });
    store.put = () => { throw Object.assign(new Error('private-path-secret'), { code: raw }); };
    await assert.rejects(store.receive('ticket', source), (error: any) => {
      assert.equal(error.code, expected); assert.ok(!error.message.includes('private-path')); return true;
    });
    assert.equal(calls, 1);
  });
}

test('failed encryption key persistence is not cached; retry stores a reopenable key', async t => {
  let protectCalls = 0;
  const keyVault = { ...vault, protect: (value: string) => {
    if (++protectCalls === 1) throw new Error('synthetic DPAPI failure');
    return vault.protect(value);
  } };
  const { store, root } = fixture(t, async () => response(Buffer.from('complete')), 60000, keyVault);
  await assert.rejects(store.receive('ticket', source), hasCode('STORAGE_KEY'));
  const saved = await store.receive('ticket', source);
  assert.equal(protectCalls, 2);
  assert.equal(new DiscordAttachmentStore(root, vault as any).get('ticket', saved.id).data.toString(), 'complete');
});
