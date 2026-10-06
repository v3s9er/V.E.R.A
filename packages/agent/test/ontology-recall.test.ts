import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryItem } from '@mr-robot/shared';
import { retrieveIndexedKnowledge, retrieveKnowledge } from '../src/ontology.js';
import { KnowledgeIndex, knowledgeQueryTokens } from '../src/ontology-index.js';

const fact = (subject: string, predicate: string, object: string, id: string, updatedAt = 1): MemoryItem => ({
  id, text: `${subject} ${predicate} ${object}`, tags: [], createdAt: 1, updatedAt,
  source: 'synthetic-recall-fixture', relationMode: 'fact', relation: { subject, predicate, object },
});
const has = (r: ReturnType<typeof retrieveKnowledge>, s: string, p: string, o: string) =>
  r.facts.some(f => f.subject === s && f.predicate === p && f.object === o && f.status !== 'unresolved');

test('long punctuation has no identifier tokens or invented empty entity', () => {
  assert.deepEqual(knowledgeQueryTokens('@'.repeat(16000)), []);
  assert.deepEqual(knowledgeQueryTokens(`${'@'.repeat(16000)}scope/name`), ['@scope/name']);
});

test('compound identifiers do not retrieve namespace siblings or prefix lookalikes', () => {
  for (const name of ['@acme/api', 'packages/api', 'service.api', '@acme/한글-api']) {
    const rows = [fact(name, 'status', 'blocked', 'target'),
      ...Array.from({ length: 100 }, (_, i) => fact(`${name}${i}`, 'status', 'ready', `n${i}`, i + 10))];
    for (const query of [name, `Inspect ${name}.`, `${name}의 상태는?`]) {
      const r = retrieveKnowledge(rows, query);
      assert.equal(r.metrics.asserted, 1, query);
      assert.equal(r.metrics.truncated, false, query);
      assert.ok(has(r, name, 'status', 'blocked'));
    }
    for (const suffix of ['상태', 'status', 'status: owner']) {
      assert.equal(retrieveKnowledge(rows, `${name}-missing ${suffix}`).context, '');
    }
  }
});

test('colon prose remains searchable and exact identifier mentions in text remain eligible', () => {
  const row = fact('Target', 'status', 'blocked', 'target');
  for (const query of ['Target:status', 'Target:상태', 'Target: status']) {
    assert.ok(has(retrieveKnowledge([row], query), 'Target', 'status', 'blocked'));
  }
  const note = { ...row, text: 'Verified reference to @acme/api' };
  assert.equal(retrieveKnowledge([note], '@acme/api status').metrics.asserted, 1);
  assert.equal(retrieveKnowledge([note], '@acme/missing status').context, '');
});

test('ordinary namespace searches and explicit multiple identifiers still retrieve each match', () => {
  const rows = [fact('@acme/api', 'status', 'blocked', 'api'), fact('@acme/ui', 'status', 'ready', 'ui')];
  for (const query of ['acme', '@acme/api @acme/ui 비교']) {
    const r = retrieveKnowledge(rows, query);
    assert.ok(has(r, '@acme/api', 'status', 'blocked'));
    assert.ok(has(r, '@acme/ui', 'status', 'ready'));
  }
});

test('a high-degree membership hub cannot crowd out a narrow dependency proof or its conflicts', () => {
  const rows = [fact('Target', 'depends_on', 'Middle', 'tm'), fact('Middle', 'depends_on', 'Core', 'mc'),
    fact('Core', 'depends_on', 'Leaf', 'cl'), fact('Leaf', 'status', 'blocked', 'old'),
    fact('Leaf', 'status', 'ready', 'new', 10000), fact('Target', 'part_of', 'Project', 'tp'),
    ...Array.from({ length: 200 }, (_, i) => fact(`Sibling${i}`, 'part_of', 'Project', `n${i}`, i + 10))];
  const forward = retrieveKnowledge(rows, 'Target dependencies');
  const reverse = retrieveKnowledge([...rows].reverse(), 'Target dependencies');
  assert.ok(has(forward, 'Target', 'depends_on', 'Leaf'));
  assert.ok(forward.conflicts.some(c => c.subject === 'Leaf' && c.kind === 'single_value'));
  assert.equal(forward.metrics.truncated, true, 'omitted hub branches must remain explicitly partial');
  assert.ok(forward.metrics.asserted <= 128 && forward.metrics.contextBytes <= 7000);
  assert.equal(reverse.context, forward.context, 'recall must not depend on storage order');
});

test('compound identity recall is identical in saved/observed overlays without changing raw entity IDs', () => {
  const saved = [fact('@acme/api', 'depends_on', '@acme/core', 'a'), fact('@acme/core', 'status', 'ready', 'b')];
  const observed = [fact('@acme/core', 'depends_on', '@acme/data', 'c'), fact('@acme/api2', 'status', 'ready', 'd')];
  for (const query of ['@acme/api', '@acme/missing', '@acme/core의 상태']) {
    const a = retrieveKnowledge([...saved, ...observed], query);
    const b = retrieveIndexedKnowledge(new KnowledgeIndex(saved).withObservations(observed), query);
    assert.equal(a.context, b.context);
    assert.deepEqual(a.facts, b.facts);
  }
});

test('a dense hub does not turn cyclic premises into a clean inferred proof', () => {
  const rows = [fact('Target', 'depends_on', 'Middle', 'tm'), fact('Middle', 'depends_on', 'Target', 'mt'),
    fact('Middle', 'depends_on', 'Leaf', 'ml'), fact('Target', 'part_of', 'Project', 'tp'),
    ...Array.from({ length: 180 }, (_, i) => fact(`Sibling${i}`, 'part_of', 'Project', `n${i}`, i + 10))];
  const r = retrieveKnowledge(rows, 'Target');
  assert.ok(r.conflicts.some(c => c.kind === 'cycle'));
  assert.equal(has(r, 'Target', 'depends_on', 'Leaf'), false);
});

test('named entity conflicts take priority over narrow but numerous downstream branches', () => {
  const rows = [fact('Target', 'status', 'blocked', 'old', 900), fact('Target', 'status', 'ready', 'new', 2000)];
  for (let i = 0; i < 28; i++) {
    rows.push(fact('Target', 'requires', `Branch${i}-0`, `root${i}`, 1000));
    for (let j = 0; j < 5; j++) rows.push(fact(`Branch${i}-${j}`, 'requires', `Branch${i}-${j+1}`, `b${i}-${j}`));
  }
  const r = retrieveKnowledge(rows, 'Target');
  assert.ok(r.conflicts.some(c => c.subject === 'Target' && c.evidence.includes('old') && c.evidence.includes('new')));
  assert.equal(has(r, 'Target', 'status', 'ready'), false, 'a truncated traversal must not hide a direct contradiction');
  assert.equal(r.metrics.truncated, true);
});

test('generic neighbor text cannot hide an omitted exact-identifier text match', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    ...fact(`D${i}`, 'requires', i === 24 ? 'Tail' : `L${i}`, `x${i}`, i+1), text: 'reference @acme/missing',
  }));
  rows.push(fact('Tail', 'status', 'ready', 'tail'));
  const r = retrieveKnowledge(rows, '@acme/missing status');
  assert.equal(r.metrics.asserted, 25);
  assert.equal(r.metrics.truncated, true);
  assert.match(r.context, /Knowledge is partial/);
});
