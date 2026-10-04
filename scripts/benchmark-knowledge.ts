import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import type { MemoryItem } from '@mr-robot/shared';
import { retrieveIndexedKnowledge, retrieveKnowledge, type KnowledgeResult } from '../packages/agent/src/ontology.js';
import { KnowledgeIndex } from '../packages/agent/src/ontology-index.js';
import { MemoryStore } from '../packages/agent/src/memory.js';

// Local, synthetic host algorithm comparison only: no model, network, saved
// user memories, latency simulation, or source writes. Compare exact repository
// HEAD code with current code; compile the former into an in-memory data URL.
const root = fileURLToPath(new URL('../', import.meta.url));
const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 });
const head = git(['rev-parse', 'HEAD']).trim();
const baselineSource = git(['show', `${head}:packages/agent/src/ontology.ts`]);
const currentSource = readFileSync(new URL('../packages/agent/src/ontology.ts', import.meta.url), 'utf8');
const currentIndexSource = readFileSync(new URL('../packages/agent/src/ontology-index.ts', import.meta.url), 'utf8');
const currentStoreSource = readFileSync(new URL('../packages/agent/src/memory.ts', import.meta.url), 'utf8');
// Controlled ablation of just the observation path, with the SAME current
// retrieval/proof rules. The reference is the former MemoryStore implementation
// compiled in memory, not a claimed reproduction of the older HEAD algorithm.
const overlayPath = `    const savedIndex = this.knowledgeIndexes.get(JSON.stringify([scope.workspaceId, scope.conversationId]), () => this.items.filter(matchesScope));
    const index = observed.length ? savedIndex.withObservations(observed.filter(matchesScope)) : savedIndex;`;
assert.ok(currentStoreSource.replace(/\r\n/g, '\n').includes(overlayPath), 'update the observed-path reference explicitly if MemoryStore changes');
const rebuildStoreSource = currentStoreSource.replace(/\r\n/g, '\n')
  .replace("import { KnowledgeIndexCache }", "import { KnowledgeIndex, KnowledgeIndexCache }")
  .replace(overlayPath, `    const index = observed.length
      ? new KnowledgeIndex([...this.items, ...observed].filter(matchesScope))
      : this.knowledgeIndexes.get(JSON.stringify([scope.workspaceId, scope.conversationId]), () => this.items.filter(matchesScope));`);
const referenceStoreCode = transformSync(rebuildStoreSource.replace(/from '\.\/(ontology|ontology-index)\.js'/g,
  (_all, name: string) => `from ${JSON.stringify(new URL(`../packages/agent/src/${name}.ts`, import.meta.url).href)}`),
{ loader: 'ts', format: 'esm', target: 'es2022' }).code;
const { MemoryStore: RebuildMemoryStore } = await import(`data:text/javascript;base64,${Buffer.from(referenceStoreCode).toString('base64')}`) as { MemoryStore: typeof MemoryStore };
const compiled = transformSync(baselineSource, { loader: 'ts', format: 'esm', target: 'es2022' }).code;
const baseline = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`) as { retrieveKnowledge: typeof retrieveKnowledge };
const countArgument = process.argv.find(argument => argument.startsWith('--samples='));
const samples = countArgument ? Number(countArgument.slice('--samples='.length)) : 20;
if (!Number.isSafeInteger(samples) || samples < 5 || samples > 20) throw new Error('--samples must be an integer from 5 to 20');
const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const round = (value: number) => Math.round(value * 1000) / 1000;
const summarize = (values: number[]) => {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return { p50Ms: round(ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2),
    p95Ms: round(ordered[Math.ceil(ordered.length * 0.95) - 1]), samplesMs: values.map(round) };
};
const fact = (subject: string, predicate: string, object: string, id: string, updatedAt = 1): MemoryItem => ({
  id, text: `${subject} ${predicate} ${object}`, tags: [], createdAt: 1, updatedAt, source: 'synthetic-fixture',
  relationMode: 'fact', relation: { subject, predicate, object },
});
const dataset = (size: number) => [
  fact('VeraTarget', 'is_a', 'Leaf', 'old-target'), fact('Leaf', 'subclass_of', 'Root', 'old-taxonomy'),
  fact('VeraTarget', 'status', 'blocked', 'old-conflict'), fact('VeraTarget', 'status', 'ready', 'new-status', size + 1000),
  ...Array.from({ length: size - 4 }, (_, i) => fact(`noise${i}`, 'status', 'ready', `noise-${i}`, i + 100)),
];
const correctness = (result: KnowledgeResult, relevant: boolean) => ({
  ancestry: result.facts.some(f => f.subject === 'VeraTarget' && f.predicate === 'is_a' && f.object === 'Root'),
  conflict: result.conflicts.some(c => c.subject === 'VeraTarget' && c.predicate === 'status'),
  relevantAnswerPreserved: relevant ? result.facts.some(f => f.subject === 'VeraTarget' && f.object === 'Root')
    && result.conflicts.some(c => c.subject === 'VeraTarget' && c.predicate === 'status') : result.context === '',
  asserted: result.metrics.asserted, contextBytes: result.metrics.contextBytes, partial: result.metrics.truncated,
});
const cases = [];
for (const size of [100, 3000, 10000]) {
  const rows = dataset(size);
  for (const relevant of [true, false]) {
    const name = relevant ? 'old-proof-and-conflict' : 'no-match';
    const prefix = relevant ? 'VeraTarget status' : 'MissingEntity';
    const indexStarted = performance.now();
    const index = new KnowledgeIndex(rows);
    const indexBuildMs = round(performance.now() - indexStarted);
    // Both implementations see the same unique query for each pair. Direct
    // pure retrieval bypasses MemoryStore's query cache entirely.
    for (let i = 0; i < 3; i++) {
      baseline.retrieveKnowledge(rows, `${prefix} warmup_${name}_${i}`);
      retrieveKnowledge(rows, `${prefix} warmup_${name}_${i}`);
      retrieveIndexedKnowledge(index, `${prefix} warmup_${name}_${i}`);
    }
    const timings = { before: [] as number[], cold: [] as number[], after: [] as number[] };
    const outcomes = {} as Record<'before' | 'cold' | 'after', ReturnType<typeof correctness>>;
    const order = ['before', 'cold', 'after'] as const;
    for (let i = 0; i < samples; i++) {
      for (let j = 0; j < order.length; j++) {
        const side = order[(i + j) % order.length];
        const started = performance.now();
        const query = `${prefix} sample_${name}_${i}`;
        const result = side === 'before' ? baseline.retrieveKnowledge(rows, query) : side === 'cold'
          ? retrieveKnowledge(rows, query) : retrieveIndexedKnowledge(index, query);
        timings[side].push(performance.now() - started);
        outcomes[side] = correctness(result, relevant);
        assert.ok(result.metrics.asserted <= 128 && result.facts.length <= 512 && result.metrics.contextBytes <= 7000);
        if (side !== 'before') {
          assert.equal(outcomes[side].relevantAnswerPreserved, true, `${size}/${name}/${i}`);
          assert.equal(result.metrics.truncated, false, 'unrelated scale must not imply omitted relevant evidence');
        }
      }
    }
    cases.push({ records: size, scenario: name, indexBuildMs, indexRetainedBytesEstimate: index.retainedBytes,
      before: { ...summarize(timings.before), ...outcomes.before }, cold: { ...summarize(timings.cold), ...outcomes.cold },
      after: { ...summarize(timings.after), ...outcomes.after } });
  }
}
const observedCases = [];
const fixtureHome = mkdtempSync(join(tmpdir(), 'knowledge-observed-benchmark-'));
try {
  for (const size of [100, 3000, 10000]) {
    writeFileSync(join(fixtureHome, 'memory.json'), JSON.stringify(dataset(size)));
    const before = new RebuildMemoryStore(fixtureHome), warm = new MemoryStore(fixtureHome);
    const scope = { workspaceId: 'synthetic-project' };
    const observations = (i: number) => [
      { ...fact('Leaf', 'subclass_of', `ObservedRoot${i}`, `manifest-proof-${i}`, i + 1), ...scope },
      { ...fact('FreshTarget', 'status', `observed${i}`, `manifest-status-${i}`, i + 1), ...scope },
    ];
    const initialStart = performance.now();
    warm.retainedContext('VeraTarget observed-initial', scope, { observed: observations(-1) });
    const initialIndexAndLookupMs = round(performance.now() - initialStart);
    const timings = { before: [] as number[], cold: [] as number[], after: [] as number[] };
    const byScenario = Object.fromEntries(['saved-plus-observed-proof', 'observed-only-entity', 'no-match'].map(name =>
      [name, { before: [] as number[], cold: [] as number[], after: [] as number[] }])) as Record<string, typeof timings>;
    const order = ['before', 'cold', 'after'] as const;
    for (let i = 0; i < samples; i++) {
      // Alternate hits and misses at every scale, including 10k. Alternate the
      // hits between an existing saved entity and a fresh-only named entity.
      const scenario = i % 2 ? 'no-match' : i % 4 ? 'observed-only-entity' : 'saved-plus-observed-proof';
      const prefix = scenario === 'no-match' ? 'MissingEntity' : scenario === 'observed-only-entity' ? 'FreshTarget status' : 'VeraTarget status';
      const query = `${prefix} observed_unique_${size}_${i}`, observed = observations(i);
      let expected: KnowledgeResult | undefined;
      for (let j = 0; j < order.length; j++) {
        const side = order[(i + j) % order.length];
        // Constructor fixture I/O is outside the timer; cold includes saved
        // index creation and the real retainedContext plain-memory scan.
        const store = side === 'before' ? before : side === 'cold' ? new MemoryStore(fixtureHome) : warm;
        const start = performance.now();
        const result = store.retainedContext(query, scope, { observed });
        const elapsed = performance.now() - start;
        timings[side].push(elapsed); byScenario[scenario][side].push(elapsed);
        if (scenario === 'saved-plus-observed-proof') {
          assert.ok(result.facts.some(f => f.subject === 'VeraTarget' && f.object === `ObservedRoot${i}`));
          assert.ok(result.conflicts.some(c => c.subject === 'VeraTarget' && c.predicate === 'status'));
        } else if (scenario === 'observed-only-entity') {
          assert.ok(result.facts.some(f => f.subject === 'FreshTarget' && f.object === `observed${i}`));
          assert.equal(result.metrics.asserted, 1);
        } else assert.equal(result.context, '');
        const normalized = { ...result, metrics: { ...result.metrics, retrievalMs: 0 } };
        if (expected) assert.deepEqual(normalized, expected, `${size}/${scenario}/${i}/${side}`);
        expected = normalized;
      }
    }
    observedCases.push({ records: size, observedRecordsPerQuery: 2, initialIndexAndLookupMs,
      before: summarize(timings.before), cold: summarize(timings.cold), after: summarize(timings.after),
      scenarios: Object.fromEntries(Object.entries(byScenario).map(([name, values]) => [name,
        Object.fromEntries(order.map(side => [side, summarize(values[side])]))])),
      equalFactsConflictsAndContext: true });
  }
} finally { rmSync(fixtureHome, { recursive: true, force: true }); }
const proofRows = [
  fact('Target', 'depends_on', 'B', 'tb'), fact('B', 'depends_on', 'C', 'bc'), fact('C', 'depends_on', 'B', 'cb'),
  fact('Target', 'depends_on', 'D', 'td'), fact('D', 'depends_on', 'C', 'dc'), fact('C', 'depends_on', 'End', 'ce'),
];
const proofIndex = new KnowledgeIndex(proofRows);
const proofTimings = { before: [] as number[], cold: [] as number[], after: [] as number[] };
const proofCorrect = { before: false, cold: false, after: false };
const proofOrder = ['before', 'cold', 'after'] as const;
for (let i = 0; i < samples; i++) for (let j = 0; j < proofOrder.length; j++) {
  const side = proofOrder[(i + j) % proofOrder.length], query = `Target proof_sample_${i}`;
  const started = performance.now();
  const result = side === 'before' ? baseline.retrieveKnowledge(proofRows, query) : side === 'cold'
    ? retrieveKnowledge(proofRows, query) : retrieveIndexedKnowledge(proofIndex, query);
  proofTimings[side].push(performance.now() - started);
  const conclusion = result.facts.find(f => f.subject === 'Target' && f.object === 'End');
  proofCorrect[side] = conclusion?.status === 'inferred' && JSON.stringify(conclusion.evidence) === JSON.stringify(['ce', 'dc', 'td']);
  if (side !== 'before') assert.equal(proofCorrect[side], true, 'a cyclic alternative must not erase an independent clean proof');
}
console.log(JSON.stringify({ fixtureOnly: true, noModelCalls: true, noNetwork: true, queryCache: false,
  afterUsesReusableIndex: true, coldIncludesIndexBuild: true,
  uniqueQueriesPerScenario: samples, rotatingExecutionOrder: true, node: process.version, platform: process.platform,
  baseline: { commit: head, sourceSha256: digest(baselineSource) },
  current: { sourceSha256: digest(currentSource), indexSha256: digest(currentIndexSource), storeSha256: digest(currentStoreSource) }, cases,
  observedPath: { api: 'MemoryStore.retainedContext with fresh observations', queryCache: false,
    reference: 'same current rules, former full-rebuild observation path', referenceStoreSha256: digest(rebuildStoreSource),
    constructorAndFixtureIoExcluded: true, plainMemoryScanIncluded: true, cases: observedCases },
  alternativeProof: Object.fromEntries(proofOrder.map(side => [side, { ...summarize(proofTimings[side]), cleanProofPreserved: proofCorrect[side] }])),
}, null, 2));
