import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryItem } from '@mr-robot/shared';
import { retrieveIndexedKnowledge, retrieveKnowledge } from '../src/ontology.js';
import { KnowledgeIndex, KnowledgeIndexCache } from '../src/ontology-index.js';
import { MemoryStore } from '../src/memory.js';

const fact = (subject: string, predicate: string, object: string, id: string, updatedAt = 1): MemoryItem => ({
  id, text: `${subject} ${predicate} ${object}`, tags: [], createdAt: 1, updatedAt,
  source: 'fixture', relationMode: 'fact', relation: { subject, predicate, object },
});
const noise = (count: number) => Array.from({ length: count }, (_, i) => fact(`noise${i}`, 'status', 'ready', `n${i}`, 100 + i));
const has = (result: ReturnType<typeof retrieveKnowledge>, subject: string, predicate: string, object: string) =>
  result.facts.some(f => f.subject === subject && f.predicate === predicate && f.object === object);

test('admission preserves both old proof branches and old conflicts at ten thousand records', () => {
  const relevant = [
    fact('Target', 'is_a', 'Leaf', 'tl'), fact('Leaf', 'subclass_of', 'Root', 'lr'),
    fact('Target', 'is_a', 'OtherLeaf', 'to'), fact('OtherLeaf', 'subclass_of', 'Root', 'or'),
    fact('Target', 'status', 'blocked', 'old'), fact('Target', 'status', 'ready', 'new', 20000),
  ];
  const rows = [...relevant, ...noise(10000 - relevant.length)];
  const forward = retrieveKnowledge(rows, 'Target status');
  const reverse = retrieveKnowledge([...rows].reverse(), 'Target status');
  assert.equal(forward.metrics.asserted, relevant.length);
  assert.equal(forward.metrics.truncated, false);
  assert.ok(has(forward, 'Target', 'is_a', 'Root'));
  assert.ok(has(forward, 'Target', 'is_a', 'OtherLeaf'));
  assert.deepEqual(forward.conflicts[0]?.evidence, ['new', 'old']);
  assert.deepEqual(reverse.facts, forward.facts, 'admission and selected provenance must be input-order independent');
  assert.equal(reverse.context, forward.context);
  assert.doesNotMatch(forward.context, /noise/);
});

test('exactly exhausted graph frontier is complete while a reachable seventh hop is marked partial', () => {
  const chain = (edges: number) => Array.from({ length: edges }, (_, i) => fact(`Node${i}`, 'requires', `Node${i + 1}`, `e${i}`));
  const complete = retrieveKnowledge(chain(7), 'Node0');
  assert.equal(complete.metrics.asserted, 7);
  assert.equal(complete.metrics.truncated, false, 'last permitted hop may finish the entire component');
  assert.ok(has(complete, 'Node6', 'requires', 'Node7'));
  const partial = retrieveKnowledge(chain(8), 'Node0');
  assert.equal(partial.metrics.asserted, 7);
  assert.equal(partial.metrics.truncated, true);
  assert.match(partial.context, /Knowledge is partial/);
});

test('disconnected positive matches past the seed limit cannot silently appear complete', () => {
  const rows = Array.from({ length: 25 }, (_, i) => fact(`Target ${i}`, 'requires', `Item${i}`, `s${i}`, i + 1));
  const result = retrieveKnowledge(rows, 'Target');
  assert.equal(result.metrics.asserted, 24);
  assert.equal(result.metrics.truncated, true);
  assert.match(result.context, /Knowledge is partial/);
});

test('large unrelated or superseded inputs do not create a false partial flag', () => {
  const relevant = fact('Target', 'status', 'ready', 'kept');
  const obsolete = { ...fact('Target', 'status', 'blocked', 'obsolete', 20000), supersededBy: relevant.id };
  const rows = [obsolete, ...noise(10000), relevant];
  const found = retrieveKnowledge(rows, 'Target');
  assert.equal(found.metrics.asserted, 1);
  assert.equal(found.metrics.conflicts, 0);
  assert.equal(found.metrics.truncated, false);
  assert.doesNotMatch(found.context, /blocked|obsolete/);
  const absent = retrieveKnowledge(rows, 'MissingEntity');
  assert.equal(absent.context, '');
  assert.equal(absent.metrics.truncated, false);
  assert.deepEqual(absent.facts, []);
});

test('dense admission and escaped Unicode evidence obey graph and byte limits without dangling references', () => {
  const rows = Array.from({ length: 200 }, (_, i) => fact('Target', 'requires', `Value${i}한글😀`, `dense-${i}`, i + 1));
  for (const row of rows) row.source = 'quoted "source"\n한글😀'.repeat(50);
  const result = retrieveKnowledge(rows, 'Target');
  assert.ok(result.metrics.asserted <= 128);
  assert.ok(result.facts.length <= 512);
  assert.equal(result.metrics.truncated, true);
  assert.ok(Buffer.byteLength(result.context) <= 7000);
  assert.equal(result.metrics.contextBytes, Buffer.byteLength(result.context));
  const references = new Set([...result.context.matchAll(/^SOURCE (m\d+) /gm)].map(match => match[1]));
  assert.ok(references.size > 0);
  for (const line of result.context.split('\n').filter(line => line.startsWith('{'))) {
    for (const reference of JSON.parse(line).evidence) assert.ok(references.has(reference));
  }
});

test('scope filtering precedes admission and ephemeral observations never poison saved-memory cache', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ontology-admission-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const saved = [
    { ...fact('Target', 'is_a', 'Leaf', 'saved-target'), workspaceId: 'one', conversationId: 'ticket' },
    { ...fact('Leaf', 'subclass_of', 'Root', 'saved-taxonomy'), workspaceId: 'one' },
    { ...fact('Target', 'owner', 'PRIVATE_OTHER_SCOPE', 'private'), workspaceId: 'two' },
    ...noise(3000).map(row => ({ ...row, workspaceId: 'two' })),
  ];
  writeFileSync(join(directory, 'memory.json'), JSON.stringify(saved));
  const store = new MemoryStore(directory);
  const scope = { workspaceId: 'one', conversationId: 'ticket' };
  const initial = store.inspect('Target', scope);
  assert.ok(has(initial, 'Target', 'is_a', 'Root'));
  assert.doesNotMatch(initial.context, /PRIVATE_OTHER_SCOPE|noise/);
  const observed = store.inspect('Target', scope, [fact('Target', 'status', 'ephemeral', 'observed')]);
  assert.ok(has(observed, 'Target', 'status', 'ephemeral'));
  const again = store.inspect('Target', scope);
  assert.equal(again.context, initial.context);
  assert.doesNotMatch(again.context, /ephemeral|observed/);
  assert.equal(store.inspect('Target', { workspaceId: 'one', conversationId: 'other-ticket' }).context, '');
  assert.equal(store.inspect('Target').context, '');
  const other = store.inspect('Target', { workspaceId: 'two' });
  assert.ok(has(other, 'Target', 'owner', 'PRIVATE_OTHER_SCOPE'));
  assert.doesNotMatch(other.context, /saved-target|saved-taxonomy/);
});

test('indexed exact-token and Unicode-substring recall preserve entity priority and raw identities', () => {
  const rows = [
    fact('Atlas', 'status', 'ready', 'ascii'), fact('Ａｔｌａｓ', 'status', 'ready', 'width'),
    fact('Atlas2', 'status', 'ready', 'suffix'), fact('myAtlas', 'status', 'ready', 'prefix'),
    fact('업무프로젝트', 'status', 'ready', 'unicode'), fact('Other', 'status', 'ready', 'text'),
  ];
  rows[0].tags = ['tagword']; rows[5].text = 'atlas tagword 특별';
  const index = new KnowledgeIndex(rows);
  assert.deepEqual(index.matches(['atlas']).map(match => [match.item.id, match.score]).sort(), [['ascii', 4], ['width', 4]]);
  assert.deepEqual(index.matches(['atlas', 'tagword']).map(match => [match.item.id, match.score]).sort(), [['ascii', 5], ['width', 4]]);
  assert.deepEqual(index.matches(['프로젝트']).map(match => match.item.id), ['unicode']);
  assert.deepEqual(index.matches(['특별']).map(match => match.item.id), ['text']);
  const result = retrieveIndexedKnowledge(index, 'Atlas의 상태는?');
  assert.ok(has(result, 'Atlas', 'status', 'ready'));
  assert.ok(has(result, 'Ａｔｌａｓ', 'status', 'ready'));
  assert.doesNotMatch(result.context, /Atlas2|myAtlas/);
});

test('index snapshots cannot be changed by later caller mutation or neighbor access', () => {
  const rows = [fact('Target', 'is_a', 'Leaf', 'target'), fact('Leaf', 'subclass_of', 'Root', 'taxonomy')];
  const index = new KnowledgeIndex(rows);
  rows[0].relation!.object = 'Modified'; rows[0].tags.push('new-tag'); rows[1].supersededBy = 'changed';
  assert.ok(has(retrieveIndexedKnowledge(index, 'Target'), 'Target', 'is_a', 'Root'));
  assert.throws(() => (index.neighbors('Target') as MemoryItem[]).push(rows[0]), TypeError);
  assert.throws(() => { index.neighbors('Target')[0].relation!.object = 'Modified'; }, TypeError);
  assert.deepEqual(index.matches(['new-tag']), []);
});

test('scope index LRU respects count, record and byte budgets without truncating uncached results', () => {
  const rows = [fact('A', 'requires', 'B', 'a'), fact('B', 'requires', 'C', 'b')];
  const cache = new KnowledgeIndexCache({ scopes: 2, records: 3, bytes: 100000 });
  let loads = 0;
  const load = (count: number) => () => { loads++; return rows.slice(0, count); };
  const first = cache.get('one', load(1)); cache.get('two', load(2));
  assert.equal(cache.get('one', load(1)), first);
  assert.equal(loads, 2);
  cache.get('three', load(2));
  assert.deepEqual(cache.stats().records, 3); assert.equal(cache.stats().scopes, 2);
  cache.get('two', load(2)); assert.equal(loads, 4, 'least recently used scope was evicted');
  assert.ok(cache.stats().records <= 3 && cache.stats().retainedBytes <= 100000);
  cache.clear(); assert.deepEqual(cache.stats(), { scopes: 0, records: 0, retainedBytes: 0 });
  const small = new KnowledgeIndexCache({ scopes: 8, records: 1, bytes: 100000 });
  const uncached = small.get('oversized', () => rows);
  assert.equal(uncached.size, 2, 'cache limits do not become recall cutoffs');
  assert.equal(small.stats().scopes, 0);
  const bytes = new KnowledgeIndexCache({ scopes: 8, records: 100, bytes: first.retainedBytes - 1 });
  assert.equal(bytes.get('bytes', () => rows.slice(0, 1)).size, 1);
  assert.equal(bytes.stats().scopes, 0);
  assert.throws(() => new KnowledgeIndexCache({ scopes: -1, records: 1, bytes: 1 }), /limits/);
});

test('saved-memory edits invalidate reused indexes across distinct uncached queries', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ontology-index-invalidation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new MemoryStore(directory);
  const scope = { workspaceId: 'one' };
  const old = store.add('Target status old', [], { ...scope, relationMode: 'fact', relation: { subject: 'Target', predicate: 'status', object: 'old' } });
  assert.ok(has(store.inspect('Target query1', scope), 'Target', 'status', 'old'));
  const fresh = store.add('Target status fresh', [], { ...scope, replacesId: old.id, relationMode: 'fact', relation: { subject: 'Target', predicate: 'status', object: 'fresh' } });
  const replaced = store.inspect('Target query2', scope);
  assert.ok(has(replaced, 'Target', 'status', 'fresh')); assert.doesNotMatch(replaced.context, /"object":"old"/);
  store.remove(fresh.id);
  assert.equal(store.inspect('Target query3', scope).context, '');
});

test('fresh observations reuse the scoped saved index but never reuse observation results', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ontology-observed-overlay-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'memory.json'), JSON.stringify([
    ...noise(3000), { ...fact('Target', 'is_a', 'Leaf', 'saved'), workspaceId: 'one' },
    { ...fact('Target', 'owner', 'PRIVATE_OTHER_SCOPE', 'other'), workspaceId: 'two' },
  ]));
  let builds = 0;
  const get = KnowledgeIndexCache.prototype.get;
  t.mock.method(KnowledgeIndexCache.prototype, 'get', function(this: KnowledgeIndexCache, key: string, load: () => readonly MemoryItem[]) {
    return get.call(this, key, () => { builds++; return load(); });
  });
  const store = new MemoryStore(directory), scope = { workspaceId: 'one' };
  for (let i = 0; i < 5; i++) {
    const observed = [fact('Leaf', 'subclass_of', `Root${i}`, `observed-${i}`),
      { ...fact('Target', 'owner', 'PRIVATE_OBSERVATION', 'excluded'), workspaceId: 'two' }];
    const result = store.inspect('Target repeated-query', scope, observed);
    assert.ok(has(result, 'Target', 'is_a', `Root${i}`));
    assert.doesNotMatch(result.context, /PRIVATE_/);
    if (i) assert.equal(has(result, 'Target', 'is_a', `Root${i - 1}`), false);
  }
  assert.equal(builds, 1, 'the full saved scope must be indexed once, not once per observation');
  assert.equal(has(store.inspect('Target saved-only', scope), 'Target', 'is_a', 'Root4'), false);
  const added = store.add('Target status fresh', [], { ...scope, relationMode: 'fact', relation: { subject: 'Target', predicate: 'status', object: 'fresh' } });
  assert.ok(has(store.inspect('Target after-save', scope, [fact('Leaf', 'subclass_of', 'AfterSave', 'fresh')]), 'Target', 'status', 'fresh'));
  assert.equal(builds, 2, 'saving invalidates the reusable scope even when observations are supplied');
  store.remove(added.id);
  assert.equal(has(store.inspect('Target after-remove', scope, [fact('Leaf', 'subclass_of', 'AfterRemove', 'fresh')]), 'Target', 'status', 'fresh'), false);
  assert.equal(builds, 3);
});

test('observation overlays preserve full rebuild semantics, global entity priority and duplicate IDs', () => {
  const saved = [fact('Target', 'is_a', 'Leaf', 'shared', 10), fact('Leaf', 'subclass_of', 'Root', 'taxonomy'),
    fact('Other', 'status', 'ready', 'text'), fact('업무프로젝트', 'status', 'ready', 'unicode')];
  saved[2].text = 'Target special';
  const observations = [
    fact('Target', 'status', 'blocked', 'observed'),
    fact('Special', 'status', 'ready', 'entity'),
    fact('Other', 'owner', 'Owner', 'shared', 10),
    fact('Target', 'owner', 'DifferentOwner', 'shared', 10),
    { ...fact('Target', 'status', 'obsolete', 'obsolete'), supersededBy: 'observed' },
  ];
  const stable = (result: ReturnType<typeof retrieveKnowledge>) => ({ ...result, metrics: { ...result.metrics, retrievalMs: 0 } });
  const index = new KnowledgeIndex(saved);
  for (const rows of [observations.slice(0, 2), observations, [...observations].reverse()]) {
    const overlay = index.withObservations(rows);
    for (const query of ['Target special', 'Special Target', '프로젝트', 'Other Target', 'Missing']) {
      assert.deepEqual(stable(retrieveIndexedKnowledge(overlay, query)), stable(retrieveKnowledge([...saved, ...rows], query)), query);
    }
    assert.equal(overlay.size, new KnowledgeIndex([...saved, ...rows]).size);
  }
  const fresh = [fact('Leaf', 'subclass_of', 'Ephemeral', 'fresh')];
  const overlay = index.withObservations(fresh);
  fresh[0].relation!.object = 'MUTATED';
  assert.ok(has(retrieveIndexedKnowledge(overlay, 'Target'), 'Target', 'is_a', 'Ephemeral'));
  assert.equal(has(retrieveIndexedKnowledge(index, 'Target'), 'Target', 'is_a', 'Ephemeral'), false);
  assert.throws(() => (overlay.neighbors('Leaf') as MemoryItem[]).push(fresh[0]), TypeError);
  const twice = overlay.withObservations([fact('Target', 'status', 'next', 'next')]);
  assert.ok(has(retrieveIndexedKnowledge(twice, 'Target'), 'Target', 'is_a', 'Ephemeral'));
  assert.ok(has(retrieveIndexedKnowledge(twice, 'Target'), 'Target', 'status', 'next'));
});

test('partitioned overlays agree with rebuilding mixed-ID, Unicode and graph fixtures', () => {
  let state = 0x71c039a5;
  const random = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  const entities = ['Target', 'Other', 'Third', '업무프로젝트', 'Ａｔｌａｓ'];
  for (let fixture = 0; fixture < 80; fixture++) {
    const rows = Array.from({ length: 12 }, (_, i) => {
      const row = fact(entities[random(entities.length)], ['requires', 'depends_on', 'status'][random(3)],
        entities[random(entities.length)], `id-${random(10)}`, random(4));
      row.text = ['Target reference', 'textonly', '프로젝트 기록'][random(3)];
      if (i % 7 === 6) row.supersededBy = 'new';
      return row;
    });
    const at = 1 + random(10), overlay = new KnowledgeIndex(rows.slice(0, at)).withObservations(rows.slice(at));
    for (const query of ['Target Third', '프로젝트', 'textonly', 'NoMatch']) {
      const expected = retrieveKnowledge(rows, query), actual = retrieveIndexedKnowledge(overlay, query);
      assert.deepEqual({ ...actual, metrics: { ...actual.metrics, retrievalMs: 0 } },
        { ...expected, metrics: { ...expected.metrics, retrievalMs: 0 } }, `fixture ${fixture}/${query}`);
    }
  }
});
