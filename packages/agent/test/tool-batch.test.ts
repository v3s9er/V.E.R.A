import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeToolBatch } from '../src/ai/tool-batch.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

test('read lanes refill before the slowest read finishes, but mutations wait and results keep model order', async () => {
  const gates = Array.from({ length: 6 }, deferred);
  const started: number[] = [];
  let active = 0, peak = 0;
  const calls = [...gates.map(() => ({ name: 'read_file' })), { name: 'write_file' }, { name: 'list_files' }];
  const run = executeToolBatch(calls, async (_call, index) => {
    started.push(index); peak = Math.max(peak, ++active);
    if (gates[index]) await gates[index].promise;
    active--; return index;
  });
  assert.deepEqual(started, [0, 1, 2]);
  gates[1].resolve(); await tick(); assert.deepEqual(started, [0, 1, 2, 3]);
  gates[2].resolve(); await tick(); assert.deepEqual(started, [0, 1, 2, 3, 4]);
  gates[3].resolve(); await tick(); assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  gates[4].resolve(); gates[5].resolve(); await tick();
  assert.equal(started.includes(6), false);
  gates[0].resolve();
  assert.deepEqual(await run, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(peak, 3);
});

test('failure stops queued reads and drains every started read before rejecting', async () => {
  const gates = Array.from({ length: 3 }, deferred);
  const started: number[] = [];
  let finished = false;
  const run = executeToolBatch(Array.from({ length: 6 }, () => ({ name: 'read_file' })), async (_call, index) => {
    started.push(index); await gates[index].promise;
    if (index === 1) throw new Error('fixture read failed');
    return index;
  });
  const rejected = assert.rejects(run, /fixture read failed/).then(() => { finished = true; });
  gates[1].resolve(); await tick(); assert.equal(finished, false);
  assert.deepEqual(started, [0, 1, 2]);
  gates[0].resolve(); gates[2].resolve(); await rejected;
  assert.deepEqual(started, [0, 1, 2]);
});

test('abort never starts queued reads or a mutation and waits for active reads', async () => {
  const controller = new AbortController();
  const gate = deferred(); const started: number[] = [];
  const run = executeToolBatch([
    ...Array.from({ length: 5 }, () => ({ name: 'list_files' })), { name: 'write_file' },
  ], async (_call, index) => { started.push(index); await gate.promise; return index; }, controller.signal);
  const rejected = assert.rejects(run, /cancelled/);
  controller.abort(new Error('cancelled')); gate.resolve(); await rejected;
  assert.deepEqual(started, [0, 1, 2]);
});

test('unknown plugins, desktop actions and writes stay serialized', async () => {
  let active = 0, peak = 0;
  const calls = ['read_file', 'mcp.call', 'mouse_click', 'write_file', 'list_files'].map(name => ({ name }));
  await executeToolBatch(calls, async () => { peak = Math.max(peak, ++active); await tick(); active--; });
  assert.equal(peak, 1);
  assert.deepEqual(await executeToolBatch([], async () => 'unused'), []);
});

test('even a synchronous or undefined rejection halts the segment', async () => {
  const seen: number[] = [];
  await assert.rejects(executeToolBatch([{ name: 'read_file' }, { name: 'read_file' }], (_call, index) => {
    seen.push(index); throw new Error('sync');
  }), /sync/);
  assert.deepEqual(seen, [0]);
  let rejected = false;
  try { await executeToolBatch([{ name: 'read_file' }], async () => { throw undefined; }); }
  catch { rejected = true; }
  assert.equal(rejected, true);
});
