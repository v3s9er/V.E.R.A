/** Synthetic timings are host/process/streaming diagnostics, NOT model TTFT. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pooledNativeCodex, closeNativeWorkers } from '../packages/agent/src/ai/cli-native-pool.js';
import { waitForCliRetirements } from '../packages/agent/src/ai/cli-process-retirement.js';
import type { NativeAgentRequest, Turn } from '../packages/agent/src/ai/provider.js';
import type { PerformanceSample } from '../packages/agent/src/evaluation/performance-metrics.js';
import { argumentsOf, integer, report, finishReport } from './performance-common.js';

const options = argumentsOf(process.argv.slice(2), ['samples', 'out', 'baseline']);
const count = integer(options.samples, 20, 2, 100);
const scratch = mkdtempSync(join(tmpdir(), 'mrrobot-perf-transport-'));
const samples: PerformanceSample[] = [];
const fixture = fileURLToPath(new URL('../packages/agent/test/fixtures/performance-app-server.mjs', import.meta.url));
const retire = async () => { closeNativeWorkers(); await waitForCliRetirements(process.env); };
const invoke = (req: NativeAgentRequest) => pooledNativeCodex({ command: process.execPath, prefixArgs: [fixture],
  env: process.env, providerId: 'performance-fixture', model: 'synthetic', req });
try {
  for (const condition of ['cold', 'warm', 'cancel'] as const) {
    const history: Turn[] = [];
    for (let repetition = condition === 'warm' ? -1 : 0; repetition < count; repetition++) {
      if (condition !== 'warm') await retire();
      const abort = new AbortController();
      const watchdog = setTimeout(() => abort.abort(), 10_000);
      const input = condition === 'cancel' ? 'CANCEL_FIXTURE' : 'Produce synthetic answer';
      let firstTextMs: number | null = null, cancelAt: number | null = null, text = '', cancelled = false;
      const started = performance.now();
      const req: NativeAgentRequest = { prompt: input, cwd: scratch, permissionMode: 'read-only', signal: abort.signal,
        session: { key: `fixture-${condition}-${condition === 'warm' ? 0 : repetition}`, directory: scratch, history: [...history], input, instructions: 'Synthetic protocol fixture.', context: '' },
        onText: chunk => { if (chunk) { firstTextMs ??= performance.now() - started; text += chunk; } },
        onStatus: status => { if (condition === 'cancel' && status.includes('요청을 검토') && cancelAt === null) { cancelAt = performance.now(); abort.abort(); } } };
      try {
        const result = await invoke(req);
        assert.notEqual(condition, 'cancel'); assert.equal(result.text, 'synthetic answer'); assert.equal(text, result.text);
        history.push({ role: 'user', content: input }, { role: 'assistant', content: result.text });
      } catch (error) {
        if (condition !== 'cancel' || cancelAt === null || !(error instanceof Error) || !/중지/.test(error.message)) throw error;
        cancelled = true; assert.equal(text, '');
      } finally { clearTimeout(watchdog); }
      const elapsed = performance.now() - (cancelAt ?? started);
      if (repetition < 0) continue; // One initialization call excluded; cold case reports process startup separately.
      samples.push({ caseId: `native.${condition}`, repetition, completionMs: elapsed, firstTextMs, completed: true,
        qualityPassed: condition === 'cancel' ? cancelled : firstTextMs !== null && firstTextMs < elapsed,
        promptTokens: null, completionTokens: null, cachedPromptTokens: null, outputBytes: Buffer.byteLength(text) });
    }
    await retire();
  }
  finishReport(report('native-transport-v1', 'synthetic-transport', { samplesPerCondition: count,
    fixtureFirstDeltaDelayMs: 5, fixtureCompletionDelayMs: 20, concurrency: 1 }, [
      'packages/agent/src/ai/cli-native-pool.ts', 'packages/agent/src/ai/cli-session-events.ts',
      'packages/agent/test/fixtures/performance-app-server.mjs', 'scripts/performance-transport.ts'], samples), options.out, options.baseline);
} finally { await retire(); rmSync(scratch, { recursive: true, force: true }); }
