/** Exact-answer contest regression through the real AgentLoop + isolated subscription transport. */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentLoop } from '../packages/agent/src/ai/loop.js';
import { CliProvider, resolveCliInvocation, cliSubscriptionEnvironment } from '../packages/agent/src/ai/cli.js';
import { discoverCodexModels, discoverCodexVersion } from '../packages/agent/src/ai/cli-models.js';
import { closeTextWorkers } from '../packages/agent/src/ai/cli-text-pool.js';
import { waitForCliRetirements } from '../packages/agent/src/ai/cli-process-retirement.js';
import { CliFailure } from '../packages/agent/src/ai/cli-failure.js';
import type { ProviderRegistry } from '../packages/agent/src/ai/registry.js';
import type { ToolExecutor } from '../packages/agent/src/ai/executor.js';
import type { ReasoningEffort } from '@mr-robot/shared';
import { assertBenchmarkModelAvailable } from './benchmark-preflight.js';
import { argumentsOf, integer, sourceHashes } from './performance-common.js';
import { readAimeCache, selectAimeYear, aimePrompt, gradeAime, summarizeAime, AIME_REVISION, AIME_JSON_SHA256, type AimeSample } from './benchmark-aime-data.js';

if (process.argv.length === 3 && process.argv[2] === '--help') {
  console.log('AIME custom exact-answer regression, not an official contest score.\nnode --import tsx scripts/benchmark-aime.ts --cache FILE --year 2024 --model gpt-6-sol --effort auto --allow-account-usage yes --out-prefix NEW_PREFIX\nOptional --timeout-ms 120000 --cli PATH. Data preparation: benchmark-aime-prepare.py (pyarrow 21.0.0).');
  process.exit(0);
}
const opt = argumentsOf(process.argv.slice(2), ['cache','year','model','effort','allow-account-usage','out-prefix','timeout-ms','cli']);
if (opt['allow-account-usage'] !== 'yes' || !opt.cache || !opt['out-prefix']) throw new Error('Explicit usage consent, cache and new report prefix required');
if (!opt.model || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(opt.model)) throw new Error('Exact model required; no fallback');
if (!opt.effort || !['auto','low','medium','high','xhigh','max'].includes(opt.effort)) throw new Error('Explicit effort required');
const year = integer(opt.year, 2024, 2022, 2024), timeoutMs = integer(opt['timeout-ms'], 120000, 10000, 300000);
const tasks = selectAimeYear(readAimeCache(resolve(opt.cache)), year), expectedIds = tasks.map(t => t.id);
const prefix = resolve(opt['out-prefix']);
for (const suffix of ['manifest.json','progress.jsonl','report.json']) if (existsSync(`${prefix}.${suffix}`)) throw new Error('Existing evidence is never overwritten');
const files = ['scripts/benchmark-aime.ts','scripts/benchmark-aime-data.ts','scripts/benchmark-aime-prepare.py','scripts/benchmark-preflight.ts','scripts/performance-common.ts',
  'packages/agent/src/evaluation/performance-metrics.ts','packages/agent/src/ai/loop.ts','packages/agent/src/ai/adaptive-execution.ts','packages/agent/src/ai/model-tuning.ts',
  'packages/agent/src/ai/provider.ts','packages/agent/src/ai/cli.ts','packages/agent/src/ai/cli-models.ts','packages/agent/src/ai/cli-failure.ts',
  'packages/agent/src/ai/cli-text-pool.ts','packages/agent/src/ai/cli-isolated.ts','packages/agent/src/ai/cli-session-events.ts',
  'packages/agent/src/ai/cli-process-retirement.ts','packages/agent/src/ai/native-run-scheduler.ts','package-lock.json'];
const hashes = sourceHashes(files), samples: AimeSample[] = [], experimentId = randomUUID();
const invocation = { ...resolveCliInvocation('codex-cli', opt.cli ?? 'codex'), env: cliSubscriptionEnvironment('codex-cli') };
const retire = async () => { closeTextWorkers(); await waitForCliRetirements(invocation.env); };
let stopped: string | null = null;
try {
  assertBenchmarkModelAvailable(opt.model, await discoverCodexModels(invocation));
  const cliVersion = await discoverCodexVersion(invocation);
  if (!cliVersion) throw new Error('Cannot verify CLI version');
  const provider = new CliProvider('aime-evaluation', 'AIME evaluation', 'codex-cli', '', opt.model, opt.cli ?? 'codex');
  const registry = { default: () => provider, tuningProfile: () => undefined } as unknown as ProviderRegistry;
  const executor = { execute: async () => { throw new Error('Evaluation host tools are disabled'); } } as unknown as ToolExecutor;
  const manifest = { schemaVersion: 1, experimentId, createdAt: new Date().toISOString(), suite: 'AIME-custom-AgentLoop-v1',
    dataset: 'AI-MO/aimo-validation-aime', revision: AIME_REVISION, datasetSha256: AIME_JSON_SHA256, year, expectedIds,
    model: opt.model, effort: opt.effort, cliVersion, timeoutMs, sourceHashes: hashes, concurrency: 1, retries: 0,
    sessionLifecycle: 'cold-new-session-per-problem', daybreak: false, hostTools: false, personalContext: false,
    officialScore: false, productionSettingsChanged: false, protocol: 'all-30-in-order; strict-final-integer; include-timeouts-and-missing; no-answer-in-prompt' };
  writeFileSync(`${prefix}.manifest.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(`${prefix}.progress.jsonl`, '', { flag: 'wx' });
  for (const task of tasks) {
    if (JSON.stringify(sourceHashes(files)) !== JSON.stringify(hashes)) { stopped = 'source_changed'; break; }
    await retire();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs), start = performance.now();
    const sample: AimeSample = { id: task.id, completed: false, passed: false, failure: null, durationMs: 0, firstTextMs: null,
      actualEffort: null, promptTokens: null, completionTokens: null, cachedPromptTokens: null, calls: 0, toolCalls: 0, predicted: null };
    try {
      const result = await new AgentLoop(registry, executor).run([], aimePrompt(task), {
        signal: controller.signal,
        beforeModelCall: source => {
          if (source.model !== opt.model || ++sample.calls > 1) throw new Error('Evaluation model/call invariant');
        },
        onText: text => { if (text.trim()) sample.firstTextMs ??= performance.now() - start; },
        onTool: () => { sample.toolCalls++; throw new Error('Unexpected tool call'); },
        onModelUsage: usage => {
          if (usage.reportStatus === 'reported' || usage.reportStatus === 'capped') {
            sample.promptTokens = usage.promptTokens; sample.completionTokens = usage.completionTokens; sample.cachedPromptTokens = usage.cachedPromptTokens ?? null;
          }
        },
      }, [], { reasoningEffort: opt.effort as ReasoningEffort, daybreakEnabled: false, permissionMode: 'read-only', tokenPolicy: 'audit-only',
        cacheKey: `aime-${randomUUID()}`, isolation: { tools: [], execute: async () => { throw new Error('No evaluation tools'); } } });
      if (result.route?.model !== opt.model || sample.calls !== 1 || sample.toolCalls) throw new Error('Evaluation invariant');
      sample.completed = true; sample.actualEffort = result.route.effort;
      Object.assign(sample, gradeAime(result.text, task.answer));
    } catch (error) {
      sample.failure = controller.signal.aborted ? 'deadline' : error instanceof CliFailure ? error.code : 'transport_or_invariant';
      if (!controller.signal.aborted) stopped = sample.failure;
    } finally { clearTimeout(timer); sample.durationMs = performance.now() - start; }
    samples.push(sample); appendFileSync(`${prefix}.progress.jsonl`, JSON.stringify(sample) + '\n');
    console.log(`${task.id}: ${sample.passed ? 'pass' : sample.failure} (${Math.round(sample.durationMs)}ms; ${sample.actualEffort ?? 'unknown'})`);
    if (stopped) break;
  }
  const provenanceValid = JSON.stringify(sourceHashes(files)) === JSON.stringify(hashes);
  const summary = summarizeAime(expectedIds, samples);
  writeFileSync(`${prefix}.report.json`, JSON.stringify({ ...manifest, provenanceValid, stopped, summary, samples }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ summary, provenanceValid, stopped }, null, 2));
  if (stopped || !provenanceValid || samples.length !== expectedIds.length) process.exitCode = 1;
} finally { await retire(); }
