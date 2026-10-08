import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import { Council, councilFailureCode, councilLimits, untilAborted, type CouncilEvent } from '../src/ai/council.js';
import { AgentLoop, ModelBudgetExceededError, type LoopCallbacks, type RunOptions } from '../src/ai/loop.js';
import type { AiProvider, ProviderResult } from '../src/ai/provider.js';
import type { RoutingNode } from '@mr-robot/shared';

const never = <T>(): Promise<T> => new Promise(() => {});
const answer = (text = 'verified answer'): ProviderResult => ({ text, toolCalls: [], usage: { promptTokens: 3, completionTokens: 2, reportStatus: 'reported' } });
const limits = { nodeMs: 80, deliberationMs: 120, graceMs: 15 };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// The Council utility remains covered for stored legacy tooling; the runtime
// deliberately never dispatches its graphs under the single-agent policy.

test('large councils bound active calls and preserve caller ordering', async () => {
  let active=0,peak=0;
  const council=new Council({limits:{nodeMs:1000,deliberationMs:5000,graceMs:100,maxConcurrent:3},signal:new AbortController().signal,isFatal:()=>false});
  const results=await council.collect(Array.from({length:11},(_,i)=>({id:String(i),run:async()=>{peak=Math.max(peak,++active);await pause(10);active--;return i;}})),11);
  assert.equal(peak,3);assert.equal(active,0);
  assert.deepEqual(results.map(r=>r.value),Array.from({length:11},(_,i)=>i));
});

test('a timed-out uncooperative node does not free capacity for queued calls', async () => {
  let calls=0;
  const council=new Council({limits:{nodeMs:15,deliberationMs:100,graceMs:10,maxConcurrent:1},signal:new AbortController().signal,isFatal:()=>false});
  const r=await council.collect(Array.from({length:3},(_,i)=>({id:String(i),run:async()=>{calls++;return never();}})),3);
  assert.equal(calls,1);assert.deepEqual(r.map(x=>x.state),['timed_out','skipped','skipped']);
  assert.throws(()=>new Council({limits:{...limits,maxConcurrent:99},signal:new AbortController().signal,isFatal:()=>false}),/concurrency/);
});

test('parent cancellation never starts queued council jobs', async () => {
  const controller=new AbortController();let calls=0;
  const council=new Council({limits:{...limits,maxConcurrent:1},signal:controller.signal,isFatal:()=>false});
  await assert.rejects(council.collect(Array.from({length:3},(_,i)=>({id:String(i),run:async()=>{calls++;controller.abort(new Error('STOP'));return never();}}))),/STOP/);
  assert.equal(calls,1);
});

test('parallel groups share one physical concurrency budget', async () => {
  let active=0,peak=0;
  const council=new Council({limits:{nodeMs:1000,deliberationMs:5000,graceMs:100,maxConcurrent:2},signal:new AbortController().signal,isFatal:()=>false});
  const group=(prefix:string)=>council.collect(Array.from({length:4},(_,i)=>({id:prefix+i,run:async()=>{peak=Math.max(peak,++active);await pause(10);active--;return i;}})),4);
  const results=await Promise.all([group('a'),group('b'),group('c')]);
  assert.equal(peak,2);assert.equal(results.flat().filter(r=>r.state==='completed').length,12);
});

test('fatal admission in one group aborts the other groups and future rounds', async () => {
  const failure=new Error('FATAL_ADMISSION');let sibling:AbortSignal|undefined;
  const council=new Council({limits:{nodeMs:1000,deliberationMs:5000,graceMs:100,maxConcurrent:2},signal:new AbortController().signal,isFatal:e=>e===failure});
  const results=await Promise.allSettled([
    council.collect([{id:'slow',run:async signal=>{sibling=signal;return never();}}]),
    council.collect([{id:'fatal',run:async()=>{throw failure;}}]),
  ]);
  assert.ok(sibling?.aborted);assert.ok(results.every(r=>r.status==='rejected'&&r.reason===failure));
  await assert.rejects(council.collect([{id:'later',run:async()=>{throw Error('must not start');}}]),e=>e===failure);
});

test('council failure diagnostics use fixed codes, not private error strings', async () => {
  assert.equal(councilFailureCode(new Error('PRIVATE_TOKEN')), 'worker_failed');
  assert.equal(councilFailureCode(new Error('구독 모델의 작업 응답 형식이 올바르지 않습니다.')), 'response_format');
  const events: CouncilEvent[] = [];
  const council = new Council({ limits, signal: new AbortController().signal, isFatal: () => false, onEvent: e => events.push(e) });
  await council.collect([{ id: 'private', run: async () => { throw new Error('Council evidence incomplete PRIVATE_TOKEN'); } }]);
  assert.equal(events.at(-1)?.failureCode, 'evidence_round_limit');
  assert.ok(!JSON.stringify(events).includes('PRIVATE_TOKEN'));
});

test('council defaults bound deliberation independently of final verification', () => {
  assert.deepEqual(councilLimits('quality'), { deliberationMs: 90000, nodeMs: 75000, graceMs: 15000 });
  assert.ok(councilLimits('economy').deliberationMs < councilLimits('balanced').deliberationMs);
});

test('abort race consumes late rejection and removes its signal listener', async () => {
  const controller = new AbortController();
  let reject!: (error: unknown) => void;
  const operation = untilAborted(new Promise((_, fail) => { reject = fail; }), controller.signal);
  const reason = new Error('cancel');
  controller.abort(reason);
  await assert.rejects(operation, error => error === reason);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  reject(new Error('late private failure'));
  await pause(0);
});

test('one deliberation deadline covers multiple rounds; skipped stages never invoke providers', { timeout: 2000 }, async t => {
  // Timer delivery and performance.now() can straddle a fractional millisecond
  // on Windows. Advance the monotonic clock explicitly before the next round.
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const events: CouncilEvent[] = [];
  const council = new Council({ limits: { nodeMs: 1000, deliberationMs: 30, graceMs: 10 }, signal: new AbortController().signal, isFatal: () => false, onEvent: e => events.push(e) });
  const first = await council.collect([{ id: 'slow', run: () => never<string>() }]);
  assert.equal(first[0].state, 'timed_out');
  now = 31;
  const second = await council.collect([{ id: 'skip', run: () => { throw new Error('Must not run'); } }]);
  assert.equal(second[0].state, 'skipped');
  assert.ok(events.every(e => !('value' in e)));
});

test('detached progress consumers cannot fail or leak an otherwise completed batch', async () => {
  let signal!: AbortSignal;
  const council = new Council({ limits, signal: new AbortController().signal, isFatal: () => false,
    onEvent: () => { throw new Error('disconnected UI'); } });
  const outcomes = await council.collect([{ id: 'a', run: async s => { signal = s; return 'done'; } }]);
  assert.equal(outcomes[0].value, 'done');
  assert.ok(signal.aborted, 'all batch-owned lifetimes are retired after settlement');
});

test('complementary source readers cannot cancel an unfinished half after one fast result', async () => {
  const council = new Council({ limits: { nodeMs: 1000, deliberationMs: 1500, graceMs: 1 }, signal: new AbortController().signal, isFatal: () => false });
  const results = await council.collect([{ id: 'a', run: async () => 'A' }, { id: 'b', run: async () => { await pause(30); return 'B'; } }], 2);
  assert.deepEqual(results.map(r => r.state), ['completed', 'completed']);
});

function scenario(overrides: Partial<RunOptions> = {}): RunOptions {
  const nodes: RoutingNode[] = ['a', 'b', 'judge'].map((id, index) => ({ id, kind: 'model', label: id,
    role: index === 2 ? 'critic' : 'reasoning', providerId: 'sol', providerModel: 'gpt-6-sol', x: index * 100, y: 0 }));
  return { cacheKey: 'case', reasoningEffort: 'medium', permissionMode: 'workspace', tokenPolicy: 'quality', councilLimits: limits,
    routing: { mode: 'quality', executionMode: 'vote', meetingRounds: 1, crossGroupRounds: 0, roles: {}, maxPremiumCalls: 12, escalationEnabled: false, graph: { nodes, edges: [] } }, ...overrides };
}
function mock(chat: AiProvider['chat'], other: Partial<AiProvider> = {}) {
  const selected: AiProvider = { id: 'sol', label: 'Selected Sol', type: 'codex-cli', baseUrl: '', model: 'gpt-6-sol', supportedReasoning: ['auto', 'medium'], supportsTools: false,
    chat, models: async () => ['gpt-6-sol'], ping: async () => ({ ok: true }), ...other };
  const registry = { default: () => selected, resolve: () => selected, costTier: () => 0,
    toolCapable: () => { throw new Error('Must not change the selected model'); } } as any;
  return new AgentLoop(registry, {} as any);
}
function meter() {
  let live = 0, calls = 0, settled = 0;
  const cb: LoopCallbacks = { reserveModelCall: () => {
    live++; calls++;
    let done = false;
    return { accountedTokens: 100, finish() { assert.equal(done, false); done = true; live--; settled++; return true; } };
  } };
  return { cb, counts: () => ({ live, calls, settled }) };
}


test('archived council graphs never run members, debates, cross-group exchanges or judges', async () => {
  for (const mode of ['vote', 'hybrid', 'single'] as const) {
    const options = scenario();
    options.routing!.executionMode = mode;
    options.routing!.meetingRounds = 3;
    options.routing!.crossGroupRounds = 2;
    const before = JSON.stringify(options), accounting = meter();
    let calls = 0;
    const loop = mock(async req => {
      calls++;
      assert.doesNotMatch(req.promptCacheKey ?? '', /:stage:|:group:|:judge/);
      assert.doesNotMatch(req.system ?? '', /independent member|represent AI group/);
      assert.doesNotMatch(req.context ?? '', /CANDIDATE_EVIDENCE|stages failed|consensus/);
      return answer('DIRECT_SELECTED_MODEL');
    });
    const result = await loop.run([], 'Answer only: 2 + 2', accounting.cb, [], options);
    assert.equal(result.text, 'DIRECT_SELECTED_MODEL');
    assert.equal(calls, 1);
    assert.deepEqual(accounting.counts(), { calls: 1, settled: 1, live: 0 });
    assert.equal(JSON.stringify(options), before, 'stored graph stays untouched');
  }
});

test('single native owner retains selected model, permission, usage and workspace without proposal calls', async () => {
  const accounting = meter(); let native = 0, proposals = 0;
  const loop = mock(async () => { proposals++; throw Error('unexpected proposal'); }, { runAgent: async req => {
    native++;
    assert.equal(accounting.counts().live, 1);
    assert.equal(req.permissionMode, 'workspace'); assert.equal(req.cwd, 'C:\\test-workspace');
    assert.equal(req.reasoningEffort, 'medium'); assert.equal(req.nativeDelegation, undefined);
    assert.match(req.prompt, /only agent/); assert.match(req.prompt, /gpt-6-sol/);
    assert.doesNotMatch(req.prompt, /ARITHMETIC_EVIDENCE|SOURCE_PROPOSAL/);
    return answer('NATIVE_VERIFIED');
  } });
  const output = await loop.run([], 'Inspect the project source', accounting.cb, [], scenario({ workspacePath: 'C:\\test-workspace' }));
  assert.equal(native, 1); assert.equal(proposals, 0);
  assert.equal(output.text, 'NATIVE_VERIFIED'); assert.equal(output.route?.model, 'gpt-6-sol');
  assert.equal(output.usage.promptTokens, 3);
  assert.deepEqual(accounting.counts(), { calls: 1, settled: 1, live: 0 });
});

test('native owner does not bypass ask-mode consent or isolated ticket tools', async () => {
  for (const isolated of [false, true]) {
    const chat = async () => answer();
    const loop = mock(chat, { chatIsolated: chat, runAgent: async () => { throw Error('Forbidden native call'); } });
    const result = await loop.run([], 'Inspect the project source', { confirm: async () => false }, [], scenario({
      workspacePath: 'C:\\test-workspace', permissionMode: isolated ? 'full' : 'ask',
      ...(isolated ? { isolation: { tools: [], execute: async () => { throw Error('Forbidden tool'); } } } : {}),
    }));
    assert.match(result.text, isolated ? /verified answer/ : /취소/);
  }
});

test('parent cancellation retires the only owner without starting a replacement', async () => {
  const controller = new AbortController(), accounting = meter(); let calls = 0;
  const loop = mock(async req => {
    calls++; controller.abort(new Error('USER_CANCEL'));
    return untilAborted(never<ProviderResult>(), req.signal!);
  });
  await assert.rejects(loop.run([], 'Answer only: 2 + 2', { ...accounting.cb, signal: controller.signal }, [], scenario()), /USER_CANCEL/);
  assert.equal(calls, 1); assert.deepEqual(accounting.counts(), { calls: 1, settled: 1, live: 0 });
});

test('admission failure starts no model, fallback, worker or judge', async () => {
  let calls = 0; const failure = new ModelBudgetExceededError('HOST_BUDGET');
  const loop = mock(async () => { calls++; return answer(); });
  await assert.rejects(loop.run([], 'Answer only: 2 + 2', { reserveModelCall: () => { throw failure; } }, [], scenario()), error => error === failure);
  assert.equal(calls, 0);
});
