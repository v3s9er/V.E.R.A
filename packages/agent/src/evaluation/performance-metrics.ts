export type ExactOutputCheck = 'exact_normalized_match' | 'expected_value_present_with_extra_text' | 'expected_value_missing';

/** Lexical diagnostics only: presence can occur in a denial or incorrect answer. Never a semantic grader. */
export function classifyExactOutput(text: string, expected: string): ExactOutputCheck {
  if (!expected.length) throw new Error('Expected output must not be empty');
  const normalized = text.trim().replace(/^```(?:\w+)?\s*|\s*```$/g, '').trim();
  if (normalized === expected) return 'exact_normalized_match';
  return normalized.includes(expected) ? 'expected_value_present_with_extra_text' : 'expected_value_missing';
}

/** Evaluation data deliberately excludes prompts, answers, paths, account IDs and secrets. */
export interface PerformanceSample {
  caseId: string;
  repetition: number;
  completionMs: number;
  /** First visible nonempty answer text, not status/reasoning. Null means not measured. */
  firstTextMs: number | null;
  completed: boolean;
  qualityPassed: boolean;
  /** Optional future-only lexical metadata. Missing in older reports; never retroactively inferred. */
  outputCheck?: ExactOutputCheck;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedPromptTokens: number | null;
  outputBytes: number;
  errorCode?: 'deadline' | 'transport' | 'invariant' | 'cancelled';
}

export interface PerformanceReport {
  schemaVersion: 1;
  suite: string;
  createdAt: string;
  mode: 'local' | 'synthetic-transport' | 'live-model';
  configuration: Record<string, string | number | boolean>;
  environment: { node: string; platform: string; arch: string; cpuCount: number; cliVersion?: string };
  sourceHashes: Record<string, string>;
  /** A single interleaved experiment; different runs cannot claim paired statistics. */
  pairingId?: string;
  treatment?: string;
  samples: PerformanceSample[];
}

export interface Distribution {
  count: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentiles; do not silently coerce absent/invalid metrics to zero. */
export function distribution(values: readonly (number | null)[]): Distribution | null {
  const sorted = values.filter((n): n is number => n !== null).sort((a, b) => a - b);
  if (sorted.some(n => !Number.isFinite(n) || n < 0)) throw new Error('Invalid nonnegative measurement');
  if (!sorted.length) return null;
  return { count: sorted.length, min: sorted[0]!, p50: sorted[Math.ceil(sorted.length * .5) - 1]!,
    p95: sorted[Math.ceil(sorted.length * .95) - 1]!, max: sorted.at(-1)!,
    mean: sorted.reduce((sum, n) => sum + n, 0) / sorted.length };
}

export function summarizePerformance(report: PerformanceReport) {
  return [...new Set(report.samples.map(s => s.caseId))].sort().map(caseId => {
    const samples = report.samples.filter(s => s.caseId === caseId);
    const completed = samples.filter(s => s.completed).length;
    const passed = samples.filter(s => s.completed && s.qualityPassed).length;
    const tokens = samples.filter(s => s.promptTokens !== null && s.completionTokens !== null);
    const outputChecks = {
      exact_normalized_match: samples.filter(s => s.outputCheck === 'exact_normalized_match').length,
      expected_value_present_with_extra_text: samples.filter(s => s.outputCheck === 'expected_value_present_with_extra_text').length,
      expected_value_missing: samples.filter(s => s.outputCheck === 'expected_value_missing').length,
      unreported: samples.filter(s => s.outputCheck === undefined).length,
    };
    return { caseId, count: samples.length, completed, passed, outputChecks,
      completionRate: completed / samples.length, qualityRate: passed / samples.length,
      completionMs: distribution(samples.map(s => s.completionMs)),
      firstTextMs: distribution(samples.map(s => s.firstTextMs)),
      promptTokens: distribution(samples.map(s => s.promptTokens)),
      completionTokens: distribution(samples.map(s => s.completionTokens)),
      cachedPromptTokens: distribution(samples.map(s => s.cachedPromptTokens)),
      outputBytes: distribution(samples.map(s => s.outputBytes)),
      tokensPerSuccess: tokens.length === samples.length && passed > 0
        ? tokens.reduce((n, s) => n + s.promptTokens! + s.completionTokens!, 0) / passed : null };
  });
}

/** Fixed-seed independent bootstrap: descriptive CI, never a proof of external validity. */
export function meanDifferenceInterval(baseline: number[], candidate: number[], draws = 1000, paired = false): [number, number] {
  if (!baseline.length || !candidate.length || !Number.isSafeInteger(draws) || draws < 100 || draws > 10_000) throw new Error('Invalid bootstrap inputs');
  if (paired && baseline.length !== candidate.length) throw new Error('Paired measurements must match');
  distribution(baseline); distribution(candidate);
  let state = 0x72a49c15;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; };
  const deltas: number[] = [];
  for (let i = 0; i < draws; i++) {
    let a = 0, b = 0;
    if (paired) {
      for (let j = 0; j < baseline.length; j++) { const index = Math.floor(random() * baseline.length); a += baseline[index]!; b += candidate[index]!; }
    } else {
      for (let j = 0; j < baseline.length; j++) a += baseline[Math.floor(random() * baseline.length)]!;
      for (let j = 0; j < candidate.length; j++) b += candidate[Math.floor(random() * candidate.length)]!;
    }
    deltas.push(b / candidate.length - a / baseline.length);
  }
  deltas.sort((a, b) => a - b);
  return [deltas[Math.floor(draws * .025)]!, deltas[Math.ceil(draws * .975) - 1]!];
}

function canonical(value: Record<string, unknown>) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

/** Mismatched workloads/model/effort/runtime and small samples cannot win a promotion. */
export function comparePerformance(baseline: PerformanceReport, candidate: PerformanceReport, minimumSamples = 20) {
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 20) throw new Error('At least 20 samples per case are required for comparison');
  const mismatches: string[] = [];
  if (baseline.suite !== candidate.suite || baseline.mode !== candidate.mode) mismatches.push('suite/mode');
  if (canonical(baseline.configuration) !== canonical(candidate.configuration)) mismatches.push('configuration');
  if (canonical(baseline.environment) !== canonical(candidate.environment)) mismatches.push('environment');
  if (baseline.configuration.sourceUnchangedDuringRun === false || candidate.configuration.sourceUnchangedDuringRun === false) mismatches.push('source changed during experiment');
  const harnessHashes = (report: PerformanceReport) => Object.fromEntries(Object.entries(report.sourceHashes)
    .filter(([path]) => path.startsWith('scripts/performance-') || path.includes('/test/fixtures/')));
  if (canonical(harnessHashes(baseline)) !== canonical(harnessHashes(candidate))) mismatches.push('harness/fixture');
  const productionHashes = (report: PerformanceReport) => Object.fromEntries(Object.entries(report.sourceHashes)
    .filter(([path]) => !path.startsWith('scripts/performance-') && !path.includes('/test/fixtures/')));
  const implementationChanged = canonical(productionHashes(baseline)) !== canonical(productionHashes(candidate))
    || baseline.treatment !== candidate.treatment;
  const left = summarizePerformance(baseline), right = summarizePerformance(candidate);
  if (left.map(s => s.caseId).join('|') !== right.map(s => s.caseId).join('|')) mismatches.push('case-set');
  const cases = right.map(next => {
    const prior = left.find(s => s.caseId === next.caseId);
    if (!prior) return { caseId: next.caseId, status: 'incomparable' as const, reasons: ['missing baseline case'] };
    const reasons: string[] = [];
    const enough = prior.count >= minimumSamples && next.count >= minimumSamples;
    if (!enough) reasons.push(`fewer than ${minimumSamples} samples`);
    if (next.completionRate < prior.completionRate || next.qualityRate < prior.qualityRate) reasons.push('completion/quality regression');
    // A successful baseline must stay successful. No silent trade of quality for speed.
    if (next.completed !== next.count || next.passed !== next.count) reasons.push('candidate not fully successful');
    const a = prior.completionMs!, b = next.completionMs!;
    const beforeSamples = baseline.samples.filter(s => s.caseId === next.caseId).sort((a, b) => a.repetition - b.repetition);
    const afterSamples = candidate.samples.filter(s => s.caseId === next.caseId).sort((a, b) => a.repetition - b.repetition);
    const paired = Boolean(baseline.pairingId && baseline.pairingId === candidate.pairingId
      && beforeSamples.length === afterSamples.length && beforeSamples.every((s, index) => s.repetition === afterSamples[index]!.repetition));
    const interval = meanDifferenceInterval(beforeSamples.map(s => s.completionMs), afterSamples.map(s => s.completionMs), 1000, paired);
    const floor = candidate.mode === 'live-model' ? 100 : .25;
    if (b.p95 > a.p95 * 1.2 && b.p95 - a.p95 > floor && interval[0] > 0) reasons.push('p95 latency regression');
    if (prior.firstTextMs && next.firstTextMs && next.firstTextMs.p95 > prior.firstTextMs.p95 * 1.2
      && next.firstTextMs.p95 - prior.firstTextMs.p95 > floor) reasons.push('first-text p95 regression');
    if ((next.firstTextMs?.count ?? 0) < (prior.firstTextMs?.count ?? 0)) reasons.push('first-text measurement unavailable');
    if (candidate.mode === 'live-model') {
      if (prior.tokensPerSuccess === null || next.tokensPerSuccess === null) reasons.push('usage measurement unavailable');
      else if (next.tokensPerSuccess > prior.tokensPerSuccess * 1.1) reasons.push('tokens per success regression');
    }
    const regression = reasons.some(r => r.includes('regression') || r.includes('not fully'));
    const improved = enough && !reasons.length && interval[1] < 0 && b.mean < a.mean * .95 && a.mean - b.mean > floor;
    return { caseId: next.caseId, status: mismatches.length ? 'incomparable' as const : regression ? 'regressed' as const
      : !enough || reasons.length ? 'inconclusive' as const : improved ? 'improved' as const : 'no-clear-change' as const,
      reasons, paired, meanDifference95CI: interval, p50ChangePercent: a.p50 > 0 ? (b.p50 / a.p50 - 1) * 100 : null,
      p95ChangePercent: a.p95 > 0 ? (b.p95 / a.p95 - 1) * 100 : null };
  });
  return { comparable: !mismatches.length, mismatches, minimumSamples, implementationChanged, cases,
    promotionEligible: implementationChanged && !mismatches.length && cases.length > 0 && cases.some(c => c.status === 'improved')
      && cases.every(c => c.status === 'improved' || c.status === 'no-clear-change'),
    note: 'Local/synthetic timing is not model speed. Independent samples do not control service load; confirm improvements in alternating repeated runs and separate holdout tasks.' };
}

/** Reports are local inputs but still untrusted: bound resources and validate all measurements. */
export function parsePerformanceReport(raw: string): PerformanceReport {
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('Performance report is too large');
  const r = JSON.parse(raw) as PerformanceReport;
  if (!r || r.schemaVersion !== 1 || typeof r.suite !== 'string' || r.suite.length > 120
    || !['local', 'synthetic-transport', 'live-model'].includes(r.mode)
    || !Array.isArray(r.samples) || !r.samples.length || r.samples.length > 20_000
    || !r.configuration || typeof r.configuration !== 'object' || Array.isArray(r.configuration)
    || Object.keys(r.configuration).length > 50 || !r.environment || typeof r.environment !== 'object'
    || !r.sourceHashes || typeof r.sourceHashes !== 'object' || Array.isArray(r.sourceHashes)
    || Object.keys(r.sourceHashes).length > 100 || Object.values(r.sourceHashes).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    || ['node', 'platform', 'arch'].some(k => typeof r.environment[k as 'node'] !== 'string')
    || !Number.isSafeInteger(r.environment.cpuCount) || r.environment.cpuCount < 1) throw new Error('Invalid performance report');
  for (const [key, value] of Object.entries(r.configuration)) {
    if (key.length > 100 || !['string', 'number', 'boolean'].includes(typeof value)
      || (typeof value === 'string' && value.length > 500) || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Invalid report configuration');
  }
  if (r.pairingId !== undefined && (typeof r.pairingId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(r.pairingId))) throw new Error('Invalid experiment identity');
  if (r.treatment !== undefined && (typeof r.treatment !== 'string' || r.treatment.length > 100)) throw new Error('Invalid treatment');
  const identities = new Set<string>();
  const caseIds = new Set<string>();
  for (const s of r.samples) {
    if (!s || typeof s.caseId !== 'string' || !/^[a-zA-Z0-9_.-]{1,120}$/.test(s.caseId)
      || !Number.isSafeInteger(s.repetition) || s.repetition < 0
      || typeof s.completed !== 'boolean' || typeof s.qualityPassed !== 'boolean'
      || (!s.completed && s.qualityPassed) || !Number.isSafeInteger(s.outputBytes) || s.outputBytes < 0
      || typeof s.completionMs !== 'number' || !Number.isFinite(s.completionMs) || s.completionMs < 0
      || (s.firstTextMs !== null && (typeof s.firstTextMs !== 'number' || s.firstTextMs < 0 || !Number.isFinite(s.firstTextMs) || s.firstTextMs > s.completionMs))) throw new Error('Invalid performance sample');
    for (const key of ['promptTokens', 'completionTokens', 'cachedPromptTokens'] as const) {
      if (s[key] !== null && (!Number.isSafeInteger(s[key]) || s[key]! < 0)) throw new Error('Invalid token measurement');
    }
    if (s.outputCheck !== undefined && !['exact_normalized_match', 'expected_value_present_with_extra_text', 'expected_value_missing'].includes(s.outputCheck)) throw new Error('Invalid output diagnostic');
    const id = `${s.caseId}:${s.repetition}`;
    if (identities.has(id)) throw new Error('Duplicate performance sample');
    identities.add(id);
    caseIds.add(s.caseId);
    if (caseIds.size > 128) throw new Error('Too many performance cases');
  }
  return r;
}
