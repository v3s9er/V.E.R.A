import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { SubagentManager, type SubagentExecutionInput, type SubagentSnapshot } from '../src/ai/subagents.js';

const identity = { providerId: 'selected-provider', model: 'selected-model' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function pendingWork(input: SubagentExecutionInput) {
  const pending = deferred<{ text: string }>();
  input.signal.addEventListener('abort', () => pending.reject(input.signal.reason), { once: true });
  return pending;
}

test('spawn is immediate, selected identity is retained, and each parent runs at most two workers', async () => {
  let active = 0, maximum = 0;
  const calls: Array<ReturnType<typeof pendingWork>> = [];
  const manager = new SubagentManager({ ...identity, execute: async input => {
    active++; maximum = Math.max(maximum, active);
    const pending = pendingWork(input); calls.push(pending);
    try { return await pending.promise; } finally { active--; }
  } });
  try {
    const ids = Array.from({ length: 6 }, (_, index) => manager.spawn({ task: `task ${index}` }).agentId);
    assert.equal(new Set(ids).size, 6);
    assert.match(ids[0], /^[a-f0-9-]{36}$/);
    assert.throws(() => manager.spawn({ task: 'overflow' }), /6개/);
    assert.equal(calls.length, 0, 'spawn does not await or synchronously enter provider execution');
    await tick();
    assert.equal(calls.length, 2);
    assert.equal(manager.list().filter(worker => worker.state === 'queued').length, 4);
    assert.ok(manager.list().every(worker => worker.providerId === identity.providerId && worker.model === identity.model));
    calls[0].resolve({ text: 'first' }); await tick();
    assert.equal(calls.length, 3);
    assert.equal(maximum, 2);
  } finally { manager.dispose(); await manager.drained(); }
  assert.equal(active, 0);
});

test('explicit assignment retries claim one active worker without merging independent reviewers', async () => {
  const calls: SubagentExecutionInput[] = [];
  const pending: Array<ReturnType<typeof pendingWork>> = [];
  const manager = new SubagentManager({ ...identity, execute: input => {
    calls.push(input);
    const work = pendingWork(input); pending.push(work); return work.promise;
  } });
  try {
    const assignment = { task: 'Inspect alpha.txt', context: 'Check its recorded hash.', assignmentKey: 'alpha-hash' };
    const first = manager.spawn(assignment);
    const retries = await Promise.all(Array.from({ length: 20 }, async () => manager.spawn(assignment)));
    assert.ok(retries.every(retry => retry.agentId === first.agentId && retry.reused === true));
    await tick(); assert.equal(calls.length, 1, '21 submissions of one keyed assignment use one provider invocation');
    assert.equal(manager.list().length, 1);
    const independent = manager.spawn({ task: assignment.task, context: assignment.context });
    assert.notEqual(independent.agentId, first.agentId, 'same text without a key requests an independent review');
    await tick(); assert.equal(calls.length, 2);
    for (const work of pending) work.resolve({ text: 'bounded evidence' });
    await manager.drained();
    const fresh = manager.spawn(assignment);
    assert.notEqual(fresh.agentId, first.agentId, 'completed evidence is not a cache for a later read');
    await tick(); assert.equal(calls.length, 3);
  } finally { manager.dispose(); await manager.drained(); }
});

test('assignment claims stay scoped to their parent, exact payload, worker and active unsteered task', async () => {
  const options = { ...identity, workers: [{ id: 'reviewer', label: 'Reviewer', ...identity }], execute: (input: SubagentExecutionInput) => pendingWork(input).promise };
  const manager = new SubagentManager(options), other = new SubagentManager(options);
  try {
    const assignment = { task: 'Inspect alpha', context: 'Only alpha', assignmentKey: 'read-alpha' };
    const first = manager.spawn(assignment);
    assert.notEqual(other.spawn(assignment).agentId, first.agentId);
    for (const change of [{ task: 'Inspect beta' }, { context: 'Only beta' }, { workerId: 'reviewer' }]) {
      assert.throws(() => manager.spawn({ ...assignment, ...change }), /assignmentKey/);
    }
    assert.throws(() => manager.spawn({ ...assignment, assignmentKey: '' }), /assignmentKey/);
    assert.throws(() => manager.spawn({ ...assignment, assignmentKey: 'x'.repeat(129) }), /assignmentKey/);
    manager.message({ agentId: first.agentId, message: 'Now also inspect beta' });
    assert.throws(() => manager.spawn(assignment), /assignmentKey/);
    manager.cancel(first.agentId);
    assert.notEqual(manager.spawn(assignment).agentId, first.agentId, 'cancelled claims can be retried');
  } finally { manager.dispose(); other.dispose(); await Promise.all([manager.drained(), other.drained()]); }
});

test('keyed retries do not consume the child cap and queued assignment claims are atomic', async () => {
  const manager = new SubagentManager({ ...identity, execute: input => pendingWork(input).promise });
  try {
    const assignments = Array.from({ length: 6 }, (_, index) => ({ task: `task ${index}`, assignmentKey: `key-${index}` }));
    const ids = assignments.map(assignment => manager.spawn(assignment).agentId);
    assert.equal(manager.spawn(assignments[5]).agentId, ids[5]);
    await tick();
    assert.equal(manager.list()[5].state, 'queued');
    assert.equal(manager.spawn(assignments[5]).reused, true);
    assert.throws(() => manager.spawn({ task: 'seventh', assignmentKey: 'new-key' }), /6개/);
  } finally { manager.dispose(); await manager.drained(); }
});

test('independent parents share three global slots in FIFO order and queued cancellation releases ownership', async () => {
  const started: string[] = [];
  const pending = new Map<string, ReturnType<typeof pendingWork>>();
  let active = 0, maximum = 0;
  const managers = Array.from({ length: 3 }, () => new SubagentManager({ ...identity, execute: async input => {
    active++; maximum = Math.max(maximum, active); started.push(input.task);
    const work = pendingWork(input); pending.set(input.task, work);
    try { return await work.promise; } finally { active--; }
  } }));
  try {
    managers[0].spawn({ task: 'a1' }); managers[0].spawn({ task: 'a2' });
    managers[1].spawn({ task: 'b1' }); managers[1].spawn({ task: 'b2' });
    const cancelled = managers[2].spawn({ task: 'c1' }); managers[2].spawn({ task: 'c2' });
    await tick(); assert.deepEqual(started, ['a1', 'a2', 'b1']);
    managers[2].cancel(cancelled.agentId);
    pending.get('a1')!.resolve({ text: 'done' }); await tick();
    assert.deepEqual(started, ['a1', 'a2', 'b1', 'b2']);
    pending.get('a2')!.resolve({ text: 'done' }); await tick();
    assert.deepEqual(started, ['a1', 'a2', 'b1', 'b2', 'c2']);
    assert.equal(maximum, 3);
    assert.equal(managers[2].list()[0].state, 'cancelled');
  } finally { for (const manager of managers) manager.dispose(); await Promise.all(managers.map(manager => manager.drained())); }
  assert.equal(active, 0);
});

test('a one-worker tuning profile serializes children and still drains cancelled work', async () => {
  let active = 0, maximum = 0;
  const started: string[] = [];
  const pending: Array<ReturnType<typeof pendingWork>> = [];
  const manager = new SubagentManager({ ...identity, maxParallel: 1, execute: async input => {
    started.push(input.task); active++; maximum = Math.max(maximum, active);
    const work = pendingWork(input); pending.push(work);
    try { return await work.promise; } finally { active--; }
  } });
  try {
    const first = manager.spawn({ task: 'first' });
    manager.spawn({ task: 'second' }); manager.spawn({ task: 'third' });
    await tick(); assert.deepEqual(started, ['first']);
    manager.cancel(first.agentId); await tick();
    assert.deepEqual(started, ['first', 'second']);
    pending[1].resolve({ text: 'second result' }); await tick();
    assert.deepEqual(started, ['first', 'second', 'third']);
    pending[2].resolve({ text: 'third result' }); await manager.drained();
    assert.equal(maximum, 1);
    assert.equal(manager.list()[0].state, 'cancelled');
    assert.equal(manager.list()[2].result, 'third result');
  } finally { manager.dispose(); await manager.drained(); }
  assert.equal(active, 0);
});

test('global admission rejects a 33rd queued invocation without leaking the remaining queue', async () => {
  let started = 0;
  const managers = Array.from({ length: 18 }, () => new SubagentManager({ ...identity, execute: input => {
    started++; return pendingWork(input).promise;
  } }));
  try {
    for (const manager of managers) { manager.spawn({ task: 'first' }); manager.spawn({ task: 'second' }); }
    await tick();
    const snapshots = managers.flatMap(manager => manager.list());
    assert.equal(started, 3);
    assert.equal(snapshots.filter(snapshot => snapshot.state === 'queued').length, 32);
    assert.equal(snapshots.filter(snapshot => snapshot.state === 'failed').length, 1);
    assert.match(snapshots.find(snapshot => snapshot.state === 'failed')!.error!, /대기열이 가득/);
  } finally { for (const manager of managers) manager.dispose(); await Promise.all(managers.map(manager => manager.drained())); }
  const recovery = new SubagentManager({ ...identity, execute: async () => ({ text: 'recovered' }) });
  try { recovery.spawn({ task: 'after saturation' }); await recovery.drained(); assert.equal(recovery.list()[0].result, 'recovered'); }
  finally { recovery.dispose(); await recovery.drained(); }
});

test('follow-up messages preserve private task context and acknowledged history without sharing mutable references', async () => {
  const initial = deferred<{ text: string; usage: { promptTokens: number; completionTokens: number } }>();
  const calls: SubagentExecutionInput[] = [];
  const manager = new SubagentManager({ ...identity, execute: async input => {
    calls.push(input);
    if (calls.length === 1) return initial.promise;
    return { text: `reply ${calls.length}`, usage: { promptTokens: 3, completionTokens: 2 } };
  } });
  try {
    const { agentId } = manager.spawn({ task: 'original task', context: 'explicit context' });
    manager.message({ agentId, message: 'follow-up before execution' });
    await tick();
    assert.deepEqual(calls[0].messages, []);
    manager.message({ agentId, message: 'follow-up while running' });
    initial.resolve({ text: 'first answer', usage: { promptTokens: 5, completionTokens: 4 } });
    await manager.drained();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].task, 'original task');
    assert.equal(calls[1].context, 'explicit context');
    assert.deepEqual(calls[1].messages, ['follow-up before execution', 'follow-up while running']);
    assert.deepEqual(calls[1].history, [{ role: 'user', content: 'original task' }, { role: 'assistant', content: 'first answer' }]);
    calls[1].history[0].content = 'mutated by executor';
    manager.message({ agentId, message: 'third request' }); await manager.drained();
    assert.equal(calls[2].history[0].content, 'original task');
    manager.message({ agentId, message: 'fourth request' }); await manager.drained();
    assert.equal(manager.list()[0].turns, 4);
    assert.deepEqual(manager.list()[0].usage, { promptTokens: 14, completionTokens: 10 });
    assert.throws(() => manager.message({ agentId, message: 'overflow' }), /한도/);
  } finally { initial.resolve({ text: '', usage: { promptTokens: 0, completionTokens: 0 } }); manager.dispose(); await manager.drained(); }
});

test('cross-parent controls are rejected, snapshots are defensive copies, and cancelled children cannot restart', async () => {
  const controller = new AbortController();
  const manager = new SubagentManager({ ...identity, signal: controller.signal, execute: input => pendingWork(input).promise });
  const other = new SubagentManager({ ...identity, execute: async () => ({ text: 'done' }) });
  try {
    const { agentId } = manager.spawn({ task: 'private assignment' });
    assert.throws(() => other.cancel(agentId), /이 작업에 속한/);
    assert.throws(() => other.message({ agentId, message: 'cross-parent' }), /이 작업에 속한/);
    await assert.rejects(other.wait({ agentIds: [agentId] }), /이 작업에 속한/);
    const snapshot = manager.list()[0]; const originalState = snapshot.state;
    snapshot.state = 'completed'; snapshot.usage.promptTokens = 12345;
    assert.equal(manager.list()[0].state, originalState);
    assert.equal(manager.list()[0].usage.promptTokens, 0);
    await tick(); controller.abort(); await manager.drained();
    assert.equal(manager.list()[0].state, 'cancelled');
    assert.throws(() => manager.spawn({ task: 'after parent cancellation' }), /종료된/);
    assert.throws(() => manager.message({ agentId, message: 'after cancellation' }), /종료된/);
    manager.dispose(); manager.dispose();
  } finally { manager.dispose(); other.dispose(); await Promise.all([manager.drained(), other.drained()]); }
});

test('bounded results, status deduplication, late callback rejection and detached UI cannot break completion', async () => {
  let callback: ((status: string) => void) | undefined;
  const updates: SubagentSnapshot[] = [];
  const manager = new SubagentManager({ ...identity, onUpdate: snapshot => { updates.push(snapshot); throw new Error('UI disconnected'); }, execute: async input => {
    callback = input.onStatus;
    input.onStatus('동일 상태'); input.onStatus('동일 상태');
    input.onStatus('상'.repeat(10_000));
    return { text: '결'.repeat(100_000), usage: { promptTokens: -1, completionTokens: Number.NaN } };
  } });
  try {
    assert.throws(() => manager.spawn({ task: '가'.repeat(3_000) }), /크기/);
    assert.throws(() => manager.spawn({ task: 'x', context: 'x'.repeat(16_385) }), /크기/);
    manager.spawn({ task: 'small task' }); await manager.drained();
    const result = manager.list()[0];
    assert.equal(result.state, 'completed');
    assert.ok(Buffer.byteLength(result.result!) <= 16 * 1024);
    assert.ok(!result.result!.endsWith('\uFFFD'));
    assert.deepEqual(result.usage, { promptTokens: 0, completionTokens: 0 });
    assert.equal(updates.filter(snapshot => snapshot.status === '동일 상태').length, 1);
    assert.ok(updates.every(snapshot => Buffer.byteLength(snapshot.status) <= 512));
    callback?.('late callback');
    assert.equal(manager.list()[0].sequence, result.sequence);
    assert.ok(updates.every((snapshot, index) => !index || snapshot.sequence > updates[index - 1].sequence));
  } finally { manager.dispose(); await manager.drained(); }
});

test('per-call usage survives failure and cancellation, validates reports atomically, and saturates safely', async () => {
  const calls: SubagentExecutionInput[] = [];
  const updates: SubagentSnapshot[] = [];
  const manager = new SubagentManager({ ...identity, onUpdate: snapshot => updates.push(snapshot), execute: input => {
    calls.push(input); return pendingWork(input).promise;
  } });
  try {
    const { agentId } = manager.spawn({ task: 'metered worker' }); await tick();
    manager.recordUsage(agentId, { promptTokens: 11, completionTokens: 7 });
    manager.recordUsage(agentId, { promptTokens: 5, completionTokens: 2 });
    assert.deepEqual(manager.list()[0].usage, { promptTokens: 16, completionTokens: 9 });
    const sequence = manager.list()[0].sequence;
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      manager.recordUsage(agentId, { promptTokens: invalid, completionTokens: 100 });
      manager.recordUsage(agentId, { promptTokens: 100, completionTokens: invalid });
    }
    assert.equal(manager.list()[0].sequence, sequence, 'a plausible companion must not mask an invalid field');
    assert.deepEqual(manager.list()[0].usage, { promptTokens: 16, completionTokens: 9 });
    assert.throws(() => manager.recordUsage('other-parent', { promptTokens: 1, completionTokens: 1 }), /이 작업에 속한/);
    manager.cancel(agentId); await manager.drained();
    manager.dispose();
    manager.recordUsage(agentId, { promptTokens: 3, completionTokens: 4 });
    assert.equal(manager.list()[0].state, 'cancelled');
    assert.deepEqual(manager.list()[0].usage, { promptTokens: 19, completionTokens: 13 });
    assert.deepEqual(updates.at(-1)!.usage, { promptTokens: 19, completionTokens: 13 });
    manager.recordUsage(agentId, { promptTokens: Number.MAX_SAFE_INTEGER, completionTokens: Number.MAX_SAFE_INTEGER });
    assert.deepEqual(manager.list()[0].usage, { promptTokens: Number.MAX_SAFE_INTEGER, completionTokens: Number.MAX_SAFE_INTEGER });
  } finally { manager.dispose(); await manager.drained(); }

  let failingManager!: SubagentManager;
  failingManager = new SubagentManager({ ...identity, execute: async input => {
    failingManager.recordUsage(input.agentId, { promptTokens: 21, completionTokens: 8 });
    throw new Error('later provider failed');
  } });
  try {
    failingManager.spawn({ task: 'failure after billable work' }); await failingManager.drained();
    assert.equal(failingManager.list()[0].state, 'failed');
    assert.deepEqual(failingManager.list()[0].usage, { promptTokens: 21, completionTokens: 8 });
  } finally { failingManager.dispose(); await failingManager.drained(); }
});

test('wait returns changed snapshots, cancels independently, and never waits over 60 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = new SubagentManager({ ...identity, execute: input => pendingWork(input).promise });
  try {
    const { agentId } = manager.spawn({ task: 'wait target' }); await tick();
    const cursor = manager.list()[0].sequence;
    const changed = manager.wait({ agentIds: [agentId], afterSequence: cursor });
    manager.message({ agentId, message: 'new update' });
    assert.ok((await changed)[0].sequence > cursor);
    const abort = new AbortController();
    const cancelledWait = manager.wait({ agentIds: [agentId] }, abort.signal);
    abort.abort(new Error('only stop waiting'));
    await assert.rejects(cancelledWait, /only stop waiting/);
    assert.equal(manager.list()[0].state, 'running');
    let settled = false;
    const boundedWait = manager.wait({ timeoutMs: 999_999 }).then(value => { settled = true; return value; });
    t.mock.timers.tick(59_999); await Promise.resolve(); assert.equal(settled, false);
    t.mock.timers.tick(1); assert.equal((await boundedWait)[0].state, 'running');
  } finally { manager.dispose(); await manager.drained(); t.mock.timers.reset(); }
});

test('default long poll does not wake at 15 seconds and returns promptly on completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const work = deferred<{ text: string }>();
  const manager = new SubagentManager({ ...identity, execute: () => work.promise });
  try {
    manager.spawn({ task: 'independent evidence' }); await tick();
    let settled = false;
    const pending = manager.wait().then(result => { settled = true; return result; });
    t.mock.timers.tick(15_001); await Promise.resolve(); assert.equal(settled, false);
    t.mock.timers.tick(4_999); work.resolve({ text: 'verified evidence' });
    assert.equal((await pending)[0].result, 'verified evidence');
  } finally { work.resolve({ text: 'cleanup' }); manager.dispose(); await manager.drained(); t.mock.timers.reset(); }
});

test('default wait is bounded at 30 seconds and non-finite input uses that default', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = new SubagentManager({ ...identity, execute: input => pendingWork(input).promise });
  try {
    manager.spawn({ task: 'bounded default wait' }); await tick();
    for (const timeoutMs of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      let settled = false;
      const pending = manager.wait({ timeoutMs }).then(result => { settled = true; return result; });
      t.mock.timers.tick(29_999); await Promise.resolve(); assert.equal(settled, false);
      t.mock.timers.tick(1); assert.equal((await pending)[0].state, 'running');
    }
  } finally { manager.dispose(); await manager.drained(); t.mock.timers.reset(); }
});

test('120 second invocation timeout aborts execution and leaves a bounded failure snapshot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let aborted = false;
  const manager = new SubagentManager({ ...identity, execute: input => {
    input.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return pendingWork(input).promise;
  } });
  try {
    manager.spawn({ task: 'slow task' }); await tick();
    t.mock.timers.tick(119_999); assert.equal(manager.list()[0].state, 'running');
    t.mock.timers.tick(1); await manager.drained();
    assert.equal(aborted, true);
    assert.equal(manager.list()[0].state, 'failed');
    assert.match(manager.list()[0].error!, /120초/);
  } finally { manager.dispose(); await manager.drained(); t.mock.timers.reset(); }
});

test('cancellation does not admit extra work before an uncooperative executor settles', async () => {
  const hung = Array.from({ length: 3 }, () => deferred<{ text: string }>());
  let started = 0;
  const first = new SubagentManager({ ...identity, execute: () => hung[started++].promise });
  const second = new SubagentManager({ ...identity, execute: () => hung[started++].promise });
  let replacementStarted = false;
  const replacement = new SubagentManager({ ...identity, execute: async () => { replacementStarted = true; return { text: 'replacement' }; } });
  try {
    first.spawn({ task: 'a' }); first.spawn({ task: 'b' }); second.spawn({ task: 'c' });
    await tick(); first.dispose(); second.dispose();
    replacement.spawn({ task: 'd' }); await tick();
    assert.equal(replacementStarted, false);
    hung[0].resolve({ text: 'late output' }); await tick();
    assert.equal(replacementStarted, true);
    assert.equal(first.list()[0].state, 'cancelled');
    assert.equal(first.list()[0].result, undefined);
  } finally {
    for (const work of hung) work.resolve({ text: 'cleanup' });
    first.dispose(); second.dispose(); replacement.dispose();
    await Promise.all([first.drained(), second.drained(), replacement.drained()]);
  }
});
