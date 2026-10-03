import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pooledNativeCodex, closeNativeWorkers } from '../src/ai/cli-native-pool.js';
import { waitForCliRetirements } from '../src/ai/cli-process-retirement.js';
import type { NativeAgentRequest } from '../src/ai/provider.js';
const dir = mkdtempSync(join(tmpdir(), 'mrrobot-native-test-'));
const base: NativeAgentRequest = { prompt: 'fallback', cwd: dir, permissionMode: 'read-only', reasoningEffort: 'high',
  session: { key: 'user:ticket', directory: dir, history: [], input: 'FIRST_PRIVATE_INPUT', instructions: 'test only', context: '' } };
const call = (req: NativeAgentRequest) => pooledNativeCodex({ command: process.execPath, prefixArgs: [fileURLToPath(new URL('./fixtures/native-app-server.mjs', import.meta.url))], env: process.env, providerId: 'test', model: 'test', req });
const next = (req: NativeAgentRequest, answer: string, input = 'follow up'): NativeAgentRequest => ({ ...req, session: { ...req.session!, input, history: [...req.session!.history, { role: 'user', content: req.session!.input }, { role: 'assistant', content: answer }] } });
try {
  let streamed = '';
  const a = await call({ ...base, onText: t => streamed += t });
  assert.equal(a.text, 'answer 1'); assert.equal(streamed, a.text);
  const second = next(base, a.text);
  const b = await call(second);
  assert.equal(b.text, 'answer 2'); assert.equal(b.usage.promptTokens, 100);
  const differentEnvironment = await pooledNativeCodex({ command: process.execPath,
    prefixArgs: [fileURLToPath(new URL('./fixtures/native-app-server.mjs', import.meta.url))],
    env: { ...process.env, MRROBOT_TEST_TRANSPORT_IDENTITY: 'different-environment' }, providerId: 'test', model: 'test', req: next(second, b.text) });
  assert.equal(differentEnvironment.text, 'answer 1', 'environment boundary cannot reuse a previous CLI process or checkpoint');
  closeNativeWorkers();
  const c = await call(next(second, b.text));
  assert.equal(c.text, 'answer 3', 'resume exact persisted thread after worker shutdown');
  assert.equal(c.usage.promptTokens, 100, 'old token totals not charged again after resume');
  const interlude = next(next(second, b.text), c.text, 'EXPECT_INTERLUDE');
  interlude.session!.history.push({ role: 'user', content: 'INTERLUDE_DATA' }, { role: 'assistant', content: 'a separate text turn' });
  assert.equal((await call(interlude)).text, 'answer 4', 'verified appended host turns do not discard a native session');
  const rewritten = { ...interlude, session: { ...interlude.session!, input: 'different', history: interlude.session!.history.map((t, i) => i === 1 ? { ...t, content: 'changed earlier answer' } : t) } };
  assert.equal((await call(rewritten)).text, 'answer 1', 'same-length or appended histories never hide an earlier rewrite');
  assert.ok(!readFileSync(join(dir, 'native-sessions.json'), 'utf8').includes('FIRST_PRIVATE_INPUT'));
  assert.equal((await call({ ...base, session: { ...base.session!, key: 'other-user' } })).text, 'answer 1');
  const tools: unknown[] = [];
  await call({ ...base, onTool: e => tools.push(e), session: { ...base.session!, key: 'metrics', input: 'EXPECT_TOOL_METRICS' } });
  assert.equal(tools.length, 2);
  assert.ok(!JSON.stringify(tools).includes('PRIVATE_COMMAND'));
  assert.equal((await call({ ...second, permissionMode: 'full' })).text, 'answer 1', 'authority change cannot reuse read-only session');
  assert.equal((await call({ ...base, session: { ...base.session!, history: [], input: 'rewritten' } })).text, 'answer 1');
  await assert.rejects(call({ ...base, session: { ...base.session!, key: 'deny', input: 'UNEXPECTED_APPROVAL' } }), /권한/);
  const abort = new AbortController();
  const pending = call({ ...base, signal: abort.signal, session: { ...base.session!, key: 'cancel', input: 'WAIT_FOREVER' } });
  setTimeout(() => abort.abort(), 100); await assert.rejects(pending, /중지/);
  console.log('Native sessions: warm reuse, restart/resume, delta input, usage deltas, authority/user/history isolation, cancellation and approval rejection passed.');
} finally {
  closeNativeWorkers();
  await waitForCliRetirements(process.env);
  for (let i = 0; i < 30; i++) { try { rmSync(dir, { recursive: true, force: true }); break; } catch (e) { if (i === 29) throw e; await new Promise(r => setTimeout(r, 100)); } }
}
