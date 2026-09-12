import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { NativeRunScheduler } from '../src/ai/native-run-scheduler.js';
import { pooledNativeCodex, closeNativeWorkers } from '../src/ai/cli-native-pool.js';
import { waitForCliRetirements } from '../src/ai/cli-process-retirement.js';
import { ChatSession } from '../src/server/chat.js';
import { AgentLoop } from '../src/ai/loop.js';
import type { NativeAgentRequest, Turn } from '../src/ai/provider.js';

const fixture = fileURLToPath(new URL('./fixtures/native-control-app-server.mjs', import.meta.url));
async function sandbox(fn: (base: NativeAgentRequest, call: (req: NativeAgentRequest) => ReturnType<typeof pooledNativeCodex>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'mrrobot-control-test-'));
  const base: NativeAgentRequest = { prompt: 'fixture', cwd: dir, permissionMode: 'read-only',
    session: { key: 'fixture-ticket', directory: dir, history: [], input: 'hello', instructions: 'fixture only', context: '' } };
  const call = (req: NativeAgentRequest) => pooledNativeCodex({ command: process.execPath, prefixArgs: [fixture], env: process.env, providerId: 'fixture', model: 'fixture', req });
  try { await fn(base, call); }
  finally { closeNativeWorkers(); await waitForCliRetirements(process.env); rmSync(dir, { recursive: true, force: true }); }
}

test('scheduler is FIFO, bounded, cancel-aware and rejects duplicate ownership', async () => {
  const scheduler = new NativeRunScheduler(1, 2);
  const release = await scheduler.acquire('a');
  const abort = new AbortController(); const positions: number[] = [];
  const b = scheduler.acquire('b', abort.signal);
  const c = scheduler.acquire('c', undefined, p => positions.push(p));
  await assert.rejects(scheduler.acquire('a'), /같은 대화/);
  await assert.rejects(scheduler.acquire('overflow'), /가득/);
  abort.abort(); await assert.rejects(b, /중지/);
  assert.equal(positions.at(-1), 1);
  release(); release(); const releaseC = await c;
  let dStarted = false;
  const d = scheduler.acquire('d').then(done => { dStarted = true; return done; });
  await delay(10); assert.equal(dStarted, false, 'idempotent release cannot grant extra slots');
  releaseC(); (await d)();
});

test('scheduler shutdown clears queued jobs and listeners without starting them', async () => {
  const scheduler = new NativeRunScheduler(1);
  const release = await scheduler.acquire('a');
  const pending = scheduler.acquire('b');
  scheduler.cancelPending(); await assert.rejects(pending, /종료/);
  release(); (await scheduler.acquire('b'))();
});

test('detached queue progress consumers cannot leak execution slots', async () => {
  const scheduler = new NativeRunScheduler(1);
  const release = await scheduler.acquire('a');
  const queued = scheduler.acquire('b', undefined, () => { throw Error('disconnected UI'); });
  release(); (await queued)(); (await scheduler.acquire('c'))();
});

test('steering queue never silently drops an unacknowledged instruction', () => {
  const session = new ChatSession(); session.begin();
  let events = 0; const unsubscribe = session.nativeSteering.subscribe(() => events++);
  for (let i = 0; i < 20; i++) session.steer(`input ${i}`);
  assert.throws(() => session.steer('overflow'), /20개/);
  assert.equal(session.nativeSteering.peek()[0], 'input 0');
  assert.equal(session.nativeSteering.commit(['wrong']), false);
  assert.equal(session.nativeSteering.commit(['input 0']), true);
  unsubscribe(); session.steer('input 20'); assert.equal(events, 20);
  session.end(); assert.equal(session.steeringQueued, 0);
  assert.throws(() => session.steer('after end'), /실행 중인 작업/);
  session.begin(); session.cancel(); assert.throws(() => session.steer('after stop'), /실행 중인 작업/); session.end();
});

for (const mode of ['STREAM', 'STREAM_NO_START']) test(`public text streams before completion when phase is absent: ${mode}`, () => sandbox(async (base, call) => {
  let first = 0, settled = false, text = ''; const started = performance.now();
  let firstDelta!: () => void; const delta = new Promise<void>(resolve => { firstDelta = resolve; });
  const pending = call({ ...base, session: { ...base.session!, input: mode }, onText: chunk => {
    if (!first) first = performance.now(); text += chunk; firstDelta();
  } }).then(result => { settled = true; return result; });
  await delta; assert.equal(settled, false, 'first output must not wait for item/completed');
  const result = await pending;
  assert.equal(text, result.text); assert.equal(text.includes('PRIVATE_REASONING'), false);
  console.log(`[synthetic ${mode}] first text ${Math.round(first - started)}ms; complete ${Math.round(performance.now() - started)}ms`);
}));

for (const mode of ['LIVE_STEER', 'LATE_ACK']) test(`active-turn steering commits once and preserves warm session: ${mode}`, () => sandbox(async (base, call) => {
  const session = new ChatSession(); session.begin(); let sent = false; const applied: string[] = [];
  const req = { ...base, session: { ...base.session!, input: mode }, steering: session.nativeSteering,
    onSteeringApplied: (inputs: readonly string[]) => applied.push(...inputs),
    onStatus: (status: string) => { if (status.includes('요청을 검토') && !sent) { sent = true; session.steer('keep existing work'); } },
  };
  const result = await call(req);
  assert.equal(result.text, 'steered 1: keep existing work');
  assert.deepEqual(applied, ['keep existing work']); assert.equal(session.steeringQueued, 0);
  const history: Turn[] = [{ role: 'user', content: mode }, { role: 'user', content: applied[0] }, { role: 'assistant', content: result.text }];
  const next = await call({ ...base, session: { ...base.session!, history, input: 'next' } });
  assert.equal(next.text, 'answer 2', 'acknowledged steering must not invalidate next-turn reuse');
  session.end();
}));

test('definitive steering rejection retains input for fallback without interrupting the turn', () => sandbox(async (base, call) => {
  const session = new ChatSession(); session.begin(); session.steer('follow up'); let applied = false;
  const result = await call({ ...base, session: { ...base.session!, input: 'REJECT_STEER' }, steering: session.nativeSteering,
    onSteeringApplied: () => { applied = true; } });
  assert.equal(result.text, 'answer 1'); assert.equal(applied, false);
  assert.deepEqual(session.takeSteering(), ['follow up']); session.end();
}));

test('wrong steering acknowledgement fails closed without consuming host input', () => sandbox(async (base, call) => {
  const session = new ChatSession(); session.begin(); session.steer('follow up');
  await assert.rejects(call({ ...base, session: { ...base.session!, input: 'WRONG_STEER' }, steering: session.nativeSteering }), /검증/);
  assert.deepEqual(session.takeSteering(), ['follow up']); session.end();
}));

for (const mode of ['INTERRUPT_ACTIVE', 'IGNORE_INTERRUPT']) test(`cancellation uses protocol interrupt and bounded retirement: ${mode}`, () => sandbox(async (base, call) => {
  const abort = new AbortController(); let at = 0;
  const pending = call({ ...base, signal: abort.signal, session: { ...base.session!, input: mode },
    onStatus: status => { if (status.includes('요청을 검토') && !at) { at = performance.now(); abort.abort(); } },
    onText: () => { assert.fail('no output after cancellation'); },
  });
  await assert.rejects(pending, /중지/);
  assert.ok(performance.now() - at < 3000, 'unresponsive CLI must be retired');
  assert.match(readFileSync(join(base.cwd, 'interrupt-observed.txt'), 'utf8'), /interrupt/);
  assert.equal((await call(base)).text, 'answer 1', 'cancelled partial turn is not resumed');
}));

test('worker capacity queues a fifth conversation instead of failing', () => sandbox(async (base, call) => {
  const queued: string[] = [];
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => call({ ...base,
    session: { ...base.session!, key: `ticket-${i}`, input: 'SLOW_SLOT' }, onStatus: status => { if (status.includes('실행 대기')) queued.push(status); },
  })));
  assert.equal(results.length, 5); assert.ok(queued.length > 0);
}));

test('shutdown between admission and process launch does not spawn a new worker', () => sandbox(async (base, call) => {
  const pending = call(base); closeNativeWorkers(); await assert.rejects(pending, /종료/);
}));

test('native loop uses one selected-provider invocation and persists live instructions for reuse', () => sandbox(async (base, call) => {
  const session = new ChatSession(); session.begin(); let sent = false, calls = 0, policyChecks = 0;
  const native = {
    id: 'fixture', label: 'Fixture', type: 'codex-cli', model: 'fixture', supportedReasoning: ['auto', 'high'], supportsTools: false,
    chat() { throw Error('single native mode must not call a coordinator model'); },
    async runAgent(req: NativeAgentRequest) { calls++; assert.equal(req.reasoningEffort, 'high'); return call(req); },
  };
  const loop = new AgentLoop({ default: () => native } as any, { execute: async () => '{}' } as any);
  const callbacks = { nativeSteering: session.nativeSteering, takeSteering: () => session.takeSteering(),
    beforeModelCall: () => { policyChecks++; },
    onStatus: (status: string) => { if (status.includes('요청을 검토') && !sent) { sent = true; session.steer('keep work'); } },
  };
  const options = { workspacePath: base.cwd, cacheKey: 'fixture', nativeSessionDirectory: base.session!.directory,
    permissionMode: 'read-only' as const, reasoningEffort: 'high' as const };
  const first = await loop.run([], 'LIVE_STEER', callbacks, [], options);
  assert.equal(calls, 1); assert.equal(policyChecks, 1);
  assert.deepEqual(first.turns.map(t => t.content), ['LIVE_STEER', 'keep work', 'steered 1: keep work']);
  const second = await loop.run(first.turns, 'next', callbacks, [], options);
  assert.equal(second.text, 'answer 2'); assert.equal(calls, 2); assert.equal(policyChecks, 2);
  session.end();
}));

test('print-CLI continuation persists the full verified transcript, not only the final answer', async () => {
  let calls = 0, steeringReads = 0;
  const provider = {
    id: 'fixture', label: 'Fixture', type: 'codex-cli', model: 'fixture', supportedReasoning: ['auto'], supportsTools: false,
    runAgent: async () => ({ text: `answer ${++calls}`, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } }),
  };
  const loop = new AgentLoop({ default: () => provider } as any, {} as any);
  const result = await loop.run([], 'original', { takeSteering: () => ++steeringReads === 1 ? ['follow-up'] : [] }, [],
    { workspacePath: tmpdir(), permissionMode: 'read-only' });
  assert.deepEqual(result.turns.map(t => t.content), ['original', 'answer 1', 'follow-up', 'answer 2']);
});
