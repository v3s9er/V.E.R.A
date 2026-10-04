import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, sha256 } from '../app-benchmark-protocol.js';
import { renderAppBenchmarkReport, summarizeAppBenchmark } from '../app-benchmark-report.js';

function fixture() {
  const plan = { suite: 'relations', model: 'exact-model', effort: 'high', arms: ['single', 'adaptive'], repetitions: 2, tasks: [{ id: 'a' }],
    schedule: ['single', 'adaptive'].flatMap(arm => [0, 1].map(repetition => ({ taskId: 'a', arm, repetition }))) };
  const planHash = sha256(canonicalJson(plan));
  const samples = plan.schedule.map(item => ({ ...item, completed: true, passed: true, failure: null,
    durationMs: 1000, firstTextMs: 500, route: { model: plan.model, effort: plan.effort }, nativeRouteObserved: true, savedFinalMatches: true, streamMatches: true,
    usage: { promptTokens: 90, completionTokens: 10, totalTokens: 100, cachedPromptTokens: 80, reportStatus: 'reported' }, agentEvents: [],
    prompt: 'PRIVATE_PROMPT', answer: 'PRIVATE_ANSWER', projectPath: 'PRIVATE_PATH', toolEvents: [{ output: 'PRIVATE_TOOL_OUTPUT' }] }));
  return { envelope: { plan, planHash }, report: { planHash, complete: true, provenanceValid: true, stopped: null, activeRunsAfter: 0, samples } };
}

test('correct denominators, repetition consistency, and no double-counted cache/worker usage', () => {
  const { envelope, report } = fixture();
  report.samples[0]!.agentEvents = [{ usage: { totalTokens: 999 } }] as any;
  const summary = summarizeAppBenchmark(envelope, report);
  assert.equal(summary.complete, true);
  assert.equal(summary.arms[0].totalTokens, 200);
  assert.equal(summary.arms[0].tokensPerSuccess, 100);
  assert.equal(summary.arms[0].consistent, 1);
  assert.equal(summary.arms[0].helperRunsObserved, 1);
});
test('missing runs remain in planned denominator, unknown usage is not zero', () => {
  const { envelope, report } = fixture();
  report.complete = false;
  report.samples.pop();
  const summary = summarizeAppBenchmark(envelope, report);
  assert.equal(summary.arms[1].expected, 2);
  assert.equal(summary.arms[1].passed, 1);
  assert.equal(summary.arms[1].missing, 1);
  assert.equal(summary.arms[1].totalTokens, null);
  assert.equal(summary.arms[1].consistent, 0);
});
test('fails closed for duplicate samples, forged completion, and plan drift', () => {
  for (const mutate of [
    (x: ReturnType<typeof fixture>) => { x.report.samples.push(x.report.samples[0]!); },
    (x: ReturnType<typeof fixture>) => { x.report.samples.pop(); },
    (x: ReturnType<typeof fixture>) => { x.report.provenanceValid = false; },
    (x: ReturnType<typeof fixture>) => { x.envelope.plan.model = 'different'; },
  ]) { const x = fixture(); mutate(x); assert.throws(() => summarizeAppBenchmark(x.envelope, x.report)); }
});
test('rejects mismatched execution route, malformed accounting, false pass and invalid durations', () => {
  for (const mutate of [
    (row: any) => { row.route.model = 'different'; },
    (row: any) => { row.usage.totalTokens = 180; },
    (row: any) => { row.usage.cachedPromptTokens = 100; },
    (row: any) => { row.failure = 'wrong_answer'; },
    (row: any) => { row.durationMs = Number.NaN; },
  ]) { const x = fixture(); mutate(x.report.samples[0]); assert.throws(() => summarizeAppBenchmark(x.envelope, x.report)); }
});
test('failures stay in latency distribution; first-text null and incomplete usage remain explicit', () => {
  const { envelope, report } = fixture();
  Object.assign(report.samples[0]!, { passed: false, completed: false, failure: 'deadline', durationMs: 9000, firstTextMs: null,
    usage: { promptTokens: null, completionTokens: null, totalTokens: null, cachedPromptTokens: null, reportStatus: 'unknown' } });
  const result = summarizeAppBenchmark(envelope, report).arms[0];
  assert.equal(result.completionP95Ms, 9000);
  assert.equal(result.firstTextCount, 1);
  assert.equal(result.usageKnown, 1);
  assert.equal(result.tokensPerSuccess, null);
  assert.equal(result.consistent, 0);
});
test('render only whitelisted metadata, excluding content, tool output and private paths', () => {
  const { envelope, report } = fixture();
  const markdown = renderAppBenchmarkReport(envelope, report);
  assert.doesNotMatch(markdown, /PRIVATE_/);
  assert.match(markdown, /세계 순위를 주장하지/);
  assert.match(markdown, /합성 관계 문제의 기능 회귀/);
  assert.doesNotMatch(markdown, /공개 문제의 로컬 회귀/);
  assert.match(markdown, /캐시 토큰은 입력 토큰의 부분집합/);
  assert.match(markdown, /2 \/ 2/);
});
test('a rehashed but unbalanced plan cannot disguise missing paired runs', () => {
  const { envelope, report } = fixture();
  envelope.plan.schedule.pop();
  report.samples.pop();
  envelope.planHash = report.planHash = sha256(canonicalJson(envelope.plan));
  assert.throws(() => summarizeAppBenchmark(envelope, report), /Unbalanced/);
});
test('uses the harness canonicalization for mixed-case artifact hash keys', () => {
  const { envelope, report } = fixture();
  Object.assign(envelope.plan, { appHashes: { 'Z:/bundle': 'a', 'a:/bundle': 'b', 'a-beta': 'c', a_beta: 'd' } });
  envelope.planHash = report.planHash = sha256(canonicalJson(envelope.plan));
  assert.equal(summarizeAppBenchmark(envelope, report).complete, true);
});
test('private path and free-text metadata is rejected instead of exported', () => {
  for (const field of ['suite', 'model', 'effort'] as const) {
    const x = fixture(); x.envelope.plan[field] = 'C:/Users/PRIVATEPERSON/private.txt';
    x.envelope.planHash = x.report.planHash = sha256(canonicalJson(x.envelope.plan));
    assert.throws(() => renderAppBenchmarkReport(x.envelope, x.report));
  }
});
test('inventory omission, stream/persistence contradiction and helper model drift fail closed', () => {
  for (const mutate of [
    (x: ReturnType<typeof fixture>) => { x.envelope.plan.tasks.push({ id: 'b' }); x.envelope.planHash = x.report.planHash = sha256(canonicalJson(x.envelope.plan)); },
    (x: ReturnType<typeof fixture>) => { x.report.samples[0]!.savedFinalMatches = false; },
    (x: ReturnType<typeof fixture>) => { x.report.samples[0]!.streamMatches = false; },
    (x: ReturnType<typeof fixture>) => { x.report.samples[0]!.agentEvents = [{ model: 'different' }] as any; },
  ]) { const x = fixture(); mutate(x); assert.throws(() => summarizeAppBenchmark(x.envelope, x.report)); }
});
test('unknown numeric zeros and fractional tokens are rejected; capped usage is not an exact total', () => {
  const x = fixture();
  Object.assign(x.report.samples[0]!.usage, { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0, reportStatus: 'unknown' });
  assert.throws(() => summarizeAppBenchmark(x.envelope, x.report));
  Object.assign(x.report.samples[0]!.usage, { promptTokens: .5, completionTokens: .5, totalTokens: 1, reportStatus: 'reported' });
  assert.throws(() => summarizeAppBenchmark(x.envelope, x.report));
  Object.assign(x.report.samples[0]!.usage, { promptTokens: 50, completionTokens: 50, totalTokens: 100, reportStatus: 'capped' });
  assert.equal(summarizeAppBenchmark(x.envelope, x.report).arms[0].totalTokens, null);
});
