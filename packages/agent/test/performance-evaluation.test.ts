import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyExactOutput, comparePerformance, distribution, meanDifferenceInterval, parsePerformanceReport, summarizePerformance,
  type PerformanceReport } from '../src/evaluation/performance-metrics.js';

function fixture(count = 20, duration = 100, mode: PerformanceReport['mode'] = 'local'): PerformanceReport {
  return { schemaVersion: 1, suite: 'fixture-v1', createdAt: '2026-01-01T00:00:00.000Z', mode,
    configuration: { model: 'synthetic', effort: 'medium' }, environment: { node: 'test', platform: 'test', arch: 'test', cpuCount: 1 },
    sourceHashes: { 'scripts/performance-fixture.ts': 'a'.repeat(64), 'src/production.ts': (duration < 100 ? 'c' : 'b').repeat(64) },
    samples: Array.from({ length: count }, (_, repetition) => ({ caseId: 'test.case', repetition, completionMs: duration,
      firstTextMs: duration / 2, completed: true, qualityPassed: true, promptTokens: 10, completionTokens: 2, cachedPromptTokens: 0, outputBytes: 8 })) };
}
test('lexical output diagnostics preserve strict grading without claiming semantic correctness', () => {
  assert.equal(classifyExactOutput('  amber-742  ', 'amber-742'), 'exact_normalized_match');
  assert.equal(classifyExactOutput('```text\namber-742\n```', 'amber-742'), 'exact_normalized_match');
  assert.equal(classifyExactOutput('The marker is amber-742.', 'amber-742'), 'expected_value_present_with_extra_text');
  assert.equal(classifyExactOutput('The marker is NOT amber-742.', 'amber-742'), 'expected_value_present_with_extra_text');
  assert.equal(classifyExactOutput('amber-743', 'amber-742'), 'expected_value_missing');
  assert.equal(classifyExactOutput('', 'amber-742'), 'expected_value_missing');
  assert.throws(() => classifyExactOutput('anything', ''), /empty/);
  const candidate = fixture(20, 50);
  candidate.samples[0]!.outputCheck = 'expected_value_present_with_extra_text';
  candidate.samples[0]!.qualityPassed = false;
  assert.equal(comparePerformance(fixture(), candidate).promotionEligible, false);
  assert.deepEqual(summarizePerformance(candidate)[0]!.outputChecks, {
    exact_normalized_match: 0, expected_value_present_with_extra_text: 1, expected_value_missing: 0, unreported: 19,
  });
  assert.deepEqual(parsePerformanceReport(JSON.stringify(candidate)), candidate);
  const invalid = JSON.stringify(candidate).replace('expected_value_present_with_extra_text', 'synthetic answer text');
  assert.throws(() => parsePerformanceReport(invalid), /output diagnostic/);
});
test('nearest-rank percentiles preserve missing metrics and reject invalid values', () => {
  assert.deepEqual(distribution([null, 1, 2, 3, 4, 5]), { count: 5, min: 1, p50: 3, p95: 5, max: 5, mean: 3 });
  assert.equal(distribution([null, null]), null);
  for (const n of [NaN, Infinity, -1]) assert.throws(() => distribution([n]), /Invalid/);
});
test('summary does not turn absent provider usage into free tokens', () => {
  const r = fixture(); r.samples[0]!.promptTokens = null;
  const summary = summarizePerformance(r)[0]!;
  assert.equal(summary.tokensPerSuccess, null); assert.equal(summary.promptTokens?.count, 19);
});
test('bootstrap is reproducible and identifies an unambiguous known difference', () => {
  const a = meanDifferenceInterval([10, 10, 10], [5, 5, 5]);
  assert.deepEqual(a, [-5, -5]);
  assert.deepEqual(meanDifferenceInterval([3, 5, 7], [2, 4, 6]), meanDifferenceInterval([3, 5, 7], [2, 4, 6]));
  assert.throws(() => meanDifferenceInterval([], [1]));
  assert.ok(meanDifferenceInterval([100, 200, 900], [90, 190, 890], 1000, true).every(n => Math.abs(n + 10) < 1e-10));
  assert.throws(() => meanDifferenceInterval([1], [1, 2], 1000, true), /match/);
});
test('paired statistics require the same experiment and repetition identities', () => {
  const before = fixture(), after = fixture(20, 50);
  before.pairingId = after.pairingId = 'same-synthetic-experiment';
  assert.equal(comparePerformance(before, after).cases[0]!.paired, true);
  after.pairingId = 'different-experiment';
  assert.equal(comparePerformance(before, after).cases[0]!.paired, false);
});
test('large consistent speed improvements with unchanged quality can pass a local gate', () => {
  const result = comparePerformance(fixture(), fixture(20, 50));
  assert.equal(result.promotionEligible, true); assert.equal(result.cases[0]!.status, 'improved');
});
test('A/A timing drift cannot promote unchanged production code or prompt', () => {
  const before = fixture(), after = fixture(20, 50); after.sourceHashes = { ...before.sourceHashes };
  const comparison = comparePerformance(before, after);
  assert.equal(comparison.implementationChanged, false); assert.equal(comparison.promotionEligible, false);
  after.treatment = 'explicit concise treatment';
  assert.equal(comparePerformance(before, after).promotionEligible, true);
});
test('a source change during measurement remains blocked in offline comparisons', () => {
  const before = fixture(), after = fixture(20, 50);
  before.configuration.sourceUnchangedDuringRun = after.configuration.sourceUnchangedDuringRun = false;
  const result = comparePerformance(before, after);
  assert.equal(result.promotionEligible, false); assert.ok(result.mismatches.includes('source changed during experiment'));
});
test('sample count and practical noise floor block unsupported promotion', () => {
  assert.equal(comparePerformance(fixture(2), fixture(2, 50)).cases[0]!.status, 'inconclusive');
  assert.equal(comparePerformance(fixture(20, .1), fixture(20, .05)).promotionEligible, false);
  assert.throws(() => comparePerformance(fixture(), fixture(), 1), /20/);
});
test('quality and completion losses cannot be traded for latency', () => {
  for (const kind of ['quality', 'completion']) {
    const candidate = fixture(20, 50); candidate.samples[0]!.qualityPassed = false;
    if (kind === 'completion') candidate.samples[0]!.completed = false;
    const result = comparePerformance(fixture(), candidate);
    assert.equal(result.promotionEligible, false); assert.equal(result.cases[0]!.status, 'regressed');
  }
});
test('regression gate checks p95, TTFT and actual tokens rather than fastest sample', () => {
  const slow = fixture(20, 150); assert.equal(comparePerformance(fixture(), slow).cases[0]!.status, 'regressed');
  const late = fixture(20, 50); late.samples.forEach(s => { s.firstTextMs = 49; });
  const early = fixture(); early.samples.forEach(s => { s.firstTextMs = 10; });
  assert.equal(comparePerformance(early, late).cases[0]!.status, 'regressed');
  const expensive = fixture(20, 500, 'live-model'); expensive.samples.forEach(s => { s.promptTokens = 100; });
  assert.equal(comparePerformance(fixture(20, 1000, 'live-model'), expensive).cases[0]!.status, 'regressed');
});
test('missing live usage or lost TTFT remains inconclusive', () => {
  const before = fixture(20, 1000, 'live-model'), after = fixture(20, 500, 'live-model');
  after.samples.forEach(s => { s.promptTokens = null; });
  assert.equal(comparePerformance(before, after).cases[0]!.status, 'inconclusive');
  const local = fixture(20, 50); local.samples.forEach(s => { s.firstTextMs = null; });
  assert.equal(comparePerformance(fixture(), local).cases[0]!.status, 'inconclusive');
});
test('different model effort workload environment or harness cannot masquerade as optimization', () => {
  for (const change of ['model', 'effort', 'suite', 'environment', 'harness', 'case']) {
    const after = fixture(20, 50);
    if (change === 'model' || change === 'effort') after.configuration[change] = 'different';
    else if (change === 'suite') after.suite = 'different';
    else if (change === 'environment') after.environment.node = 'different';
    else if (change === 'harness') after.sourceHashes['scripts/performance-fixture.ts'] = 'c'.repeat(64);
    else after.samples.forEach(s => { s.caseId = 'different'; });
    assert.equal(comparePerformance(fixture(), after).promotionEligible, false, change);
  }
  const sourceChange = fixture(20, 50); sourceChange.sourceHashes['src/production.ts'] = 'c'.repeat(64);
  assert.equal(comparePerformance(fixture(), sourceChange).promotionEligible, true);
});
test('report validation rejects malformed or duplicated measurements', () => {
  const good = fixture(); assert.deepEqual(parsePerformanceReport(JSON.stringify(good)), good);
  const duplicate = fixture(); duplicate.samples.push(duplicate.samples[0]!);
  assert.throws(() => parsePerformanceReport(JSON.stringify(duplicate)), /Duplicate/);
  const lateText = fixture(); lateText.samples[0]!.firstTextMs = 101;
  assert.throws(() => parsePerformanceReport(JSON.stringify(lateText)), /Invalid/);
  const tokens = fixture(); tokens.samples[0]!.promptTokens = -1;
  assert.throws(() => parsePerformanceReport(JSON.stringify(tokens)), /Invalid/);
  const many = fixture(129); many.samples.forEach((sample, i) => { sample.caseId = `case.${i}`; });
  assert.throws(() => parsePerformanceReport(JSON.stringify(many)), /Too many/);
  assert.throws(() => parsePerformanceReport('x'.repeat(8 * 1024 * 1024 + 1)), /large/);
});
