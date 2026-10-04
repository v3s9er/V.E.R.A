import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop } from '../src/ai/loop.js';
import type { AiProvider, ChatRequest, NativeAgentRequest, ProviderResult, Turn } from '../src/ai/provider.js';
import type { ModelTuningProfile } from '@mr-robot/shared';

const answer = (): ProviderResult => ({ text: 'done', toolCalls: [], usage: { promptTokens: 3, completionTokens: 2 } });
const api = (chat: AiProvider['chat']): AiProvider => ({ id: 'test', label: 'fixture', type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.1', supportedReasoning: ['auto', 'none', 'low', 'medium', 'high'], supportsTools: true, chat, models: async () => [], ping: async () => ({ ok: true }) });
const registry = (selected: AiProvider, profile?: ModelTuningProfile) => ({ default: () => selected, tuningProfile: () => profile }) as any;

test('real loop applies inference tuning before budget reservation without touching original history', async () => {
  let received: ChatRequest | undefined, maximum = 0;
  const selected = api(async request => { received = request; return answer(); });
  const profile: ModelTuningProfile = { id: 'measured', name: 'Measured', reasoningEffort: 'none', maxOutputTokens: 512, temperature: .2, helperMode: 'off', responseStyle: 'concise', contextTokenLimit: 2048 };
  const loop = new AgentLoop(registry(selected, profile), {} as any);
  const history: Turn[] = [{ role: 'user', content: 'keep original' }, { role: 'assistant', content: 'verified prior answer' }];
  let configured: string | undefined;
  const output = await loop.run(history, 'Answer directly', {
    configureModelBudget: value => { configured = value.reasoningEffort; },
    reserveModelCall: (_kind, bound) => { maximum = bound; return { finish: () => true, accountedTokens: 5 }; },
  }, [], { context: '보조 자료'.repeat(2000), workspacePath: 'fixture', permissionMode: 'read-only', tokenPolicy: 'standard' });
  assert.equal(configured, 'none'); assert.equal(received?.reasoningEffort, 'none');
  assert.equal(received?.maxTokens, 512); assert.equal(received?.temperature, .2);
  assert.match(received?.system ?? '', /be concise/); assert.match(received?.context ?? '', /보조 문맥 일부 생략/);
  assert.ok(!received?.tools?.some(tool => tool.name === 'agent_spawn'));
  assert.deepEqual(output.turns.slice(0, 2), history); assert.ok(maximum > 512);
  assert.equal(selected.model, 'gpt-5.1');
});

test('native loop preserves scope and uses explicit chat effort over the profile', async () => {
  let received: NativeAgentRequest | undefined;
  const selected = { ...api(async () => { throw new Error('must use native'); }), type: 'codex-cli' as const, baseUrl: '', supportsTools: false,
    chatIsolated: async () => answer(), runAgent: async (request: NativeAgentRequest) => { received = request; return answer(); } };
  const loop = new AgentLoop(registry(selected, { id: 'profile', name: 'profile', reasoningEffort: 'low', responseStyle: 'concise', helperMode: 'off' }), {} as any);
  const result = await loop.run([], 'Answer directly', {}, [], { workspacePath: 'C:/fixture-only', permissionMode: 'read-only', tokenPolicy: 'audit-only', cacheKey: 'synthetic', nativeSessionDirectory: 'C:/fixture-only', reasoningEffort: 'high' });
  assert.equal(received?.permissionMode, 'read-only'); assert.equal(received?.reasoningEffort, 'high');
  assert.match(received?.session?.instructions ?? '', /be concise/);
  assert.equal(received?.hostTools, undefined); assert.equal(result.route?.effort, 'high');
});

test('an unsupported active profile fails before admission or provider execution', async () => {
  let called = false, reserved = false;
  const selected = api(async () => { called = true; return answer(); });
  const loop = new AgentLoop(registry(selected, { id: 'bad', name: 'bad', temperature: .2, reasoningEffort: 'high' }), {} as any);
  await assert.rejects(loop.run([], 'hello', { reserveModelCall: () => { reserved = true; return { finish: () => true, accountedTokens: 0 }; } }), /temperature/);
  assert.equal(called, false); assert.equal(reserved, false);
});

test('unsupported explicit Codex effort fails before inference instead of being silently sent or downgraded', async () => {
  let called = false, prepared = 0;
  const selected = { ...api(async () => { called = true; return answer(); }), type: 'codex-cli' as const, supportedReasoning: ['auto', 'max'] as const };
  const providers = { default: () => selected, prepareModelCapabilities: async () => { prepared++; } } as any;
  await assert.rejects(new AgentLoop(providers, {} as any).run([], 'Substantive work', {}, [], { routing: null, reasoningEffort: 'ultra' }), /지원.*확인/);
  assert.equal(called, false);
  assert.equal(prepared, 1);
});

test('automatic profile effort keeps adaptive API and native choices', async () => {
  const profile: ModelTuningProfile = { id: 'auto-profile', name: 'Auto', reasoningEffort: 'auto', helperMode: 'off' };
  let apiRequest: ChatRequest | undefined;
  const selected = api(async request => { apiRequest = request; return answer(); });
  await new AgentLoop(registry(selected, profile), {} as any).run([], '안녕', {}, [], { reasoningEffort: 'auto' });
  assert.equal(apiRequest?.reasoningEffort, 'low');
  let nativeRequest: NativeAgentRequest | undefined;
  const native = { ...api(async () => { throw new Error('must use native'); }), type: 'codex-cli' as const, baseUrl: '', supportsTools: false,
    chatIsolated: async () => answer(), runAgent: async (request: NativeAgentRequest) => { nativeRequest = request; return answer(); } };
  await new AgentLoop(registry(native, profile), {} as any).run([], '취약점 분석', {}, [], {
    workspacePath: 'C:/fixture-only', permissionMode: 'read-only', tokenPolicy: 'audit-only', cacheKey: 'synthetic',
    nativeSessionDirectory: 'C:/fixture-only', reasoningEffort: 'auto',
  });
  assert.equal(nativeRequest?.reasoningEffort, 'high');
});

test('simple requests lower actual API and native effort without changing model, saved preference or authority', async () => {
  const profile: ModelTuningProfile = { id: 'deep', name: 'Deep', reasoningEffort: 'high', helperMode: 'off' };
  let apiRequest: ChatRequest | undefined;
  const selected = api(async request => { apiRequest = request; return answer(); });
  const apiResult = await new AgentLoop(registry(selected, profile), {} as any).run([], 'ㅎㅇ', {}, [], { reasoningEffort: 'high', daybreakEnabled: true });
  assert.equal(apiRequest?.reasoningEffort, 'low'); assert.equal(apiResult.route?.effort, 'low');
  assert.equal(apiRequest?.daybreakEnabled, true); assert.equal(profile.reasoningEffort, 'high');
  assert.equal(apiResult.route?.model, selected.model);
  let nativeRequest: NativeAgentRequest | undefined;
  const native = { ...selected, type: 'codex-cli' as const, baseUrl: '', supportsTools: false,
    runAgent: async (request: NativeAgentRequest) => { nativeRequest = request; return answer(); } };
  const options = { workspacePath: 'C:/fixture-only', permissionMode: 'read-only' as const, reasoningEffort: 'high' as const, daybreakEnabled: true };
  const loop = new AgentLoop(registry(native, profile), {} as any);
  const first = await loop.run([], 'ㅎㅇ', {}, [], options);
  assert.equal(nativeRequest, undefined, 'simple turn does not start the native computer harness');
  assert.equal(apiRequest?.reasoningEffort, 'low'); assert.equal(first.route?.effort, 'low');
  assert.deepEqual(apiRequest?.tools, []); assert.equal(apiRequest?.daybreakEnabled, true);
  const next = await loop.run(first.turns, '이 코드 취약점을 분석해', {}, [], options);
  assert.equal(nativeRequest?.reasoningEffort, 'high'); assert.equal(next.route?.effort, 'high');
  assert.equal(nativeRequest?.permissionMode, 'read-only'); assert.equal(nativeRequest?.daybreakEnabled, true);
  assert.match(nativeRequest?.prompt ?? '', /ㅎㅇ/); assert.equal(options.reasoningEffort, 'high');
  assert.equal(next.route?.model, first.route?.model);
});
