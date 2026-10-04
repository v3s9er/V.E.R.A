import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryItem } from '@mr-robot/shared';
import { retrieveKnowledge, type KnowledgeResult } from '../src/ontology.js';

const fact = (subject: string, predicate: string, object: string, id: string): MemoryItem => ({
  id, text: `${subject} ${predicate} ${object}`, tags: [], createdAt: 1, updatedAt: 1,
  source: 'proof-fixture', relationMode: 'fact', relation: { subject, predicate, object },
});
const dependency = (subject: string, object: string, id: string) => fact(subject, 'depends_on', object, id);
const get = (result: KnowledgeResult, subject: string, object: string) => result.facts.find(f => f.subject === subject && f.object === object);
const cyclic = [dependency('Target', 'B', 'tb'), dependency('B', 'C', 'bc'), dependency('C', 'B', 'cb')];

test('an independent acyclic proof survives another derivation involving a cycle', () => {
  const rows = [...cyclic, dependency('Target', 'D', 'td'), dependency('D', 'C', 'dc'), dependency('C', 'End', 'ce')];
  for (const input of [rows, [...rows].reverse()]) {
    const result = retrieveKnowledge(input, 'Target');
    assert.equal(get(result, 'Target', 'C')?.status, 'inferred');
    assert.deepEqual(get(result, 'Target', 'C')?.evidence, ['dc', 'td']);
    assert.equal(get(result, 'Target', 'End')?.status, 'inferred');
    assert.deepEqual(get(result, 'Target', 'End')?.evidence, ['ce', 'dc', 'td']);
    assert.ok(result.conflicts.some(c => c.kind === 'cycle' && c.subject === 'B'));
    assert.ok(result.conflicts.some(c => c.kind === 'cycle' && c.subject === 'C'));
    assert.equal(get(result, 'B', 'C')?.status, 'unresolved');
    assert.equal(get(result, 'C', 'B')?.status, 'unresolved');
    assert.equal(result.metrics.truncated, false);
  }
});

test('a deduction with only cyclic support remains unresolved and never fabricates a clean proof', () => {
  const result = retrieveKnowledge(cyclic, 'Target');
  assert.equal(get(result, 'Target', 'C')?.status, 'unresolved');
  assert.deepEqual(get(result, 'Target', 'C')?.evidence, ['bc', 'tb']);
  assert.equal(get(result, 'Target', 'B')?.status, 'asserted');
});

test('all cyclic premises are excluded from reconstruction, not only one cycle witness', () => {
  const rows = [
    dependency('Target', 'A', 'ta'), dependency('A', 'B', 'ab'), dependency('B', 'A', 'ba'),
    dependency('A', 'C', 'ac'), dependency('C', 'B', 'cb'), dependency('B', 'C', 'bc'),
    dependency('Target', 'D', 'td'), dependency('D', 'C', 'dc'),
  ];
  const result = retrieveKnowledge(rows, 'Target');
  assert.equal(get(result, 'Target', 'C')?.status, 'inferred');
  assert.deepEqual(get(result, 'Target', 'C')?.evidence, ['dc', 'td']);
  assert.equal(get(result, 'Target', 'B')?.status, 'unresolved');
  for (const [subject, object] of [['A', 'B'], ['B', 'A'], ['A', 'C'], ['C', 'B'], ['B', 'C']]) {
    assert.equal(get(result, subject, object)?.status, 'unresolved', `${subject}->${object}`);
  }
});

test('clean taxonomy alternatives do not override entity-specific disjointness or functional conflicts', () => {
  const rows = [
    fact('Target', 'is_a', 'A', 'ta'), fact('A', 'subclass_of', 'B', 'ab'), fact('B', 'subclass_of', 'A', 'ba'),
    fact('Target', 'is_a', 'Clean', 'tc'), fact('Clean', 'subclass_of', 'B', 'clean-b'),
  ];
  const valid = retrieveKnowledge(rows, 'Target');
  assert.equal(get(valid, 'Target', 'B')?.status, 'inferred');
  assert.deepEqual(get(valid, 'Target', 'B')?.evidence, ['clean-b', 'tc']);
  const conflicted = retrieveKnowledge([...rows,
    fact('Target', 'is_a', 'Cold', 'cold'), fact('B', 'disjoint_with', 'Cold', 'disjoint'),
    fact('Target', 'status', 'ready', 'ready'), fact('Target', 'status', 'blocked', 'blocked'),
  ], 'Target');
  assert.equal(get(conflicted, 'Target', 'B')?.status, 'unresolved');
  assert.ok(conflicted.conflicts.some(c => c.kind === 'disjoint_types' && c.subject === 'Target'));
  assert.ok(conflicted.conflicts.some(c => c.kind === 'single_value' && c.subject === 'Target'));
  assert.ok(conflicted.facts.filter(f => f.subject === 'Target' && f.predicate === 'status').every(f => f.status === 'unresolved'));
});

test('dense cyclic alternatives remain graph, proof and context bounded', () => {
  const rows: MemoryItem[] = [];
  for (let i = 0; i < 11; i++) for (let j = 0; j < 11; j++) if (i !== j) rows.push(dependency(`N${i}`, `N${j}`, `${i}-${j}`));
  rows.push(dependency('Target', 'N0', 'target'), dependency('Target', 'Clean', 'clean'), dependency('Clean', 'N10', 'clean-end'));
  const result = retrieveKnowledge(rows, 'Target N10');
  assert.ok(result.metrics.asserted <= 128);
  assert.ok(result.metrics.asserted + result.metrics.inferred <= 512);
  assert.ok(result.conflicts.length <= 64);
  assert.ok(Buffer.byteLength(result.context) <= 7000);
  assert.ok(result.facts.every(f => f.evidence.length <= 24));
  assert.equal(result.metrics.truncated, true);
});

test('small graph proof status and witness reachability agree with an independent matrix oracle', () => {
  const size = 4;
  const closure = (edges: Array<[number, number]>) => {
    const reached = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
    for (const [from, to] of edges) reached[from][to] = true;
    for (let via = 0; via < size; via++) for (let from = 0; from < size; from++) for (let to = 0; to < size; to++) {
      reached[from][to] ||= reached[from][via] && reached[via][to];
    }
    return reached;
  };
  const possible: Array<[number, number]> = [];
  for (let from = 0; from < size; from++) for (let to = 0; to < size; to++) if (from !== to) possible.push([from, to]);
  let state = 617;
  for (let sample = 0; sample < 64; sample++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const edges = possible.filter((_, i) => state & (1 << i));
    const rows = edges.map(([from, to], i) => dependency(`N${from}`, `N${to}`, `e${i}`));
    const reached = closure(edges);
    const cyclicIds = new Set(edges.flatMap(([from, to], i) => reached[to][from] ? [`e${i}`] : []));
    const cleanReached = closure(edges.filter(([from, to]) => !reached[to][from]));
    const result = retrieveKnowledge(rows, 'N0 N1 N2 N3');
    assert.equal(result.metrics.truncated, false, `sample ${sample}`);
    for (let from = 0; from < size; from++) for (let to = 0; to < size; to++) {
      const conclusion = get(result, `N${from}`, `N${to}`);
      if (!reached[from][to]) { assert.equal(conclusion, undefined); continue; }
      assert.ok(conclusion, `missing conclusion ${sample}: N${from}->N${to}`);
      if (!cleanReached[from][to]) { assert.equal(conclusion.status, 'unresolved'); continue; }
      assert.notEqual(conclusion.status, 'unresolved', `lost clean proof ${sample}: N${from}->N${to}`);
      assert.ok(conclusion.evidence.every(id => !cyclicIds.has(id)));
      const supportingEdges = conclusion.evidence.map(id => {
        const edge = edges[Number(id.slice(1))]; assert.ok(edge, `invented premise ${id}`); return edge;
      });
      assert.equal(closure(supportingEdges)[from][to], true, 'published premises alone must entail the conclusion');
    }
  }
});
