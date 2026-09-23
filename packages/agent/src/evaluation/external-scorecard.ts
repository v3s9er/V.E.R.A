/** Descriptive custom-subset evidence only; no prompts, answers or executable actions. */
export const EXTERNAL_CATEGORIES = ['simple_python', 'multiple', 'parallel', 'irrelevance'] as const;
export type ExternalCategory = typeof EXTERNAL_CATEGORIES[number];

export interface ExternalSample {
  id: string;
  category: ExternalCategory;
  completed: boolean;
  passed: boolean;
  /** A short machine-readable failure code, never a raw exception or model output. */
  failure: string | null;
  durationMs: number;
  firstTextMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedPromptTokens: number | null;
  callCount: number;
}

export interface ExternalRunReport {
  schemaVersion: 1;
  benchmark: 'BFCL-custom-subset-v1';
  revision: string;
  datasetHashes: Record<string, string>;
  sourceHashes: Record<string, string>;
  partitionHash: string;
  provenanceValid: boolean;
  split: 'dev' | 'holdout';
  seed: string;
  model: string;
  effort: string;
  variant: 'baseline' | 'candidate';
  cliVersion: string;
  experimentId: string;
  expectedSampleIds: string[];
  samples: ExternalSample[];
}

const REPORT_KEYS = ['schemaVersion', 'benchmark', 'revision', 'datasetHashes', 'sourceHashes', 'partitionHash', 'provenanceValid', 'split', 'seed', 'model', 'effort', 'variant', 'cliVersion', 'experimentId', 'expectedSampleIds', 'samples'];
const SAMPLE_KEYS = ['id', 'category', 'completed', 'passed', 'failure', 'durationMs', 'firstTextMs', 'promptTokens', 'completionTokens', 'cachedPromptTokens', 'callCount'];
const MAX_SAMPLES = 1000;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_DURATION_MS = 86_400_000;
const MAX_TOKENS = 1_000_000_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function fail(label: string): never { throw new Error(`Invalid external benchmark ${label}`); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(label);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail(label);
  return value as Record<string, unknown>;
}
function exactKeys(source: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(source).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(source, key))) fail(`${label} fields`);
}
function text(value: unknown, label: string, max: number, pattern = ID_PATTERN): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !pattern.test(value)) return fail(label);
  return value;
}
function number(value: unknown, label: string, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isInteger(value))) return fail(label);
  return value;
}
function nullableNumber(value: unknown, label: string, max: number, integer = false): number | null {
  return value === null ? null : number(value, label, max, integer);
}
function boolean(value: unknown, label: string): boolean { return typeof value === 'boolean' ? value : fail(label); }
function hashes(value: unknown, label: string): Record<string, string> {
  const source = record(value, label);
  const entries = Object.entries(source);
  if (!entries.length || entries.length > 64) return fail(`${label} count`);
  return Object.fromEntries(entries.map(([key, hash]) => {
    text(key, `${label} key`, 240, /^[A-Za-z0-9][A-Za-z0-9_./-]*$/);
    if (key.split('/').includes('..') || key === '__proto__' || key === 'constructor' || key === 'prototype') fail(`${label} key`);
    return [key, text(hash, `${label} digest`, 64, HASH_PATTERN)];
  }));
}

/** Unknown fields are rejected before summaries can accidentally expose model text. */
export function parseExternalRunReport(value: unknown): ExternalRunReport {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_REPORT_BYTES) fail('report size');
    try { value = JSON.parse(value); } catch { fail('JSON'); }
  }
  const source = record(value, 'report');
  exactKeys(source, REPORT_KEYS, 'report');
  if (source.schemaVersion !== 1 || source.benchmark !== 'BFCL-custom-subset-v1') fail('schema or benchmark');
  if (source.split !== 'dev' && source.split !== 'holdout') fail('split');
  if (source.variant !== 'baseline' && source.variant !== 'candidate') fail('variant');
  if (!Array.isArray(source.expectedSampleIds) || source.expectedSampleIds.length < 1 || source.expectedSampleIds.length > MAX_SAMPLES) fail('expected samples');
  const expectedSampleIds = source.expectedSampleIds.map(id => text(id, 'expected sample id', 160));
  const expected = new Set(expectedSampleIds);
  if (expected.size !== expectedSampleIds.length) fail('duplicate expected sample id');
  if (!Array.isArray(source.samples) || source.samples.length > MAX_SAMPLES) fail('samples');
  const seen = new Set<string>();
  const samples = source.samples.map(raw => {
    const item = record(raw, 'sample');
    exactKeys(item, SAMPLE_KEYS, 'sample');
    const id = text(item.id, 'sample id', 160);
    if (seen.has(id) || !expected.has(id)) fail('duplicate or unexpected sample id');
    seen.add(id);
    if (!(EXTERNAL_CATEGORIES as readonly unknown[]).includes(item.category)) fail('sample category');
    const completed = boolean(item.completed, 'sample completed');
    const passed = boolean(item.passed, 'sample passed');
    const failure = item.failure === null ? null : text(item.failure, 'failure code', 80, /^[a-z][a-z0-9_-]*$/);
    if ((passed && (!completed || failure !== null)) || (!passed && failure === null)) fail('sample outcome');
    const durationMs = number(item.durationMs, 'sample duration', MAX_DURATION_MS);
    const firstTextMs = nullableNumber(item.firstTextMs, 'sample first text', MAX_DURATION_MS);
    if (firstTextMs !== null && firstTextMs > durationMs) fail('first text exceeds duration');
    const promptTokens = nullableNumber(item.promptTokens, 'prompt tokens', MAX_TOKENS, true);
    const completionTokens = nullableNumber(item.completionTokens, 'completion tokens', MAX_TOKENS, true);
    const cachedPromptTokens = nullableNumber(item.cachedPromptTokens, 'cached tokens', MAX_TOKENS, true);
    if (cachedPromptTokens !== null && promptTokens !== null && cachedPromptTokens > promptTokens) fail('cached tokens exceed prompt tokens');
    return { id, category: item.category as ExternalCategory, completed, passed, failure, durationMs, firstTextMs, promptTokens, completionTokens, cachedPromptTokens, callCount: number(item.callCount, 'call count', 10_000, true) };
  });
  return {
    schemaVersion: 1, benchmark: 'BFCL-custom-subset-v1', revision: text(source.revision, 'revision', 160),
    datasetHashes: hashes(source.datasetHashes, 'dataset hashes'), sourceHashes: hashes(source.sourceHashes, 'source hashes'),
    partitionHash: text(source.partitionHash, 'partition hash', 64, HASH_PATTERN), provenanceValid: boolean(source.provenanceValid, 'provenance'),
    split: source.split, seed: text(source.seed, 'seed', 80), model: text(source.model, 'model', 160, /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/),
    effort: text(source.effort, 'effort', 24, /^(?:auto|none|minimal|low|medium|high|xhigh|max|ultra)$/),
    variant: source.variant, cliVersion: text(source.cliVersion, 'CLI version', 120, /^[A-Za-z0-9][A-Za-z0-9_.+() /-]*$/),
    experimentId: text(source.experimentId, 'experiment id', 128), expectedSampleIds, samples,
  };
}

export interface ExternalDistribution { samples: number; p50: number | null; p95: number | null }
function distribution(values: readonly number[]): ExternalDistribution {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]! : null;
  return { samples: sorted.length, p50: percentile(.5), p95: percentile(.95) };
}

/** Wilson score interval for descriptive binomial task accuracy, not pair superiority. */
export function wilsonAccuracyInterval(passed: number, total: number): [number, number] | null {
  if (!Number.isInteger(total) || total < 0 || total > MAX_SAMPLES || !Number.isInteger(passed) || passed < 0 || passed > total) fail('accuracy counts');
  if (!total) return null;
  const z = 1.959963984540054, z2 = z * z, rate = passed / total;
  const divisor = 1 + z2 / total;
  const center = (rate + z2 / (2 * total)) / divisor;
  const half = z * Math.sqrt((rate * (1 - rate) + z2 / (4 * total)) / total) / divisor;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function summaryOf(report: ExternalRunReport) {
  const expected = report.expectedSampleIds.length;
  const attempted = report.samples.length;
  const completed = report.samples.filter(sample => sample.completed).length;
  const passed = report.samples.filter(sample => sample.passed).length;
  const reported = (field: 'promptTokens' | 'completionTokens' | 'cachedPromptTokens') => {
    const values = report.samples.flatMap(sample => sample[field] === null ? [] : [sample[field]!]);
    return { samples: values.length, total: values.length ? values.reduce((sum, value) => sum + value, 0) : null };
  };
  const promptTokens = reported('promptTokens'), completionTokens = reported('completionTokens'), cachedPromptTokens = reported('cachedPromptTokens');
  const completeUsageSamples = report.samples.filter(sample => sample.promptTokens !== null && sample.completionTokens !== null && sample.cachedPromptTokens !== null).length;
  return {
    expectedTasks: expected, attemptedTasks: attempted, completedTasks: completed, passedTasks: passed,
    failedTasks: expected - passed, accuracy: passed / expected, accuracyWilson95: wilsonAccuracyInterval(passed, expected)!,
    coverage: { expected, observed: attempted, missing: expected - attempted, fraction: attempted / expected, completedFraction: completed / expected, completeUsageSamples, usageFraction: completeUsageSamples / expected },
    completionMs: distribution(report.samples.map(sample => sample.durationMs)),
    firstTextMs: distribution(report.samples.flatMap(sample => sample.firstTextMs === null ? [] : [sample.firstTextMs])),
    reportedTokens: { promptTokens, completionTokens, cachedPromptTokens },
    tokensPerSuccess: attempted === expected && promptTokens.samples === expected && completionTokens.samples === expected && passed > 0
      ? (promptTokens.total! + completionTokens.total!) / passed : null,
    callCount: report.samples.reduce((sum, sample) => sum + sample.callCount, 0),
    perCategory: EXTERNAL_CATEGORIES.map(category => {
      const rows = report.samples.filter(sample => sample.category === category);
      const successes = rows.filter(sample => sample.passed).length;
      return { category, observedTasks: rows.length, completedTasks: rows.filter(sample => sample.completed).length, passedTasks: successes,
        failedTasks: rows.length - successes, accuracy: rows.length ? successes / rows.length : null,
        accuracyWilson95: wilsonAccuracyInterval(successes, rows.length), completionMs: distribution(rows.map(sample => sample.durationMs)) };
    }),
    missingTaskCategoriesUnknown: expected - attempted,
  };
}

export function summarizeExternalRun(value: ExternalRunReport) {
  const report = parseExternalRunReport(value);
  return { benchmark: report.benchmark, split: report.split, model: report.model, effort: report.effort, variant: report.variant,
    provenanceValid: report.provenanceValid, officialLeaderboardScore: false as const, ...summaryOf(report),
    interpretation: 'Custom BFCL subset and custom grader. Missing tasks count as failures overall; categories of missing tasks are unassigned. Wilson intervals describe task accuracy, not improvement significance or a general agent ranking.' };
}
export type ExternalRunSummary = ReturnType<typeof summarizeExternalRun>;

export const EXTERNAL_GATE_PRESET = Object.freeze({
  id: 'bfcl-custom-holdout-review-v1', minHoldoutTasks: 40, requireAllCompleted: true,
  allowObservedCategoryAccuracyDrop: false, maxCompletionP95Ratio: 1.25, completionP95SlackMs: 100,
  requireCompleteUsage: true, maxTokensPerSuccessRatio: 1.10,
  minMedianLatencyImprovement: .10, minTokensPerSuccessImprovement: .15, minAccuracyImprovement: .05,
});
const sorted = (values: readonly string[]) => [...values].sort();
const sameIds = (left: readonly string[], right: readonly string[]) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const canonicalHashes = (value: Record<string, string>) => JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));

/** Fixed review gate. Never mutates settings or authorizes automatic activation. */
export function compareExternalRuns(baselineValue: ExternalRunReport, candidateValue: ExternalRunReport) {
  const baseline = parseExternalRunReport(baselineValue), candidate = parseExternalRunReport(candidateValue);
  const before = summarizeExternalRun(baseline), after = summarizeExternalRun(candidate);
  const reasons: string[] = [];
  const mismatches: string[] = [];
  if (baseline.variant !== 'baseline' || candidate.variant !== 'candidate') mismatches.push('variant order');
  for (const field of ['benchmark', 'revision', 'partitionHash', 'split', 'seed', 'model', 'cliVersion', 'experimentId'] as const) if (baseline[field] !== candidate[field]) mismatches.push(field);
  if (canonicalHashes(baseline.datasetHashes) !== canonicalHashes(candidate.datasetHashes)) mismatches.push('dataset hashes');
  if (canonicalHashes(baseline.sourceHashes) !== canonicalHashes(candidate.sourceHashes)) mismatches.push('source hashes');
  if (!baseline.provenanceValid || !candidate.provenanceValid) mismatches.push('invalid source provenance');
  if (!sameIds(baseline.expectedSampleIds, candidate.expectedSampleIds)) mismatches.push('expected sample identities');
  if (!sameIds(baseline.samples.map(row => row.id), candidate.samples.map(row => row.id))) mismatches.push('observed sample identities');
  const candidateCategories = new Map(candidate.samples.map(row => [row.id, row.category]));
  if (baseline.samples.some(row => candidateCategories.has(row.id) && candidateCategories.get(row.id) !== row.category)) mismatches.push('sample category identities');
  if (baseline.effort === candidate.effort) reasons.push('No distinct effort treatment was tested.');
  if (mismatches.length) reasons.push('Comparison provenance or workload does not match.');
  if (baseline.split !== 'holdout' || candidate.split !== 'holdout') reasons.push('Development results are diagnostic only; use an untouched holdout.');
  if (before.expectedTasks < EXTERNAL_GATE_PRESET.minHoldoutTasks || after.expectedTasks < EXTERNAL_GATE_PRESET.minHoldoutTasks) reasons.push('At least 40 holdout tasks are required.');
  if (before.completedTasks !== before.expectedTasks || after.completedTasks !== after.expectedTasks) reasons.push('Every expected task must be observed and completed.');
  if (after.accuracy < before.accuracy) reasons.push('Observed overall accuracy declined.');
  for (const category of EXTERNAL_CATEGORIES) {
    const left = before.perCategory.find(row => row.category === category)!, right = after.perCategory.find(row => row.category === category)!;
    if (left.accuracy !== null && (right.accuracy === null || right.accuracy < left.accuracy)) reasons.push(`Observed ${category} accuracy declined.`);
  }
  if (before.completionMs.p95 === null || after.completionMs.p95 === null) reasons.push('Completion latency was not measured.');
  else if (after.completionMs.p95 > before.completionMs.p95 * EXTERNAL_GATE_PRESET.maxCompletionP95Ratio + EXTERNAL_GATE_PRESET.completionP95SlackMs) reasons.push('Completion P95 exceeded the fixed regression allowance.');
  if (before.coverage.completeUsageSamples !== before.expectedTasks || after.coverage.completeUsageSamples !== after.expectedTasks) reasons.push('Complete usage reports are required for every task.');
  if (before.tokensPerSuccess === null || after.tokensPerSuccess === null) reasons.push('Tokens per successful task cannot be determined.');
  else if (after.tokensPerSuccess > before.tokensPerSuccess * EXTERNAL_GATE_PRESET.maxTokensPerSuccessRatio) reasons.push('Tokens per success increased by more than 10 percent.');
  const latencyImprovement = before.completionMs.p50 !== null && before.completionMs.p50 > 0 && after.completionMs.p50 !== null ? 1 - after.completionMs.p50 / before.completionMs.p50 : null;
  const tokenImprovement = before.tokensPerSuccess !== null && before.tokensPerSuccess > 0 && after.tokensPerSuccess !== null ? 1 - after.tokensPerSuccess / before.tokensPerSuccess : null;
  const accuracyImprovement = after.accuracy - before.accuracy;
  const meaningful = (latencyImprovement !== null && latencyImprovement >= EXTERNAL_GATE_PRESET.minMedianLatencyImprovement - 1e-12)
    || (tokenImprovement !== null && tokenImprovement >= EXTERNAL_GATE_PRESET.minTokensPerSuccessImprovement - 1e-12)
    || accuracyImprovement >= EXTERNAL_GATE_PRESET.minAccuracyImprovement - 1e-12;
  if (!meaningful) reasons.push('No fixed-threshold practical improvement was observed.');
  return {
    eligible: reasons.length === 0, recommendationOnly: true as const, automaticActivation: false as const,
    officialLeaderboardScore: false as const, statisticalSuperiorityClaimed: false as const, generalAgentRankingClaimed: false as const,
    gatePreset: { ...EXTERNAL_GATE_PRESET }, mismatches, reasons, baseline: before, candidate: after,
    changes: { medianCompletionReduction: latencyImprovement, tokensPerSuccessReduction: tokenImprovement, accuracyPercentagePointGain: accuracyImprovement * 100 },
    interpretation: 'Eligibility recommends human review of this custom holdout subset only. It does not establish statistically significant improvement, official BFCL standing or general agent superiority, and never activates a profile.',
  };
}
export type ExternalComparison = ReturnType<typeof compareExternalRuns>;
