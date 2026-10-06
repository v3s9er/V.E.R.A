/** Publishable metadata-only summary; never exports prompts, answers or local paths. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, sha256 } from './app-benchmark-protocol.js';

type Item = { taskId: string; arm: string; repetition: number };
const measurement = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const tokenCount = (value: unknown): value is number => measurement(value) && Number.isSafeInteger(value);
const knownUsage = (usage: any) => ['reported', 'reported-positive-aggregate'].includes(usage?.reportStatus) && tokenCount(usage?.totalTokens);
const key = ({ taskId, arm, repetition }: Item) => JSON.stringify([taskId, arm, repetition]);
const cell = (value: unknown) => String(value).replace(/[\r\n\t]/g, ' ').replace(/[\\|`*_[\]<>]/g, char => `\\${char}`).slice(0, 160);
const number = (value: number | null, digits = 0) => value === null ? '미확인' : value.toLocaleString('en-US', { maximumFractionDigits: digits });
const percentile = (values: number[], fraction: number) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]! : null;

export function summarizeAppBenchmark(envelope: any, report: any) {
  const plan = envelope?.plan;
  if (!plan || !Array.isArray(plan.schedule) || !plan.schedule.length || plan.schedule.length > 10_000
    || !Array.isArray(plan.arms) || !plan.arms.length || new Set(plan.arms).size !== plan.arms.length
    || plan.arms.some((arm: unknown) => !['single', 'adaptive', 'ontology-adaptive'].includes(arm as string))
    || !['aime', 'relations', 'arc2', 'knowledge-recall'].includes(plan.suite)
    || (!['relations', 'knowledge-recall'].includes(plan.suite) && plan.arms.includes('ontology-adaptive'))
    || (plan.suite === 'knowledge-recall' && (plan.arms.length !== 1 || plan.arms[0] !== 'ontology-adaptive'))
    || typeof plan.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(plan.model)
    || !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(plan.effort)
    || !Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.length > 10_000
    || !Number.isSafeInteger(plan.repetitions) || plan.repetitions < 1 || plan.repetitions > 20
    || envelope.planHash !== sha256(canonicalJson(plan)) || report?.planHash !== envelope.planHash
    || !Array.isArray(report.samples)) throw new Error('Invalid or mismatched evaluation evidence');
  const taskIds = new Set<string>();
  const knowledgeInventory = new Map<string, { relationCount: number; relationsSha256: string }>();
  for (const task of plan.tasks) {
    if (typeof task?.id !== 'string' || !task.id || task.id.length > 200 || taskIds.has(task.id)) throw new Error('Invalid task inventory');
    taskIds.add(task.id);
    if (plan.suite === 'knowledge-recall') {
      if (!tokenCount(task.relationCount) || typeof task.relationsSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(task.relationsSha256)) throw new Error('Invalid knowledge-recall inventory');
      knowledgeInventory.set(task.id, { relationCount: task.relationCount, relationsSha256: task.relationsSha256 });
    }
  }
  const planned = new Map<string, Item>();
  for (const item of plan.schedule as Item[]) {
    if (!taskIds.has(item.taskId) || !plan.arms.includes(item.arm)
      || !Number.isSafeInteger(item.repetition) || item.repetition < 0 || item.repetition >= plan.repetitions
      || planned.has(key(item))) throw new Error('Invalid or duplicate planned sample');
    planned.set(key(item), item);
  }
  for (const taskId of taskIds) for (const arm of plan.arms) {
    for (let repetition = 0; repetition < plan.repetitions; repetition++) {
      if (!planned.has(key({ taskId, arm, repetition }))) throw new Error('Unbalanced paired plan');
    }
  }
  const observed = new Map<string, any>();
  for (const row of report.samples) {
    if (!planned.has(key(row)) || observed.has(key(row)) || typeof row.passed !== 'boolean'
      || typeof row.completed !== 'boolean' || (row.passed && (!row.completed || row.failure !== null))
      || !measurement(row.durationMs) || !(row.firstTextMs === null || measurement(row.firstTextMs))) throw new Error('Invalid or duplicate observed sample');
    if (row.completed && (row.route?.model !== plan.model || row.route?.effort !== plan.effort || row.nativeRouteObserved !== true
      || row.savedFinalMatches !== true || row.streamMatches !== true)) throw new Error('Observed execution invariants differ from plan');
    if (row.completed && plan.suite === 'knowledge-recall') {
      const expected = knowledgeInventory.get(row.taskId)!;
      const setup = row.memorySetup;
      if (setup?.verified !== true || setup.expectedRelations !== expected.relationCount
        || setup.receiptCount !== expected.relationCount || setup.storedCount !== expected.relationCount
        || setup.relationsSha256 !== expected.relationsSha256) throw new Error('Observed knowledge setup differs from plan');
    }
    if (!Array.isArray(row.agentEvents) || row.agentEvents.some((event: any) => event.model !== undefined && event.model !== plan.model)) throw new Error('Helper model differs from plan');
    const usage = row.usage;
    if (!usage || !['reported', 'capped', 'reported-positive-aggregate', 'unknown'].includes(usage.reportStatus)) throw new Error('Invalid usage status');
    if (usage.reportStatus === 'unknown') {
      if ([usage.promptTokens, usage.completionTokens, usage.totalTokens, usage.cachedPromptTokens].some(value => value !== null)) throw new Error('Unknown usage must remain unknown');
    } else {
      if (![usage.promptTokens, usage.completionTokens, usage.totalTokens].every(tokenCount)
        || usage.promptTokens + usage.completionTokens !== usage.totalTokens
        || (usage.reportStatus === 'reported-positive-aggregate' && usage.totalTokens === 0)
        || (usage.cachedPromptTokens !== null && usage.cachedPromptTokens !== undefined
          && (!tokenCount(usage.cachedPromptTokens) || usage.cachedPromptTokens > usage.promptTokens))) throw new Error('Invalid token accounting');
    }
    observed.set(key(row), row);
  }
  const complete = report.complete === true && report.provenanceValid === true && report.stopped === null
    && report.activeRunsAfter === 0 && report.cancellationUnconfirmed !== true && report.closeUnconfirmed !== true
    && observed.size === planned.size;
  if (report.complete === true && !complete) throw new Error('Claimed completion contradicts raw evidence');
  const arms = plan.arms.map((arm: string) => {
    const expected = [...planned.values()].filter(item => item.arm === arm);
    const rows = expected.map(item => observed.get(key(item))).filter(Boolean);
    const passed = rows.filter(row => row.passed).length;
    const first = rows.map(row => row.firstTextMs).filter(measurement);
    const durations = rows.map(row => row.durationMs);
    const usageKnown = rows.filter(row => knownUsage(row.usage)).length;
    const usageComplete = rows.length === expected.length && usageKnown === expected.length;
    const totalTokens = usageComplete ? rows.reduce((sum, row) => sum + row.usage.totalTokens, 0) : null;
    if (totalTokens !== null && !tokenCount(totalTokens)) throw new Error('Aggregate usage overflow');
    const tasks = [...new Set(expected.map(item => item.taskId))];
    const consistent = tasks.filter(taskId => {
      const repeats = expected.filter(item => item.taskId === taskId);
      return repeats.length === plan.repetitions && repeats.every(item => observed.get(key(item))?.passed === true);
    }).length;
    return { arm, expected: expected.length, attempted: rows.length, passed, missing: expected.length - rows.length,
      independentTaskCount: tasks.length, consistent, repetitions: plan.repetitions,
      completionP50Ms: percentile(durations, .5), completionP95Ms: percentile(durations, .95),
      firstTextP50Ms: percentile(first, .5), firstTextCount: first.length, usageKnown, totalTokens,
      tokensPerSuccess: totalTokens !== null && passed > 0 ? totalTokens / passed : null,
      helperRunsObserved: rows.filter(row => Array.isArray(row.agentEvents) && row.agentEvents.length > 0).length };
  });
  return { complete, planHash: envelope.planHash as string, model: String(plan.model), effort: String(plan.effort),
    suite: String(plan.suite), arms, officialScore: false as const };
}

export function renderAppBenchmarkReport(envelope: any, report: any): string {
  const summary = summarizeAppBenchmark(envelope, report);
  const lines = ['# V.E.R.A 실제 앱 평가', '',
    `상태: ${summary.complete ? '계획된 실행 완료 · 해시 고정 확인' : '미완료 — 누락 실행도 계획 분모에 포함'}`,
    `문제군: ${cell(summary.suite)} · 모델: ${cell(summary.model)} · 추론: ${cell(summary.effort)}`, '',
    '| 실행 정책 | 정답 / 계획 | 미실행 | 응답 완료 p50 / p95 | 총 토큰 | 정답 1회당 토큰 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |'];
  for (const arm of summary.arms) lines.push(`| ${cell(arm.arm)} | ${arm.passed} / ${arm.expected} | ${arm.missing} | ${number(arm.completionP50Ms === null ? null : arm.completionP50Ms / 1000, 2)} / ${number(arm.completionP95Ms === null ? null : arm.completionP95Ms / 1000, 2)}초 | ${number(arm.totalTokens)} | ${number(arm.tokensPerSuccess, 1)} |`);
  lines.push('', '## 반복 일관성과 관측', '',
    '| 실행 정책 | 모든 반복에서 정답인 문제 | 첫 답변 p50 (관측 수) | 사용량 확인 수 | 보조 작업 관측 실행 수 |',
    '| --- | ---: | ---: | ---: | ---: |');
  for (const arm of summary.arms) lines.push(`| ${cell(arm.arm)} | ${arm.consistent} / ${arm.independentTaskCount} (${arm.repetitions}회 반복) | ${number(arm.firstTextP50Ms === null ? null : arm.firstTextP50Ms / 1000, 2)}초 (${arm.firstTextCount}) | ${arm.usageKnown} / ${arm.expected} | ${arm.helperRunsObserved} / ${arm.expected} |`);
  lines.push('', '## 해석 범위', '',
    summary.suite === 'knowledge-recall'
      ? '- 저장 지식 검색의 합성 기능 회귀 검사입니다. 동일한 모델·설정·문제로 앱 버전 간 회귀를 비교하기 위한 것이며 실행 모드의 우열이나 공개 벤치마크 점수를 나타내지 않습니다.'
      : summary.suite === 'relations'
      ? '- 합성 관계 문제의 기능 회귀 검사이며 공개 대회·리더보드 점수나 일반 추론 성능 점수가 아닙니다.'
      : '- 공개 문제의 로컬 회귀 검사이며 공식 대회·리더보드 점수가 아닙니다. 문제의 사전 학습 포함 여부는 보장하지 않습니다.',
    '- 반복 실행은 새로운 독립 문제가 아닙니다. 가장 잘 나온 답만 고르는 pass@k가 아니라 각 실행을 그대로 계산합니다.',
    '- 응답 완료 시간에는 실패를 포함하며 첫 답변 시간은 실제 텍스트가 관측된 실행만 포함합니다. 상태 알림은 첫 답변이 아닙니다.',
    '- 캐시 토큰은 입력 토큰의 부분집합입니다. 작업자 사용량은 전체 집계에 다시 더하지 않습니다. 미확인·상한 절단 사용량을 정확한 값이나 0으로 보지 않습니다.',
    '- 같은 모델·시간 제한이 같은 계산량을 의미하지는 않습니다. 공급자 부하와 로컬 백그라운드 작업은 완전히 통제되지 않습니다.',
    '- adaptive 정책 선택만으로 다중 에이전트 효과가 입증되지는 않습니다. CLI 도구 관측은 일부 버전·재연결 상태에서 불완전할 수 있습니다.',
    '- 작은 문제 집합의 수치로 일반 정확도 향상이나 세계 순위를 주장하지 않습니다.', '',
    `계획 SHA-256: ${summary.planHash}`, '');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [planPath, reportPath, outputPath, extra] = process.argv.slice(2);
    if (!planPath || !reportPath || !outputPath || extra) throw new Error('Expected plan report output paths');
    const read = (path: string) => { const data = readFileSync(path); if (data.length > 32 * 1024 * 1024) throw new Error('Evidence too large'); return JSON.parse(data.toString('utf8')); };
    writeFileSync(resolve(outputPath), renderAppBenchmarkReport(read(planPath), read(reportPath)), { flag: 'wx' });
    console.log('Metadata-only evaluation report written.');
  } catch { console.error('Cannot summarize: verify evidence, matching plan and a new output path. Existing files were not overwritten.'); process.exitCode = 1; }
}
