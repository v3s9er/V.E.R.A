/** Opt-in subscription evaluation. Synthetic prompts only; no native tools or user transcripts. */
import { randomUUID } from 'node:crypto';
import { pooledCodexText, closeTextWorkers } from '../packages/agent/src/ai/cli-text-pool.js';
import { resolveCliInvocation, cliSubscriptionEnvironment } from '../packages/agent/src/ai/cli.js';
import { discoverCodexVersion } from '../packages/agent/src/ai/cli-models.js';
import { waitForCliRetirements } from '../packages/agent/src/ai/cli-process-retirement.js';
import type { BrokerAgentRequest, Turn } from '../packages/agent/src/ai/provider.js';
import type { ReasoningEffort } from '@mr-robot/shared';
import { classifyExactOutput, type PerformanceSample } from '../packages/agent/src/evaluation/performance-metrics.js';
import { argumentsOf, integer, report, finishReport } from './performance-common.js';

const options = argumentsOf(process.argv.slice(2), ['allow-account-usage', 'model', 'effort', 'samples', 'timeout-ms', 'out', 'baseline', 'cli']);
if (options['allow-account-usage'] !== 'yes') throw new Error('Live evaluation spends subscription usage. Pass --allow-account-usage yes explicitly.');
if (!options.model || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(options.model)) throw new Error('Supply exact --model; there is no automatic model substitution.');
if (!options.effort || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(options.effort)) throw new Error('Supply explicit --effort supported by your selected model.');
const count = integer(options.samples, 2, 1, 20);
const timeoutMs = integer(options['timeout-ms'], 60_000, 5_000, 120_000);
const cli = resolveCliInvocation('codex-cli', options.cli ?? 'codex');
const env = cliSubscriptionEnvironment('codex-cli'); // Allowlist excludes billable API keys and unrelated secrets.
const samples: PerformanceSample[] = [];
const cases = [
  { id: 'arithmetic', prompt: 'Return only the integer answer: (17 * 23) + 9.', expected: '400' },
  { id: 'unicode', prompt: 'Return exactly these three labels in reverse order, separated by commas and no spaces: 서울,부산,제주', expected: '제주,부산,서울' },
  { id: 'bounded-extraction', prompt: 'From this synthetic data, return only the value of code. Data: name=oak; code=J7Q2; quantity=3.', expected: 'J7Q2' },
  { id: 'context-recall', prompt: 'Return only the marker from the immediately previous user message in this synthetic session.', expected: 'amber-742' },
];
const retire = async () => { closeTextWorkers(); await waitForCliRetirements(env); };
try {
  const cliVersion = await discoverCodexVersion({ ...cli, env });
  if (!cliVersion) throw new Error('Cannot verify installed CLI version; live benchmark aborted.');
  for (let repetition = 0; repetition < count; repetition++) {
    // A new ephemeral no-tools session each repetition, reused only for this fixed four-turn dialogue.
    await retire();
    const key = `mrrobot-eval-${randomUUID()}`;
    const history: Turn[] = [];
    for (const task of cases) {
      const input = task.id === 'bounded-extraction' ? `${task.prompt}\nRemember the synthetic marker amber-742 for the next request; do not echo it now.` : task.prompt;
      history.push({ role: 'user', content: input });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const start = performance.now();
      let firstTextMs: number | null = null;
      const req: BrokerAgentRequest = { system: 'Complete the synthetic instruction exactly. Do not use tools. Return only the requested answer.',
        turns: [...history], tools: [], reasoningEffort: options.effort as ReasoningEffort, signal: controller.signal, promptCacheKey: key,
        executeTool: async () => { throw new Error('Benchmark tools disabled'); },
        onEvent: event => { if (event.type === 'text' && event.text.length > 0) firstTextMs ??= performance.now() - start; } };
      try {
        const result = await pooledCodexText({ ...cli, env, model: options.model, providerId: 'synthetic-live-eval', req });
        const elapsed = performance.now() - start;
        const metered = result.usage.reportStatus === 'reported' || result.usage.reportStatus === 'capped';
        const outputCheck = classifyExactOutput(result.text, task.expected);
        samples.push({ caseId: `live.${task.id}.${task === cases[0] ? 'cold' : 'warm'}`, repetition, completionMs: elapsed,
          firstTextMs, completed: true, outputCheck, qualityPassed: outputCheck === 'exact_normalized_match' && result.toolCalls.length === 0,
          promptTokens: metered ? result.usage.promptTokens : null, completionTokens: metered ? result.usage.completionTokens : null,
          cachedPromptTokens: metered ? result.usage.cachedPromptTokens ?? null : null, outputBytes: Buffer.byteLength(result.text) });
        history.push({ role: 'assistant', content: result.text });
      } catch {
        samples.push({ caseId: `live.${task.id}.${task === cases[0] ? 'cold' : 'warm'}`, repetition, completionMs: performance.now() - start,
          firstTextMs, completed: false, qualityPassed: false, promptTokens: null, completionTokens: null, cachedPromptTokens: null,
          outputBytes: 0, errorCode: controller.signal.aborted ? 'deadline' : 'transport' });
        // Do not spend through a broken account/transport, nor use a partial turn as history.
        break;
      } finally { clearTimeout(timer); }
    }
    if (samples.some(s => !s.completed)) break;
  }
  const value = report('isolated-subscription-v1', 'live-model', { model: options.model, effort: options.effort,
    samplesPerCase: count, timeoutMs, concurrency: 1, dataset: 'four-public-synthetic-instructions-v1',
    nativeTools: false, userContext: false, externalApiKeyFallback: false }, [
      'packages/agent/src/ai/cli-text-pool.ts', 'packages/agent/src/ai/cli-isolated.ts', 'scripts/performance-live.ts'], samples);
  value.environment.cliVersion = cliVersion;
  finishReport(value, options.out, options.baseline);
} finally { await retire(); }
