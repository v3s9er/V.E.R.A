/** Local evidence renderer only: no model requests, activation or uploads. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareExternalRuns, parseExternalRunReport, type ExternalRunReport } from '../packages/agent/src/evaluation/external-scorecard.js';

const MAX_BYTES = 2 * 1024 * 1024;
const invalid = (): never => { throw new Error('Invalid local benchmark evidence'); };

/** Read a bounded ordinary file; do not follow a leaf symlink or stream devices. */
export function readBenchmarkReport(path: string): ExternalRunReport {
  const target = resolve(path), initial = lstatSync(target);
  if (initial.isSymbolicLink() || !initial.isFile() || initial.size > MAX_BYTES) invalid();
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_BYTES || before.dev !== initial.dev || before.ino !== initial.ino) invalid();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length > MAX_BYTES || length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    return parseExternalRunReport(buffer.subarray(0, length).toString('utf8'));
  } finally { closeSync(fd); }
}

const pct = (value: number | null) => value === null ? '미측정' : `${(value * 100).toFixed(1)}%`;
const metric = (value: number | null, suffix = '') => value === null ? '미측정' : `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}`;
const interval = (value: readonly number[] | null) => value ? `${pct(value[0]!)}–${pct(value[1]!)}` : '미측정';
const code = (value: string) => `\`${value}\``;

export function renderBenchmarkReport(baseline: ExternalRunReport, candidate: ExternalRunReport): string {
  const comparison = compareExternalRuns(baseline, candidate);
  const left = comparison.baseline, right = comparison.candidate;
  const lines = [
    '# BFCL V4 공개 부분집합 · Mr.Robot 자체 채점', '',
    '공식 BFCL 리더보드 점수가 아니다. 도구 선택·인자를 기록한 제한된 실험이며 GUI·코딩·전체 에이전트 성능으로 환산하지 않는다.', '',
    ...(left.completedTasks !== left.expectedTasks || right.completedTasks !== right.expectedTasks ? ['**실행 불완전: 아래 집계는 모델의 능력 점수가 아니다. 먼저 모델 접근·인증·실행 실패 원인을 확인해야 한다.**', ''] : []),
    '## 비교 요약', '',
    '| 지표 | 기준 | 후보 |', '| --- | ---: | ---: |',
    `| 모델 / 추론 | ${code(left.model)} / ${code(left.effort)} | ${code(right.model)} / ${code(right.effort)} |`,
    `| 분할 | ${left.split} | ${right.split} |`,
    `| 정답 / 예정 문항 | ${left.passedTasks}/${left.expectedTasks} | ${right.passedTasks}/${right.expectedTasks} |`,
    `| 정확도 | ${pct(left.accuracy)} | ${pct(right.accuracy)} |`,
    `| 정확도 Wilson 95% 구간 | ${interval(left.accuracyWilson95)} | ${interval(right.accuracyWilson95)} |`,
    `| 시도 / 완료 / 누락 | ${left.attemptedTasks} / ${left.completedTasks} / ${left.coverage.missing} | ${right.attemptedTasks} / ${right.completedTasks} / ${right.coverage.missing} |`,
    `| cold 완료 p50 / p95 (ms) | ${metric(left.completionMs.p50)} / ${metric(left.completionMs.p95)} | ${metric(right.completionMs.p50)} / ${metric(right.completionMs.p95)} |`,
    `| 첫 텍스트 p50 / p95 (ms) | ${metric(left.firstTextMs.p50)} / ${metric(left.firstTextMs.p95)} | ${metric(right.firstTextMs.p50)} / ${metric(right.firstTextMs.p95)} |`,
    `| 첫 텍스트 관측 수 | ${left.firstTextMs.samples} | ${right.firstTextMs.samples} |`,
    `| 사용량 완전 보고 수 | ${left.coverage.completeUsageSamples}/${left.expectedTasks} | ${right.coverage.completeUsageSamples}/${right.expectedTasks} |`,
    `| 정답 1개당 토큰 | ${metric(left.tokensPerSuccess)} | ${metric(right.tokensPerSuccess)} |`,
    `| 호출 수 | ${left.callCount} | ${right.callCount} |`, '',
    '전체 정확도는 누락을 실패로 계산한다. 토큰은 공급자가 보고한 값이며 미보고는 0으로 계산하지 않는다.',
    'cold 지연은 BFCL 실행기의 매 문항·설정별 새 세션 기준이다. warm 지속 대화 속도를 나타내지 않는다.',
    '지연 분포는 관측 시도 기준이며 실패·시간 제한도 포함한다. Wilson 구간은 단일 설정 정확도의 불확실성이지 두 설정의 우월성 검정이 아니다.', '',
    '## 범주별 결과', '', '| 범주 | 기준 정답/예정 (관측) | 후보 정답/예정 (관측) | 기준 정확도 | 후보 정확도 |', '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const before of left.perCategory) {
    const after = right.perCategory.find(row => row.category === before.category)!;
    lines.push(`| ${before.category} | ${before.passedTasks}/${before.expectedTasks} (${before.observedTasks}) | ${after.passedTasks}/${after.expectedTasks} (${after.observedTasks}) | ${pct(before.accuracy)} | ${pct(after.accuracy)} |`);
  }
  lines.push('', '범주별 분모는 예정 문항 수다. 문항 ID로 누락 범주를 확인해 실패로 집계하고, 실제 관측 수는 괄호에 별도 표시한다.', '', '## 고정 검토 기준', '',
    comparison.eligible ? '보류 부분집합에서 검토 기준을 충족했다. 사람의 추가 검토를 추천할 뿐, 자동 반영이나 통계적 우월성 주장이 아니다.' : '검토 기준을 충족하지 않았다. 이 결과로 기본 설정을 승격하지 않는다.',
    '', `- 기준: ${code(comparison.gatePreset.id)}`, '- 자동 활성화: 없음', '- 외부 리더보드 제출: 없음',
    '- 검토 기준은 이 보고서 생성 시점의 버전이다. 실행 당시 판단은 당시 저장한 비교 결과 또는 보존된 보고서를 참조한다.');
  for (const reason of comparison.reasons) lines.push(`- ${reason}`);
  if (comparison.mismatches.length) lines.push(`- 비교 불일치: ${comparison.mismatches.join(', ')}`);
  lines.push('', '## 실패 유형', '', '| 설정 | 실패 코드 | 수 |', '| --- | --- | ---: |');
  for (const [label, report] of [['기준', baseline], ['후보', candidate]] as const) {
    const counts = new Map<string, number>();
    for (const sample of report.samples) if (sample.failure) counts.set(sample.failure, (counts.get(sample.failure) ?? 0) + 1);
    if (!counts.size) lines.push(`| ${label} | 관측 실패 없음 | 0 |`);
    for (const [failure, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) lines.push(`| ${label} | ${code(failure)} | ${count} |`);
    const missing = report.expectedSampleIds.length - report.samples.length;
    if (missing) lines.push(`| ${label} | 미시도 문항 (실패로 집계) | ${missing} |`);
  }
  lines.push('', '## 재현 출처', '', '| 항목 | 기준 | 후보 |', '| --- | --- | --- |');
  for (const key of ['revision', 'partitionHash', 'seed', 'experimentId', 'cliVersion', 'provenanceValid'] as const) {
    lines.push(`| ${key} | ${code(String(baseline[key]))} | ${code(String(candidate[key]))} |`);
  }
  for (const [label, report] of [['기준', baseline], ['후보', candidate]] as const) {
    lines.push('', `### ${label} 데이터·소스 해시`, '', '| 종류 | 식별자 | SHA-256 |', '| --- | --- | --- |');
    for (const group of ['datasetHashes', 'sourceHashes'] as const) for (const [name, hash] of Object.entries(report[group]).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`| ${group} | ${code(name)} | ${code(hash)} |`);
    }
  }
  return lines.concat('', '문제·정답·모델 원문·호출 인자·자격증명을 이 문서에 내보내지 않는다.', '').join('\n');
}

export function writeBenchmarkReport(baselinePath: string, candidatePath: string, outputPath: string): void {
  const baseline = readBenchmarkReport(baselinePath), candidate = readBenchmarkReport(candidatePath);
  writeFileSync(resolve(outputPath), renderBenchmarkReport(baseline, candidate), { flag: 'wx', encoding: 'utf8' });
}

function main(args: string[]) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Local Markdown report only (no inference): --baseline FILE --candidate FILE --out NEW_FILE'); return;
  }
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!key || !['--baseline', '--candidate', '--out'].includes(key) || values[key] || !args[i + 1] || args[i + 1]!.startsWith('--')) invalid();
    values[key] = args[i + 1]!;
  }
  if (Object.keys(values).length !== 3) invalid();
  writeBenchmarkReport(values['--baseline']!, values['--candidate']!, values['--out']!);
  console.log('벤치마크 요약 보고서를 저장했습니다. 모델 호출·설정 변경·업로드는 하지 않았습니다.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch {
    console.error('보고서를 만들지 못했습니다. 입력 형식·파일 크기·경로와 출력 파일 중복을 확인하세요.'); process.exitCode = 1;
  }
}
