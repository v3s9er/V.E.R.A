/** Actual host hot paths with public synthetic inputs. This does not measure inference. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextBroker } from '../packages/agent/src/context-broker.js';
import { McpDiscovery } from '../packages/agent/src/plugins/mcp-discovery.js';
import { NativeRunScheduler } from '../packages/agent/src/ai/native-run-scheduler.js';
import type { PerformanceSample } from '../packages/agent/src/evaluation/performance-metrics.js';
import { argumentsOf, integer, report, finishReport } from './performance-common.js';

const options = argumentsOf(process.argv.slice(2), ['samples', 'out', 'baseline']);
const count = integer(options.samples, 100, 20, 1000);
const scratch = mkdtempSync(join(tmpdir(), 'mrrobot-local-perf-'));
const samples: PerformanceSample[] = [];
const evidence = 'Synthetic evidence. 요청😀\n'.repeat(2048);
const toolPage = { tools: Array.from({ length: 250 }, (_, i) => ({ name: `synthetic_tool_${i}`,
  description: 'Synthetic tool description. '.repeat(10), inputSchema: { type: 'object' as const,
    properties: Object.fromEntries(Array.from({ length: 12 }, (_, j) => [`field_${j}`, { type: 'string', description: 'Bounded synthetic parameter.' }])) } })) };
try {
  const path = join(scratch, 'synthetic-evidence.txt'); writeFileSync(path, evidence, 'utf8');
  const broker = new ContextBroker(scratch);
  const request = 'Keep this original task. Inspect bounded evidence, retain Korean text, and state uncertainty.';
  const handoffs = Array.from({ length: 24 }, (_, i) => ({ label: `review-${i}`, text: `HEAD-${i} ` + 'Synthetic 한글😀 '.repeat(2000) + ` TAIL-${i}` }));
  const discovery = new McpDiscovery();
  let listCalls = 0;
  const list = async () => { listCalls++; return toolPage; };
  const cases: Array<[string, () => Promise<number> | number]> = [
    ['context.read.cold16k', () => { broker.invalidate(path); const v = broker.read(path, 16_384); assert.equal(v.cached, false); assert.ok(evidence.startsWith(v.content)); return Buffer.byteLength(v.content); }],
    ['context.read.warm16k', () => { const v = broker.read(path, 16_384); assert.equal(v.cached, true); assert.ok(evidence.startsWith(v.content)); return Buffer.byteLength(v.content); }],
    ['context.pack.24handoffs', () => { const v = broker.rolePack('reviewer', request, handoffs, 18_000); assert.ok(v.includes(request)); assert.ok(v.length <= 18_000); assert.equal((v.match(/HEAD-/g) ?? []).length, 24); return Buffer.byteLength(v); }],
    ['mcp.discovery.cold250', async () => { discovery.clear(); const before = listCalls; const v = await discovery.discover('synthetic', { limit: 12 }, list); assert.equal(listCalls, before + 1); assert.equal(v.tools?.length, 12); return Buffer.byteLength(JSON.stringify(v)); }],
    ['mcp.discovery.warm250', async () => { const before = listCalls; const v = await discovery.discover('synthetic', { limit: 12 }, list); assert.equal(listCalls, before); assert.equal(v.tools?.length, 12); return Buffer.byteLength(JSON.stringify(v)); }],
    ['mcp.schema.oneOf250', async () => { const before = listCalls; const v = await discovery.discover('synthetic', { tool: 'synthetic_tool_42' }, list); assert.equal(listCalls, before); assert.ok('tool' in v); assert.equal(v.tool?.name, 'synthetic_tool_42'); return Buffer.byteLength(JSON.stringify(v)); }],
    ['scheduler.fifo32', async () => {
      const scheduler = new NativeRunScheduler(1, 32), release = await scheduler.acquire('head');
      const order: number[] = [];
      const pending = Array.from({ length: 32 }, (_, i) => scheduler.acquire(`queued-${i}`).then(done => { order.push(i); done(); }));
      release(); await Promise.all(pending); assert.deepEqual(order, Array.from({ length: 32 }, (_, i) => i)); return 0;
    }],
    ['scheduler.cancel32', async () => {
      const scheduler = new NativeRunScheduler(1, 32), release = await scheduler.acquire('head');
      const aborts = Array.from({ length: 32 }, () => new AbortController());
      let cancelled = 0;
      const pending = aborts.map((a, i) => scheduler.acquire(`queued-${i}`, a.signal).then(() => assert.fail('cancelled work ran'), () => { cancelled++; }));
      for (const a of aborts) a.abort(); await Promise.all(pending); assert.equal(cancelled, 32); release(); (await scheduler.acquire('after'))(); return 0;
    }],
  ];
  for (const [caseId, execute] of cases) {
    for (let i = 0; i < 5; i++) await execute(); // Exclude setup/JIT warmup, not the per-case declared cold cache.
    for (let repetition = 0; repetition < count; repetition++) {
      const start = performance.now();
      const outputBytes = await execute();
      samples.push({ caseId, repetition, completionMs: performance.now() - start, firstTextMs: null,
        completed: true, qualityPassed: true, promptTokens: null, completionTokens: null, cachedPromptTokens: null, outputBytes });
    }
  }
  const result = report('host-hotpaths-v1', 'local', { samplesPerCase: count, warmupPerCase: 5,
    evidenceBytes: Buffer.byteLength(evidence), toolCount: 250, handoffCount: 24, contextBudget: 18_000,
    rawMcpPageBytes: Buffer.byteLength(JSON.stringify(toolPage)), concurrency: 1 }, [
      'packages/agent/src/context-broker.ts', 'packages/agent/src/plugins/mcp-discovery.ts',
      'packages/agent/src/ai/native-run-scheduler.ts', 'scripts/performance-local.ts'], samples);
  finishReport(result, options.out, options.baseline);
} finally { rmSync(scratch, { recursive: true, force: true }); }
