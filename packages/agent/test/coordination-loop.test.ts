import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentLoop, toolsFor, type LoopCallbacks } from '../src/ai/loop.js';
import { ToolExecutor } from '../src/ai/executor.js';
import { pooledNativeCodex, closeNativeWorkers } from '../src/ai/cli-native-pool.js';
import { waitForCliRetirements } from '../src/ai/cli-process-retirement.js';
import { coordinationTools, executeCoordination } from '../src/ai/coordination-tools.js';
import { SubagentManager } from '../src/ai/subagents.js';
import type { AiProvider, ChatRequest, ProviderResult, ProviderUsage, Turn } from '../src/ai/provider.js';
import type { SubagentSnapshot } from '../src/ai/subagents.js';

const result = (text = '', toolCalls: ProviderResult['toolCalls'] = [], promptTokens = 3, completionTokens = 2): ProviderResult => ({
  text, toolCalls, usage: { promptTokens, completionTokens, reportStatus: 'reported' },
});
const tool = (id: string, name: string, args: unknown) => ({ id, name, args: JSON.stringify(args) });
function provider(overrides: Partial<AiProvider> = {}): AiProvider {
  return { id: 'selected-provider', label: 'Selected', type: 'openai-compatible', baseUrl: '', model: 'selected-model',
    supportedReasoning: ['auto', 'high'], supportsTools: true, chat: async () => result('done'),
    ping: async () => ({ ok: true }), models: async () => ['selected-model'], ...overrides };
}
function registry(selected: AiProvider) {
  return { default: () => selected, costTier: () => 0, getForModel: (id: string, model: string) => {
    assert.equal(id, selected.id); assert.equal(model, selected.model); return selected;
  } } as any;
}
function lastTools(req: ChatRequest) { return req.turns.at(-1)?.toolResults ?? []; }
test('English tool hints do not match substrings in ordinary questions', () => {
  for (const text of ['Find the greatest possible value.', 'What is the latest result?', 'Describe a happy archetype.', 'Explain a profile in psychology.']) assert.deepEqual(toolsFor(text), []);
  for (const text of ['Run tests', 'TEST the change', 'Run a shell command', '명령 실행해', '테스트해줘']) assert.ok(toolsFor(text).some(t=>t.name==='shell_exec'));
  assert.ok(toolsFor('Read files in this project').some(t=>t.name==='read_file'));
  assert.ok(toolsFor('Open the app').some(t=>t.name==='launch_app'));
  assert.ok(toolsFor('Type with the keyboard').some(t=>t.name==='type_text'));
});

test('mathematics vote stays on the selected text model without an accidental tool executor', async () => {
  let calls=0;
  const selected=provider({type:'codex-cli',model:'gpt-6-sol',supportsTools:false,chat:async req=>{
    calls++; assert.equal(req.tools?.length??0,0); return result('Answer: 1');
  }});
  const reg={default:()=>selected,resolve:()=>selected,costTier:()=>0,
    toolCapable:()=>{ throw new Error('must not switch models for greatest'); }} as any;
  const nodes=['a','b','judge'].map((id,i)=>({id,kind:'model' as const,label:id,role:i===2?'critic' as const:'reasoning' as const,providerId:selected.id,providerModel:selected.model,x:i*100,y:0}));
  const answer=await new AgentLoop(reg,{} as any).run([],'Find the greatest possible value.',{},[],{
    reasoningEffort:'high',permissionMode:'workspace',routing:{mode:'quality',executionMode:'vote',meetingRounds:1,crossGroupRounds:0,maxPremiumCalls:12,escalationEnabled:false,roles:{},graph:{nodes,edges:[]}},
  });
  assert.equal(calls,1); assert.equal(answer.route?.model,selected.model);
});
function instrument() {
  let admitted = 0, settled = 0, live = 0;
  const deltas: ProviderUsage[] = [];
  const kinds: string[] = [];
  const callbacks: LoopCallbacks = {
    reserveModelCall: kind => {
      admitted++; live++; kinds.push(kind);
      let finished = false, accountedTokens = 0;
      return { get accountedTokens() { return accountedTokens; }, finish: usage => {
        assert.equal(finished, false, 'a provider lease must settle exactly once');
        finished = true; settled++; live--;
        accountedTokens = usage ? usage.promptTokens + usage.completionTokens : 1;
        return true;
      } };
    },
    onModelUsage: usage => deltas.push(usage),
  };
  return { callbacks, deltas, kinds, counts: () => ({ admitted, settled, live }) };
}
async function workspace<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'mrrobot-coordination-loop-'));
  try { writeFileSync(join(directory, 'alpha.txt'), 'alpha fixture'); writeFileSync(join(directory, 'beta.txt'), 'beta fixture'); return await run(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const native of [false, true]) test(`Discord direct ${native ? 'native' : 'API'} execution has no helpers or PC preset`, () => workspace(async directory => {
  let calls = 0;
  const selected = provider({ type: native ? 'codex-cli' : 'openai-compatible', supportsTools: !native,
    chat: async req => {
      calls++; assert.ok(!req.tools?.some(t => t.name.startsWith('agent_')));
      return result('single direct response');
    },
    chatIsolated: async () => { throw new Error('No helper may execute'); },
    ...(native ? { runAgent: async (req: any) => {
      calls++; assert.ok(!req.hostTools?.tools.some((t: any) => t.name.startsWith('agent_')));
      assert.ok(!req.session?.instructions.includes('agent_spawn'));
      assert.equal(req.session.key, 'discord-ticket');
      return result('single direct response');
    } } : {}),
  });
  const loop = new AgentLoop(registry(selected), {} as any);
  const output = await loop.run([], 'Review this workspace', {}, [], {
    workspacePath: directory, permissionMode: 'read-only', tokenPolicy: 'audit-only',
    cacheKey: 'discord-ticket', nativeSessionDirectory: directory, singleModelOnly: true,
    routing: { mode: 'quality', executionMode: 'vote', maxPremiumCalls: 12, escalationEnabled: false, roles: {}, graph: { nodes: [], edges: [] } },
  });
  assert.equal(calls, 1);
  assert.equal(output.text, 'single direct response');
}));

test('Discord direct text-only model cannot hand tools off to another model', () => workspace(async directory => {
  const selected = provider({ supportsTools: false, chat: async () => { throw new Error('No advisor call'); } });
  await assert.rejects(new AgentLoop(registry(selected), {} as any).run([], 'Read files in this workspace', {}, [], {
    workspacePath: directory, permissionMode: 'read-only', singleModelOnly: true,
  }), /다른 모델로 전환하지 않았습니다/);
}));

test('hallucinated API helper is rejected locally without starting another model or generic executor', () => workspace(async directory => {
 let calls = 0;
 const selected = provider({chat: async req => {
   calls++;
   assert.ok(!req.tools?.some(t=>t.name.startsWith('agent_')));
   if(calls === 1) return result('', [tool('forbidden','agent_spawn',{task:'do work'})]);
   assert.match(lastTools(req)[0].content, /단일 에이전트/);
   return result('single final');
 }, chatIsolated: async()=>{throw Error('No child execution');}});
 const loop = new AgentLoop(registry(selected), {execute: async()=>{throw Error('No generic helper execution');}} as any);
 const answer = await loop.run([], 'Inspect the workspace', {}, [], {workspacePath:directory,permissionMode:'workspace'});
 assert.equal(answer.text, 'single final'); assert.equal(calls,2);
}));
for (const mode of ['read-only','workspace','full'] as const) test(`native ${mode} owns all work and exposes no delegation tools`, () => workspace(async directory => {
 let calls=0;
 const selected=provider({type:'codex-cli',supportsTools:false,runAgent:async req=>{
  calls++; assert.equal(req.nativeDelegation, undefined);
  assert.ok(!req.hostTools?.tools.some(t=>t.name.startsWith('agent_')));
  assert.match(req.session!.instructions, /only agent/);
  return result('native final');
 }});
 const answer = await new AgentLoop(registry(selected),{} as any).run([], 'Inspect project files', {}, [], {
  workspacePath:directory,permissionMode:mode,tokenPolicy:'audit-only',cacheKey:'owner',nativeSessionDirectory:directory,
 });
 assert.equal(answer.text,'native final'); assert.equal(calls,1);
}));

test('coordination dispatch preserves explicit assignment identity for default and configured workers', async () => {
  for (const workers of [[], [{ id: 'review', label: 'Review', providerId: 'fixture', model: 'fixture' }]]) {
    const schema = coordinationTools(workers).find(tool => tool.name === 'agent_spawn')!.parameters as any;
    assert.equal(schema.properties.assignmentKey.maxLength, 128);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const manager = new SubagentManager({ providerId: 'fixture', model: 'fixture', workers, execute: async () => {
      calls++; await gate; return { text: 'Independent result' };
    } });
    const signal = new AbortController().signal;
    try {
      const input = { task: 'Check the same source', assignmentKey: 'retry-this-assignment', workerId: workers[0]?.id };
      const first = JSON.parse(await executeCoordination(manager, 'agent_spawn', input, signal));
      const retry = JSON.parse(await executeCoordination(manager, 'agent_spawn', input, signal));
      assert.equal(retry.agentId, first.agentId); assert.equal(retry.reused, true);
      const independent = JSON.parse(await executeCoordination(manager, 'agent_spawn', { ...input, assignmentKey: 'independent-review' }, signal));
      assert.notEqual(independent.agentId, first.agentId);
      release(); await manager.drained(); assert.equal(calls, 2);
    } finally { release(); manager.dispose(); await manager.drained(); }
  }
});

test('coordination cursor strips repeated result bodies and repeated waits cannot create budget progress', async () => {
  const manager = new SubagentManager({ providerId: 'fixture', model: 'fixture', execute: async () => ({ text: 'completed evidence' }) });
  const signal = new AbortController().signal;
  try {
    manager.spawn({ task: 'bounded fixture' }); await manager.drained();
    const initial = JSON.parse(await executeCoordination(manager, 'agent_wait', {}, signal));
    assert.equal(initial.progress, true); assert.equal(initial.agents[0].result, 'completed evidence');
    const unchanged = JSON.parse(await executeCoordination(manager, 'agent_wait', { afterSequence: initial.sequence, timeoutMs: 0 }, signal));
    assert.equal(unchanged.progress, false); assert.equal(unchanged.agents[0].result, undefined);
    const repeated = JSON.parse(await executeCoordination(manager, 'agent_wait', {}, signal));
    assert.equal(repeated.progress, false, 'omitting a model-controlled cursor cannot manufacture verified progress');
    assert.equal(repeated.agents[0].result, undefined, 'host delivery state also bounds output without a cursor');
    const stale = JSON.parse(await executeCoordination(manager, 'agent_wait', { afterSequence: 0 }, signal));
    assert.equal(stale.progress, false, 'replaying a stale cursor cannot manufacture verified progress');
    assert.equal(stale.agents[0].result, undefined);
  } finally { manager.dispose(); await manager.drained(); }
});

test('waiting for one child cannot hide undelivered sibling evidence behind a global cursor', async () => {
  const manager = new SubagentManager({ providerId: 'fixture', model: 'fixture', execute: async input => ({ text: `Evidence for ${input.task}` }) });
  const signal = new AbortController().signal;
  try {
    const first = manager.spawn({ task: 'first source' }), second = manager.spawn({ task: 'second source' });
    await manager.drained();
    const selected = JSON.parse(await executeCoordination(manager, 'agent_wait', { agentIds: [second.agentId] }, signal));
    assert.equal(selected.agents[0].result, 'Evidence for second source');
    const unread = JSON.parse(await executeCoordination(manager, 'agent_wait', { agentIds: [first.agentId], afterSequence: selected.sequence }, signal));
    assert.equal(unread.agents[0].result, 'Evidence for first source');
    assert.equal(unread.progress, true);
    assert.ok(unread.waitedMs < 1000, 'already available unread evidence must not wait for the long-poll deadline');
    const repeated = JSON.parse(await executeCoordination(manager, 'agent_wait', { timeoutMs: 0 }, signal));
    assert.ok(repeated.agents.every((agent: any) => agent.result === undefined));
    assert.equal(repeated.progress, false);
  } finally { manager.dispose(); await manager.drained(); }
});

test('concurrent waits deliver a completion once and a later follow-up only after it finishes', async () => {
  let finish: ((value: { text: string }) => void) | undefined;
  let calls = 0;
  const manager = new SubagentManager({ providerId: 'fixture', model: 'fixture', execute: async () => {
    if (++calls === 1) return { text: 'First evidence' };
    return new Promise(resolve => { finish = resolve; });
  } });
  const signal = new AbortController().signal;
  try {
    const { agentId } = manager.spawn({ task: 'first source' }); await manager.drained();
    const waits = await Promise.all(Array.from({ length: 8 }, async () => JSON.parse(await executeCoordination(manager, 'agent_wait', { agentIds: [agentId] }, signal))));
    assert.equal(waits.filter(wait => wait.progress).length, 1);
    assert.equal(waits.filter(wait => wait.agents[0].result === 'First evidence').length, 1);
    manager.message({ agentId, message: 'Check the changed source' });
    const running = JSON.parse(await executeCoordination(manager, 'agent_wait', { agentIds: [agentId], timeoutMs: 0 }, signal));
    assert.equal(running.agents[0].result, undefined, 'a follow-up must not present the previous result as current evidence');
    await new Promise(resolve => setImmediate(resolve));
    finish!({ text: 'New evidence' }); await manager.drained();
    const final = JSON.parse(await executeCoordination(manager, 'agent_wait', { agentIds: [agentId], afterSequence: Number.MAX_SAFE_INTEGER }, signal));
    assert.equal(final.agents[0].result, 'New evidence'); assert.equal(final.progress, true);
  } finally { finish?.({ text: 'cleanup' }); manager.dispose(); await manager.drained(); }
});

test('unread failures survive cursors without manufacturing evidence progress', async () => {
  const manager = new SubagentManager({ providerId: 'fixture', model: 'fixture', execute: async () => { throw new Error('read failed'); } });
  const signal = new AbortController().signal;
  try {
    manager.spawn({ task: 'read a missing source' }); await manager.drained();
    const failed = JSON.parse(await executeCoordination(manager, 'agent_wait', { afterSequence: Number.MAX_SAFE_INTEGER }, signal));
    assert.equal(failed.agents[0].error, 'read failed'); assert.equal(failed.progress, false);
    const repeated = JSON.parse(await executeCoordination(manager, 'agent_wait', { timeoutMs: 0 }, signal));
    assert.equal(repeated.agents[0].error, undefined);
  } finally { manager.dispose(); await manager.drained(); }
});
