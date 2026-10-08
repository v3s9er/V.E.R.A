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

for (const mode of ['adaptive','pipeline','vote','hybrid','swarm'] as const) test(`legacy ${mode} is preserved but executes only the current primary`, () => fixture(async f => {
 const options=structuredClone(f.options); options.routing.executionMode=mode;
 const before=JSON.stringify(options);
 const r=await f.loop.run([], 'Analyze the project and verify results.', {onStatus:(s:string)=>f.statuses.push(s)}, [], options);
 assert.deepEqual(f.calls,['native:master']); assert.equal(r.route.model,'master');
 assert.equal(JSON.stringify(options),before); assert.ok(f.statuses.some((s:string)=>s.includes('저장된 다중 모델')));
}));
test('isolated Discord retains selected model and receives no owner helpers', () => fixture(async f => {
 const r=await f.loop.run([], 'Analyze supplied material.', {}, [], {...f.options,isolation:{tools:[],execute:async()=>{throw Error('unexpected');}}});
 assert.deepEqual(f.calls,['isolated:master']); assert.equal(r.text,'FINDING_master');
 assert.ok(!f.requests[0].tools?.some((t:any)=>t.name==='agent_spawn'));
}));
test('tool capability fails without a speculative advisor or replacement model', () => fixture(async f => {
 delete f.providers.master.runAgent;
 await assert.rejects(f.loop.run([], 'Read the project file.', {}, [], f.options), /도구 작업을 지원하지 않습니다/);
 assert.deepEqual(f.calls,[]);
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
