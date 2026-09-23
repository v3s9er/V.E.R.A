import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareExternalRuns, EXTERNAL_CATEGORIES, parseExternalRunReport, summarizeExternalRun, wilsonAccuracyInterval, type ExternalRunReport } from '../src/evaluation/external-scorecard.js';

function report(variant: ExternalRunReport['variant'] = 'baseline', count = 40): ExternalRunReport {
  const ids = Array.from({ length: count }, (_, index) => `${EXTERNAL_CATEGORIES[index % 4]}_${index}`);
  return { schemaVersion: 1, benchmark: 'BFCL-custom-subset-v1', revision: 'a'.repeat(40), datasetHashes: { 'simple.questions.jsonl': 'b'.repeat(64) }, sourceHashes: { 'src/grader.ts': 'c'.repeat(64) }, partitionHash: 'd'.repeat(64), provenanceValid: true, split: 'holdout', seed: 'test-seed', model: 'test-model', effort: variant === 'baseline' ? 'medium' : 'low', variant, cliVersion: 'codex-cli 1.2.3', experimentId: 'same-experiment', expectedSampleIds: ids,
    samples: ids.map((id, index) => ({ id, category: EXTERNAL_CATEGORIES[index % 4]!, completed: true, passed: index % 10 !== 0, failure: index % 10 === 0 ? 'wrong_tool' : null, durationMs: variant === 'baseline' ? 1000 : 850, firstTextMs: 100, promptTokens: 100, completionTokens: 20, cachedPromptTokens: 10, callCount: 1 })) };
}

test('strict reports round-trip and forbid raw output and unknown metadata', () => {
  const input = report();
  assert.deepEqual(parseExternalRunReport(JSON.stringify(input)), input);
  assert.deepEqual(parseExternalRunReport(input), input);
  for (const key of ['prompt', 'answer', 'rawOutput', 'notes']) assert.throws(() => parseExternalRunReport({ ...input, [key]: 'not allowed' }), /fields/);
  const extra = structuredClone(input); (extra.samples[0] as any).answer = 'not allowed';
  assert.throws(() => parseExternalRunReport(extra), /fields/);
  const rawFailure = structuredClone(input); rawFailure.samples[0]!.failure = 'raw exception includes text';
  assert.throws(() => parseExternalRunReport(rawFailure), /failure code/);
});

test('parser bounds strings, schemas, hash maps, sample counts and finite measurements', () => {
  const input = report();
  for (const override of [{ schemaVersion: 2 }, { benchmark: 'official-BFCL' }, { seed: 'x'.repeat(81) }, { partitionHash: 'bad' }, { provenanceValid: 'true' }, { datasetHashes: {} }, { expectedSampleIds: [] }, { samples: Array(1001).fill(input.samples[0]) }, { expectedSampleIds: Array(1001).fill('id') }]) assert.throws(() => parseExternalRunReport({ ...input, ...override }));
  for (const value of [NaN, Infinity, -1, 86_400_001]) { const invalid = structuredClone(input); invalid.samples[0]!.durationMs = value; assert.throws(() => parseExternalRunReport(invalid), /duration/); }
  for (const field of ['promptTokens', 'completionTokens', 'cachedPromptTokens', 'callCount'] as const) { const invalid = structuredClone(input); invalid.samples[0]![field] = 1.5; assert.throws(() => parseExternalRunReport(invalid)); }
  assert.throws(() => parseExternalRunReport({ ...input, sourceHashes: { '../private/key': 'a'.repeat(64) } }), /key/);
});

test('identity and outcome invariants prevent duplicated success, omitted fields and impossible measurements', () => {
  const input = report();
  for (const mutate of [
    (value: ExternalRunReport) => { value.samples[1]!.id = value.samples[0]!.id; },
    (value: ExternalRunReport) => { value.samples[0]!.id = 'unexpected'; },
    (value: ExternalRunReport) => { value.expectedSampleIds[1] = value.expectedSampleIds[0]!; },
    (value: ExternalRunReport) => { value.samples[1]!.completed = false; },
    (value: ExternalRunReport) => { value.samples[0]!.failure = null; },
    (value: ExternalRunReport) => { value.samples[1]!.firstTextMs = 1001; },
    (value: ExternalRunReport) => { value.samples[0]!.cachedPromptTokens = 101; },
  ]) { const invalid = structuredClone(input); mutate(invalid); assert.throws(() => parseExternalRunReport(invalid)); }
  const noCalls = report(); noCalls.samples[3]!.callCount = 0;
  assert.equal(parseExternalRunReport(noCalls).samples[3]!.passed, true, 'correct irrelevance can need no tool call');
});

test('summary includes missing and failed tasks in accuracy instead of dropping them', () => {
  const input = report(); input.samples.pop();
  input.samples[1]!.completed = false; input.samples[1]!.passed = false; input.samples[1]!.failure = 'deadline';
  const summary = summarizeExternalRun(input);
  assert.equal(summary.expectedTasks, 40); assert.equal(summary.attemptedTasks, 39);
  assert.equal(summary.passedTasks, 34); assert.equal(summary.failedTasks, 6); assert.equal(summary.accuracy, .85);
  assert.equal(summary.coverage.missing, 1); assert.equal(summary.missingTaskCategoriesUnknown, 0);
  const missingCategory = summary.perCategory.find(row => row.category === 'irrelevance')!;
  assert.equal(missingCategory.expectedTasks, 10); assert.equal(missingCategory.observedTasks, 9);
  assert.equal(missingCategory.missingTasks, 1); assert.equal(missingCategory.failedTasks, 1);
  assert.equal(missingCategory.accuracy, .9);
  assert.deepEqual(missingCategory.accuracyWilson95, wilsonAccuracyInterval(9, 10));
  assert.equal(summary.tokensPerSuccess, null);
  assert.equal(summary.officialLeaderboardScore, false);
  assert.equal('samples' in summary, false);
});

test('Wilson intervals are bounded and small samples remain visibly uncertain', () => {
  assert.equal(wilsonAccuracyInterval(0, 0), null);
  assert.throws(() => wilsonAccuracyInterval(2, 1));
  const all = wilsonAccuracyInterval(40, 40)!;
  assert.ok(all[0] > .90 && all[0] < .93); assert.ok(all[1] <= 1);
  const none = wilsonAccuracyInterval(0, 40)!; assert.ok(none[0] >= 0); assert.ok(none[1] > .08 && none[1] < .10);
  assert.ok(wilsonAccuracyInterval(1, 1)![0] < .3);
});

test('missing usage stays unknown, while reported totals include failed attempts', () => {
  const input = report(); input.samples[0]!.promptTokens = null;
  const summary = summarizeExternalRun(input);
  assert.deepEqual(summary.reportedTokens.promptTokens, { samples: 39, total: 3900 });
  assert.equal(summary.coverage.completeUsageSamples, 39); assert.equal(summary.tokensPerSuccess, null);
  const all = summarizeExternalRun(report());
  assert.equal(all.tokensPerSuccess, 4800 / 36); assert.equal(all.reportedTokens.completionTokens.total, 800);
});

test('a matched improving holdout is only a review recommendation without requiring perfect accuracy', () => {
  const result = compareExternalRuns(report(), report('candidate'));
  assert.equal(result.eligible, true); assert.equal(result.recommendationOnly, true); assert.equal(result.automaticActivation, false);
  assert.equal(result.statisticalSuperiorityClaimed, false); assert.equal(result.generalAgentRankingClaimed, false);
  assert.equal(result.baseline.accuracy, .9); assert.equal(result.candidate.accuracy, .9);
  assert.equal(result.gatePreset.id, 'bfcl-custom-holdout-review-v2');
  assert.ok(result.changes.medianCompletionReduction! >= .10);
});

test('every provenance and workload mismatch blocks later re-comparison', () => {
  for (const field of ['revision', 'partitionHash', 'seed', 'model', 'cliVersion', 'experimentId'] as const) {
    const candidate = report('candidate'); candidate[field] = field === 'partitionHash' ? 'e'.repeat(64) : 'different';
    const result = compareExternalRuns(report(), candidate); assert.equal(result.eligible, false); assert.ok(result.mismatches.includes(field));
  }
  for (const field of ['datasetHashes', 'sourceHashes'] as const) { const candidate = report('candidate'); candidate[field] = { other: 'f'.repeat(64) }; assert.equal(compareExternalRuns(report(), candidate).eligible, false); }
  const drifted = report('candidate'); drifted.provenanceValid = false;
  assert.ok(compareExternalRuns(report(), drifted).mismatches.includes('invalid source provenance'));
  const category = report('candidate'); category.samples[0]!.category = 'irrelevance';
  assert.throws(() => compareExternalRuns(report(), category), /category does not match id/);
  assert.equal(compareExternalRuns(report('candidate'), report()).eligible, false);
});

test('BFCL identities reject invented IDs and category spoofing, including matching pair spoofing', () => {
  for (const id of ['task_0', 'simple_python_1x', 'multiple_-1', 'parallel_1234567', 'irrelevance_', 'other_1']) {
    const invalid = report(); invalid.expectedSampleIds[0] = id; invalid.samples[0]!.id = id;
    assert.throws(() => parseExternalRunReport(invalid), /sample id/);
  }
  const before = report(), after = report('candidate');
  before.samples[0]!.category = after.samples[0]!.category = 'irrelevance';
  assert.throws(() => compareExternalRuns(before, after), /category does not match id/);
});

test('forty total tasks cannot replace the minimum of ten expected tasks per category', () => {
  const oneCategory = (variant: ExternalRunReport['variant']) => {
    const input = report(variant);
    input.expectedSampleIds = input.samples.map((sample, index) => {
      sample.id = `simple_python_${index}`; sample.category = 'simple_python'; return sample.id;
    });
    return input;
  };
  const result = compareExternalRuns(oneCategory('baseline'), oneCategory('candidate'));
  assert.equal(result.eligible, false);
  for (const category of ['multiple', 'parallel', 'irrelevance']) assert.ok(result.reasons.includes(`At least 10 expected ${category} holdout tasks are required.`));
  assert.equal(result.baseline.perCategory[1]!.accuracy, null);

  const uneven = (variant: ExternalRunReport['variant']) => {
    const input = report(variant);
    input.samples[39]!.id = 'simple_python_999'; input.samples[39]!.category = 'simple_python';
    input.expectedSampleIds[39] = 'simple_python_999';
    return input;
  };
  const unevenResult = compareExternalRuns(uneven('baseline'), uneven('candidate'));
  assert.equal(unevenResult.baseline.expectedTasks, 40); assert.equal(unevenResult.eligible, false);
  assert.ok(unevenResult.reasons.includes('At least 10 expected irrelevance holdout tasks are required.'));
  assert.equal(compareExternalRuns(report('baseline', 44), report('candidate', 44)).eligible, true);
});

test('balanced complete reports retain pre-hardening score values and measurement denominators', () => {
  const input = report();
  const summary = summarizeExternalRun(input);
  assert.equal(summary.accuracy, 36 / 40);
  assert.deepEqual(summary.accuracyWilson95, wilsonAccuracyInterval(36, 40));
  assert.deepEqual(summary.completionMs, { samples: 40, p50: 1000, p95: 1000 });
  assert.deepEqual(summary.firstTextMs, { samples: 40, p50: 100, p95: 100 });
  assert.equal(summary.tokensPerSuccess, 4800 / 36);
  assert.equal(summary.reportedTokens.promptTokens.total, 4000);
  assert.equal(summary.reportedTokens.completionTokens.total, 800);
  assert.equal(summary.reportedTokens.cachedPromptTokens.total, 400);
  for (const category of summary.perCategory) {
    const rows = input.samples.filter(row => row.category === category.category);
    const successes = rows.filter(row => row.passed).length;
    assert.equal(category.expectedTasks, rows.length); assert.equal(category.missingTasks, 0);
    assert.equal(category.accuracy, successes / rows.length);
    assert.equal(category.failedTasks, rows.length - successes);
    assert.deepEqual(category.accuracyWilson95, wilsonAccuracyInterval(successes, rows.length));
  }
});

test('development, too few tasks, missing tasks, and incomplete execution cannot promote', () => {
  const before = report(), after = report('candidate'); before.split = after.split = 'dev';
  assert.equal(compareExternalRuns(before, after).eligible, false);
  assert.equal(compareExternalRuns(report('baseline', 39), report('candidate', 39)).eligible, false);
  const missingA = report(), missingB = report('candidate'); missingA.samples.pop(); missingB.samples.pop();
  assert.equal(compareExternalRuns(missingA, missingB).eligible, false, 'matching omissions are still failures');
  const incomplete = report('candidate'); incomplete.samples[0]!.completed = false;
  assert.equal(compareExternalRuns(report(), incomplete).eligible, false);
});

test('category accuracy cannot be traded for a gain in another category', () => {
  const after = report('candidate');
  after.samples[1]!.passed = false; after.samples[1]!.failure = 'wrong_tool';
  after.samples[0]!.passed = true; after.samples[0]!.failure = null;
  const result = compareExternalRuns(report(), after);
  assert.equal(result.baseline.accuracy, result.candidate.accuracy); assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('Observed multiple accuracy declined.'));
});

test('fixed tail latency and usage regression gates apply independently of median gain', () => {
  const tail = report('candidate'); for (const sample of tail.samples.slice(-3)) sample.durationMs = 1351;
  assert.equal(compareExternalRuns(report(), tail).eligible, false);
  tail.samples.slice(-3).forEach(sample => { sample.durationMs = 1350; });
  assert.equal(compareExternalRuns(report(), tail).eligible, true);
  const costly = report('candidate'); costly.samples.forEach(sample => { sample.completionTokens = 33; });
  assert.equal(compareExternalRuns(report(), costly).eligible, false);
  const missingUsage = report('candidate'); missingUsage.samples[0]!.cachedPromptTokens = null;
  assert.equal(compareExternalRuns(report(), missingUsage).eligible, false);
});

test('practical improvement requires a fixed latency, token or accuracy threshold', () => {
  const unchanged = report('candidate'); unchanged.samples.forEach(sample => { sample.durationMs = 950; });
  assert.equal(compareExternalRuns(report(), unchanged).eligible, false);
  const token = structuredClone(unchanged); token.samples.forEach(sample => { sample.promptTokens = 82; });
  assert.equal(compareExternalRuns(report(), token).eligible, true);
  const quality = structuredClone(unchanged); for (const index of [0, 10]) { quality.samples[index]!.passed = true; quality.samples[index]!.failure = null; }
  assert.equal(compareExternalRuns(report(), quality).eligible, true);
  const sameEffort = report('candidate'); sameEffort.effort = 'medium';
  assert.equal(compareExternalRuns(report(), sameEffort).eligible, false);
});
