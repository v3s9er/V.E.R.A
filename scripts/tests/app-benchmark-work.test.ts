import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, datasetProvenance, gradeTask, loadTasks, parseOptions, publicTask, schedule, sha256 } from '../app-benchmark-protocol.js';
import { finishWorkEvidence, gradeWorkEvidence, newWorkEvidence, observeWorkProgress, observeWorkTool, prepareWorkWorkspace, readWorkArtifacts, validWorkAcceptance, workCaseRoutePolicy, workOntologyTasks, workRouteMatches, workSummary, WORK_TOOLS, type WorkEvidence, type WorkScenario } from '../app-benchmark-work.js';
import { renderAppBenchmarkReport, summarizeAppBenchmark } from '../app-benchmark-report.js';
import { isSelfContainedRequest } from '../../packages/agent/src/ai/request-shape.js';

const base = ['--app-path', 'packages/desktop/.stage', '--expected-version', '0.7.9', '--model', 'gpt-6-sol', '--effort', 'high', '--out-prefix', 'release/validation/work-test', '--suite', 'work-ontology'];
const completed = (count: number) => ({ total: count, reported: count, verified: count, blocked: 0, checksPassed: count, checksFailed: 0 });
function evidence(scenario: WorkScenario): WorkEvidence {
  const result = newWorkEvidence();
  if (scenario.acceptance.kind === 'greeting') return result;
  result.artifacts = scenario.artifacts.map(artifact => ({ present: true, sha256: artifact.sha256, bytes: 25, issue: null }));
  for (const name of WORK_TOOLS) observeWorkTool(result, { name, status: 'done' });
  if (scenario.acceptance.requiresFailedCheck) observeWorkProgress(result, { ...completed(2), verified: 0, checksPassed: 0, checksFailed: 1 });
  observeWorkProgress(result, completed(scenario.acceptance.taskCount));
  result.final = completed(scenario.acceptance.taskCount);
  return result;
}

test('work ontology locks requested single gpt-6-sol high, explicit usage and a predeclared plan hash', () => {
  const options = parseOptions([...base, '--plan-only', 'yes']);
  assert.deepEqual(options.arms, ['single']); assert.equal(options.repetitions, 2);
  assert.equal(schedule(loadTasks(options), options.arms, options.repetitions).length, 6);
  assert.equal(options.seed, 'vera-work-ontology-v1'); assert.equal(options.allowUsage, false);
  assert.throws(() => parseOptions(base), /allow-account-usage/);
  assert.throws(() => parseOptions([...base, '--allow-account-usage', 'yes']), /plan-hash/);
  assert.equal(parseOptions([...base, '--allow-account-usage', 'yes', '--plan-hash', 'a'.repeat(64)]).model, 'gpt-6-sol');
  for (const arms of ['adaptive', 'ontology-adaptive', 'single,adaptive']) assert.throws(() => parseOptions([...base, '--plan-only', 'yes', '--arms', arms]), /single arm/);
  for (const [from, to] of [['gpt-6-sol', 'different-model'], ['high', 'medium']]) assert.throws(() => parseOptions([...base.map(value => value === from ? to : value), '--plan-only', 'yes']), /single arm/);
  for (const [name, value] of [['cache', 'private.json'], ['year', '2022'], ['ids', '2022-AIME-I-01'], ['arc-selection', 'development']]) assert.throws(() => parseOptions([...base, '--plan-only', 'yes', `--${name}`, value]));
});

test('three deterministic cases freeze fixtures and artifact acceptance without exposing contents in the plan', () => {
  const tasks = workOntologyTasks('fixed');
  assert.deepEqual(tasks, workOntologyTasks('fixed'));
  assert.notDeepEqual(tasks.map(task => task.id), workOntologyTasks('different').map(task => task.id));
  assert.deepEqual(tasks.map(task => task.work!.acceptance.kind), ['create', 'recovery', 'greeting']);
  assert.equal(tasks[2].prompt, '안녕');
  assert.equal(isSelfContainedRequest(tasks[2].prompt, []), true);
  for (const task of tasks) {
    assert.ok(validWorkAcceptance(task.work!.acceptance));
    const visible = publicTask(task), text = JSON.stringify(visible);
    assert.equal(visible.workSpecSha256, sha256(canonicalJson(task.work)));
    assert.deepEqual(visible.workRoutePolicy, workCaseRoutePolicy(task.work!.acceptance.kind));
    assert.doesNotMatch(text, /STALE_SOURCE_|WORK_SOURCE_|WORK_RESULT_|WORK_BUNDLE_|\.txt/);
    assert.ok(!Object.hasOwn(visible, 'prompt')); assert.ok(!Object.hasOwn(visible, 'expected'));
    assert.throws(() => gradeTask(task, 'Done. Everything passed.'), /work_evidence_required/);
  }
  const changed = structuredClone(tasks[1]); changed.work!.initialFiles[0].content = 'changed';
  assert.notEqual(publicTask(changed).workSpecSha256, publicTask(tasks[1]).workSpecSha256);
  assert.match(JSON.stringify(datasetProvenance(parseOptions([...base, '--plan-only', 'yes']))), /not independently|cannot independently/);
});

test('default case routing keeps artifact native/high and permits actual low for the short text greeting', () => {
  for (const kind of ['create', 'recovery', 'greeting'] as const) assert.equal(workCaseRoutePolicy(kind).routingPresetId, null);
  for (const kind of ['create', 'recovery'] as const) {
    assert.equal(workRouteMatches(kind, { effort: 'high' }, [{ transport: 'codex-native' }]), true);
    assert.equal(workRouteMatches(kind, { effort: 'low' }, [{ transport: 'codex-native' }]), false);
    assert.equal(workRouteMatches(kind, { effort: 'high' }, [{ transport: 'codex-text' }]), false);
  }
  for (const effort of ['low', 'high']) assert.equal(workRouteMatches('greeting', { effort }, [{ transport: 'codex-text' }]), true);
  assert.equal(workRouteMatches('greeting', { effort: 'high' }, [{ transport: 'codex-native' }]), false);
  assert.equal(workRouteMatches('greeting', { effort: 'medium' }, [{ transport: 'codex-text' }]), false);
  assert.equal(workRouteMatches('greeting', { effort: 'low' }, []), false);
});

test('workspace fixtures never overwrite files and artifact acceptance uses exact bytes with link/size guards', () => {
  const root = mkdtempSync(join(tmpdir(), 'work-benchmark-test-'));
  try {
    const [create, repair] = workOntologyTasks('file-check');
    prepareWorkWorkspace(repair.work!, root);
    assert.match(readFileSync(join(root, 'source.txt'), 'utf8'), /^STALE_SOURCE_/);
    assert.throws(() => prepareWorkWorkspace(repair.work!, root), /EEXIST/);
    assert.throws(() => prepareWorkWorkspace({ ...repair.work!, initialFiles: [{ path: '../escape.txt', content: 'no' }] }, root), /path_invalid/);
    const content = JSON.parse(create.prompt.match(/containing exactly ("[^"]+") \(/)![1]);
    const resultPath = join(root, 'result.txt');
    assert.equal(readWorkArtifacts(create.work!, root)[0].issue, 'missing_artifact');
    writeFileSync(resultPath, content);
    assert.equal(readWorkArtifacts(create.work!, root)[0].sha256, create.work!.artifacts[0].sha256);
    for (const invalid of [`\ufeff${content}`, content.replace(/\n$/, '\r\n'), content.trimEnd(), `${content}extra`]) {
      writeFileSync(resultPath, invalid);
      assert.notEqual(readWorkArtifacts(create.work!, root)[0].sha256, create.work!.artifacts[0].sha256);
    }
    writeFileSync(resultPath, 'x'.repeat(16_385));
    assert.equal(readWorkArtifacts(create.work!, root)[0].issue, 'unsafe_or_oversized_artifact');
    writeFileSync(resultPath, content); linkSync(resultPath, join(root, 'linked.txt'));
    assert.equal(readWorkArtifacts(create.work!, root)[0].issue, 'unsafe_or_oversized_artifact');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('host work observations retain only fixed counts and tool receipts, never native arguments/results', () => {
  const result = newWorkEvidence();
  observeWorkTool(result, { name: 'shell', status: 'done', detail: 'work_check PRIVATE_FAKE' });
  observeWorkTool(result, { name: 'work_check', status: 'done', input: { path: 'PRIVATE_PATH' }, detail: 'PRIVATE_RESULT' });
  observeWorkProgress(result, { ...completed(1), title: 'PRIVATE_TITLE', tasks: ['PRIVATE_TASK'] });
  observeWorkProgress(result, { ...completed(1), title: 'another' });
  assert.equal(result.tools.length, 1); assert.equal(result.progress.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|another|tasks|detail|input/);
  assert.equal(workSummary({ ...completed(1), verified: -1 }), null);
  assert.equal(workSummary({ ...completed(1), checksPassed: Number.NaN }), null);
  assert.equal(workSummary({ ...completed(1), stale: 'false' }), null);
  observeWorkProgress(result, { total: 1 }); assert.equal(result.invalidObservation, true);
});

test('work acceptance requires artifacts, every actual work tool and verified final host summaries', () => {
  const scenario = workOntologyTasks('grade')[0].work!;
  assert.deepEqual(gradeWorkEvidence(scenario.acceptance, evidence(scenario)), { passed: true, failure: null });
  for (const [mutate, reason] of [
    [(row: WorkEvidence) => { row.artifacts[0].sha256 = sha256('wrong'); }, 'artifact_mismatch'],
    [(row: WorkEvidence) => { row.tools = row.tools.filter(tool => tool.name !== 'work_check'); }, 'work_receipt_missing'],
    [(row: WorkEvidence) => { row.tools.forEach(tool => { tool.status = 'start'; }); }, 'work_receipt_missing'],
    [(row: WorkEvidence) => { row.final = null; }, 'work_not_verified'],
    [(row: WorkEvidence) => { row.final!.verified = 0; }, 'work_not_verified'],
    [(row: WorkEvidence) => { row.final!.stale = true; }, 'work_not_verified'],
    [(row: WorkEvidence) => { row.progress = []; }, 'work_not_verified'],
    [(row: WorkEvidence) => { row.invalidObservation = true; }, 'work_observation_invalid'],
  ] as const) { const row = evidence(scenario); mutate(row); assert.equal(gradeWorkEvidence(scenario.acceptance, row).failure, reason); }
  const fake = Object.assign(newWorkEvidence(), { answer: 'Done. All files and checks passed.' });
  assert.equal(gradeWorkEvidence(scenario.acceptance, fake).passed, false);
});

test('recovery needs a recorded failed check before later successful verification, greeting uses no work tools', () => {
  const [, repair, greeting] = workOntologyTasks('recovery');
  const row = evidence(repair.work!);
  assert.equal(gradeWorkEvidence(repair.work!.acceptance, row).passed, true);
  row.progress.shift(); assert.equal(gradeWorkEvidence(repair.work!.acceptance, row).failure, 'work_recovery_not_observed');
  row.progress.push({ ...completed(2), checksFailed: 1 });
  assert.equal(gradeWorkEvidence(repair.work!.acceptance, row).failure, 'work_not_verified');
  const hello = newWorkEvidence();
  assert.equal(gradeWorkEvidence(greeting.work!.acceptance, hello).passed, true);
  observeWorkTool(hello, { name: 'work_status', status: 'start' });
  assert.equal(gradeWorkEvidence(greeting.work!.acceptance, hello).failure, 'unexpected_work_tools');
  const summaryOnly = newWorkEvidence(); summaryOnly.final = completed(0);
  assert.equal(gradeWorkEvidence(greeting.work!.acceptance, summaryOnly).failure, 'unexpected_work_tools');
});

function reportFixture() {
  const tasks = workOntologyTasks('report');
  const plan = { suite: 'work-ontology', model: 'gpt-6-sol', effort: 'high', arms: ['single'], repetitions: 1, tasks: tasks.map(publicTask), schedule: schedule(tasks, ['single'], 1) };
  const planHash = sha256(canonicalJson(plan));
  const samples = plan.schedule.map((item, i) => ({ ...item, completed: true, passed: true, failure: null, durationMs: 1000, firstTextMs: 500,
    route: { model: plan.model, effort: i === 2 ? 'low' : plan.effort }, nativeRouteObserved: i !== 2, nativeOnly: i !== 2, transport: [{ transport: i === 2 ? 'codex-text' : 'codex-native' }], savedFinalMatches: true, streamMatches: true,
    usage: { promptTokens: 90, completionTokens: 10, totalTokens: 100, cachedPromptTokens: 0, reportStatus: 'reported' }, agentEvents: [],
    workEvidence: evidence(tasks[i].work!), answer: 'PRIVATE_ANSWER', projectPath: 'PRIVATE_PATH' }));
  return { envelope: { plan, planHash }, report: { planHash, complete: true, provenanceValid: true, stopped: null, activeRunsAfter: 0, samples } };
}
test('work reports regrade objective evidence and reject route fallback, forged acceptance and missing receipts', () => {
  const good = reportFixture(); assert.equal(summarizeAppBenchmark(good.envelope, good.report).arms[0].passed, 3);
  for (const mutate of [
    (row: any) => { row.nativeOnly = false; },
    (row: any) => { row.transport.push({ transport: 'codex-text' }); },
    (row: any) => { delete row.workEvidence; },
    (row: any) => { row.workEvidence.tools = []; },
    (row: any) => { row.workEvidence.artifacts[0].sha256 = sha256('forged'); },
    (row: any) => { row.workEvidence.final.verified = 0; },
  ]) { const x = reportFixture(); mutate(x.report.samples[0]); assert.throws(() => summarizeAppBenchmark(x.envelope, x.report)); }
  for (const mutate of [
    (plan: any) => { plan.model = 'fallback-model'; },
    (plan: any) => { plan.arms = ['adaptive']; },
    (plan: any) => { plan.tasks[0].workAcceptance.taskCount = 0; },
    (plan: any) => { delete plan.tasks[0].workSpecSha256; },
    (plan: any) => { plan.tasks[2].workRoutePolicy.transport = 'codex-native'; },
  ]) { const x = reportFixture(); mutate(x.envelope.plan); x.envelope.planHash = x.report.planHash = sha256(canonicalJson(x.envelope.plan)); assert.throws(() => summarizeAppBenchmark(x.envelope, x.report)); }
  const markdown = renderAppBenchmarkReport(good.envelope, good.report);
  assert.doesNotMatch(markdown, /PRIVATE_|WORK_RESULT_|WORK_SOURCE_|\.txt/);
  assert.match(markdown, /작은 합성 기능 회귀/); assert.match(markdown, /의존성 그래프와 검사 정의 자체/);
  assert.match(markdown, /요청 추론: high/); assert.match(markdown, /greeting \| low \| codex-text/);
  assert.deepEqual(summarizeAppBenchmark(good.envelope, good.report).workRoutes?.find(row => row.kind === 'greeting'), { kind: 'greeting', effort: 'low', transport: 'codex-text', count: 1 });
  const forcedNative = reportFixture();
  Object.assign(forcedNative.report.samples[2], { nativeRouteObserved: true, nativeOnly: true, transport: [{ transport: 'codex-native' }], route: { model: 'gpt-6-sol', effort: 'high' } });
  assert.throws(() => summarizeAppBenchmark(forcedNative.envelope, forcedNative.report), /work route/);
});

test('harness observes real renderer events and frozen work fixture source without direct provider inference', () => {
  const source = readFileSync(new URL('../app-benchmark.ts', import.meta.url), 'utf8');
  assert.match(source, /'scripts\/app-benchmark-work\.ts'/);
  assert.match(source, /observeWorkTool\(activeSample\.workEvidence, data\)/);
  assert.match(source, /observeWorkProgress\(activeSample\.workEvidence, data\.work\)/);
  assert.match(source, /finishWorkEvidence\(activeSample\.workEvidence, task\.work, workspace, response\.work\)/);
  assert.match(source, /call\('chat\.start'/);
  assert.match(source, /routingPresetId: options\.suite === 'work-ontology' \? null : presets\[item\.arm\]/);
  assert.match(source, /preparedConversation\.routingPresetId \|\| preparedConversation\.reasoningEffort !== options\.effort/);
  assert.ok(source.indexOf('prepareWorkWorkspace(task.work, workspace)') < source.indexOf('started = performance.now();'));
  assert.doesNotMatch(source, /new AgentLoop|\.chatNative\(|\.runAgent\(/);
});
