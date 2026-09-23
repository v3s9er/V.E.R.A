import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EXTERNAL_CATEGORIES, type ExternalRunReport } from '../../packages/agent/src/evaluation/external-scorecard.js';
import { readBenchmarkReport, renderBenchmarkReport, writeBenchmarkReport } from '../benchmark-report.js';

function report(variant: ExternalRunReport['variant']): ExternalRunReport {
  const ids = Array.from({ length: 40 }, (_, i) => `${EXTERNAL_CATEGORIES[i % 4]}_${i}`);
  return { schemaVersion: 1, benchmark: 'BFCL-custom-subset-v1', revision: 'a'.repeat(40), datasetHashes: { 'questions.jsonl': 'b'.repeat(64) }, sourceHashes: { 'src/worker.ts': 'c'.repeat(64) }, partitionHash: 'd'.repeat(64), provenanceValid: true, split: 'dev', seed: 'fixture', model: 'fixture-model', effort: variant === 'baseline' ? 'medium' : 'low', variant, cliVersion: 'codex-cli 1.0', experimentId: 'fixture-pair', expectedSampleIds: ids,
    samples: ids.map((id, i) => ({ id, category: EXTERNAL_CATEGORIES[i % 4]!, completed: true, passed: i !== 0, failure: i === 0 ? 'arguments_mismatch' : null, durationMs: variant === 'baseline' ? 1000 : 800, firstTextMs: 500, promptTokens: 100, completionTokens: 10, cachedPromptTokens: 0, callCount: i % 4 === 3 ? 0 : 1 })) };
}
function fixture(run: (dir: string, baseline: string, candidate: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'mrrobot-report-test-'));
  try {
    const baseline = join(dir, 'baseline.json'), candidate = join(dir, 'candidate.json');
    writeFileSync(baseline, JSON.stringify(report('baseline'))); writeFileSync(candidate, JSON.stringify(report('candidate')));
    run(dir, baseline, candidate);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('renderer reports custom scores, all categories, uncertainty, cold timing and non-promotion', () => {
  const output = renderBenchmarkReport(report('baseline'), report('candidate'));
  for (const value of ['공식 BFCL 리더보드 점수가 아니다', '39/40', '97.5%', 'Wilson 95%', 'cold 완료', '자동 활성화: 없음', 'arguments_mismatch', 'Development results are diagnostic only', 'questions.jsonl', 'src/worker.ts']) assert.ok(output.includes(value), value);
  for (const category of EXTERNAL_CATEGORIES) assert.ok(output.includes(`| ${category} |`));
  assert.equal(output.includes('fixture-pair') && output.includes('기준 데이터·소스 해시'), true);
});
test('missing tasks and unknown usage are shown without converting them to success or zero', () => {
  const candidate = report('candidate'); candidate.samples.pop(); candidate.samples[0]!.promptTokens = null;
  const output = renderBenchmarkReport(report('baseline'), candidate);
  assert.ok(output.includes('38/40')); assert.ok(output.includes('미시도 문항 (실패로 집계) | 1'));
  assert.ok(output.includes('| 정답 1개당 토큰 | 112.82 | 미측정 |'));
  assert.ok(output.includes('| irrelevance | 10/10 (10) | 9/10 (9) | 100.0% | 90.0% |'));
  assert.ok(output.includes('범주별 분모는 예정 문항 수다'));
  assert.ok(output.includes('실행 불완전: 아래 집계는 모델의 능력 점수가 아니다'));
});
test('strict parser prevents exporting injected raw responses or unknown fields', () => {
  const candidate = report('candidate'); (candidate.samples[0] as any).answer = 'SECRET_RESPONSE_DO_NOT_EXPORT';
  assert.throws(() => renderBenchmarkReport(report('baseline'), candidate), /fields/);
  assert.throws(() => renderBenchmarkReport({ ...report('baseline'), rawOutput: 'secret' } as any, report('candidate')), /fields/);
});
test('bounded local reader rejects directories, oversized files and malformed evidence', () => fixture((dir, baseline) => {
  assert.equal(readBenchmarkReport(baseline).samples.length, 40);
  assert.throws(() => readBenchmarkReport(dir));
  const oversized = join(dir, 'huge.json'); writeFileSync(oversized, Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.throws(() => readBenchmarkReport(oversized));
  const malformed = join(dir, 'bad.json'); writeFileSync(malformed, '{bad');
  assert.throws(() => readBenchmarkReport(malformed));
}));
test('reader refuses symbolic links when OS permits creating one', t => fixture((dir, baseline) => {
  const linked = join(dir, 'linked.json');
  try { symlinkSync(baseline, linked, 'file'); } catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('OS cannot create test file symlink'); return; }
    throw error;
  }
  assert.throws(() => readBenchmarkReport(linked));
}));
test('writer is write-once and preserves existing evidence and inputs', () => fixture((dir, baseline, candidate) => {
  const output = join(dir, 'report.md'), original = readFileSync(baseline, 'utf8');
  writeBenchmarkReport(baseline, candidate, output);
  const first = readFileSync(output, 'utf8'); assert.ok(first.startsWith('# BFCL'));
  assert.throws(() => writeBenchmarkReport(baseline, candidate, output));
  assert.throws(() => writeBenchmarkReport(baseline, candidate, baseline));
  assert.equal(readFileSync(output, 'utf8'), first); assert.equal(readFileSync(baseline, 'utf8'), original);
}));
test('CLI renders without inference and hides input paths/raw failure contents on error', () => fixture((dir, baseline, candidate) => {
  const script = fileURLToPath(new URL('../benchmark-report.ts', import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 16_384 });
  const success = run(['--baseline', baseline, '--candidate', candidate, '--out', join(dir, 'cli.md')]);
  assert.equal(success.status, 0, success.stderr); assert.ok(success.stdout.includes('모델 호출·설정 변경·업로드는 하지 않았습니다'));
  const badPath = join(dir, 'SECRET_PRIVATE_PATH.json');
  const failure = run(['--baseline', badPath, '--candidate', candidate, '--out', join(dir, 'bad.md')]);
  assert.equal(failure.status, 1); assert.equal(failure.stderr.includes('SECRET_PRIVATE_PATH'), false);
  const duplicate = run(['--baseline', baseline, '--baseline', candidate, '--out', join(dir, 'duplicate.md')]);
  assert.equal(duplicate.status, 1);
}));
