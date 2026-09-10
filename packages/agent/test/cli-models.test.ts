import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { discoverCodexModels, discoverCodexVersion, ModelDiscoveryError, ModelListCache } from '../src/ai/cli-models.js';
import { discordModelAllowed } from '../src/plugins/discord-model-policy.js';
import { CliProvider } from '../src/ai/cli.js';
const options = (mode: string) => ({ command: process.execPath,
  prefixArgs: [fileURLToPath(new URL('./fixtures/codex-models-fixture.mjs', import.meta.url))],
  env: { ...process.env, MRROBOT_MODEL_FIXTURE: mode }, timeoutMs: mode.includes('timeout') ? 250 : 3000 });
const probe = (mode: string) => discoverCodexModels(options(mode));
assert.deepEqual(await probe('normal'), ['gpt-6-astra', 'gpt-new-catalog-model', 'gpt-daybreak-blue-latest', 'catalog-second-model']);
assert.equal(await discoverCodexVersion(options('normal')), '0.153.4');
assert.equal(await discoverCodexVersion(options('private-version')), undefined);
assert.equal(await discoverCodexVersion(options('version-timeout')), undefined);
for (const mode of ['timeout', 'request', 'error', 'invalid', 'cycle', 'empty', 'unsupported', 'missing-method']) {
  await assert.rejects(probe(mode), error => error instanceof Error && !error.message.includes('private-fixture-value'));
}
await assert.rejects(probe('unsupported'), error => error instanceof ModelDiscoveryError && error.reason === 'unsupported');
await assert.rejects(probe('missing-method'), error => error instanceof ModelDiscoveryError && error.reason === 'unsupported');
await assert.rejects(probe('timeout'), error => error instanceof ModelDiscoveryError && error.reason === 'timeout');
await assert.rejects(probe('empty'), error => error instanceof ModelDiscoveryError && error.reason === 'empty');
let now = 0, calls = 0, fail = false;
const cache = new ModelListCache(async () => { calls++; await Promise.resolve(); if (fail) throw Error('private'); return [`model-${calls}`]; }, () => ['offline-default'], () => now);
assert.deepEqual(cache.status(), { state: 'fallback', lastUpdatedAt: null, lastAttemptAt: null });
const [one, two] = await Promise.all([cache.get(), cache.get(true)]);
assert.equal(calls, 1); assert.deepEqual(one, two);
assert.deepEqual(cache.status(), { state: 'fresh', lastUpdatedAt: 0, lastAttemptAt: 0 });
one.push('mutated'); assert.deepEqual(await cache.get(), ['model-1']);
now = 299_999; await cache.get(); assert.equal(calls, 1);
now = 300_001; assert.equal(cache.status().state, 'stale'); assert.deepEqual(await cache.get(), ['model-2']);
now += 5001; assert.deepEqual(await cache.get(true), ['model-3']);
await cache.get(true); assert.equal(calls, 3); // Button spam is coalesced/throttled.
fail = true; now += 5001;
await assert.rejects(cache.get(true), /기존 목록/);
assert.equal(cache.status().state, 'stale');
assert.equal(cache.status().lastUpdatedAt, 305_002);
assert(!cache.status().warning?.includes('private'));
assert.deepEqual(await cache.get(), ['model-3']); assert.equal(calls, 4);
await assert.rejects(cache.get(true)); assert.equal(calls, 4);
now += 30_001; fail = false; assert.deepEqual(await cache.get(), ['model-5']);
assert.equal(cache.status().state, 'fresh'); assert.equal(cache.status().warning, undefined);
const unavailable = new ModelListCache(async () => { throw Error('private'); }, () => ['saved-model']);
assert.deepEqual(await unavailable.get(), ['saved-model']);
assert.equal(unavailable.status().state, 'fallback'); assert.equal(unavailable.status().lastUpdatedAt, null);
await assert.rejects(unavailable.get(true));
const oldCli = new ModelListCache(async () => { throw new ModelDiscoveryError('unsupported'); }, () => ['saved-model']);
await oldCli.get(); assert.match(oldCli.status().warning!, /CLI를 업데이트/);
const offlineProvider = new CliProvider('offline', 'Codex', 'codex-cli', '', 'my-saved-model', 'codex');
Object.defineProperty(offlineProvider, 'discoverModels', { value: async () => { throw new ModelDiscoveryError('unsupported'); } });
const offlineCatalog = await offlineProvider.modelCatalog(true);
assert.deepEqual(offlineCatalog.models, ['my-saved-model']); // Never invent account availability from the legacy fixed list.
assert.equal(offlineCatalog.source, 'codex-model-list'); assert.equal(offlineCatalog.state, 'fallback');
assert.match(offlineCatalog.warning!, /CLI를 업데이트/);
assert.deepEqual(await offlineProvider.models(), ['my-saved-model']);
await assert.rejects(offlineProvider.models(true)); // Existing API contract remains unchanged.
assert.equal(discordModelAllowed('sol', 'gpt-new-catalog-model'), false);
assert.equal(discordModelAllowed('astra', 'gpt-new-catalog-model'), false);
console.log('MODEL CATALOG TESTS PASSED: Astra/Daybreak discovery, CLI version, private diagnostics, pagination, hidden models, failure/timeout, freshness, TTL, force refresh, isolation.');
