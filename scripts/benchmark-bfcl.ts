/** BFCL public subset, custom strict grader, production Mr.Robot broker; NOT an official BFCL score. */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReasoningEffort } from '@mr-robot/shared';
import type { BrokerAgentRequest } from '../packages/agent/src/ai/provider.js';
import { pooledCodexText, closeTextWorkers } from '../packages/agent/src/ai/cli-text-pool.js';
import { cliSubscriptionEnvironment, resolveCliInvocation } from '../packages/agent/src/ai/cli.js';
import { discoverCodexVersion, discoverCodexModels } from '../packages/agent/src/ai/cli-models.js';
import { CliFailure } from '../packages/agent/src/ai/cli-failure.js';
import { assertBenchmarkModelAvailable } from './benchmark-preflight.js';
import { waitForCliRetirements } from '../packages/agent/src/ai/cli-process-retirement.js';
import { parseBenchmarkTasks, parseBenchmarkAnswers, selectBenchmarkTasks, prepareBenchmarkTask, validateBenchmarkCall, gradeBenchmarkCalls } from '../packages/agent/src/evaluation/external-tool-benchmark.js';
import { parseExternalRunReport, summarizeExternalRun, compareExternalRuns, type ExternalRunReport } from '../packages/agent/src/evaluation/external-scorecard.js';
import { argumentsOf, integer, sourceHashes } from './performance-common.js';
import { BFCL_REVISION, BFCL_FILES, benchmarkHash, downloadBfclCache, readBfclCache } from './benchmark-bfcl-data.js';

if (process.argv.length === 3 && process.argv[2] === '--help') {
  console.log(`BFCL public subset / CUSTOM grading, NOT the official leaderboard score.
Prepare data (no model usage):
  npm run benchmark:bfcl -- --mode prepare --cache DIRECTORY --download yes
Paired effort experiment (explicit subscription usage):
  npm run benchmark:bfcl -- --mode run --cache DIRECTORY --split dev --seed mrrobot-bfcl-v1 --per-category 10 --allow-account-usage yes --model MODEL --baseline-effort medium --candidate-effort low --out-prefix NEW_REPORT_PREFIX
Use --split holdout only after freezing a development candidate. Reports never activate app settings.
Optional: --timeout-ms 90000 --cli PATH. Existing output files are never overwritten.`);
  process.exit(0);
}

const options = argumentsOf(process.argv.slice(2), ['mode', 'cache', 'download', 'seed', 'per-category', 'split', 'allow-account-usage', 'model', 'baseline-effort', 'candidate-effort', 'timeout-ms', 'out-prefix', 'cli']);
if (!['prepare', 'run'].includes(options.mode ?? '') || !options.cache) throw new Error('Required --mode prepare|run --cache DIRECTORY. Run also needs explicit model, efforts, usage consent and out-prefix.');
if (options.download && options.download !== 'yes') throw new Error('Download consent must be yes or omitted.');
if (options.mode === 'run' && options.download) throw new Error('Download in a separate prepare step, never during measured inference.');
const perCategory = integer(options['per-category'], 10, 1, 30);
const seed = options.seed ?? 'mrrobot-bfcl-v1';
if (!/^[A-Za-z0-9_-]{1,80}$/.test(seed)) throw new Error('Seed must be a short non-secret identifier.');
const split = options.split ?? 'dev';
if (split !== 'dev' && split !== 'holdout') throw new Error('Choose --split dev|holdout.');
const cached = options.download === 'yes' ? await downloadBfclCache(options.cache) : readBfclCache(options.cache);
const categories = ['simple_python', 'multiple', 'parallel', 'irrelevance'] as const;
const allTasks = categories.flatMap(category => parseBenchmarkTasks(cached[`${category}.questions.jsonl`]!, category));
const tasks = selectBenchmarkTasks(allTasks, { seed, perCategory, split });
const expectedSampleIds = tasks.map(t => t.id);
const partitionHash = benchmarkHash(JSON.stringify(expectedSampleIds));
if (options.mode === 'prepare') {
  const prepared = tasks.map(task => { try { prepareBenchmarkTask(task); return { id: task.id, supported: true }; } catch { return { id: task.id, supported: false }; } });
  console.log(JSON.stringify({ benchmark: 'BFCL-custom-subset-v1', revision: BFCL_REVISION, seed, split, perCategory, partitionHash,
    categories: Object.fromEntries(categories.map(c => [c, allTasks.filter(t => t.category === c).length])), selected: prepared,
    dataOnly: true, officialLeaderboardScore: false, accountUsage: false }, null, 2));
} else {
  if (options['allow-account-usage'] !== 'yes') throw new Error('Pass --allow-account-usage yes; real model requests spend subscription usage.');
  if (!options.model || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(options.model)) throw new Error('Supply exact --model; no fallback.');
  const efforts = { baseline: options['baseline-effort'], candidate: options['candidate-effort'] };
  for (const effort of Object.values(efforts)) if (!effort || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new Error('Supply explicit supported --baseline-effort and --candidate-effort.');
  if (efforts.baseline === efforts.candidate) throw new Error('This tuning experiment requires distinct effort settings.');
  if (!options['out-prefix']) throw new Error('Supply --out-prefix for write-once evidence.');
  const outputPrefix = resolve(options['out-prefix']);
  for (const suffix of ['manifest', 'baseline', 'candidate', 'comparison']) if (existsSync(`${outputPrefix}.${suffix}.json`)) throw new Error('Evidence output already exists; refusing overwrite.');
  if (existsSync(`${outputPrefix}.progress.jsonl`)) throw new Error('Progress evidence already exists; refusing overwrite.');
  const timeoutMs = integer(options['timeout-ms'], 90_000, 10_000, 120_000);
  const files = ['scripts/benchmark-bfcl.ts', 'scripts/benchmark-bfcl-data.ts', 'scripts/benchmark-preflight.ts', 'packages/agent/src/ai/cli-failure.ts', 'packages/agent/src/evaluation/external-tool-benchmark.ts',
    'packages/agent/src/evaluation/external-scorecard.ts', 'packages/agent/src/ai/cli-text-pool.ts', 'packages/agent/src/ai/cli-isolated.ts',
    'packages/agent/src/ai/cli-session-events.ts', 'packages/agent/src/ai/cli.ts', 'packages/agent/src/ai/provider.ts',
    'packages/agent/src/ai/cli-process-retirement.ts', 'packages/agent/src/ai/native-run-scheduler.ts',
    'packages/agent/src/ai/cli-models.ts', 'packages/agent/src/computer/shell.ts', 'scripts/performance-common.ts', 'package-lock.json'];
  const initialHashes = sourceHashes(files);
  const experimentId = randomUUID();
  const answers = new Map(categories.filter(c => c !== 'irrelevance').flatMap(category => [...parseBenchmarkAnswers(cached[`${category}.answers.jsonl`]!, category)]));
  for (const task of tasks) if (task.category !== 'irrelevance' && !answers.has(task.id)) throw new Error('Incomplete reference data; inference aborted.');
  const cli = resolveCliInvocation('codex-cli', options.cli ?? 'codex'), env = cliSubscriptionEnvironment('codex-cli');
  const retired = async () => { closeTextWorkers(); await waitForCliRetirements(env); };
  const records: Record<'baseline' | 'candidate', ExternalRunReport['samples']> = { baseline: [], candidate: [] };
  let stop = false, cliVersion = '';
  // Grader references never enter the request. These tools RECORD selection/arguments only.
  const system = 'Use the registered tools to address the user request when their documented capabilities are relevant and all required information is available. Do not invent missing arguments. If no tool is suitable, respond without calling one. This is a simulated tool-selection evaluation: tools only record requested calls and do not perform real external actions. After requested calls are recorded, finish your response. No other tools or environment are available.';
  try {
    assertBenchmarkModelAvailable(options.model, await discoverCodexModels({ ...cli, env }));
    cliVersion = await discoverCodexVersion({ ...cli, env }) ?? '';
    if (!cliVersion) throw new Error('Cannot verify installed CLI version.');
    writeFileSync(`${outputPrefix}.manifest.json`, JSON.stringify({ benchmark: 'BFCL-custom-subset-v1', revision: BFCL_REVISION, seed, split,
      expectedSampleIds, partitionHash, model: options.model, efforts, cliVersion, experimentId, sourceHashes: initialHashes,
      timeoutMs, concurrency: 1, maxCallsPerTask: 16, sessionLifecycle: 'fresh-cold-session-per-task-treatment', defaultSettingsChanged: false, officialLeaderboardScore: false,
      protocol: 'paired-alternating-effort-v1; strict-reference-custom-grader; no retries; include failures; no answer-based selection',
    }, null, 2) + '\n', { flag: 'wx' });
    writeFileSync(`${outputPrefix}.progress.jsonl`, '', { flag: 'wx' });
    for (const [index, task] of tasks.entries()) {
      const variants = index % 2 ? ['candidate', 'baseline'] as const : ['baseline', 'candidate'] as const;
      for (const variant of variants) {
        if (stop) break;
        if (JSON.stringify(initialHashes) !== JSON.stringify(sourceHashes(files))) { stop = true; break; }
        await retired();
        const sample: ExternalRunReport['samples'][number] = { id: task.id, category: task.category, completed: false, passed: false,
          failure: 'unsupported_schema', durationMs: 0, firstTextMs: null, promptTokens: null, completionTokens: null, cachedPromptTokens: null, callCount: 0 };
        let prepared: ReturnType<typeof prepareBenchmarkTask>;
        try { prepared = prepareBenchmarkTask(task); } catch { records[variant].push(sample); appendFileSync(`${outputPrefix}.progress.jsonl`, JSON.stringify({ variant, sample }) + '\n'); continue; }
        const calls: Array<{ name: string; input: unknown }> = [];
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
        const start = performance.now();
        const req: BrokerAgentRequest = { system, turns: prepared.turns, tools: prepared.tools, reasoningEffort: efforts[variant] as ReasoningEffort,
          promptCacheKey: `external-eval-${randomUUID()}`, signal: controller.signal,
          executeTool: async (name, input, signal) => {
            signal.throwIfAborted();
            if (calls.length >= 16) { controller.abort(); throw new Error('Evaluation call limit reached'); }
            calls.push({ name, input: structuredClone(input) });
            const validation = validateBenchmarkCall(prepared, { name, input });
            if (!validation.valid) return 'The requested call did not match its registered schema. No action was performed.';
            return 'Requested call recorded. No real external action was performed and no additional result is available.';
          },
          onEvent: event => { if (event.type === 'text' && event.text.trim()) sample.firstTextMs ??= performance.now() - start; },
        };
        try {
          const result = await pooledCodexText({ ...cli, env, model: options.model, providerId: 'public-external-benchmark', req });
          sample.completed = true;
          const grade = gradeBenchmarkCalls(prepared, answers.get(task.id), calls);
          sample.passed = grade.passed;
          sample.failure = grade.passed ? null : grade.code;
          if (result.usage.reportStatus === 'reported' || result.usage.reportStatus === 'capped') {
            sample.promptTokens = result.usage.promptTokens; sample.completionTokens = result.usage.completionTokens;
            sample.cachedPromptTokens = result.usage.cachedPromptTokens ?? null;
          }
        } catch (error) {
          sample.failure = controller.signal.aborted ? 'deadline_or_call_limit' : error instanceof CliFailure ? error.code : 'transport';
          // Do not burn the remaining budget through failed authentication/transport.
          if (!controller.signal.aborted) stop = true;
        } finally {
          clearTimeout(timer); sample.durationMs = performance.now() - start; sample.callCount = calls.length;
          records[variant].push(sample);
          appendFileSync(`${outputPrefix}.progress.jsonl`, JSON.stringify({ variant, sample }) + '\n');
        }
        console.error(`[BFCL subset] ${split} ${task.id} ${variant}: ${sample.passed ? 'pass' : sample.failure} (${Math.round(sample.durationMs)}ms)`);
      }
      if (stop) break;
    }
  } finally { await retired(); }
  const unchanged = JSON.stringify(initialHashes) === JSON.stringify(sourceHashes(files));
  const reports = (['baseline', 'candidate'] as const).map(variant => {
    const value: ExternalRunReport = { schemaVersion: 1, benchmark: 'BFCL-custom-subset-v1', revision: BFCL_REVISION,
      datasetHashes: Object.fromEntries(BFCL_FILES.map(f => [f.file, f.sha256])), sourceHashes: initialHashes,
      partitionHash, split, seed, model: options.model!, effort: efforts[variant]!, variant, cliVersion, experimentId, expectedSampleIds, provenanceValid: unchanged, samples: records[variant] };
    parseExternalRunReport(value);
    writeFileSync(`${outputPrefix}.${variant}.json`, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ variant, summary: summarizeExternalRun(value) }));
    return value;
  });
  const comparison = compareExternalRuns(reports[0]!, reports[1]!);
  if (!unchanged) { comparison.eligible = false; comparison.reasons.push('Source changed during run; experiment invalid.'); }
  writeFileSync(`${outputPrefix}.comparison.json`, JSON.stringify(comparison, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(comparison, null, 2));
  if (stop || !unchanged || reports.some(r => r.samples.length !== expectedSampleIds.length)) process.exitCode = 1;
}
