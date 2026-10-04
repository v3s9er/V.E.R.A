import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import { ProviderRegistry } from '../src/ai/registry.js';
import { AgentLoop } from '../src/ai/loop.js';

const fixture = () => {
  const registry = new ProviderRegistry({ providers: [
    { id: 'api', type: 'openai-compatible', label: 'API fixture', model: 'fixture', baseUrl: 'https://example.invalid', apiKey: '', isDefault: true },
    ...['unused', 'selected', 'graph'].map(id => ({ id, type: 'codex-cli', label: id, model: 'fixture', baseUrl: '', apiKey: '', command: 'NEVER_LAUNCH' })),
  ], routing: { roles: { critic: ['unused'] } }, getProviderTuning: () => ({ profiles: [] }) } as never);
  const prepared: string[] = [];
  for (const id of ['unused', 'selected', 'graph']) Object.defineProperty(registry.get(id), 'models', { configurable: true, value: async () => { prepared.push(id); return []; } });
  return { registry, prepared };
};

test('explicit single/default API route never discovers unused global CLI roles', async () => {
  const { registry, prepared } = fixture();
  await registry.prepareModelCapabilities(undefined, null);
  assert.deepEqual(prepared, []);
  await registry.prepareModelCapabilities('selected', null);
  assert.deepEqual(prepared, ['selected']);
});

test('preset and unspecified legacy routing still prepare their providers plus an explicit override', async () => {
  const { registry, prepared } = fixture();
  await registry.prepareModelCapabilities(undefined);
  assert.deepEqual(prepared, ['unused']);
  prepared.length = 0;
  await registry.prepareModelCapabilities('selected', { roles: { critic: ['unused'] }, graph: { nodes: [{ providerId: 'graph' }], edges: [] } } as never);
  assert.deepEqual([...prepared].sort(), ['graph', 'selected', 'unused']);
});

test('real loop preserves null routing during metadata preparation and takes the simple API path', async () => {
  const { registry, prepared } = fixture();
  let calls = 0;
  Object.defineProperty(registry.get('api'), 'chat', { value: async () => {
    calls++; return { text: 'hello', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } };
  } });
  const answer = await new AgentLoop(registry, {} as never).run([], 'hello', {}, [], { routing: null, reasoningEffort: 'auto' });
  assert.equal(answer.text, 'hello');
  assert.equal(calls, 1);
  assert.deepEqual(prepared, []);
});

test('metadata cancellation releases only its waiter and leaves the shared discovery usable', async () => {
  const { registry } = fixture();
  const controller = new AbortController();
  let release!: () => void, probes = 0;
  const pending = new Promise<string[]>(resolve => { release = () => resolve(['fixture']); });
  Object.defineProperty(registry.get('selected'), 'models', { configurable: true, value: () => { probes++; return pending; } });
  const cancelled = registry.prepareModelCapabilities('selected', null, controller.signal);
  const survivor = registry.prepareModelCapabilities('selected', null);
  const reason = new Error('cancel metadata wait');
  controller.abort(reason);
  const outcome = await Promise.race([cancelled.then(() => 'resolved', error => error), new Promise(resolve => setImmediate(() => resolve('still waiting')))]);
  release(); await survivor;
  assert.equal(outcome, reason, 'cancellation must not await the shared catalog timeout');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(probes, 2, 'both calls may await the same provider-owned in-flight discovery');
});

test('an already cancelled run performs no discovery or inference', async () => {
  const { registry, prepared } = fixture();
  const controller = new AbortController(); controller.abort(new Error('already cancelled'));
  let called = false;
  Object.defineProperty(registry.get('api'), 'chat', { value: async () => { called = true; throw new Error('must not run'); } });
  await assert.rejects(new AgentLoop(registry, {} as never).run([], 'hello', { signal: controller.signal }, [], { routing: null }), /already cancelled/);
  assert.deepEqual(prepared, []);
  assert.equal(called, false);
});

test('the loop forwards cancellation while discovery is pending and never starts inference afterward', async () => {
  const { registry } = fixture();
  let release!: () => void, calls = 0;
  const pending = new Promise<string[]>(resolve => { release = () => resolve(['fixture']); });
  Object.defineProperty(registry.get('selected'), 'models', { configurable: true, value: () => pending });
  Object.defineProperty(registry.get('selected'), 'chat', { value: async () => { calls++; throw new Error('must not infer'); } });
  const controller = new AbortController(), reason = new Error('cancel running discovery');
  const run = new AgentLoop(registry, {} as never).run([], 'hello', { signal: controller.signal }, [], { providerId: 'selected', routing: null });
  controller.abort(reason);
  const outcome = await Promise.race([run.then(() => 'resolved', error => error), new Promise(resolve => setImmediate(() => resolve('still waiting')))]);
  release(); await run.catch(() => undefined);
  assert.equal(outcome, reason);
  assert.equal(calls, 0);
});

test('numeric cost and free-provider routing never clone model catalogs; public listing reads each once', () => {
  const { registry } = fixture();
  let reads = 0;
  for (const id of ['unused', 'selected', 'graph']) Object.defineProperty(registry.get(id), 'modelCapabilities', { get() {
    reads++; return { fixture: { supportedReasoningEfforts: ['low', 'ultra'] } };
  } });
  assert.equal(registry.costTier('api'), 1);
  assert.equal(registry.costTier('missing'), 1);
  assert.equal(registry.freeProvider('general'), undefined);
  assert.equal(reads, 0, 'scalar routing must not access unrelated capability metadata');
  assert.equal(registry.list().length, 4);
  assert.equal(reads, 3, 'each public catalog getter should be evaluated once, not twice');
});

test('cost metadata preserves explicit source overrides and free-provider eligibility/order', () => {
  const providers = [
    { id: 'local', type: 'ollama', costTier: 2 },
    { id: 'free-api', type: 'openai-compatible', source: 'free', costTier: 2 },
    { id: 'paid-local', type: 'ollama', source: 'api', costTier: 2 },
    { id: 'cli', type: 'codex-cli', source: 'subscription', costTier: 0 },
    { id: 'paid-api', type: 'openai-compatible' },
    { id: 'invalid-free', type: 'openai-compatible', source: 'free', baseUrl: 'invalid' },
  ].map(row => ({ label: row.id, model: 'fixture', baseUrl: 'https://example.invalid', apiKey: '', ...row }));
  const registry = new ProviderRegistry({ providers, routing: { roles: { general: ['invalid-free', 'cli'] } } } as never);
  const expected = [0, 0, 2, 0, 1, 0];
  assert.deepEqual(providers.map(row => registry.costTier(row.id)), expected);
  assert.deepEqual(registry.list().map(row => row.costTier), expected);
  assert.equal(registry.freeProvider('general')?.id, 'cli');
  assert.equal(registry.freeProvider('general', ['free-api'])?.id, 'free-api');
  assert.equal(registry.freeProvider('general', ['cli'], true)?.id, 'local');
});

test('single/default CLI still prepares itself and completed metadata waits remove abort listeners', async () => {
  const { registry, prepared } = fixture();
  Object.defineProperty(registry, 'default', { value: () => registry.get('selected') });
  const controller = new AbortController();
  await registry.prepareModelCapabilities(undefined, null, controller.signal);
  assert.deepEqual(prepared, ['selected']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
  await assert.rejects(registry.prepareModelCapabilities('unused', null, controller.signal));
  assert.deepEqual(prepared, ['selected']);
});
