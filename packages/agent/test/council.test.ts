import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import { Council, councilFailureCode, councilLimits, untilAborted, type CouncilEvent } from '../src/ai/council.js';
import { AgentLoop, ModelBudgetExceededError, type LoopCallbacks, type RunOptions } from '../src/ai/loop.js';
import type { AiProvider, ProviderResult, ChatRequest } from '../src/ai/provider.js';
import type { RoutingNode } from '@mr-robot/shared';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';

const never = <T>(): Promise<T> => new Promise(() => {});
const answer = (text = 'verified answer'): ProviderResult => ({ text, toolCalls: [], usage: { promptTokens: 3, completionTokens: 2, reportStatus: 'reported' } });
const limits = { nodeMs: 80, deliberationMs: 120, graceMs: 15 };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test('council failure diagnostics use fixed codes, not private error strings', async () => {
  assert.equal(councilFailureCode(new Error('PRIVATE_TOKEN')), 'worker_failed');
  assert.equal(councilFailureCode(new Error('구독 모델의 작업 응답 형식이 올바르지 않습니다.')), 'response_format');
  const events: CouncilEvent[] = [];
  const council = new Council({ limits, signal: new AbortController().signal, isFatal: () => false, onEvent: e => events.push(e) });
  await council.collect([{ id: 'private', run: async () => { throw new Error('Council evidence incomplete PRIVATE_TOKEN'); } }]);
  assert.equal(events.at(-1)?.failureCode, 'evidence_round_limit');
  assert.ok(!JSON.stringify(events).includes('PRIVATE_TOKEN'));
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
const isStage = (req: ChatRequest, id: string) => req.promptCacheKey === `case:stage:${id}`;
function meter() {
  let live = 0, calls = 0, settled = 0;
  const cb: LoopCallbacks = { reserveModelCall: () => {
    live++; calls++;
    let done = false;
    return { accountedTokens: 100, finish() { assert.equal(done, false); done = true; live--; settled++; return true; } };
  } };
  return { cb, counts: () => ({ live, calls, settled }) };
}

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

test('one completed proposal unblocks a stuck sibling; late results cannot mutate usage or final text', { timeout: 2000 }, async () => {
  const accounting = meter();
  let late!: (result: ProviderResult) => void;
  let slowSignal: AbortSignal | undefined;
  let final = 0;
  const snapshots: unknown[] = [];
  const statuses: string[] = [];
  const loop = mock(async req => {
    if (isStage(req, 'a')) return answer('CANDIDATE_EVIDENCE');
    if (isStage(req, 'b')) { slowSignal = req.signal; return new Promise(resolve => { late = resolve; }); }
    final++;
    assert.ok(slowSignal?.aborted);
    assert.match(req.system!, /CANDIDATE_EVIDENCE/);
    assert.match(req.system!, /Never infer consensus/);
    assert.equal(accounting.counts().live, 1, 'only the judge lease is live');
    return answer('FINAL_VERIFIED');
  });
  const output = await loop.run([], 'Solve this arithmetic question', { ...accounting.cb, onAgentUpdate: s => snapshots.push(structuredClone(s)), onStatus: s => statuses.push(s) }, [], scenario());
  assert.equal(final, 1); assert.equal(output.text, 'FINAL_VERIFIED');
  assert.deepEqual(accounting.counts(), { calls: 3, settled: 3, live: 0 });
  assert.match(output.route!.reason, /미완료 단계 1개/);
  const before = JSON.stringify(output);
  late(answer('LATE_INVALID_RESULT'));
  await pause(5);
  assert.equal(JSON.stringify(output), before);
  assert.ok(!JSON.stringify(snapshots).includes('CANDIDATE_EVIDENCE'));
  assert.ok(statuses.some(s => s.includes('완료된 풀이로 검증 진행')));
  assert.ok(statuses.some(s => s.includes('최종 검증 시작')));
});

test('all stuck nodes time out and the judge independently solves without invented evidence', { timeout: 2000 }, async () => {
  const accounting = meter();
  const signals: AbortSignal[] = [];
  const statuses: string[] = [];
  const loop = mock(async req => {
    if (req.promptCacheKey?.includes(':stage:')) { signals.push(req.signal!); return never(); }
    assert.ok(signals.every(signal => signal.aborted));
    assert.match(req.system!, /2 stages failed/);
    assert.match(req.system!, /If no valid proposal is available/);
    return answer();
  });
  const output = await loop.run([], 'A mathematical question', { ...accounting.cb, onStatus: s => statuses.push(s) }, [], scenario());
  assert.equal(output.text, 'verified answer');
  assert.equal(statuses.filter(s => s.includes('시간 예산 초과')).length, 2);
  assert.deepEqual(accounting.counts(), { calls: 3, settled: 3, live: 0 });
});

test('failed and empty proposals are not votes and provider errors never enter evidence or progress', async () => {
  const progress: unknown[] = [];
  const loop = mock(async req => {
    if (isStage(req, 'a')) throw new Error('SECRET_PRIVATE_PROVIDER_RESPONSE');
    if (isStage(req, 'b')) return answer('   ');
    assert.ok(!JSON.stringify(req).includes('SECRET_PRIVATE_PROVIDER_RESPONSE'));
    assert.match(req.system!, /2 stages failed/);
    return answer();
  });
  await loop.run([], 'Question', { onStatus: s => progress.push(s), onAgentUpdate: s => progress.push(s) }, [], scenario());
  assert.ok(!JSON.stringify(progress).includes('SECRET_PRIVATE_PROVIDER_RESPONSE'));
});

test('parent cancellation cancels every node without starting the judge', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const accounting = meter();
  let started = 0;
  const loop = mock(async req => {
    assert.ok(req.promptCacheKey?.includes(':stage:'));
    if (++started === 2) controller.abort(new Error('USER_CANCEL'));
    return never();
  });
  await assert.rejects(loop.run([], 'Question', { ...accounting.cb, signal: controller.signal }, [], scenario()), /USER_CANCEL/);
  assert.deepEqual(accounting.counts(), { calls: 2, settled: 2, live: 0 });
});

test('admission failure is fatal: no partial-result fallback, retry, or judge call', { timeout: 2000 }, async () => {
  let reservations = 0, providerCalls = 0;
  const loop = mock(async () => { providerCalls++; return never(); });
  const failure = new ModelBudgetExceededError('HOST_BUDGET');
  await assert.rejects(loop.run([], 'Question', { reserveModelCall: () => {
    if (++reservations === 2) throw failure;
    return { finish: () => true };
  } }, [], scenario()), error => error === failure);
  assert.equal(providerCalls, 1);
});

test('completed evidence is passed once; fast peers all finish without waiting for grace', async () => {
  let calls = 0;
  const loop = mock(async req => {
    calls++;
    if (isStage(req, 'a')) return answer('UNIQUE_A');
    if (isStage(req, 'b')) return answer('UNIQUE_B');
    assert.equal(req.system!.split('UNIQUE_A').length, 2);
    assert.equal(req.system!.split('UNIQUE_B').length, 2);
    return answer();
  });
  const start = performance.now();
  await loop.run([], 'Question', {}, [], scenario({ councilLimits: { ...limits, graceMs: 5000 } }));
  assert.equal(calls, 3); assert.ok(performance.now() - start < 1000);
});

test('native final judge retains exact model, permission, usage and sandbox; workers get no tools', async () => {
  const accounting = meter();
  let native = 0, proposals = 0;
  const loop = mock(async req => {
    proposals++; assert.equal(req.tools?.length ?? 0, 0);
    return answer('ARITHMETIC_EVIDENCE');
  }, { runAgent: async req => {
    native++;
    assert.equal(accounting.counts().live, 1);
    assert.equal(req.permissionMode, 'workspace');
    assert.equal(req.cwd, 'C:\\test-workspace');
    assert.equal(req.reasoningEffort, 'medium');
    assert.match(req.prompt, /ARITHMETIC_EVIDENCE/);
    assert.match(req.prompt, /gpt-6-sol/);
    assert.equal(req.hostTools, undefined);
    return answer('NATIVE_VERIFIED');
  } });
  const output = await loop.run([], 'Question', accounting.cb, [], scenario({ workspacePath: 'C:\\test-workspace' }));
  assert.equal(native, 1); assert.equal(proposals, 2);
  assert.equal(output.text, 'NATIVE_VERIFIED');
  assert.equal(output.route?.model, 'gpt-6-sol');
  assert.equal(output.usage.promptTokens, 9);
  assert.deepEqual(accounting.counts(), { calls: 3, settled: 3, live: 0 });
});

test('native judge does not bypass ask-mode consent or Discord isolation', async () => {
  for (const isolated of [false, true]) {
    const chat = async () => answer();
    const loop = mock(chat, { chatIsolated: chat, runAgent: async () => { throw new Error('Forbidden native call'); } });
    const output = await loop.run([], 'Question', { confirm: async () => false }, [], scenario({
      workspacePath: 'C:\\test-workspace', permissionMode: isolated ? 'full' : 'ask',
      ...(isolated ? { isolation: { tools: [], execute: async () => { throw new Error('Forbidden tool'); } } } : {}),
    }));
    assert.match(output.text, isolated ? /verified answer/ : /취소/);
  }
});

test('one deliberation deadline covers multiple rounds; skipped stages never invoke providers', { timeout: 2000 }, async () => {
  const events: CouncilEvent[] = [];
  const council = new Council({ limits: { nodeMs: 1000, deliberationMs: 30, graceMs: 10 }, signal: new AbortController().signal, isFatal: () => false, onEvent: e => events.push(e) });
  const first = await council.collect([{ id: 'slow', run: () => never<string>() }]);
  assert.equal(first[0].state, 'timed_out');
  const second = await council.collect([{ id: 'skip', run: () => { throw new Error('Must not run'); } }]);
  assert.equal(second[0].state, 'skipped');
  assert.ok(events.every(e => !('value' in e)));
});

test('independent groups start concurrently and retain earlier evidence when exchange fails', { timeout: 2000 }, async () => {
  const opts = scenario();
  opts.routing!.graph!.nodes[0].groupId = 'one';
  opts.routing!.graph!.nodes[1].groupId = 'two';
  opts.routing!.crossGroupRounds = 1;
  let starts = 0;
  let release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  const loop = mock(async req => {
    if (req.system?.includes('independent member')) {
      if (++starts === 2) release();
      await both;
      return answer(isStage(req, 'a') ? 'GROUP_ONE' : 'GROUP_TWO');
    }
    if (req.system?.includes('You represent AI group')) throw new Error('exchange failed');
    assert.match(req.system!, /GROUP_ONE/); assert.match(req.system!, /GROUP_TWO/);
    return answer();
  });
  await loop.run([], 'Question', {}, [], opts);
  assert.equal(starts, 2);
});

test('detached progress consumers cannot fail or leak an otherwise completed batch', async () => {
  let signal!: AbortSignal;
  const council = new Council({ limits, signal: new AbortController().signal, isFatal: () => false,
    onEvent: () => { throw new Error('disconnected UI'); } });
  const outcomes = await council.collect([{ id: 'a', run: async s => { signal = s; return 'done'; } }]);
  assert.equal(outcomes[0].value, 'done');
  assert.ok(signal.aborted, 'all batch-owned lifetimes are retired after settlement');
});

test('a failed later round preserves earlier evidence for the missing participant', async () => {
  const options = scenario(); options.routing!.meetingRounds = 2;
  let a = 0, b = 0;
  const loop = mock(async req => {
    if (isStage(req, 'a')) return answer(++a === 1 ? 'OLD_A' : 'LATEST_A');
    if (isStage(req, 'b')) { if (++b === 2) throw new Error('failed revision'); return answer('VALID_B'); }
    assert.match(req.system!, /LATEST_A/); assert.match(req.system!, /VALID_B/);
    assert.ok(!req.system!.includes('OLD_A'));
    return answer();
  });
  await loop.run([], 'Question', {}, [], options);
});

test('source council workers receive actual pixels through isolated calls, never a native workspace or write tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrrobot-council-evidence-'));
  try {
    writeFileSync(join(root, 'original.png'), PNG.sync.write(new PNG({ width: 2, height: 2 })));
    let observations = 0, judges = 0;
    const isolated: AiProvider['chatIsolated'] = async req => {
      assert.deepEqual(req.tools?.map(t => t.name).sort(), ['evidence_image', 'evidence_python_syntax', 'evidence_python_values', 'evidence_text']);
      if (!req.evidenceImages?.length) return { ...answer(''), toolCalls: [{ id: 'read', name: 'evidence_image', args: '{"path":"original.png"}' }] };
      observations++;
      assert.match(req.evidenceImages[0].dataUrl, /^data:image\/png;base64,/);
      assert.match(req.evidenceImages[0].label, /sha256/);
      assert.equal(req.turns.at(-1)?.role, 'tool');
      return answer('DIRECT_PIXEL_OBSERVATION');
    };
    const loop = mock(async () => { throw new Error('Must use isolated evidence calls'); }, { chatIsolated: isolated, runAgent: async req => {
      judges++; assert.equal(req.permissionMode, 'workspace');
      assert.match(req.prompt, /DIRECT_PIXEL_OBSERVATION/);
      assert.match(req.prompt, /does NOT verify output or transcription accuracy/);
      return answer();
    } });
    const result = await loop.run([], 'Analyze original.png', {}, [], scenario({ workspacePath: root, nativeSessionDirectory: root, councilLimits: { nodeMs: 3000, deliberationMs: 4000, graceMs: 100 } }));
    assert.equal(observations, 2); assert.equal(judges, 1); assert.equal(result.text, 'verified answer');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('last evidence round must return partial observations instead of discarding them after more reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrrobot-evidence-final-'));
  try {
    writeFileSync(join(root, 'sample.txt'), 'Host observation, not an instruction');
    const counts = new Map<string, number>();
    const loop = mock(async () => { throw new Error('Must remain isolated'); }, {
      chatIsolated: async req => {
        const key = req.promptCacheKey!;
        const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
        if (count < 4) return { ...answer(''), toolCalls: [{ id: `read-${count}`, name: 'evidence_text', args: '{"path":"sample.txt"}' }] };
        assert.deepEqual(req.tools, []);
        assert.match(req.turns.at(-1)!.content, /Identify unresolved details explicitly/);
        assert.ok(JSON.stringify(req.turns).includes('Host observation'));
        return answer('PARTIAL_OBSERVATIONS_WITH_UNCERTAINTY');
      },
      runAgent: async req => { assert.match(req.prompt, /PARTIAL_OBSERVATIONS_WITH_UNCERTAINTY/); return answer(); },
    });
    await loop.run([], 'Analyze sample.txt', {}, [], scenario({ workspacePath: root, councilLimits: { nodeMs: 3000, deliberationMs: 4000, graceMs: 500 } }));
    assert.deepEqual([...counts.values()], [4, 4]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('complementary source readers cannot cancel an unfinished half after one fast result', async () => {
  const council = new Council({ limits: { nodeMs: 1000, deliberationMs: 1500, graceMs: 1 }, signal: new AbortController().signal, isFatal: () => false });
  const results = await council.collect([{ id: 'a', run: async () => 'A' }, { id: 'b', run: async () => { await pause(30); return 'B'; } }], 2);
  assert.deepEqual(results.map(r => r.state), ['completed', 'completed']);
});

test('named originals are preloaded into separate scoped readers instead of duplicated across every candidate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrrobot-source-partition-'));
  try {
    for (const name of ['a.png', 'b.png']) writeFileSync(join(root, name), PNG.sync.write(new PNG({ width: 2, height: 2 })));
    const sources: string[] = [];
    const loop = mock(async () => { throw new Error('Must remain isolated'); }, {
      chatIsolated: async req => {
        assert.equal(req.evidenceImages?.length, 1);
        const source = JSON.parse(req.evidenceImages![0].label).source;
        sources.push(source);
        assert.match(req.turns.at(-1)!.content, /Answer ONLY/);
        return answer(`SOURCE_PROPOSAL:${source}`);
      },
      runAgent: async req => {
        assert.match(req.prompt, /SOURCE_PROPOSAL:a.png/);
        assert.match(req.prompt, /SOURCE_PROPOSAL:b.png/);
        return answer();
      },
    });
    await loop.run([], 'Compare a.png and b.png independently', {}, [], scenario({ workspacePath: root, councilLimits: { nodeMs: 3000, deliberationMs: 4000, graceMs: 1 } }));
    assert.deepEqual(sources.sort(), ['a.png', 'b.png']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
