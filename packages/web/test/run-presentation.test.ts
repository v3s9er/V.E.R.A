import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityLabel, mergeToolActivity, runPresentation, terminalRunUpdate } from '../../shared/src/run-presentation.js';

test('progress reports actual tools, waiting, approvals and failures without fabricated reasoning', () => {
  assert.equal(activityLabel('{"token":"private"}'), '도구 작업');
  assert.equal(activityLabel('read_file'), '파일 읽기');
  assert.equal(runPresentation({ busy: true }).detail, '모델 응답을 기다리고 있어요');
  assert.match(runPresentation({ busy: true, phase: 'approval' }).detail, /승인 또는 거절/);
  assert.match(runPresentation({ busy: true, phase: 'working', activity: [{ id: 'a', label: 'read_file', state: 'running', startedAt: 1 }] }).detail, /파일 읽기/);
  assert.match(runPresentation({ busy: false, phase: 'completed', activity: [{ id: 'a', label: 'read_file', state: 'error', startedAt: 1 }] }).heading, /오류/);
});
test('terminal timers freeze at the acknowledged end, not UI remount or delayed replies', () => {
  const run = { busy: false, phase: 'completed' as const, startedAt: 1000, updatedAt: 8000 };
  assert.equal(runPresentation(run, 90000).elapsed, '0:07');
  assert.equal(runPresentation(run, 120000).elapsed, '0:07');
  assert.equal(runPresentation({ ...run, updatedAt: undefined }).elapsed, '');
  assert.deepEqual(terminalRunUpdate({ phase: 'cancelled', updatedAt: 8000 }, 'completed', 120000), { phase: 'cancelled', updatedAt: 8000 });
  assert.deepEqual(terminalRunUpdate({ phase: 'working' }, 'completed', 8000), { phase: 'completed', updatedAt: 8000 });
});
test('tool rows are immutable and duplicate call events cannot duplicate a row', () => {
  const event = { key: 'read1', callId: 'a', name: 'read_file', status: 'start' as const };
  const original: Array<Omit<typeof event, 'status'> & { status: 'start' | 'done' | 'error' }> = [];
  const started = mergeToolActivity(original, event);
  assert.equal(original.length, 0);
  assert.deepEqual(mergeToolActivity(original, event), started);
  assert.equal(mergeToolActivity(started, event).length, 1);
  const ended = mergeToolActivity(started, { ...event, status: 'done' });
  assert.equal(started[0].status, 'start');
  assert.equal(ended[0].status, 'done');
  assert.equal(mergeToolActivity(ended, event)[0].status, 'done');
});
