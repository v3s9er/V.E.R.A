import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop, type RunOptions } from '../src/ai/loop.js';
import { SubagentManager } from '../src/ai/subagents.js';
import { proposalContext, unchangedProposals } from '../src/ai/orchestration-context.js';
import { ContextBroker } from '../src/context-broker.js';
import type { AiProvider, ChatRequest, NativeAgentRequest } from '../src/ai/provider.js';

const response = (text: string) => ({ text, toolCalls: [], usage: { promptTokens: 3, completionTokens: 2 } });
async function fixture(check: (f: any) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'mrrobot-adaptive-'));
  const calls: string[] = [], requests: ChatRequest[] = [], statuses: string[] = [];
  const models = ['plan', 'solve', 'critique', 'master'];
  const providers = Object.fromEntries(models.map(model => [model, {
    id: 'configured', label: 'Configured', type: 'codex-cli', baseUrl: '', model, supportsTools: false, supportedReasoning: ['auto', 'low', 'high'],
    chat: async (r: ChatRequest) => { calls.push(`chat:${model}`); requests.push(r); return response(`FINDING_${model}`); },
    chatIsolated: async (r: ChatRequest) => { calls.push(`isolated:${model}`); requests.push(r); return response(`FINDING_${model}`); },
    runAgent: async (_r: NativeAgentRequest) => { calls.push(`native:${model}`); return response('FINAL'); },
    models: async () => models, ping: async () => ({ ok: true }),
  } satisfies AiProvider]));
  const registry = { default: () => providers.master, resolve: (_role: string, _id: string, model: string) => providers[model], costTier: () => 0,
    toolCapable: () => { throw Error('Unexpected model substitution'); } };
  const options: RunOptions = { workspacePath: root, nativeSessionDirectory: root, cacheKey: 'test', permissionMode: 'read-only', tokenPolicy: 'audit-only', reasoningEffort: 'high',
    routing: { mode: 'quality', executionMode: 'adaptive', roles: {}, maxPremiumCalls: 12, escalationEnabled: false,
      graph: { nodes: models.map((model, i) => ({ id: model, kind: 'model', label: model, role: i === 3 ? 'critic' : 'reasoning', providerId: 'configured', providerModel: model, x: i * 100, y: 0 })), edges: [] } } };
  try { await check({ root, calls, requests, statuses, providers, options, registry, loop: new AgentLoop(registry as any, {} as any, undefined, new ContextBroker(root)) }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('adaptive starts the exact final model without calling planners, solvers or critics', () => fixture(async f => {
  const r = await f.loop.run([], 'Solve a difficult supplied problem.', {}, [], f.options);
  assert.deepEqual(f.calls, ['native:master']); assert.equal(r.route.model, 'master'); assert.equal(r.usage.promptTokens, 3);
}));

test('adaptive API greeting stays on its selected model without helpers, plugins or unnecessary high effort', () => fixture(async f => {
  delete f.providers.master.runAgent;
  f.providers.master.type = 'openai-compatible'; f.providers.master.supportsTools = true;
  f.providers.master.chat = async (r: ChatRequest) => {
    assert.deepEqual(r.tools, []); assert.equal(r.reasoningEffort, 'low'); return response('안녕!');
  };
  const result = await f.loop.run([], '안녕', {}, [{ name: 'fixture.plugin', description: 'irrelevant', parameters: { type: 'object' } }], f.options);
  assert.equal(result.route.model, 'master'); assert.equal(result.route.effort, 'low'); assert.deepEqual(f.calls, []);
}));

test('adaptive inline transformation avoids PC startup but preserves requested reasoning effort', () => fixture(async f => {
  const result = await f.loop.run([], '다음 텍스트를 요약해: 제공된 문장만 요약하는 검사입니다.', {}, [], f.options);
  assert.deepEqual(f.calls, ['chat:master']); assert.equal(result.route.model, 'master');
  assert.equal(f.requests[0].reasoningEffort, 'high'); assert.deepEqual(f.requests[0].tools, []);
}));

test('adaptive native master can choose only a configured isolated helper and account its usage', () => fixture(async f => {
  f.providers.master.runAgent = async (r: NativeAgentRequest) => {
    assert.equal(r.permissionMode, 'read-only');
    assert.match(r.prompt, /objective evidence/);
    assert.match(r.session!.instructions, /workerId/);
    const spawn: any = r.hostTools!.tools.find(t => t.name === 'agent_spawn');
    assert.deepEqual(spawn.parameters.properties.workerId.enum, ['plan', 'solve', 'critique']);
    assert.equal(r.hostTools!.authorize!('agent_spawn', 'ask'), false);
    await assert.rejects(r.hostTools!.execute('agent_spawn', { task: 'x', workerId: 'arbitrary-model' }, r.signal!), /허용된/);
    const result = await r.hostTools!.execute('agent_spawn', { task: 'Independent bounded subproblem', workerId: 'solve' }, r.signal!);
    const id = JSON.parse((result.contentItems[0] as any).text).agentId;
    const waited = await r.hostTools!.execute('agent_wait', { agentIds: [id] }, r.signal!);
    const worker = JSON.parse((waited.contentItems[0] as any).text).agents[0];
    assert.equal(worker.model, 'solve'); assert.equal(worker.result, 'FINDING_solve');
    assert.deepEqual(f.requests[0].tools.map((t: any) => t.name), ['list_files', 'read_file']);
    assert.doesNotMatch(f.requests[0].system, /agent_spawn/);
    return response('VERIFIED');
  };
  const r = await f.loop.run([], 'Investigate supplied constraints.', {}, [], f.options);
  assert.deepEqual(f.calls, ['isolated:solve']); assert.equal(r.route.model, 'master'); assert.equal(r.usage.promptTokens, 6);
}));

test('unavailable workers are not offered, and unavailable master never silently falls back', () => fixture(async f => {
  const original = f.registry.resolve;
  f.registry.resolve = (role: string, id: string, model: string) => model === 'solve' ? f.providers.master : original(role, id, model);
  f.providers.master.runAgent = async (r: NativeAgentRequest) => {
    const spawn: any = r.hostTools!.tools.find(t => t.name === 'agent_spawn');
    assert.deepEqual(spawn.parameters.properties.workerId.enum, ['plan', 'critique']);
    return response('FINAL');
  };
  await f.loop.run([], 'Analyze supplied material.', {}, [], f.options);
  f.registry.resolve = () => f.providers.solve;
  await assert.rejects(f.loop.run([], 'Analyze supplied material.', {}, [], f.options), /최종 모델/);
}));

test('adaptive never bypasses isolated Discord authority or finite native reservations', () => fixture(async f => {
  const r = await f.loop.run([], 'Analyze supplied material.', {}, [], { ...f.options, isolation: { tools: [], execute: async () => { throw Error('unexpected'); } } });
  assert.deepEqual(f.calls, ['isolated:master']); assert.equal(r.text, 'FINDING_master');
  assert.ok(!f.requests[0].tools?.some((t: any) => t.name === 'agent_spawn'));
  f.providers.master.runAgent = async (req: NativeAgentRequest) => { assert.ok(!req.hostTools?.tools.some(t => t.name === 'agent_spawn')); return response('FINAL'); };
  await f.loop.run([], 'Analyze supplied material.', {}, [], { ...f.options, tokenPolicy: 'standard' });
}));

test('adaptive helpers honor the paid-call limit without substituting a cheaper model', () => fixture(async f => {
  f.registry.costTier = () => 1;
  f.providers.master.runAgent = async (r: NativeAgentRequest) => {
    const spawned = await r.hostTools!.execute('agent_spawn', { task: 'bounded', workerId: 'solve' }, r.signal!);
    const id = JSON.parse((spawned.contentItems[0] as any).text).agentId;
    const waited = await r.hostTools!.execute('agent_wait', { agentIds: [id] }, r.signal!);
    assert.equal(JSON.parse((waited.contentItems[0] as any).text).agents[0].state, 'failed');
    return response('FINAL');
  };
  await f.loop.run([], 'Analyze supplied material.', {}, [], { ...f.options, routing: { ...f.options.routing, maxPremiumCalls: 1 } });
  assert.deepEqual(f.calls, []);
}));

test('adaptive master never substitutes a free model when its call budget is exhausted', () => fixture(async f => {
  f.registry.costTier = () => 1;
  f.registry.freeProvider = () => { throw Error('Unrequested substitution'); };
  await assert.rejects(f.loop.run([], 'Analyze supplied material.', {}, [], {
    ...f.options, routing: { ...f.options.routing, maxPremiumCalls: 0 },
  }), /선택한 모델을 다른 모델로 바꾸지 않고 중단/);
  assert.deepEqual(f.calls, []);
}));

test('adaptive unsupported tool capability fails before a speculative advisor or replacement executor', () => fixture(async f => {
  delete f.providers.master.runAgent;
  await assert.rejects(f.loop.run([], 'Read the project file.', {}, [], f.options), /도구 실행을 지원하지 않습니다/);
  assert.deepEqual(f.calls, []);
}));

test('optional API helpers cannot spend the final master response call', () => fixture(async f => {
  delete f.providers.master.runAgent;
  f.providers.master.type = 'openai-compatible'; f.providers.master.supportsTools = true;
  f.registry.costTier = () => 1;
  let calls = 0;
  f.providers.master.chat = async (r: ChatRequest) => {
    calls++;
    if (calls === 1) return { ...response(''), toolCalls: [{ id: 'spawn', name: 'agent_spawn', args: JSON.stringify({ task: 'bounded subproblem', workerId: 'solve' }) }] };
    assert.ok(r.turns.at(-1)?.toolResults?.length);
    return response('FINAL');
  };
  const result = await f.loop.run([], 'Investigate supplied constraints.', {}, [], { ...f.options, routing: { ...f.options.routing, maxPremiumCalls: 2 } });
  assert.equal(result.text, 'FINAL'); assert.equal(calls, 2); assert.deepEqual(f.calls, []);
}));

for (const executionMode of ['vote', 'hybrid'] as const) test(`${executionMode} keeps original evidence and project instructions through all handoffs`, () => fixture(async f => {
  const original = 'ORIGINAL_BEGIN' + ' supplied evidence '.repeat(3500) + 'ORIGINAL_END';
  const context = 'PROJECT_BEGIN' + ' constraint '.repeat(4500) + 'PROJECT_END';
  const routing = structuredClone(f.options.routing);
  routing.executionMode = executionMode; routing.meetingRounds = 2; routing.crossGroupRounds = 1;
  routing.graph.nodes[0].role = executionMode === 'hybrid' ? 'router' : 'reasoning';
  routing.graph.nodes[1].groupId = 'one'; routing.graph.nodes[2].groupId = 'two';
  for (const model of ['plan', 'solve', 'critique']) f.providers[model].chat = async (r: ChatRequest) => {
    f.requests.push(r); return response('PROPOSAL ' + '한😀'.repeat(12000));
  };
  f.providers.master.runAgent = async (r: NativeAgentRequest) => {
    assert.ok(r.prompt.includes(original)); assert.ok(r.prompt.includes(context));
    assert.ok(Buffer.byteLength(r.prompt) < Buffer.byteLength(original + context) + 30000);
    return response('FINAL');
  };
  await f.loop.run([], original, {}, [], { ...f.options, context, routing });
  assert.ok(f.requests.length >= 3);
  for (const r of f.requests) {
    const content = r.turns[0].content as string;
    assert.ok(content.includes(original)); assert.ok(content.includes(context));
    assert.ok(Buffer.byteLength(content) < Buffer.byteLength(original + context) + 25000);
    assert.ok(!content.includes('\uFFFD'));
  }
}));

test('pipeline sends the original exactly once, preserves its start and end, and bounds only proposals', () => fixture(async f => {
  const original = 'ORIGINAL_BEGIN' + ' supplied evidence '.repeat(3000) + 'ORIGINAL_END';
  for (const model of ['plan', 'solve', 'critique']) f.providers[model].chat = async (r: ChatRequest) => { f.requests.push(r); return response('same evidence '.repeat(5000)); };
  await f.loop.run([], original, {}, [], { ...f.options, routing: { ...f.options.routing, executionMode: 'pipeline' } });
  for (const r of f.requests) {
    const text = r.turns[0].content;
    assert.equal(text.split('ORIGINAL_BEGIN').length, 2); assert.ok(text.includes(original));
    assert.ok(Buffer.byteLength(text) < Buffer.byteLength(original) + 18500);
  }
}));

for (const kind of ['failure', 'empty', 'tool-request'] as const) test(`pipeline ${kind} stops dependent advisory work but keeps final verification`, () => fixture(async f => {
  f.providers.plan.chat = async () => {
    f.calls.push('failed:plan');
    if (kind === 'failure') throw Error('SECRET_PROVIDER_DETAIL');
    return { ...response(''), ...(kind === 'tool-request' ? { toolCalls: [{ id: 'x', name: 'shell_exec', args: '{}' }] } : {}) };
  };
  f.providers.master.runAgent = async (r: NativeAgentRequest) => {
    assert.doesNotMatch(r.prompt, /SECRET_PROVIDER_DETAIL/); assert.match(r.prompt, /3 advisory stages did not complete/);
    f.calls.push('native:master'); return response('FINAL');
  };
  await f.loop.run([], 'Solve supplied problem.', { onStatus: (s: string) => f.statuses.push(s) }, [], { ...f.options, routing: { ...f.options.routing, executionMode: 'pipeline' } });
  assert.deepEqual(f.calls, ['failed:plan', 'native:master']); assert.ok(f.statuses.some((s: string) => /후속 의견 수집 생략/.test(s)));
}));

test('pipeline cancellation does not start final verification', () => fixture(async f => {
  const abort = new AbortController(); f.providers.plan.chat = async () => { abort.abort(Error('STOP')); throw abort.signal.reason; };
  await assert.rejects(f.loop.run([], 'Solve supplied problem.', { signal: abort.signal }, [], { ...f.options, routing: { ...f.options.routing, executionMode: 'pipeline' } }), /STOP/);
  assert.deepEqual(f.calls, []);
}));

test('proposal packing de-duplicates exact text, preserves byte budgets and Unicode', () => {
  const text = 'HEAD ' + '한😀'.repeat(2000) + ' TAIL';
  for (const budget of [0, 30, 100, 300, 12000]) {
    const packed = proposalContext([{ label: 'a', text }, { label: 'b', text }], budget);
    assert.ok(Buffer.byteLength(packed) <= budget); assert.ok(!packed.includes('\uFFFD'));
    if (budget >= 300) { assert.match(packed, /HEAD/); assert.match(packed, /TAIL/); assert.match(packed, /1 identical/); }
  }
  assert.equal(unchangedProposals([], []), false);
  assert.equal(unchangedProposals([{ nodeId: 'a', text: 'x' }], [{ nodeId: 'a', text: 'x' }]), true);
  assert.equal(unchangedProposals([{ nodeId: 'a', text: 'x' }], [{ nodeId: 'a', text: 'y' }]), false);
  assert.equal(unchangedProposals([{ nodeId: 'a', text: ' ' }], [{ nodeId: 'a', text: ' ' }]), false);
});

test('default manager rejects arbitrary worker ids even if callers bypass tool schema', async () => {
  const manager = new SubagentManager({ providerId: 'p', model: 'm', execute: async () => ({ text: '' }) });
  try { assert.throws(() => manager.spawn({ task: 'x', workerId: 'invented' }), /허용된/); }
  finally { manager.dispose(); await manager.drained(); }
});
