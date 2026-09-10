import assert from 'node:assert/strict';
import { loadModelCatalog, modelCatalogSummary } from '../src/model-catalog.js';
import type { ProviderModelCatalog } from '@mr-robot/shared';

const catalog: ProviderModelCatalog = { models: ['gpt-6-astra', 'gpt-daybreak-blue-latest'], source: 'codex-model-list',
  state: 'fresh', lastUpdatedAt: 123, lastAttemptAt: 120, cliVersion: '0.153.4' };
const requests: unknown[] = [];
const client = { async call(method: string, params: unknown) { requests.push([method, params]); return catalog; } };
assert.deepEqual(await loadModelCatalog(client, 'pc-codex', true), catalog);
assert.deepEqual(requests, [['providers.catalog', { id: 'pc-codex', refresh: true }]]);
assert.match(modelCatalogSummary(catalog), /Codex model\/list · CLI 0.153.4 · 2개 · 조회 완료/);
assert.match(modelCatalogSummary({ ...catalog, state: 'stale' }), /이전 목록/);
assert.match(modelCatalogSummary({ ...catalog, state: 'fallback' }), /저장된 모델만/);
const legacy = { async call(method: string) {
  if (method === 'providers.catalog') throw Error('unknown method: providers.catalog');
  return ['saved-model'];
} };
const retained = await loadModelCatalog(legacy, 'old-pc');
assert.deepEqual(retained.models, ['saved-model']); assert.equal(retained.state, 'stale');
assert.match(retained.warning!, /해당 PC의 Mr.Robot을 업데이트/);
let failedCalls = 0;
await assert.rejects(loadModelCatalog({ async call() { failedCalls++; throw Error('unauthorized'); } }, 'remote'), /unauthorized/);
assert.equal(failedCalls, 1);
console.log('MODEL CATALOG UI TESTS PASSED: live/stale/fallback labels, manual refresh, old-PC compatibility, auth failure preservation.');
