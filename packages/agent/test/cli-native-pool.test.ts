import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pooledNativeCodex, closeNativeWorkers } from '../src/ai/cli-native-pool.js';
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
  closeNativeWorkers();
  const c = await call(next(second, b.text));
  assert.equal(c.text, 'answer 3', 'resume exact persisted thread after worker shutdown');
  assert.equal(c.usage.promptTokens, 100, 'old token totals not charged again after resume');
  assert.ok(!readFileSync(join(dir, 'native-sessions.json'), 'utf8').includes('FIRST_PRIVATE_INPUT'));
  assert.equal((await call({ ...base, session: { ...base.session!, key: 'other-user' } })).text, 'answer 1');
  assert.equal((await call({ ...second, permissionMode: 'full' })).text, 'answer 1', 'authority change cannot reuse read-only session');
  assert.equal((await call({ ...base, session: { ...base.session!, history: [], input: 'rewritten' } })).text, 'answer 1');
  await assert.rejects(call({ ...base, session: { ...base.session!, key: 'deny', input: 'UNEXPECTED_APPROVAL' } }), /권한/);
  const abort = new AbortController();
  const pending = call({ ...base, signal: abort.signal, session: { ...base.session!, key: 'cancel', input: 'WAIT_FOREVER' } });
  setTimeout(() => abort.abort(), 100); await assert.rejects(pending, /중지/);
  console.log('Native sessions: warm reuse, restart/resume, delta input, usage deltas, authority/user/history isolation, cancellation and approval rejection passed.');
} finally {
  closeNativeWorkers();
  for (let i = 0; i < 30; i++) { try { rmSync(dir, { recursive: true, force: true }); break; } catch (e) { if (i === 29) throw e; await new Promise(r => setTimeout(r, 100)); } }
}
