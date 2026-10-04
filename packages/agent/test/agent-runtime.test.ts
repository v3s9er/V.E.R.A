import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { executeToolBatch, toolResultSucceeded } from '../src/ai/tool-batch.js';
import { RunProgress } from '../src/server/run-progress.js';

test('read batching has a three-worker ceiling and mutation barriers', async () => {
  let active = 0, peak = 0; const finished: number[] = [];
  const calls = ['read_file', 'list_files', 'read_file', 'write_file', 'read_file', 'shell_exec'].map(name => ({ name }));
  const results = await executeToolBatch(calls, async (call, index) => {
    if (index === 3) assert.deepEqual([...finished].sort(), [0, 1, 2]);
    if (index === 4) assert.ok(finished.includes(3));
    if (index === 5) assert.ok(finished.includes(4));
    active++; peak = Math.max(peak, active); await delay(index === 0 ? 20 : 5);
    active--; finished.push(index); return index;
  });
  assert.equal(peak, 3); assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
});
test('failure drains in-flight reads and never starts subsequent mutation', async () => {
  let completed = false, mutated = false;
  await assert.rejects(executeToolBatch([{ name: 'read_file' }, { name: 'read_file' }, { name: 'write_file' }], async (_, index) => {
    if (index === 0) throw Error('fixture');
    if (index === 1) { await delay(15); completed = true; }
    if (index === 2) mutated = true;
  }));
  assert.equal(completed, true); assert.equal(mutated, false);
});
test('cancelled batch starts no later actions; plugin tools stay serialized', async () => {
  const stop = new AbortController(); let count = 0;
  await assert.rejects(executeToolBatch([{ name: 'plugin.a' }, { name: 'plugin.b' }], async () => { count++; stop.abort(); }, stop.signal));
  assert.equal(count, 1);
});
test('returned errors, cancellation and unsuccessful process exits are not progress', () => {
  for (const value of [{ error: 'failed' }, { ok: false }, { cancelled: true }, { exitCode: 1 }, { launched: false }]) assert.equal(toolResultSucceeded(JSON.stringify(value)), false);
  for (const value of ['text', '{}', '[1]', '{"ok":true}', '{"exitCode":0}']) assert.equal(toolResultSucceeded(value), true);
});
test('run snapshots are bounded, detached and do not revive terminal or cancelling work', () => {
  let now = 0; const run = new RunProgress(() => ++now);
  for (let i = 0; i < 50; i++) { run.tool({ name: 'read_file', callId: String(i), status: 'start' }); run.tool({ name: 'read_file', callId: String(i), status: 'done' }); }
  run.text('x'.repeat(70000));
  const snap = run.snapshot(); assert.equal(snap.activity?.length, 32); assert.equal(snap.partialText?.length, 64000); assert.equal(snap.partialTextTruncated, true);
  snap.activity![0].label = 'tampered'; assert.equal(run.snapshot().activity![0].label, 'read_file');
  run.transition('approval'); assert.equal(run.snapshot().phase, 'approval');
  run.transition('cancelling'); run.text('late'); run.transition('working'); assert.equal(run.snapshot().phase, 'cancelling');
  run.transition('cancelled'); run.transition('completed'); assert.equal(run.snapshot().phase, 'cancelled');
});
test('parallel same-name tools correlate by provider call ID', () => {
  const run = new RunProgress(); run.tool({ name: 'read_file', callId: 'a', status: 'start' }); run.tool({ name: 'read_file', callId: 'b', status: 'start' });
  run.tool({ name: 'read_file', callId: 'b', status: 'error' });
  assert.deepEqual(run.snapshot().activity!.map(item => item.state), ['running', 'error']);
});
