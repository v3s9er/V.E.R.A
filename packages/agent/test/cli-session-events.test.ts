import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pooledCodexText, closeTextWorkers } from '../src/ai/cli-text-pool.js';
import { pooledNativeCodex, closeNativeWorkers } from '../src/ai/cli-native-pool.js';
import type { BrokerAgentRequest, NativeAgentRequest, Turn } from '../src/ai/provider.js';
import { CliSessionEvents } from '../src/ai/cli-session-events.js';
import { ChatSession } from '../src/server/chat.js';
import { ChildProcess } from 'node:child_process';
import { CliProcessRetirement, waitForCliRetirements } from '../src/ai/cli-process-retirement.js';
const session = new ChatSession();
session.begin(); session.cancel('discord-authority'); session.cancel('user');
assert.match(session.cancellationMessage()!, /역할·권한/); // First cause must survive cleanup cancellation.
session.end(); session.begin(); assert.equal(session.cancellationMessage(), undefined);
session.cancel(); assert.equal(session.cancellationMessage(), '작업이 중지되었습니다.'); session.end();
const gate = new CliSessionEvents();
assert.equal(gate.accept({ method: 'warning', params: { threadId: 'fixture', message: 'Ignored notice' } }), false);
gate.beginThread(); gate.bindThread('fixture'); gate.beginTurn(3);
for (let i = 0; i < 128; i++) gate.accept({ method: 'turn/started', params: { threadId: 'fixture', turn: { id: 'turn' } } });
assert.throws(() => gate.accept({ method: 'turn/started', params: { threadId: 'fixture', turn: { id: 'turn' } } }), /한도/);
const toolGate = new CliSessionEvents(); toolGate.beginThread(); toolGate.bindThread('fixture'); toolGate.beginTurn(4);
assert.equal(toolGate.deferToolRequest({ id: 88, method: 'item/tool/call', params: { threadId: 'fixture', turnId: 'turn' } }), true);
assert.equal(toolGate.bindTurn('turn').length, 1);
toolGate.complete(); toolGate.beginTurn(5);
assert.throws(() => toolGate.deferToolRequest({ id: 89, method: 'item/tool/call', params: { threadId: 'fixture', turnId: 'turn' } }));
const resumed = new CliSessionEvents(); resumed.beginThread();
resumed.bindThread('fixture', [{ id: 'previous', status: 'completed' }]); resumed.beginTurn(7);
assert.equal(resumed.accept({ method: 'thread/tokenUsage/updated', params: { threadId: 'fixture', turnId: 'previous', tokenUsage: { total: { inputTokens: 999 } } } }), false);
assert.deepEqual(resumed.bindTurn('current'), [], 'resumed usage cannot poison or bill the next turn');
const dir = mkdtempSync(join(tmpdir(), 'mrrobot-session-order-'));
// Unspawned process handle: exercise lifecycle waiting without killing anything.
const retired = new ChildProcess();
const retirementEnv = { CODEX_HOME: join(dir, 'retirement') };
new CliProcessRetirement(retired, retirementEnv).retire();
await waitForCliRetirements({ CODEX_HOME: join(dir, 'different-runtime') });
const waitAbort = new AbortController();
const waiting = waitForCliRetirements(retirementEnv, waitAbort.signal);
waitAbort.abort(); await assert.rejects(waiting, /중지/);
let released = false;
const afterClose = waitForCliRetirements(retirementEnv).then(() => { released = true; });
await Promise.resolve(); assert.equal(released, false);
retired.emit('close', 0, null); await afterClose; assert.equal(released, true);
const fixture = fileURLToPath(new URL('./fixtures/session-events-app-server.mjs', import.meta.url));
const options = (mode: string) => ({ command: process.execPath, prefixArgs: [fixture], env: { ...process.env, MRROBOT_SESSION_FIXTURE: mode }, providerId: 'fixture', model: 'fixture' });
try {
  for (const kind of ['broker', 'native'] as const) {
    let toolCalls = 0, streamed = '';
    const call = (mode: string, history: Turn[] = [], signal?: AbortSignal) => kind === 'broker'
      ? pooledCodexText({ ...options(mode), req: { promptCacheKey: kind + mode, turns: [...history, { role: 'user', content: 'hello' }], signal,
        tools: [{ name: 'fixture_tool', description: 'fixture', parameters: { type: 'object' } }], executeTool: async () => { toolCalls++; return ''; }, onEvent: e => { if (e.type === 'text') streamed += e.text; } } as BrokerAgentRequest })
      : pooledNativeCodex({ ...options(mode), req: { prompt: 'hello', cwd: dir, permissionMode: 'read-only', signal, onText: t => streamed += t,
        session: { key: kind + mode, directory: dir, history, input: 'hello', instructions: 'fixture', context: '' } } as NativeAgentRequest });
    const a = await call('early');
    assert.equal(a.text, 'answer 1'); assert.equal(streamed, 'answer 1');
    const b = await call('early', [{ role: 'user', content: 'hello' }, { role: 'assistant', content: a.text }]);
    assert.equal(b.text, 'answer 2', 'late prior-turn completion cannot finish or cancel the new turn');
    for (const mode of ['other-startup', 'other-thread', 'other-turn', 'early-tool']) await assert.rejects(call(mode));
    assert.equal(toolCalls, 0, 'early tool requests never execute');
    const controller = new AbortController();
    const pending = call('wait', [], controller.signal);
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(pending, /중지/);
    await assert.rejects(call('wait', [], AbortSignal.abort()));
    assert.equal((await call('early')).text, 'answer 1', 'explicit retry rebuilds an incompatible worker, without replaying a cancelled turn');
  }
} finally {
  closeTextWorkers(); closeNativeWorkers();
  for (let i = 0; i < 30; i++) { try { rmSync(dir, { recursive: true, force: true }); break; } catch (e) { if (i === 29) throw e; await new Promise(r => setTimeout(r, 100)); } }
}
console.log('Session event ordering passed for isolated and native transports.');
