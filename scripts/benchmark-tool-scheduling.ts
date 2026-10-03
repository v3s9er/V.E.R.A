import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { executeToolBatch } from '../packages/agent/src/ai/tool-batch.js';
import { McpDiscovery } from '../packages/agent/src/plugins/mcp-discovery.js';

// Reproduce the prior fixed-three algorithm on the same synthetic read delays.
// This is scheduler latency, not an LLM/model accuracy benchmark.
const durations = [120, 15, 15, 90, 15, 15];
async function sample(current: boolean) {
  const calls = durations.map(ms => ({ name: 'read_file', ms }));
  const started = performance.now();
  const execute = async (call: { ms: number }, index: number) => { await delay(call.ms); return index; };
  let results: number[] = [];
  if (current) results = await executeToolBatch(calls, execute);
  else for (let i = 0; i < calls.length; i += 3) {
    const group = await Promise.all(calls.slice(i, i + 3).map((call, offset) => execute(call, i + offset)));
    results.push(...group);
  }
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  return Math.round((performance.now() - started) * 10) / 10;
}
const samples = { before: [] as number[], after: [] as number[] };
for (let i = 0; i < 6; i++) {
  // Alternate order to reduce warm-up / time-order bias.
  if (i % 2) { samples.after.push(await sample(true)); samples.before.push(await sample(false)); }
  else { samples.before.push(await sample(false)); samples.after.push(await sample(true)); }
}
const median = (v: number[]) => { const sorted = [...v].sort((a, b) => a - b); return (sorted[2] + sorted[3]) / 2; };

// Count the serialized discovery context necessary to find a known late tool
// and load its schema. The schema call is included on both sides.
const tools = Array.from({ length: 240 }, (_, i) => ({
  name: i === 239 ? 'find_symbol' : `unrelated_${i}`,
  description: i === 239 ? 'Locate a named code symbol' : 'Unrelated fixture operation',
  inputSchema: { type: 'object' as const, properties: { name: { type: 'string' } } },
}));
const list = async () => ({ tools });
let beforeChars = 0, beforeCalls = 0;
const prior = new McpDiscovery(); let cursor: string | undefined;
while (true) {
  const page = await prior.discover('fixture', { cursor }, list);
  beforeChars += JSON.stringify(page).length; beforeCalls++;
  if (page.tools?.some(t => t.name === 'find_symbol')) {
    beforeChars += JSON.stringify(await prior.discover('fixture', { cursor, tool: 'find_symbol' }, list)).length; beforeCalls++; break;
  }
  assert.ok(page.nextCursor); cursor = page.nextCursor;
}
const current = new McpDiscovery();
const found = await current.discover('fixture', { query: 'find symbol' }, list);
const selected = found.tools![0]; assert.equal(selected.name, 'find_symbol'); assert.ok('cursor' in selected);
const schema = await current.discover('fixture', { tool: selected.name, cursor: selected.cursor }, list);
assert.ok('tool' in schema);
assert.deepEqual(schema.tool?.inputSchema, tools[239].inputSchema);
console.log(JSON.stringify({
  fixtureOnly: true, noPaidModelCalls: true,
  scheduling: { durations, samples, medianBeforeMs: median(samples.before), medianAfterMs: median(samples.after) },
  discovery: { catalogSize: tools.length, beforeCalls, afterCalls: 2, beforeChars, afterChars: JSON.stringify(found).length + JSON.stringify(schema).length, sameSchema: true },
}, null, 2));
