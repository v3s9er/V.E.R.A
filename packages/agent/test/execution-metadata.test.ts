import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executionContext, executionMetadata } from '../src/ai/execution-metadata.js';
import { AgentLoop } from '../src/ai/loop.js';
import type { AiProvider, ChatRequest, NativeAgentRequest, ProviderResult } from '../src/ai/provider.js';

const answer = (): ProviderResult => ({ text: 'fixture answer', toolCalls: [], usage: { promptTokens: 3, completionTokens: 2 } });
const provider = (overrides: Partial<AiProvider> = {}): AiProvider => ({
  id: 'fixture', label: 'Fixture provider', type: 'openai-compatible', baseUrl: '', model: 'fixture-model',
  supportsTools: true, supportedReasoning: ['auto', 'low', 'high', 'xhigh'],
  chat: async () => answer(), ping: async () => ({ ok: true }), models: async () => [], ...overrides,
});
const loop = (selected: AiProvider) => new AgentLoop({ default: () => selected } as any, {} as any);
const question = '지금 모델이랑 추론강도 대답해봐';

test('execution metadata allowlists model options and distinguishes unknown defaults from planning depth', () => {
  const selected = { ...provider(), apiKey: 'fixture-secret-not-a-real-key', userId: 'fixture-private-user', environment: { SECRET: 'fixture-private-env' } };
  const text = executionMetadata(selected, 'xhigh');
  assert.match(text, /model="fixture-model", reasoning_effort=xhigh/);
  assert.match(text, /direct\/standard\/deep are NOT reasoning-effort/);
  for (const value of [selected.apiKey, selected.userId, selected.environment.SECRET]) assert.ok(!text.includes(value));
  assert.match(executionMetadata(selected), /reasoning_effort=auto/);
  assert.match(executionMetadata(selected, 'auto'), /provider default is unverified/);
  assert.ok(executionContext('retained evidence', selected, 'xhigh').startsWith('retained evidence\n\n'));
});

test('API reporting uses actual xhigh and does not alter saved options or user history', async () => {
  let received: ChatRequest | undefined;
  const selected = provider({ chat: async request => { received = request; return answer(); } });
  const options = Object.freeze({ reasoningEffort: 'xhigh' as const, routing: null });
  const history = [{ role: 'user' as const, content: 'earlier question' }, { role: 'assistant' as const, content: 'standard is not effort' }];
  const before = structuredClone(history);
  await loop(selected).run(history, question, {}, [], options);
  assert.equal(received?.reasoningEffort, 'xhigh');
  assert.match(received?.context ?? '', /reasoning_effort=xhigh/);
  assert.doesNotMatch(received?.system ?? '', /Current V.E.R.A execution metadata/);
  assert.deepEqual(history, before);
  assert.equal(options.reasoningEffort, 'xhigh');
});

test('native reporting updates context without changing stable session identity or instructions', async () => {
  const requests: NativeAgentRequest[] = [];
  const selected = provider({ type: 'codex-cli', supportsTools: false, runAgent: async request => { requests.push(request); return answer(); } });
  const options = { workspacePath: 'C:/fixture-only', permissionMode: 'read-only' as const, tokenPolicy: 'audit-only' as const,
    cacheKey: 'synthetic-ticket', nativeSessionDirectory: 'C:/fixture-only', routing: null };
  const agent = loop(selected);
  const first = await agent.run([], question, {}, [], { ...options, reasoningEffort: 'xhigh' });
  await agent.run(first.turns, question, {}, [], { ...options, reasoningEffort: 'high' });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].session?.key, requests[1].session?.key);
  assert.equal(requests[0].session?.instructions, requests[1].session?.instructions);
  for (const [i, effort] of ['xhigh', 'high'].entries()) {
    assert.equal(requests[i].reasoningEffort, effort);
    assert.ok(requests[i].prompt.includes(`reasoning_effort=${effort}`));
    assert.ok(requests[i].session?.context.includes(`reasoning_effort=${effort}`));
    assert.doesNotMatch(requests[i].session?.instructions ?? '', /Current V.E.R.A execution metadata/);
    assert.equal(requests[i].permissionMode, 'read-only');
    assert.equal(requests[i].session?.input, question);
  }
});

test('simple native text route reports adaptive low without overwriting explicit xhigh preference', async () => {
  let received: ChatRequest | undefined;
  const selected = provider({ type: 'codex-cli', supportsTools: false,
    chat: async request => { received = request; return answer(); }, runAgent: async () => { throw Error('must not start native tools'); } });
  const options = Object.freeze({ workspacePath: 'C:/fixture-only', permissionMode: 'read-only' as const, reasoningEffort: 'xhigh' as const });
  const result = await loop(selected).run([], 'ㅎㅇ', {}, [], options);
  assert.equal(received?.reasoningEffort, 'low');
  assert.match(received?.context ?? '', /reasoning_effort=low/);
  assert.equal(result.route?.effort, 'low');
  assert.equal(options.reasoningEffort, 'xhigh');
});

test('isolated Discord broker receives the same final effort in its option and reporting context', async () => {
  let received: ChatRequest | undefined;
  const selected = provider({ type: 'codex-cli', chatIsolated: async () => { throw Error('must use broker'); },
    runBrokerAgent: async request => { received = request; return answer(); } });
  const result = await loop(selected).run([], question, {}, [], {
    reasoningEffort: 'xhigh', tokenPolicy: 'audit-only', singleModelOnly: true,
    isolation: { tools: [], system: 'fixture isolation boundary', execute: async () => { throw Error('unexpected tool'); } },
  });
  assert.equal(received?.reasoningEffort, 'xhigh');
  assert.match(received?.context ?? '', /reasoning_effort=xhigh/);
  assert.equal(result.route?.effort, 'xhigh');
});
