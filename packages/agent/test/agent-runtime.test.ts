import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { executeToolBatch, toolResultSucceeded } from '../src/ai/tool-batch.js';
import { RunProgress } from '../src/server/run-progress.js';
import { runPresentation } from '../../shared/src/run-presentation.js';

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

test('clipped tool failures remain visible without claiming the retained tail is the whole run', () => {
  const run = new RunProgress();
  run.tool({ name: 'read_file', callId: 'failed', status: 'start' });
  run.tool({ name: 'read_file', callId: 'failed', status: 'error' });
  for (let i = 0; i < 32; i++) {
    run.tool({ name: 'read_file', callId: String(i), status: 'start' });
    run.tool({ name: 'read_file', callId: String(i), status: 'done' });
  }
  run.transition('completed');
  const snapshot = run.snapshot();
  assert.equal(snapshot.activity!.length, 32);
  assert.equal(snapshot.activityTruncated, true);
  assert.equal(snapshot.activityHadErrors, true);
  const view = runPresentation({ ...snapshot, busy: false });
  assert.equal(view.hasErrors, true);
  assert.match(view.heading, /오류/);
  assert.match(view.detail, /최근 도구 32\/32 완료/);
  assert.match(view.detail, /전체 내역 일부 생략/);
  assert.match(view.detail, /표시되지 않은 도구 오류 있음/);
  assert.doesNotMatch(view.detail, /오류 0개/);
});

test('late errors for evicted starts and duplicate errors preserve bounded evidence, not fabricated totals', () => {
  const run = new RunProgress();
  run.tool({ name: 'read_file', callId: 'slow', status: 'start' });
  for (let i = 0; i < 32; i++) {
    run.tool({ name: 'read_file', callId: String(i), status: 'start' });
    run.tool({ name: 'read_file', callId: String(i), status: 'done' });
  }
  for (let i = 0; i < 50; i++) run.tool({ name: 'read_file', callId: 'slow', status: 'error' });
  const snapshot = run.snapshot();
  assert.equal(snapshot.activityHadErrors, true);
  assert.equal(snapshot.activity!.length, 32);
  assert.equal(snapshot.activity!.filter(item => item.state === 'error').length, 0);
  assert.equal(runPresentation({ ...snapshot, busy: true }).hasErrors, true);
  snapshot.activityHadErrors = false;
  snapshot.activityTruncated = false;
  assert.equal(run.snapshot().activityHadErrors, true);
  assert.equal(run.snapshot().activityTruncated, true);
});

test('untruncated runs expose known false flags and terminal incomplete tools retain their warning', () => {
  const run = new RunProgress();
  assert.equal(run.snapshot().activityTruncated, false);
  assert.equal(run.snapshot().activityHadErrors, false);
  run.tool({ name: 'read_file', callId: 'unfinished', status: 'start' });
  run.transition('completed');
  assert.equal(run.snapshot().activityHadErrors, true);
  const ended = run.snapshot();
  run.tool({ name: 'read_file', callId: 'late', status: 'start' });
  run.tool({ name: 'read_file', callId: 'late', status: 'error' });
  assert.deepEqual(run.snapshot(), ended);
});

test('observation limitation is exact, run-local and sticky without changing phase or errors', () => {
  const marker = '도구 관측 제한 · 이 연결에서는 일부 코드 실행이 집계되지 않을 수 있습니다.';
  const run = new RunProgress();
  assert.equal(run.snapshot().observationLimited, false);
  run.status(`${marker} extra`);
  assert.equal(run.snapshot().observationLimited, false);
  run.transition('approval');
  run.status(marker); run.status('working');
  assert.equal(run.snapshot().phase, 'approval');
  assert.equal(run.snapshot().observationLimited, true);
  assert.equal(run.snapshot().activityHadErrors, false);
  assert.equal(run.snapshot().activityTruncated, false);
  run.transition('failed');
  assert.equal(run.snapshot().observationLimited, true);
  const terminal = run.snapshot(); run.status(marker);
  assert.deepEqual(run.snapshot(), terminal);
  assert.equal(new RunProgress().snapshot().observationLimited, false);
});

test('explicit same-call failure corrects a completed row without matching unrelated or legacy calls', () => {
  const run = new RunProgress();
  run.tool({ name: 'native_custom_tool', callId: 'returned', status: 'start' });
  run.tool({ name: 'native_custom_tool', callId: 'returned', status: 'done' });
  run.tool({ name: 'native_custom_tool', callId: 'running', status: 'start' });
  run.tool({ name: 'native_custom_tool', callId: 'returned', status: 'error' });
  run.tool({ name: 'native_custom_tool', callId: 'returned', status: 'done' });
  run.tool({ name: 'native_custom_tool', callId: 'returned', status: 'start' });
  assert.deepEqual(run.snapshot().activity!.map(item => item.state), ['error', 'running']);
  assert.equal(run.snapshot().activityHadErrors, true);
  run.tool({ name: 'legacy_tool', status: 'start' }); run.tool({ name: 'legacy_tool', status: 'done' });
  run.tool({ name: 'legacy_tool', status: 'error' });
  assert.equal(run.snapshot().activity!.at(-1)!.state, 'done');
});
