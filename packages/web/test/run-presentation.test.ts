import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityLabel, executionPresentation, mergeToolActivity, runPresentation, runTimeline, terminalRunUpdate, timelineStateLabel } from '../../shared/src/run-presentation.js';
import type { CoordinationAgent } from '../../shared/src/coordination.js';

const helper = (state: CoordinationAgent['state'], overrides: Partial<CoordinationAgent> = {}): CoordinationAgent => ({
  agentId: 'review', label: '프로젝트 검토', providerId: 'fixture', model: 'fixture-model', state,
  sequence: 1, turns: 1, status: 'PRIVATE_STATUS', usage: { promptTokens: 0, completionTokens: 0 }, ...overrides,
});

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
test('inline timeline stays chronological and bounded without reflecting raw tool payloads', () => {
  const activity = Array.from({ length: 40 }, (_, i) => ({ id: String(i), label: i === 39 ? '{"secret":"TEST_ONLY"}' : 'read_file', startedAt: i, state: 'done' as const, input: 'PRIVATE_INPUT', output: 'PRIVATE_OUTPUT' })).reverse();
  const snapshot = JSON.stringify(activity);
  const rows = runTimeline({ activity });
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map(r => r.at), [34, 35, 36, 37, 38, 39]);
  assert.equal(rows.at(-1)?.label, '도구 작업');
  assert.equal(JSON.stringify(activity), snapshot);
  assert.doesNotMatch(JSON.stringify(rows), /TEST_ONLY|PRIVATE_/);
  assert.deepEqual(runTimeline({}), []);
});

test('queued helpers are visible without claiming an active or successful run', () => {
  const run = { busy: true, phase: 'working' as const, agents: [helper('queued')] };
  assert.equal(runPresentation(run).heading, '보조 작업 실행 대기');
  assert.match(runPresentation(run).detail, /실행 순서를 기다리고/);
  assert.equal(timelineStateLabel(runTimeline(run)[0].state), '실행 대기');
  assert.equal(timelineStateLabel('queued', true), '완료 미확인');
  assert.equal(runPresentation({ busy: true, phase: 'working' }).heading, '모델 응답 대기');
});

test('helper snapshots deduplicate by sequence and terminal updates retain their own outcome', () => {
  const agents = [helper('completed', { sequence: 3 }), helper('running', { sequence: 2 }), helper('queued', { sequence: 1 }),
    helper('failed', { agentId: 'failed', label: '{"private":"PRIVATE_LABEL"}' }),
    helper('cancelled', { agentId: 'cancelled' })];
  const before = JSON.stringify(agents);
  const rows = runTimeline({ agents });
  assert.equal(rows.length, 3);
  assert.equal(rows.find(row => row.id === 'agent:review')?.state, 'done');
  assert.equal(rows.find(row => row.id === 'agent:failed')?.state, 'error');
  assert.equal(rows.find(row => row.id === 'agent:failed')?.label, '보조 작업');
  assert.equal(timelineStateLabel(rows.find(row => row.id === 'agent:cancelled')!.state), '중지');
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_|fixture-model/);
  assert.equal(JSON.stringify(agents), before);
  assert.match(runPresentation({ busy: false, phase: 'completed', agents }).detail, /보조 작업 1\/3 완료/);
});

test('live log stays bounded and retains active helpers after long tool histories', () => {
  const activity = Array.from({ length: 50 }, (_, index) => ({ id: String(index), label: 'read_file', state: 'done' as const, startedAt: index }));
  const run = { activity: [...activity, activity[49]], agents: [helper('queued'), helper('running', { agentId: 'second' })] };
  for (const limit of [6, Infinity, NaN]) {
    const rows = runTimeline(run, limit);
    assert.equal(rows.length, 6);
    assert.equal(new Set(rows.map(row => row.id)).size, 6);
    assert.equal(rows.at(-2)?.state, 'queued');
    assert.equal(rows.at(-1)?.state, 'running');
  }
  assert.equal(runTimeline(run, 100).length, 12);
});

test('selected execution policy is distinct from actual helper observations', () => {
  const selected = executionPresentation('adaptive');
  assert.equal(selected.selected, '선택: 적응형 협업');
  assert.equal(selected.observed, '보조 실행 이벤트 없음');
  const queued = executionPresentation('adaptive', [helper('queued')]);
  assert.match(queued.observed, /1개 실행 대기/);
  assert.doesNotMatch(queued.observed, /병렬 실행|완료/);
  const parallel = executionPresentation('adaptive', [helper('running'), helper('running', { agentId: 'second' })]);
  assert.match(parallel.observed, /2개 병렬 실행/);
  assert.equal(executionPresentation('single').selected, '선택: 단일 모델');
  assert.equal(executionPresentation('vote').selected, '선택: 병렬 검토·투표');
  assert.equal(executionPresentation(undefined).selected, '선택한 실행 방식 확인 중');
});

test('verification is a recognized host stage and never a fabricated successful outcome', () => {
  const run = { busy: true, phase: 'working' as const, status: '최종 검증 시작 · PRIVATE_NODE_LABEL' };
  const view = runPresentation(run);
  assert.equal(view.heading, '최종 결과 검토 중');
  assert.match(view.detail, /아직 확인되지 않았습니다/);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_/);
  assert.equal(runPresentation({ ...run, phase: 'completed', busy: false }).heading, '응답 완료');
  assert.equal(runPresentation({ ...run, status: '{"reasoning":"PRIVATE_CHAIN"}' }).heading, '모델 응답 대기');
  assert.equal(runPresentation({ ...run, phase: 'approval' }).heading, '승인이 필요해요');
});

test('legacy capped snapshots cannot establish complete history or a zero error count', () => {
  const activity = Array.from({ length: 32 }, (_, index) => ({ id: String(index), label: 'read_file', state: 'done' as const, startedAt: index }));
  const legacy = runPresentation({ busy: false, phase: 'completed', activity });
  assert.match(legacy.detail, /최근 도구 32\/32 완료/);
  assert.match(legacy.detail, /전체 도구 내역 확인 불가/);
  const complete = runPresentation({ busy: false, phase: 'completed', activity, activityTruncated: false, activityHadErrors: false });
  assert.equal(complete.detail, '도구 32/32 완료');
  assert.equal(complete.hasErrors, false);
});

test('omitted error metadata never overrides visible errors or invents an exact error total', () => {
  const activity = [{ id: 'error', label: 'read_file', state: 'error' as const, startedAt: 1 }];
  const view = runPresentation({ busy: false, phase: 'completed', activity, activityTruncated: true, activityHadErrors: true });
  assert.equal(view.hasErrors, true);
  assert.match(view.detail, /표시된 오류 1개/);
  const missing = runPresentation({ busy: false, phase: 'completed', activityTruncated: true, activityHadErrors: true });
  assert.equal(missing.hasErrors, true);
  assert.doesNotMatch(missing.detail, /도구 실행 없음|오류 [0-9]+개/);
  assert.match(missing.detail, /전체 내역 일부 생략/);
  assert.equal(runPresentation({ busy: false, phase: 'completed', activity, activityHadErrors: false }).hasErrors, true);
});
