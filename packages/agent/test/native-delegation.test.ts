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

test('single harness rejects every legacy delegation opt-in before starting a process', () => {
 const base = { permissionMode: 'read-only', session: {} } as NativeAgentRequest;
 assert.equal(nativeDelegationLimit(base), 0);
 assert.deepEqual(nativeDelegationConfig(base, 'selected'), { 'agents.enabled': false, 'features.multi_agent': false, 'features.multi_agent_v2': false });
 for (const nativeDelegation of [{}, {maxAgents:1}, {maxAgents:2}, {maxAgents:0}, null]) {
   assert.throws(() => nativeDelegationLimit({...base, nativeDelegation} as NativeAgentRequest), /단일 에이전트/);
   assert.throws(() => nativeDelegationConfig({...base, nativeDelegation} as NativeAgentRequest, 'selected'), /단일 에이전트/);
 }
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

test('legacy native request fails before child execution and ordinary parent usage stays reported', async () => sandbox(async (base, call) => {
 await assert.rejects(call(base), /단일 에이전트/);
 const result = await call({...withCase(base, 'DISABLED'), nativeDelegation: undefined});
 assert.equal(result.usage.promptTokens, 100);
 assert.equal(result.usage.reportStatus, 'reported');
}));
test('unexpected native child events fail closed without mixing child output', async () => sandbox(async (base, call) => {
 let output = '';
 await assert.rejects(call({...withCase(base, 'DISABLED_SPAWN'), nativeDelegation: undefined, onText: t => output += t}), /허용되지 않은/);
 assert.equal(output, '');
}));
