import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pooledNativeCodex, closeNativeWorkers } from '../src/ai/cli-native-pool.js';
import { waitForCliRetirements } from '../src/ai/cli-process-retirement.js';
import { DESKTOP_TOOLS } from '../src/computer/desktop-session.js';
import type { NativeAgentRequest, NativeToolResult } from '../src/ai/provider.js';

const output: NativeToolResult = { success: true, contentItems: [{ type: 'inputText', text: 'test only' }, { type: 'inputImage', imageUrl: 'data:image/png;base64,aGVsbG8=' }] };
async function run(mode: string, execute: NonNullable<NativeAgentRequest['hostTools']>['execute'], permission: NativeAgentRequest['permissionMode'] = 'full', signal?: AbortSignal) {
  const directory = mkdtempSync(join(tmpdir(), 'mrrobot-native-desktop-'));
  let disposed = false;
  try {
    return await pooledNativeCodex({ command: process.execPath, prefixArgs: [fileURLToPath(new URL('./fixtures/native-desktop-app-server.mjs', import.meta.url))],
      env: process.env, providerId: 'fixture', model: 'fixture', req: {
        prompt: mode, cwd: directory, permissionMode: permission, signal,
        session: { key: 'desktop-fixture', directory, input: mode, history: [], context: '', instructions: 'fixture only' },
        hostTools: { tools: DESKTOP_TOOLS, execute, dispose: () => { disposed = true; } },
      } });
  } finally {
    closeNativeWorkers(); await waitForCliRetirements(process.env); rmSync(directory, { recursive: true, force: true });
    if (permission === 'full') assert.equal(disposed, true, 'capability released on completion/failure');
  }
}
for (const mode of ['NORMAL_IMAGE', 'EARLY_IMAGE']) test(`native desktop calls correlate before executing: ${mode}`, async () => {
  let count = 0;
  const result = await run(mode, async name => { count++; assert.equal(name, 'desktop_windows'); return output; });
  assert.equal(result.text, 'desktop verified'); assert.equal(count, 1);
});
for (const mode of ['WRONG_THREAD', 'WRONG_TURN', 'NAMESPACE', 'UNKNOWN', 'DUPLICATE', 'EARLY_WRONG_TURN']) test(`native desktop fails closed: ${mode}`, async () => {
  let count = 0;
  await assert.rejects(run(mode, async (_name, _args, signal) => { signal.throwIfAborted(); count++; return output; }));
  // Pipe packets may split between the first valid request and its duplicate.
  // The first call may already have run; the safety invariant is no replay.
  if (mode === 'DUPLICATE') assert.ok(count <= 1, 'duplicate must never execute twice');
  else assert.equal(count, 0);
});
test('dynamic tool failures return a human-readable model result without ending a valid turn', async () => {
  const result = await run('NORMAL', async () => { throw Error('window stale'); });
  assert.equal(result.text, 'desktop error explained');
});
test('cancellation aborts an active host capability and releases it', async () => {
  const abort = new AbortController(); let stopped = false;
  await assert.rejects(run('NORMAL', async (_name, _args, signal) => {
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { stopped = true; reject(Error('aborted')); }, { once: true });
      abort.abort();
    });
  }, 'full', abort.signal), /중지/);
  assert.equal(stopped, true);
});
for (const permission of ['read-only', 'workspace', 'ask'] as const) test(`no desktop capability at ${permission}`, async () => {
  let count = 0; await assert.rejects(run('NORMAL', async () => { count++; return output; }, permission)); assert.equal(count, 0);
});
