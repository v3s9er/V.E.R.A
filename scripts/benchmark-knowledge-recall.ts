/** Deterministic retrieval regression, NOT model accuracy or a public leaderboard. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import type { MemoryItem } from '@mr-robot/shared';
import { retrieveKnowledge, type KnowledgeResult } from '../packages/agent/src/ontology.js';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--baseline' || !/^[a-f0-9]{7,40}$/.test(args[1]) || args[2] !== '--out') {
  throw new Error('Use --baseline COMMIT_HEX --out NEW_REPORT_JSON');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 });
const commit = git(['rev-parse', '--verify', `${args[1]}^{commit}`]).trim();
const paths = ['packages/agent/src/ontology.ts', 'packages/agent/src/ontology-index.ts'];
const old = paths.map(path => git(['show', `${commit}:${path}`]));
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const moduleUrl = (text: string) => `data:text/javascript;base64,${Buffer.from(transformSync(text,
  { loader: 'ts', format: 'esm', target: 'es2022' }).code).toString('base64')}`;
assert.ok(old[0].includes("from './ontology-index.js'"), 'Baseline dependency must be resolved explicitly');
const baseline = await import(moduleUrl(old[0].replace("from './ontology-index.js'", `from '${moduleUrl(old[1])}'`))) as
  { retrieveKnowledge: typeof retrieveKnowledge };
const fact = (s: string, p: string, o: string, id: string, at = 1): MemoryItem => ({
  id, text: `${s} ${p} ${o}`, tags: [], createdAt: 1, updatedAt: at, source: 'synthetic-benchmark',
  relationMode: 'fact', relation: { subject: s, predicate: p, object: o },
});
const has = (r: KnowledgeResult, s: string, p: string, o: string) =>
  r.facts.some(f => f.subject === s && f.predicate === p && f.object === o && f.status !== 'unresolved');
type Case = { id: string; rows: MemoryItem[]; query: string; check: (r: KnowledgeResult) => boolean };
const cases: Case[] = [];
for (const count of [100, 1000, 10000]) {
  for (const name of ['@fixture/service', 'components/service', 'service.backend']) {
    const rows = [fact(name, 'status', 'blocked', 'target'),
      ...Array.from({ length: count }, (_, i) => fact(`${name}${i}`, 'status', 'ready', `n${i}`, i+10))];
    cases.push({ id: `exact-${name}-${count}`, rows, query: `${name}의 상태는?`,
      check: r => r.metrics.asserted === 1 && has(r, name, 'status', 'blocked') });
    cases.push({ id: `absent-${name}-${count}`, rows, query: `${name}-absent 상태`, check: r => r.context === '' });
  }
  const rows = [fact('Service', 'depends_on', 'Queue', 'sq'), fact('Queue', 'depends_on', 'Storage', 'qs'),
    fact('Storage', 'depends_on', 'Leaf', 'sl'), fact('Service', 'part_of', 'Project', 'sp'),
    fact('Leaf', 'status', 'blocked', 'old'), fact('Leaf', 'status', 'ready', 'new', count+100),
    ...Array.from({ length: count }, (_, i) => fact(`Sibling${i}`, 'part_of', 'Project', `n${i}`, i+10))];
  cases.push({ id: `hub-${count}`, rows, query: 'Service dependencies',
    check: r => has(r, 'Service', 'depends_on', 'Leaf') && r.conflicts.some(c => c.subject === 'Leaf') });
}
cases.push({ id: 'ordinary-proof-control', rows: [fact('A', 'depends_on', 'B', 'a'), fact('B', 'depends_on', 'C', 'b')],
  query: 'A', check: r => has(r, 'A', 'depends_on', 'C') && !r.metrics.truncated });
cases.push({ id: 'cycle-control', rows: [fact('A', 'depends_on', 'B', 'a'), fact('B', 'depends_on', 'A', 'b'), fact('B', 'depends_on', 'C', 'c')],
  query: 'A', check: r => !has(r, 'A', 'depends_on', 'C') && r.conflicts.some(c => c.kind === 'cycle') });
cases.push({ id: 'literal-status-control', rows: [fact('A', 'status', 'ready', 'a'), fact('B', 'status', 'ready', 'b')],
  query: 'A status', check: r => r.metrics.asserted === 1 && has(r, 'A', 'status', 'ready') });
const round = (n: number) => Math.round(n*1000)/1000;
const results = cases.map(c => {
  const timings = { before: [] as number[], after: [] as number[] };
  const outcomes: Record<string, { passed: boolean; contextBytes: number; asserted: number }> = {};
  for (let i = 0; i < 5; i++) for (const side of (i % 2 ? ['after', 'before'] : ['before', 'after']) as ('before' | 'after')[]) {
    const start = performance.now();
    const r = (side === 'before' ? baseline.retrieveKnowledge : retrieveKnowledge)(c.rows, c.query);
    timings[side].push(performance.now()-start);
    const outcome = { passed: c.check(r), contextBytes: r.metrics.contextBytes, asserted: r.metrics.asserted };
    if (outcomes[side]) assert.deepEqual(outcome, outcomes[side], 'deterministic repetitions must agree');
    outcomes[side] = outcome;
    assert.ok(r.metrics.asserted <= 128 && r.facts.length <= 512 && r.metrics.contextBytes <= 7000);
    if (side === 'after') assert.ok(outcome.passed, c.id);
  }
  return { id: c.id, records: c.rows.length, fixtureSha256: digest(JSON.stringify([c.rows,c.query])),
    ...Object.fromEntries(['before','after'].map(side => [side, { ...outcomes[side],
      samplesMs: timings[side as 'before' | 'after'].map(round),
      p50Ms: round([...timings[side as 'before' | 'after']].sort((a,b)=>a-b)[2]) }])) };
});
const report = { schemaVersion: 1, fixtureOnly: true, modelCalls: 0, noNetwork: true, queryCache: false,
  includesIndexBuild: true, repetitions: 5, alternatingOrder: true, node: process.version,
  baseline: { commit, sha256: old.map(digest) }, current: { sha256: paths.map(path => digest(readFileSync(new URL(`../${path}`, import.meta.url),'utf8'))) },
  summary: Object.fromEntries(['before','after'].map(side => [side, { passed: results.filter(r => (r as any)[side].passed).length, total: results.length }])),
  limits: 'Synthetic algorithm fixtures with parameter variants, not independent difficult tasks, model accuracy, token counts or application latency.', results };
writeFileSync(args[3], `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ ...report.summary, reportWritten: true, modelCalls: 0 }));
