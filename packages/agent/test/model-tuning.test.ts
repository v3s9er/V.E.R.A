import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ModelTuningProfile, ReasoningEffort } from '@mr-robot/shared';
import { ConfigStore } from '../src/config.js';
import { ProviderRegistry } from '../src/ai/registry.js';
import { OpenAICompatibleProvider } from '../src/ai/openai.js';
import { activeTuningProfile, applyModelTuning, getTuningCapabilities, normalizeProviderTuningSettings, resolveModelTuning, tuningInstructions } from '../src/ai/model-tuning.js';

const allEfforts: ReasoningEffort[] = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];
const api = { type: 'openai-compatible' as const, model: 'gpt-5.2', baseUrl: 'https://api.openai.com/v1', supportedReasoning: allEfforts };
const cli = { ...api, type: 'codex-cli' as const, baseUrl: '', model: 'gpt-6-astra' };
const profile: ModelTuningProfile = { id: 'careful', name: '정밀 검증', reasoningEffort: 'high', helperMode: 'auto', maxParallelHelpers: 2 };
const protector = { protect: (value: string) => `test:${Buffer.from(value).toString('base64url')}`, unprotect: (value: string) => Buffer.from(value.slice(5), 'base64url').toString() };

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'mrrobot-tuning-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new ConfigStore(dir, { providerVault: protector, pairingVault: protector });
  store.upsertProvider({ id: 'primary', label: 'Primary', type: 'codex-cli', model: 'gpt-6-astra', baseUrl: '', apiKey: '', isDefault: true });
  return { dir, store };
}

test('unset tuning preserves the exact request and default provider behavior', () => {
  const request = { system: 'original', turns: [{ role: 'user' as const, content: 'task' }], maxTokens: 900 };
  const resolved = resolveModelTuning(undefined, cli, 'high');
  assert.deepEqual(resolved, {});
  assert.equal(applyModelTuning(request, resolved), request);
  assert.equal(activeTuningProfile({ profiles: [profile] }), undefined);
});

test('profile validation rejects unsafe expansion knobs and malformed values', () => {
  for (const extra of [{ model: 'another-model' }, { permissionMode: 'full' }, { apiKey: 'not-a-key' }, { budget: 'unlimited' }, { command: 'runner' }]) {
    assert.throws(() => normalizeProviderTuningSettings({ profiles: [{ ...profile, ...extra }] }), /알 수 없는/);
  }
  for (const extra of [{ maxParallelHelpers: 3 }, { maxOutputTokens: Infinity }, { maxOutputTokens: 255 }, { contextTokenLimit: 2000 }, { temperature: -1 }, { temperature: NaN }, { reasoningEffort: 'unknown' }, { name: '\nname' }]) {
    assert.throws(() => normalizeProviderTuningSettings({ profiles: [{ ...profile, ...extra }] }));
  }
  assert.throws(() => normalizeProviderTuningSettings({ profiles: [profile, profile] }), /중복/);
  assert.throws(() => normalizeProviderTuningSettings({ profiles: [profile], activeProfileId: 'missing' }), /찾을/);
  assert.throws(() => normalizeProviderTuningSettings({ profiles: Array.from({ length: 17 }, (_, index) => ({ ...profile, id: `p${index}` })) }), /16/);
  assert.throws(() => normalizeProviderTuningSettings({ profiles: [], permissionMode: 'full' }), /알 수 없는/);
});

test('explicit per-chat effort wins without changing the chosen model or permissions', () => {
  const before = structuredClone(cli);
  assert.equal(resolveModelTuning(profile, cli, 'low').reasoningEffort, 'low');
  assert.equal(resolveModelTuning(profile, cli, 'auto').reasoningEffort, 'high');
  assert.equal(resolveModelTuning(profile, cli).reasoningEffort, 'high');
  assert.deepEqual(cli, before);
  assert.throws(() => resolveModelTuning({ ...profile, reasoningEffort: 'high' }, { ...cli, supportedReasoning: ['auto'] }), /지원하지/);
  assert.equal(resolveModelTuning({ ...profile, reasoningEffort: 'high' }, { ...cli, supportedReasoning: ['auto', 'low'] }, 'low').reasoningEffort, 'low');
});

test('subscription capabilities reject unsupported weight, output and sampling controls', () => {
  assert.equal(getTuningCapabilities(cli).weightTraining, 'unavailable-subscription');
  assert.equal(getTuningCapabilities(cli).maxOutputTokens, false);
  assert.throws(() => resolveModelTuning({ ...profile, temperature: 0.4 }, cli), /temperature/);
  assert.throws(() => resolveModelTuning({ ...profile, maxOutputTokens: 500 }, cli), /구독 CLI/);
  assert.equal(resolveModelTuning({ ...profile, responseStyle: 'concise', contextTokenLimit: 4096, helperMode: 'off', maxParallelHelpers: 1 }, cli).helperMode, 'off');
});

test('sampling controls use actual verified model and endpoint capabilities', () => {
  const sampling = { ...profile, reasoningEffort: 'none' as const, temperature: 0.4 };
  assert.equal(resolveModelTuning(sampling, api).temperature, 0.4);
  assert.throws(() => resolveModelTuning(sampling, api, 'high'), /추론 none/);
  assert.throws(() => resolveModelTuning({ ...profile, temperature: 0.4 }, api), /추론 none/);
  assert.throws(() => resolveModelTuning(sampling, { ...api, baseUrl: 'https://gateway.example/v1' }), /추론 단계|temperature/);
  for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.2-pro', 'gpt-5.2-codex', 'unknown-model']) {
    assert.equal(getTuningCapabilities({ ...api, model }).temperature.supported, false, model);
  }
  assert.equal(getTuningCapabilities({ ...api, model: 'gpt-4.1' }).temperature.supported, true);
  assert.deepEqual(getTuningCapabilities({ ...api, model: 'gpt-4.1' }).reasoningEfforts, ['auto']);
  assert.equal(getTuningCapabilities({ ...api, model: 'gpt-6-astra' }).reasoningEfforts.includes('none'), false);
  assert.equal(getTuningCapabilities({ ...api, type: 'ollama', model: 'custom-local', baseUrl: 'http://127.0.0.1:11434' }).temperature.supported, true);
});

test('output tuning only narrows existing limits and preserves tool data and cancellation', () => {
  const signal = AbortSignal.abort();
  const turns = [{ role: 'tool' as const, content: '', toolResults: [{ id: 'call', name: 'read', content: 'evidence' }] }];
  const request = { turns, tools: [{ name: 'read', description: 'read', parameters: {} }], maxTokens: 700, reasoningEffort: 'auto' as const, signal };
  const resolved = resolveModelTuning({ ...profile, maxOutputTokens: 1500, responseStyle: 'concise' }, api);
  const result = applyModelTuning(request, resolved);
  assert.equal(result.maxTokens, 700);
  assert.equal(result.turns, turns);
  assert.equal(result.tools, request.tools);
  assert.equal(result.signal, signal);
  assert.equal(result.reasoningEffort, 'high');
  assert.match(result.system!, /Preserve necessary evidence/);
  assert.equal(applyModelTuning({ ...request, maxTokens: 2000 }, resolved).maxTokens, 1500);
  assert.equal(applyModelTuning({ turns }, resolved).maxTokens, 1500);
  assert.equal(tuningInstructions({ responseStyle: 'default' }), '');
  assert.match(tuningInstructions({ responseStyle: 'detailed' }), /verification/);
});

test('provider profiles persist atomically, are cloned and remain isolated per provider', t => {
  const { dir, store } = fixture(t);
  const saved = store.saveProviderTuning('primary', { profiles: [profile], activeProfileId: profile.id });
  saved.profiles[0].name = 'mutated return';
  assert.equal(store.getProviderTuning('primary').profiles[0].name, profile.name);
  assert.deepEqual(store.getProviderTuning('other'), { profiles: [] });
  assert.deepEqual(store.getProviderTuning('__proto__'), { profiles: [] });
  assert.throws(() => store.saveProviderTuning('other', { profiles: [] }), /공급자/);
  const registry = new ProviderRegistry(store);
  assert.equal(registry.tuningProfile('primary')?.id, profile.id);
  const reopened = new ConfigStore(dir, { providerVault: protector, pairingVault: protector });
  assert.equal(reopened.getProviderTuning('primary').activeProfileId, profile.id);
  assert.equal(reopened.providers[0].model, 'gpt-6-astra');
  store.removeProvider('primary');
  assert.deepEqual(store.getProviderTuning('primary'), { profiles: [] });
});

test('invalid writes and filesystem failures do not publish new active settings', t => {
  const { dir, store } = fixture(t);
  store.saveProviderTuning('primary', { profiles: [profile], activeProfileId: profile.id });
  const before = readFileSync(join(dir, 'config.json'), 'utf8');
  assert.throws(() => store.saveProviderTuning('primary', { profiles: [{ ...profile, temperature: 500 }] }));
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), before);
  renameSync(join(dir, 'config.json.bak'), join(dir, 'config.json.bak.saved'));
  mkdirSync(join(dir, 'config.json.bak'));
  assert.throws(() => store.saveProviderTuning('primary', { profiles: [] }));
  assert.equal(store.getProviderTuning('primary').activeProfileId, profile.id);
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), before);
});

test('one corrupt optional profile does not roll back providers or silently overwrite the damaged original', t => {
  const { dir, store } = fixture(t);
  const raw = JSON.parse(readFileSync(store.file, 'utf8'));
  const damaged = { profiles: [{ ...profile, maxOutputTokens: -1 }], activeProfileId: profile.id };
  raw.providers[0].label = 'Latest provider name';
  raw.modelTuning = { primary: damaged };
  writeFileSync(store.file, JSON.stringify(raw));
  const reopened = new ConfigStore(dir, { providerVault: protector, pairingVault: protector });
  assert.equal(reopened.providers[0].label, 'Latest provider name');
  assert.deepEqual(reopened.getProviderTuning('primary'), { profiles: [] });
  assert.match(reopened.getProviderTuningWarning('primary')!, /원본 설정은 보존/);
  assert.equal(reopened.recovery.diagnostics.some(item => item.code === 'config-backup-recovered'), false);
  reopened.updateSettings({});
  assert.deepEqual(JSON.parse(readFileSync(store.file, 'utf8')).modelTuning.primary, damaged);
  reopened.saveProviderTuning('primary', { profiles: [profile], activeProfileId: profile.id });
  assert.equal(reopened.getProviderTuningWarning('primary'), undefined);
  assert.equal(JSON.parse(readFileSync(store.file, 'utf8')).modelTuning.primary.profiles[0].maxOutputTokens, undefined);
});

test('a malformed tuning envelope stays preserved until explicit tuning replacement', t => {
  const { dir, store } = fixture(t);
  const raw = JSON.parse(readFileSync(store.file, 'utf8'));
  raw.modelTuning = 'damaged optional field';
  writeFileSync(store.file, JSON.stringify(raw));
  const reopened = new ConfigStore(dir, { providerVault: protector, pairingVault: protector });
  assert.equal(reopened.providers.length, 1);
  assert.deepEqual(reopened.getProviderTuning('primary'), { profiles: [] });
  assert.ok(reopened.getProviderTuningWarning('primary'));
  reopened.updateSettings({});
  assert.equal(JSON.parse(readFileSync(store.file, 'utf8')).modelTuning, raw.modelTuning);
  reopened.saveProviderTuning('primary', { profiles: [] });
  assert.deepEqual(JSON.parse(readFileSync(store.file, 'utf8')).modelTuning, { primary: { profiles: [] } });
  assert.equal(reopened.getProviderTuningWarning('primary'), undefined);
});

test('validated tuning is present in the actual Responses request, not a cosmetic profile', async t => {
  let sent: Record<string, any> | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 2 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  const provider = new OpenAICompatibleProvider('test', 'Test', 'openai-compatible', api.baseUrl, api.model, '');
  const tuned = resolveModelTuning({ ...profile, reasoningEffort: 'none', temperature: 0.2, maxOutputTokens: 800, responseStyle: 'concise' }, provider);
  const response = await provider.chat(applyModelTuning({ turns: [{ role: 'user', content: 'hello' }], maxTokens: 1000 }, tuned));
  assert.equal(response.text, 'done');
  assert.equal(sent?.model, api.model);
  assert.equal(sent?.temperature, 0.2);
  assert.deepEqual(sent?.reasoning, { effort: 'none' });
  assert.equal(sent?.max_output_tokens, 800);
  assert.equal(sent?.store, false);
  assert.match(sent?.instructions, /Response preference/);
});

test('unsupported sampling is rejected before any provider network request', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network request'); });
  const provider = new OpenAICompatibleProvider('test', 'Test', 'openai-compatible', api.baseUrl, 'gpt-6-astra', '');
  await assert.rejects(provider.chat({ turns: [], temperature: 0.5 }), /temperature/);
  assert.equal(fetchMock.mock.callCount(), 0);
});
