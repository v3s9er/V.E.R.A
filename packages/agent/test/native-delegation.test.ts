import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { nativeDelegationConfig, nativeDelegationLimit, NativeDelegationEvents, sanitizeNativeDelegationRequest } from '../src/ai/native-delegation.js';
import { pooledNativeCodex, closeNativeWorkers } from '../src/ai/cli-native-pool.js';
import { CliProcessRetirement, waitForCliRetirements } from '../src/ai/cli-process-retirement.js';
import type { NativeAgentRequest, NativeToolEvent } from '../src/ai/provider.js';

const fixture = fileURLToPath(new URL('./fixtures/native-delegation-app-server.mjs', import.meta.url));
async function sandbox(body: (base: NativeAgentRequest, call: (req: NativeAgentRequest) => ReturnType<typeof pooledNativeCodex>) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'vera-native-delegation-'));
  const base: NativeAgentRequest = { prompt: 'fixture', cwd: directory, permissionMode: 'read-only', reasoningEffort: 'high', nativeDelegation: { maxAgents: 2 },
    session: { key: 'synthetic-delegation', directory, history: [], input: 'CASE:BASIC', instructions: 'fixture only', context: '' } };
  try {
    await body(base, req => pooledNativeCodex({ command: process.execPath, prefixArgs: [fixture], env: process.env, providerId: 'fixture', model: 'fixture', req }));
  } finally {
    closeNativeWorkers(); await waitForCliRetirements(process.env);
    const target = resolve(directory), parent = resolve(tmpdir()) + sep;
    assert.ok(target.startsWith(parent) && target.slice(parent.length).startsWith('vera-native-delegation-'));
    rmSync(target, { recursive: true, force: true });
  }
}
const withCase = (base: NativeAgentRequest, name: string): NativeAgentRequest => ({ ...base, session: { ...base.session!, key: name, input: `CASE:${name}` } });
const item = (tool = 'spawnAgent', status = 'running', overrides = {}) => ({ id: 'call', type: 'collabAgentToolCall', senderThreadId: 'parent', receiverThreadIds: ['child'],
  tool, status: 'completed', model: 'fixture', reasoningEffort: 'high', agentsStates: { child: { status, message: 'PRIVATE' } }, prompt: 'PRIVATE', ...overrides });

test('native delegation is explicit, bounded, scoped and rejects duplicate coordinator trees', () => {
  const base = { permissionMode: 'read-only', session: {} } as NativeAgentRequest;
  assert.equal(nativeDelegationLimit(base), 0);
  assert.deepEqual(nativeDelegationConfig(base, 'selected'), { 'agents.enabled': false, 'features.multi_agent': false, 'features.multi_agent_v2': false });
  assert.equal(nativeDelegationLimit({ ...base, nativeDelegation: {} }), 2);
  for (const maxAgents of [0, 3, -1, NaN, 1.5]) assert.throws(() => nativeDelegationLimit({ ...base, nativeDelegation: { maxAgents } }), /한도/);
  assert.throws(() => nativeDelegationLimit({ ...base, nativeDelegation: {}, permissionMode: 'ask' }), /승인/);
  assert.throws(() => nativeDelegationLimit({ ...base, nativeDelegation: {}, session: undefined }), /세션/);
  assert.throws(() => nativeDelegationLimit({ ...base, nativeDelegation: {}, hostTools: { tools: [{ name: 'agent_spawn' }] } as any }), /중복/);
  const config = nativeDelegationConfig({ ...base, nativeDelegation: {}, reasoningEffort: 'high' }, 'selected');
  assert.equal(config['agents.default_subagent_model'], 'selected'); assert.equal(config['agents.default_subagent_reasoning_effort'], 'high');
  assert.equal(config['agents.max_depth'], 1);
});

test('only correlated parent records grant bounded child ownership and public lifecycle metadata', () => {
  const events: NativeToolEvent[] = []; const tracker = new NativeDelegationEvents(2, 'fixture', 'high', e => events.push(e));
  tracker.observeChildThread({ id: 'child', model: 'fixture' }, 'parent'); assert.equal(tracker.owns('child'), false);
  tracker.accept('item/completed', item(), 'parent'); assert.equal(tracker.owns('child'), true);
  assert.throws(() => tracker.assertSettled(), /실행 중/);
  tracker.accept('item/completed', item('wait', 'completed', { id: 'wait' }), 'parent'); tracker.assertSettled();
  assert.equal(events.length, 4); assert.ok(!JSON.stringify(events).includes('PRIVATE'));
  assert.ok(!JSON.stringify(events).includes('child')); assert.ok(events.every(e => Object.keys(e.input).length === 0));
  tracker.finish(); assert.equal(tracker.owns('child'), false);
});

test('unowned receivers, state keys, altered models, malformed IDs and over-limit children fail closed', () => {
  const cases = [item('wait'), item('spawnAgent', 'running', { senderThreadId: 'other' }), item('spawnAgent', 'running', { model: 'other' }),
    item('spawnAgent', 'running', { reasoningEffort: 'xhigh' }), item('spawnAgent', 'running', { id: '../path' }),
    item('spawnAgent', 'running', { receiverThreadIds: ['child', 'child'] }), item('spawnAgent', 'running', { agentsStates: { other: { status: 'completed' } } })];
  for (const value of cases) assert.throws(() => new NativeDelegationEvents(2, 'fixture', 'high').accept('item/completed', value, 'parent'));
  const tracker = new NativeDelegationEvents(1, 'fixture', 'high'); tracker.accept('item/completed', item(), 'parent');
  assert.throws(() => tracker.accept('item/completed', item('spawnAgent', 'running', { id: 'second', receiverThreadIds: ['second'], agentsStates: {} }), 'parent'), /한도/);
  assert.throws(() => tracker.observeChildThread({ id: 'child', model: 'other' }, 'parent'), /실제 모델/);
  const early = new NativeDelegationEvents(2, 'fixture', 'high');
  early.observeChildThread({ id: 'child', parentThreadId: 'parent', model: 'other' }, 'parent');
  assert.equal(early.owns('child'), false);
  assert.throws(() => early.accept('item/completed', item(), 'parent'), /실제 모델/);
  const changed = new NativeDelegationEvents(2, 'fixture', 'high');
  changed.observeChildThread({ id: 'child', model: 'other' }, 'parent');
  changed.observeChildThread({ id: 'child', model: 'fixture' }, 'parent');
  assert.throws(() => changed.accept('item/completed', item(), 'parent'), /실제 모델/, 'later metadata must not erase an observed mismatch');
});

test('owned retirement await does not wait for an unrelated CLI sharing the same home', async () => {
  const first = new EventEmitter() as ChildProcess, other = new EventEmitter() as ChildProcess;
  const owned = new CliProcessRetirement(first, process.env), unrelated = new CliProcessRetirement(other, process.env);
  owned.retire(); unrelated.retire();
  try {
    first.emit('close', 0);
    await owned.waitUntilClosed();
    let otherClosed = false;
    const pending = unrelated.waitUntilClosed().then(() => { otherClosed = true; });
    await Promise.resolve(); assert.equal(otherClosed, false);
    other.emit('close', 0); await pending; assert.equal(otherClosed, true);
  } finally { first.emit('close', 0); other.emit('close', 0); }
});

test('current CLI activity lifecycle establishes ownership without paths, prompts or raw arguments', () => {
  const events: NativeToolEvent[] = []; const tracker = new NativeDelegationEvents(2, 'fixture', 'high', event => events.push(event));
  const activity = { type: 'subAgentActivity', id: 'opaque:activity:id', agentThreadId: 'child', agentPath: '/root/PRIVATE_LABEL', kind: 'started' };
  tracker.activity('item/started', activity, 'parent'); tracker.activity('item/completed', activity, 'parent');
  assert.equal(tracker.owns('child'), true); assert.throws(() => tracker.assertSettled(), /실행 중/);
  tracker.activity('item/started', { ...activity, id: 'done:activity', kind: 'completed' }, 'parent');
  assert.throws(() => tracker.assertSettled(), /실행 중/);
  tracker.activity('item/completed', { ...activity, id: 'done:activity', kind: 'completed' }, 'parent'); tracker.assertSettled();
  assert.deepEqual(events.map(event => event.status), ['start', 'done']); assert.ok(!JSON.stringify(events).includes('PRIVATE_LABEL'));
  const raw = { method: 'rawResponseItem/completed', params: { threadId: 'parent', turnId: 'turn', item: { type: 'function_call', name: 'spawn_agent', call_id: 'call',
    arguments: JSON.stringify({ model: 'other', reasoning_effort: 'high', prompt: 'PRIVATE_PROMPT', arbitrary: 'PRIVATE_ARGUMENT' }) } } };
  const metadata = sanitizeNativeDelegationRequest(raw);
  assert.ok(!JSON.stringify(metadata).includes('PRIVATE')); assert.throws(() => tracker.requested(metadata.params), /모델/);
  assert.equal(sanitizeNativeDelegationRequest({ ...raw, params: { ...raw.params, item: { ...raw.params.item, name: 'unrelated' } } }), undefined);
  assert.throws(() => new NativeDelegationEvents(2, 'fixture', 'high').activity('item/completed', { ...activity, kind: 'completed' }, 'parent'), /속하지 않은/);
  tracker.activity('item/completed', { ...activity, id: 'followup:activity', kind: 'interacted' }, 'parent');
  assert.throws(() => tracker.assertSettled(), /실행 중/, 'a previous completed child cannot hide follow-up work');
  tracker.activity('item/completed', { ...activity, id: 'followup:done', kind: 'completed' }, 'parent'); tracker.assertSettled();
  const bounded = new NativeDelegationEvents(1, 'fixture', 'high');
  bounded.activity('item/completed', activity, 'parent');
  bounded.activity('item/completed', { ...activity, kind: 'completed' }, 'parent');
  bounded.activity('item/completed', { ...activity, id: 'second-start', agentThreadId: 'second' }, 'parent');
  assert.throws(() => bounded.activity('item/completed', { ...activity, id: 'restart-first', kind: 'interacted' }, 'parent'), /한도/);
});

test('installed v2 subAgentActivity events and spawn setting overrides follow the parent boundary', async () => sandbox(async (base, call) => {
  const events: NativeToolEvent[] = [];
  const result = await call({ ...withCase(base, 'MODERN'), onTool: event => events.push(event) });
  assert.equal(events.filter(event => event.name === 'native_agent_spawn' && event.status === 'done').length, 1);
  assert.equal(result.usage.reportStatus, 'missing');
  await assert.rejects(call(withCase(base, 'MODERN_OVERRIDE')), /모델/);
}));

test('protocol child text and usage never mix; child host calls denied while parent host remains usable', async () => sandbox(async (base, call) => {
  let executions = 0, text = ''; const events: NativeToolEvent[] = [];
  const req = withCase(base, 'CHILD_HOST');
  req.onText = delta => text += delta; req.onTool = event => events.push(event);
  req.hostTools = { tools: [{ name: 'safe_parent_tool', description: 'fixture', parameters: { type: 'object' } }], authorize: () => true,
    execute: async () => { executions++; return { success: true, contentItems: [] }; }, dispose() {} };
  const result = await call(req);
  assert.equal(executions, 1); assert.equal(text, result.text); assert.ok(!text.includes('PRIVATE'));
  assert.equal(result.usage.promptTokens, 100); assert.equal(result.usage.reportStatus, 'missing');
  assert.equal(events.filter(e => e.name === 'native_agent_spawn').length, 2); assert.ok(!JSON.stringify(events).includes('PRIVATE'));
}));

test('native opt-in workers retire even without observed children and do not claim complete accounting', async () => sandbox(async (base, call) => {
  const a = await call(base);
  const next = { ...base, session: { ...base.session!, history: [{ role: 'user' as const, content: base.session!.input }, { role: 'assistant' as const, content: a.text }] } };
  const b = await call(next); assert.notEqual(a.text.split(' ')[1], b.text.split(' ')[1]);
  assert.equal(a.usage.reportStatus, 'missing'); assert.equal(b.usage.reportStatus, 'missing');
  const c = await call({ ...base, reasoningEffort: 'xhigh' }); assert.notEqual(a.text.split(' ')[1], c.text.split(' ')[1]);
  const d = await call({ ...withCase(base, 'DISABLED'), nativeDelegation: undefined }); assert.equal(d.usage.reportStatus, 'reported');
}));

test('parent correlation and child completion/model gates remain fail-closed', async () => sandbox(async (base, call) => {
  for (const name of ['MODEL_MISMATCH', 'ACTUAL_MODEL_MISMATCH', 'SENDER_MISMATCH', 'BAD_PARENT_TURN', 'UNSETTLED']) {
    await assert.rejects(call(withCase(base, name)), /보조 작업|식별자/);
    if (name === 'UNSETTLED') {
      const pid = Number(readFileSync(join(base.cwd, 'fixture-child-pid.txt'), 'utf8'));
      assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH', 'failure must drain descendants before rejecting admission');
    }
  }
  await assert.rejects(call({ ...withCase(base, 'DISABLED_SPAWN'), nativeDelegation: undefined }), /허용되지 않은/);
}));

test('delegated completion retires the owned native process tree before reporting success', async () => sandbox(async (base, call) => {
  await call(withCase(base, 'RETIRE'));
  const pid = Number(readFileSync(join(base.cwd, 'fixture-child-pid.txt'), 'utf8'));
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
}));

test('cancellation after native spawn aborts the full owned execution and never reports a completed answer', async () => sandbox(async (base, call) => {
  const controller = new AbortController(); let streamed = '';
  const req = withCase(base, 'HANG'); req.signal = controller.signal; req.onText = text => streamed += text;
  req.onTool = event => { if (event.name === 'native_agent_spawn' && event.status === 'done') setTimeout(() => controller.abort(), 10); };
  await assert.rejects(call(req), /중지/); assert.equal(streamed, '');
  const pid = Number(readFileSync(join(base.cwd, 'fixture-child-pid.txt'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH', 'cancellation must drain descendants before rejecting admission');
}));
