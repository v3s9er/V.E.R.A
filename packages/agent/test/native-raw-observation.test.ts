import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { closeNativeWorkers, pooledNativeCodex } from '../src/ai/cli-native-pool.js';
import { waitForCliRetirements } from '../src/ai/cli-process-retirement.js';
import { CliSessionEvents, NativeRawToolEvents, sanitizeNativeRawNotification } from '../src/ai/cli-session-events.js';
import { NativeToolEvents } from '../src/ai/native-tool-events.js';
import type { NativeAgentRequest, NativeToolEvent } from '../src/ai/provider.js';

const fixture = fileURLToPath(new URL('./fixtures/native-raw-events-app-server.mjs', import.meta.url));
async function workspace(run: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'mrrobot-raw-observation-'));
  try { await run(directory); }
  finally { closeNativeWorkers(); await waitForCliRetirements(process.env); rmSync(directory, { recursive: true, force: true }); }
}
function request(directory: string, onTool: (event: NativeToolEvent) => void): NativeAgentRequest {
  return { prompt: 'fixture', cwd: directory, permissionMode: 'read-only', onTool,
    session: { key: 'raw-observation', directory, history: [], input: 'fixture', instructions: 'fixture', context: '' } };
}
function call(req: NativeAgentRequest, mode = 'normal') {
  return pooledNativeCodex({ command: process.execPath, prefixArgs: [fixture], env: { ...process.env, MRROBOT_RAW_FIXTURE: mode }, providerId: 'fixture', model: 'fixture', req });
}

test('registered host operation names stay paired without exposing provider payloads or accepting unknown names', () => {
  const events: NativeToolEvent[] = [], registered = ['browser_open', 'browser_close', 'invalid\nname'];
  const tracker = new NativeToolEvents(event => events.push(event), () => 10, registered);
  registered.push('late_registration');
  const forbidden = () => assert.fail('host operation labels must never inspect private payloads');
  tracker.accept('item/started', { id: 'browser-1', type: 'dynamicToolCall', tool: 'browser_open', get arguments() { return forbidden(); } });
  tracker.accept('item/completed', { id: 'browser-1', type: 'dynamicToolCall', tool: 'browser_close', get contentItems() { return forbidden(); } });
  tracker.accept('item/completed', { id: 'browser-1', type: 'dynamicToolCall', tool: 'unregistered', success: false });
  tracker.accept('item/completed', { id: 'browser-1', type: 'dynamicToolCall', tool: 'browser_close', success: false });
  for (const [index, tool] of ['unregistered', 'late_registration', 'invalid\nname', 'PRIVATE_SECRET', undefined].entries()) {
    tracker.accept('item/completed', { id: `unknown-${index}`, type: 'dynamicToolCall', tool });
  }
  tracker.accept('item/completed', { id: 'ordinary', type: 'commandExecution', tool: 'browser_open' });
  assert.deepEqual(events.slice(0, 3).map(event => [event.name, event.status]), [
    ['browser_open', 'start'], ['browser_open', 'done'], ['browser_open', 'error'],
  ]);
  assert.equal(events[2].terminalCorrection, true);
  assert.ok(events.slice(3, 13).every(event => event.name === 'native_host_tool'));
  assert.deepEqual(events.slice(13).map(event => event.name), ['native_command', 'native_command']);
  assert.ok(events.every(event => JSON.stringify(event.input) === '{}'));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SECRET|invalid|late_registration|contentItems|arguments/);
});

for (const mode of ['host-tools', 'host-other-thread', 'host-other-turn']) test(`registered host names are exposed only after correlation: ${mode}`, () => workspace(async directory => {
  const events: NativeToolEvent[] = [];
  const req = { ...request(directory, event => events.push(event)), hostTools: {
    tools: [{ name: 'browser_open', description: 'Synthetic registered tool', parameters: { type: 'object', properties: {} } }],
    authorize: () => true,
    execute: async () => { assert.fail('notification fixture does not execute a host tool'); },
    dispose: () => {},
  } };
  if (mode === 'host-tools') {
    await call(req, mode);
    assert.deepEqual(events.map(event => [event.name, event.status]), [
      ['browser_open', 'start'], ['browser_open', 'done'], ['native_host_tool', 'start'], ['native_host_tool', 'done'],
    ]);
  } else {
    await assert.rejects(call(req, mode));
    assert.deepEqual(events, []);
  }
}));

test('raw exec observations are correlated, deduplicated and do not double-count usage snapshots', () => workspace(async directory => {
  const events: NativeToolEvent[] = [], statuses: string[] = [];
  const first = request(directory, event => events.push(event)); first.onStatus = status => statuses.push(status);
  const result = await call(first);
  assert.deepEqual(events.map(event => [event.name, event.status]), [
    ['native_custom_tool', 'start'], ['native_custom_tool', 'done'], ['native_command', 'start'], ['native_command', 'error'],
  ]);
  for (const event of events) assert.deepEqual(event.input, {});
  assert.deepEqual([result.usage.promptTokens, result.usage.completionTokens, result.usage.cachedPromptTokens], [100, 20, 60]);
  const history = [{ role: 'user' as const, content: 'fixture' }, { role: 'assistant' as const, content: result.text }];
  const next = { ...first, session: { ...first.session!, history, input: 'next' } };
  const warm = await call(next);
  assert.equal(events.length, 8, 'warm continuation ignores stale raw events and emits one pair per call');
  assert.equal(warm.usage.promptTokens, 100);
  assert.ok(!statuses.some(status => status.includes('관측 제한')));
}));

test('cold resume preserves thread identity and reports the protocol observation limit', () => workspace(async directory => {
  const events: NativeToolEvent[] = [], statuses: string[] = [];
  const first = request(directory, event => events.push(event));
  const result = await call(first);
  const checkpoint = () => Object.values(JSON.parse(readFileSync(join(directory, 'native-sessions.json'), 'utf8')))[0] as { thread: string };
  const thread = checkpoint().thread;
  closeNativeWorkers(); await waitForCliRetirements(process.env);
  const resumed = await call({ ...first, onStatus: status => statuses.push(status), session: { ...first.session!,
    history: [{ role: 'user', content: 'fixture' }, { role: 'assistant', content: result.text }], input: 'next' } });
  assert.equal(checkpoint().thread, thread);
  assert.equal(resumed.usage.promptTokens, 100);
  assert.equal(statuses.filter(status => status.includes('관측 제한')).length, 1);
}));

test('unsupported raw opt-in falls back once before the first turn without retrying inference', () => workspace(async directory => {
  const statuses: string[] = [];
  const req = { ...request(directory, () => assert.fail('unsupported server has no raw events')), onStatus: (status: string) => statuses.push(status) };
  const result = await call(req, 'unsupported');
  assert.equal(result.text, 'answer 1');
  assert.equal(result.usage.promptTokens, 100);
  assert.equal(statuses.filter(status => status.includes('관측 제한')).length, 1);
  const next = await call({ ...req, session: { ...req.session!, input: 'next',
    history: [{ role: 'user', content: 'fixture' }, { role: 'assistant', content: result.text }] } }, 'unsupported');
  assert.equal(next.text, 'answer 2', 'warm continuation never re-probes or recreates its thread');
  assert.equal(statuses.filter(status => status.includes('관측 제한')).length, 2);
}));

for (const mode of ['other-thread', 'other-turn']) test(`raw events never escape ${mode} correlation`, () => workspace(async directory => {
  const events: NativeToolEvent[] = [];
  await assert.rejects(call(request(directory, event => events.push(event)), mode));
  assert.deepEqual(events, []);
}));

test('raw capability negotiation never retries unrelated invalid parameters', () => workspace(async directory => {
  await assert.rejects(call(request(directory, () => assert.fail('no turn may start')), 'unrelated-error'));
}));

test('cancellation closes pending raw calls without exposing provider payloads', () => workspace(async directory => {
  const events: NativeToolEvent[] = [], controller = new AbortController();
  const req = request(directory, event => { events.push(event); if (event.callId === 'pending' && event.status === 'start') controller.abort(); });
  await assert.rejects(call({ ...req, signal: controller.signal }, 'cancel'));
  assert.deepEqual(events.filter(event => event.callId === 'pending').map(event => event.status), ['start', 'error']);
}));

test('raw content is never accessed or queued; unknown raw notifications and names are ignored', () => {
  const forbidden = () => assert.fail('private raw content must not be accessed');
  const item = { type: 'custom_tool_call', call_id: 'safe-call', name: 'exec', get input() { return forbidden(); }, get arguments() { return forbidden(); } };
  const message = { method: 'rawResponseItem/completed', params: { threadId: 'safe-thread', turnId: 'safe-turn', item } };
  const sanitized = sanitizeNativeRawNotification(message);
  assert.deepEqual(sanitized.params.item, { type: 'custom_tool_call', call_id: 'safe-call', name: 'exec' });
  const gate = new CliSessionEvents(); gate.beginThread(); gate.bindThread('safe-thread'); gate.beginTurn(3);
  assert.equal(gate.accept(message), false);
  assert.deepEqual(gate.bindTurn('safe-turn'), [sanitized]);
  assert.equal(sanitizeNativeRawNotification({ ...message, params: { ...message.params, item: { type: 'reasoning', get content() { return forbidden(); } } } }), undefined);
  assert.equal(sanitizeNativeRawNotification({ ...message, params: { ...message.params, item: { type: 'custom_tool_call', call_id: 'unknown-call', name: 'unknown', get input() { return forbidden(); } } } }), undefined);
  assert.equal(sanitizeNativeRawNotification({ method: 'rawResponse/completed', get params() { return forbidden(); } }), undefined);
  assert.throws(() => gate.accept({ method: 'rawResponseItem/completed', params: { item: { type: 'custom_tool_call', call_id: 'safe-call', name: 'exec' } } }), /식별자/);
});

test('raw output marks return, not semantic verification, and respects explicit failure metadata', () => {
  const events: NativeToolEvent[] = [], native = new NativeToolEvents(event => events.push(event));
  const raw = new NativeRawToolEvents((method, item) => native.accept(method, item));
  for (const id of ['returned', 'failed']) {
    raw.accept({ type: 'custom_tool_call', call_id: id, name: 'exec' });
    const message = sanitizeNativeRawNotification({ method: 'rawResponseItem/completed', params: { threadId: 't', turnId: 'u', item: {
      type: 'custom_tool_call_output', call_id: id, ...(id === 'failed' ? { status: 'failed' } : {}),
      get output() { assert.fail('return data cannot be inspected to guess success'); },
    } } });
    raw.accept(message.params.item);
  }
  assert.deepEqual(events.map(event => [event.callId, event.status]), [['returned', 'start'], ['returned', 'done'], ['failed', 'start'], ['failed', 'error']]);
  raw.accept({ type: 'custom_tool_call_output', call_id: 'early-output' });
  raw.accept({ type: 'custom_tool_call', call_id: 'early-output', name: 'exec', status: 'failed' });
  assert.deepEqual(events.slice(-2).map(event => event.status), ['start', 'error']);
});

test('raw pending metadata has a bounded map and is cleared independently of tool content', () => {
  const raw = new NativeRawToolEvents(() => assert.fail('unknown output must not create a tool event'));
  for (let i = 0; i < 2048; i++) raw.accept({ type: 'custom_tool_call_output', call_id: `pending-${i}` });
  assert.throws(() => raw.accept({ type: 'custom_tool_call_output', call_id: 'overflow' }), /한도/);
  raw.clear();
  raw.accept({ type: 'custom_tool_call_output', call_id: 'new-turn' });
});

for (const source of ['ordinary', 'raw'] as const) test(`late ${source} failure corrects a returned raw call exactly once`, () => {
  let now = 0;
  const events: NativeToolEvent[] = [], native = new NativeToolEvents(event => events.push(event), () => now);
  const raw = new NativeRawToolEvents((method, item) => native.accept(method, item));
  raw.accept({ type: 'custom_tool_call', call_id: 'returned-then-failed', name: 'exec' });
  now = 10;
  raw.accept({ type: 'custom_tool_call_output', call_id: 'returned-then-failed' });
  const fail = () => source === 'ordinary'
    ? native.accept('item/completed', { type: 'customToolCall', id: 'returned-then-failed', status: 'failed', exitCode: 1 })
    : raw.accept({ type: 'custom_tool_call', call_id: 'returned-then-failed', name: 'exec', status: 'failed' });
  now = 20;
  fail(); fail();
  raw.accept({ type: 'custom_tool_call_output', call_id: 'returned-then-failed' });
  native.accept('item/completed', { type: 'customToolCall', id: 'returned-then-failed', status: 'completed', exitCode: 0 });
  native.finish();
  assert.deepEqual(events, [
    { name: 'native_custom_tool', callId: 'returned-then-failed', input: {}, status: 'start' },
    { name: 'native_custom_tool', callId: 'returned-then-failed', input: {}, status: 'done', elapsedMs: 10 },
    { name: 'native_custom_tool', callId: 'returned-then-failed', input: {}, status: 'error', terminalCorrection: true },
  ], 'An explicit failure dominates return-only completion without restarting or charging duration twice.');
});
