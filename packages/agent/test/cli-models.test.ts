import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { discoverCodexModels, ModelListCache } from '../src/ai/cli-models.js';
import { discordModelAllowed } from '../src/plugins/discord-model-policy.js';
const probe = (mode: string) => discoverCodexModels({ command: process.execPath,
  prefixArgs: [fileURLToPath(new URL('./fixtures/codex-models-fixture.mjs', import.meta.url))],
  env: { ...process.env, MRROBOT_MODEL_FIXTURE: mode }, timeoutMs: mode === 'timeout' ? 250 : 3000 });
assert.deepEqual(await probe('normal'), ['gpt-new-catalog-model', 'catalog-second-model']);
for (const mode of ['timeout', 'request', 'error', 'invalid', 'cycle', 'empty']) {
  await assert.rejects(probe(mode), error => error instanceof Error && !error.message.includes('private-fixture-value'));
}
let now = 0, calls = 0, fail = false;
const cache = new ModelListCache(async () => { calls++; await Promise.resolve(); if (fail) throw Error('private'); return [`model-${calls}`]; }, () => ['offline-default'], () => now);
const [one, two] = await Promise.all([cache.get(), cache.get(true)]);
assert.equal(calls, 1); assert.deepEqual(one, two);
one.push('mutated'); assert.deepEqual(await cache.get(), ['model-1']);
now = 299_999; await cache.get(); assert.equal(calls, 1);
now = 300_001; assert.deepEqual(await cache.get(), ['model-2']);
now += 5001; assert.deepEqual(await cache.get(true), ['model-3']);
await cache.get(true); assert.equal(calls, 3); // Button spam is coalesced/throttled.
fail = true; now += 5001;
await assert.rejects(cache.get(true), /기존 목록/);
assert.deepEqual(await cache.get(), ['model-3']); assert.equal(calls, 4);
await assert.rejects(cache.get(true)); assert.equal(calls, 4);
now += 30_001; fail = false; assert.deepEqual(await cache.get(), ['model-5']);
const unavailable = new ModelListCache(async () => { throw Error('private'); }, () => ['saved-model']);
assert.deepEqual(await unavailable.get(), ['saved-model']);
await assert.rejects(unavailable.get(true));
assert.equal(discordModelAllowed('sol', 'gpt-new-catalog-model'), false);
assert.equal(discordModelAllowed('astra', 'gpt-new-catalog-model'), false);
console.log('MODEL CATALOG TESTS PASSED: live protocol, pagination, hidden models, failure/timeout, TTL, force refresh, isolation.');
