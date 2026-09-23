/** Local storage microbenchmark: synthetic rows only, no model or user data. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { TelemetryStore, type RoutingTrace } from '../packages/agent/src/telemetry.js';

const count = 100;
const scratch = mkdtempSync(join(tmpdir(), 'mrrobot-perf-telemetry-'));
const output = process.argv[2];
const row = (i: number): RoutingTrace => ({ id: `synthetic-${i}`, at: 1_000_000 + i,
  model: 'synthetic-model', providerId: 'synthetic', promptTokens: 100, completionTokens: 20,
  toolCalls: 2, latencyMs: 100, estimatedCost: 0, ok: true });
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)]!;
try {
  const results = [];
  for (const initialRows of [100, 1000]) {
    const home = join(scratch, String(initialRows)); mkdirSync(home);
    writeFileSync(join(home, 'routing-traces.jsonl'), Array.from({ length: initialRows }, (_, i) => JSON.stringify(row(i))).join('\n') + '\n');
    const store = new TelemetryStore(home);
    // One-time load/OS-cache warmup is excluded, exactly the same for both revisions.
    store.list(1000); store.summary();
    for (const operation of ['record', 'list', 'summary'] as const) {
      const samples = [];
      for (let i = 0; i < count; i++) {
        const start = performance.now();
        if (operation === 'record') store.record(row(initialRows + i));
        else if (operation === 'list') store.list(100);
        else store.summary();
        samples.push(performance.now() - start);
      }
      const expected = Math.min(1000, initialRows + count);
      if (store.summary().turns !== expected || store.list(1)[0]?.id !== `synthetic-${initialRows + count - 1}`) throw new Error('Synthetic trace correctness failed');
      results.push({ caseId: `telemetry.${operation}.${initialRows}`, count, p50Ms: percentile(samples, .5), p95Ms: percentile(samples, .95), samplesMs: samples, correct: true });
    }
  }
  const report = { schemaVersion: 1, suite: 'telemetry-storage-v1', createdAt: new Date().toISOString(), sourceSha256: createHash('sha256').update(readFileSync(new URL('../packages/agent/src/telemetry.ts', import.meta.url))).digest('hex'), runtime: { node: process.version, platform: process.platform, arch: process.arch }, inference: false, results };
  if (output) writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ...report, results: results.map(({ samplesMs, ...summary }) => summary) }, null, 2));
} finally { rmSync(scratch, { recursive: true, force: true }); }
