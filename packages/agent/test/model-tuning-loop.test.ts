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
  assert.match(received?.system ?? '', /be concise/); assert.match(received?.system ?? '', /보조 문맥 일부 생략/);
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
