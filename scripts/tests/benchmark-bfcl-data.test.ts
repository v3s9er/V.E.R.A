import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { BFCL_FILES, BFCL_REVISION, benchmarkHash, downloadBfclCache, readBfclCache } from '../benchmark-bfcl-data.js';

function cache() {
  const root = resolve(tmpdir()), path = mkdtempSync(join(root, 'mrrobot-bfcl-unit-'));
  return { path, dispose() { assert.ok(resolve(path).startsWith(`${root}${sep}mrrobot-bfcl-unit-`)); rmSync(path, { recursive: true, force: true }); } };
}
test('snapshot has immutable upstream identity and only data/license resources', () => {
  assert.match(BFCL_REVISION, /^[a-f0-9]{40}$/);
  assert.equal(BFCL_FILES.length, 8);
  assert.equal(new Set(BFCL_FILES.map(f => f.file)).size, 8);
  for (const file of BFCL_FILES) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.ok(file.path === 'LICENSE' || /^berkeley-function-call-leaderboard\/bfcl_eval\/data\/(possible_answer\/)?BFCL_v4_(simple_python|multiple|parallel|irrelevance)\.json$/.test(file.path));
    assert.ok(!file.file.includes('/') && !file.file.includes('\\'));
  }
});
test('cache never accepts a forged or modified corpus', () => {
  const dir = cache();
  try { for (const file of BFCL_FILES) writeFileSync(join(dir.path, file.file), '{}\n'); assert.throws(() => readBfclCache(dir.path), /checksum/); }
  finally { dir.dispose(); }
});
test('download refuses overwrite of an existing unverified file before network use', async () => {
  const dir = cache(), old = globalThis.fetch;
  try {
    writeFileSync(join(dir.path, 'LICENSE'), 'preserve me');
    globalThis.fetch = (async () => { throw new Error('Network must not run'); }) as typeof fetch;
    await assert.rejects(downloadBfclCache(dir.path), /refusing overwrite/);
    assert.equal(readFileSync(join(dir.path, 'LICENSE'), 'utf8'), 'preserve me');
  } finally { globalThis.fetch = old; dir.dispose(); }
});
test('download uses pinned allowlisted URL, blocks redirects, verifies bytes before saving', async () => {
  const dir = cache(), old = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async (url, init) => {
      calls++;
      assert.equal(url, `https://raw.githubusercontent.com/ShishirPatil/gorilla/${BFCL_REVISION}/LICENSE`);
      assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
      return new Response('not the pinned license');
    }) as typeof fetch;
    await assert.rejects(downloadBfclCache(dir.path), /checksum/);
    assert.equal(calls, 1);
    assert.throws(() => readFileSync(join(dir.path, 'LICENSE')), /ENOENT/);
  } finally { globalThis.fetch = old; dir.dispose(); }
});
test('identity digest is stable and content sensitive', () => {
  assert.equal(benchmarkHash('hello'), benchmarkHash(Buffer.from('hello')));
  assert.notEqual(benchmarkHash('hello'), benchmarkHash('hello\n'));
});
