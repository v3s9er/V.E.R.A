import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunProgress } from '../src/server/run-progress.js';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelemetryStore, type RoutingTrace } from '../src/telemetry.js';

const trace = (n: number): RoutingTrace => ({ id: String(n), at: n, model: 'fixture-model', promptTokens: 100, completionTokens: 20, toolCalls: 1, latencyMs: 100 + n, estimatedCost: 0, ok: true });

test('first visible text latency ignores status, empty deltas, and late events', () => {
  let clock = 100;
  const run = new RunProgress(() => clock);
  run.transition('working'); clock = 500;
  run.text(''); assert.equal(run.firstTextLatencyMs(), undefined);
  clock = 800; run.text('hello'); assert.equal(run.firstTextLatencyMs(), 700);
  clock = 900; run.text(' world'); assert.equal(run.firstTextLatencyMs(), 700);
  run.transition('completed'); clock = 2000; run.text('late');
  assert.equal(run.firstTextLatencyMs(), 700);
  const stopped = new RunProgress(() => clock);
  stopped.transition('cancelled'); stopped.text('late');
  assert.equal(stopped.firstTextLatencyMs(), undefined);
});

test('telemetry rotation, restart, defensive copies and bounded limits preserve measurements', () => {
  const home = mkdtempSync(join(tmpdir(), 'mrrobot-telemetry-test-'));
  try {
    const store = new TelemetryStore(home);
    for (let i = 0; i < 1210; i++) store.record(trace(i));
    assert.equal(store.list(9999).length, 1010);
    assert.equal(store.list()[0].id, '1209');
    assert.deepEqual(store.list(0), []); assert.deepEqual(store.list(-10), []);
    const copy = store.list(1); copy[0].model = 'modified';
    assert.equal(store.list(1)[0].model, 'fixture-model');
    const summary = store.summary(); summary.byModel[0].model = 'modified';
    assert.equal(store.summary().byModel[0].model, 'fixture-model');
    assert.equal(store.summary().turns, 1000);
    assert.deepEqual(new TelemetryStore(home).summary(), store.summary());
    assert.throws(() => store.record({ ...trace(1), latencyMs: -1 }));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('one malformed row and external appends do not erase valid measurements', () => {
  const home = mkdtempSync(join(tmpdir(), 'mrrobot-telemetry-test-'));
  try {
    const file = join(home, 'routing-traces.jsonl');
    writeFileSync(file, `${JSON.stringify(trace(1))}\n{broken\n${JSON.stringify(trace(2))}\n`);
    const store = new TelemetryStore(home);
    assert.equal(store.list().length, 2);
    appendFileSync(file, `${JSON.stringify({ ...trace(3), firstTextMs: 25, unknownSecret: 'not-part-of-schema' })}\n`);
    assert.equal(store.list().length, 3);
    assert.equal('unknownSecret' in store.list()[0], false);
    const perf = store.summary().performance;
    assert.deepEqual(perf.firstTextMs, { samples: 1, p50: 25, p95: 25 });
    assert.equal(perf.completionMs.samples, 3);
    store.record({ ...trace(4), ok: false, cancelled: true, firstTextMs: 10 });
    assert.equal(store.summary().performance.cancelled, 1);
    assert.equal(store.summary().performance.firstTextMs.samples, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
