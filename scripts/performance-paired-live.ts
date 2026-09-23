/** Interleaved, case-isolated A/B of the actual concise response-style modifier. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pooledCodexText, closeTextWorkers } from '../packages/agent/src/ai/cli-text-pool.js';
import { resolveCliInvocation, cliSubscriptionEnvironment } from '../packages/agent/src/ai/cli.js';
import { discoverCodexVersion } from '../packages/agent/src/ai/cli-models.js';
import { waitForCliRetirements } from '../packages/agent/src/ai/cli-process-retirement.js';
import { tuningInstructions } from '../packages/agent/src/ai/model-tuning.js';
import { classifyExactOutput, comparePerformance, type PerformanceSample } from '../packages/agent/src/evaluation/performance-metrics.js';
import type { BrokerAgentRequest, Turn } from '../packages/agent/src/ai/provider.js';
import type { ReasoningEffort } from '@mr-robot/shared';
import { argumentsOf, integer, report, finishReport, sourceHashes } from './performance-common.js';

const options = argumentsOf(process.argv.slice(2), ['allow-account-usage', 'model', 'effort', 'samples', 'timeout-ms', 'out-prefix', 'cli']);
if (options['allow-account-usage'] !== 'yes') throw new Error('Pass --allow-account-usage yes; this spends subscription usage.');
if (!options.model || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(options.model)) throw new Error('Supply exact --model.');
if (!options.effort || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(options.effort)) throw new Error('Supply explicit supported --effort.');
if (!options['out-prefix']) throw new Error('Supply --out-prefix for reproducible private reports.');
const count = integer(options.samples, 20, 1, 20);
const timeoutMs = integer(options['timeout-ms'], 60_000, 5000, 120_000);
const cli = resolveCliInvocation('codex-cli', options.cli ?? 'codex');
const env = cliSubscriptionEnvironment('codex-cli');
const pairingId = randomUUID();
const records = { baseline: [] as PerformanceSample[], concise: [] as PerformanceSample[] };
const files = ['packages/agent/src/ai/cli-text-pool.ts', 'packages/agent/src/ai/cli-isolated.ts',
  'packages/agent/src/ai/model-tuning.ts', 'scripts/performance-paired-live.ts'];
const initialHashes = sourceHashes(files);
const retired = async () => { closeTextWorkers(); await waitForCliRetirements(env); };
const tasks = [
  { id: 'arithmetic', input: 'Return only the integer answer: (17 * 23) + 9.', expected: '400' },
  { id: 'unicode', input: 'Return exactly these labels in reverse order, separated by commas and no spaces: 서울,부산,제주', expected: '제주,부산,서울' },
  { id: 'extraction', input: 'From this synthetic data, return only the value of code. Data: name=oak; code=J7Q2; quantity=3.', expected: 'J7Q2' },
  { id: 'recall', input: 'Return only the marker from the previous user message.', expected: 'amber-742' },
];
let executed = 0;
try {
  const cliVersion = await discoverCodexVersion({ ...cli, env });
  if (!cliVersion) throw new Error('Installed CLI version unavailable.');
  experiment: for (let repetition = 0; repetition < count; repetition++) {
    // Every other block reverses order to reduce service-load/cache-order bias.
    const variants = repetition % 2 ? ['concise', 'baseline'] as const : ['baseline', 'concise'] as const;
    for (const task of tasks) {
      for (const variant of variants) {
        await retired(); // Each case and treatment starts an independent ephemeral session.
        const key = `mrrobot-eval-paired-${randomUUID()}`, turns: Turn[] = [];
        const steps = task.id === 'recall' ? [
          { id: 'recall-prime', input: 'Remember synthetic marker amber-742 for the next request. Reply only READY.', expected: 'READY' }, task,
        ] : [task];
        for (const step of steps) {
          turns.push({ role: 'user', content: step.input });
          const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
          let firstTextMs: number | null = null;
          const start = performance.now();
          const req: BrokerAgentRequest = { system: ['Complete the synthetic instruction exactly. Do not use tools. Return only the requested answer.',
            tuningInstructions({ responseStyle: variant === 'concise' ? 'concise' : 'default' })].filter(Boolean).join('\n\n'),
            turns: [...turns], tools: [], reasoningEffort: options.effort as ReasoningEffort, signal: controller.signal,
            promptCacheKey: key, executeTool: async () => { throw new Error('Benchmark tools disabled'); },
            onEvent: event => { if (event.type === 'text' && event.text) firstTextMs ??= performance.now() - start; } };
          try {
            const result = await pooledCodexText({ ...cli, env, model: options.model, providerId: 'synthetic-paired-eval', req });
            const metered = result.usage.reportStatus === 'reported' || result.usage.reportStatus === 'capped';
            const outputCheck = classifyExactOutput(result.text, step.expected);
            records[variant].push({ caseId: `live.${step.id}.${step.id === 'recall' ? 'warm' : 'cold'}`, repetition,
              completionMs: performance.now() - start, firstTextMs, completed: true,
              outputCheck, qualityPassed: outputCheck === 'exact_normalized_match' && result.toolCalls.length === 0,
              promptTokens: metered ? result.usage.promptTokens : null, completionTokens: metered ? result.usage.completionTokens : null,
              cachedPromptTokens: metered ? result.usage.cachedPromptTokens ?? null : null, outputBytes: Buffer.byteLength(result.text) });
            turns.push({ role: 'assistant', content: result.text });
          } catch {
            records[variant].push({ caseId: `live.${step.id}.${step.id === 'recall' ? 'warm' : 'cold'}`, repetition,
              completionMs: performance.now() - start, firstTextMs, completed: false, qualityPassed: false,
              promptTokens: null, completionTokens: null, cachedPromptTokens: null, outputBytes: 0,
              errorCode: controller.signal.aborted ? 'deadline' : 'transport' });
            break experiment; // A broken transport must not burn through the experiment budget.
          } finally { clearTimeout(timer); }
          if (++executed % 10 === 0) console.error(`[evaluation] ${executed}/${count * 10} synthetic calls completed; no production settings changed.`);
        }
      }
    }
  }
  const unchanged = JSON.stringify(initialHashes) === JSON.stringify(sourceHashes(files));
  const values = (['baseline', 'concise'] as const).map(variant => {
    const value = report('isolated-paired-subscription-v1', 'live-model', { model: options.model!, effort: options.effort!,
      samplesPerCase: count, timeoutMs, concurrency: 1, dataset: 'independent-four-instructions-plus-recall-prime-v1',
      nativeTools: false, userContext: false, alternatingTreatmentOrder: true, sourceUnchangedDuringRun: unchanged }, files, records[variant]);
    value.environment.cliVersion = cliVersion; value.pairingId = pairingId; value.treatment = variant;
    // Exact hashes imported before the experiment, not an edited file at completion.
    value.sourceHashes = initialHashes;
    finishReport(value, `${options['out-prefix']}.${variant}.json`);
    return value;
  });
  const comparison = comparePerformance(values[0]!, values[1]!);
  if (!unchanged) { comparison.promotionEligible = false; comparison.mismatches.push('source changed during experiment'); }
  writeFileSync(`${options['out-prefix']}.comparison.json`, JSON.stringify(comparison, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(comparison, null, 2));
} finally { await retired(); }
