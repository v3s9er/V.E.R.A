import test from 'node:test';
import assert from 'node:assert/strict';
import { ARC_KNOWN_DEVELOPMENT_IDS, arcPrompt, extractArcIds, gradeArc, parseArcTask, selectArcIds } from '../benchmark-arc-data.js';
import { gradeTask, parseOptions, publicTask } from '../app-benchmark-protocol.js';

const base = ['--app-path', 'packages/desktop/.stage', '--expected-version', '0.7.0', '--model', 'gpt-6-sol', '--effort', 'high', '--out-prefix', 'release/validation/test-only-arc', '--suite', 'arc2', '--cache', 'private-cache.json', '--plan-only', 'yes'];
const fixture = () => ({ train: [{ input: [[1, 2]], output: [[2, 1]] }], test: [{ input: [[3, 4]], output: [[9, 8]] }, { input: [[5]], output: [[7]] }] });

test('ARC requires an honest selection label and keeps the exact model and two-arm defaults', () => {
  assert.throws(() => parseOptions(base), /arc-selection/);
  const options = parseOptions([...base, '--arc-selection', 'locally-unused']);
  assert.equal(options.model, 'gpt-6-sol'); assert.equal(options.effort, 'high');
  assert.deepEqual(options.arms, ['single', 'adaptive']); assert.equal(options.deadlineMs, 600000);
  assert.throws(() => parseOptions([...base, '--arc-selection', 'locally-unused', '--ids', '1234abcd']), /development/);
  assert.throws(() => parseOptions([...base, '--arc-selection', 'development']), /development/);
  assert.deepEqual(parseOptions([...base, '--arc-selection', 'development', '--ids', '1234abcd,abcdef12']).ids, ['1234abcd', 'abcdef12']);
  assert.throws(() => parseOptions([...base, '--arc-selection', 'development', '--ids', '../bad']), /Invalid benchmark IDs/);
  assert.throws(() => parseOptions([...base, '--arc-selection', 'locally-unused', '--arms', 'single,ontology-adaptive']), /no supplied ontology/);
  assert.throws(() => parseOptions([...base, '--arc-selection', 'locally-unused', '--year', '2023']), /frozen/);
});

test('ARC visible projection strips every private test answer and does not alias source grids', () => {
  const raw = fixture(), task = parseArcTask('1234abcd', raw, 'a'.repeat(64)), prompt = arcPrompt(task.visible);
  assert.ok(task.visible.test.every(pair => !Object.hasOwn(pair, 'output')));
  assert.ok(!prompt.includes('98')); assert.ok(!prompt.includes('TEST 1 OUTPUT'));
  assert.ok(prompt.includes('TRAIN 1 OUTPUT\n21')); assert.ok(prompt.includes('TEST 2 INPUT\n5'));
  raw.train[0].input[0][0] = 0; raw.test[0].output[0][0] = 0;
  assert.equal(task.visible.train[0].input[0][0], 1); assert.equal(task.expected[0][0][0], 9);
  const published = publicTask({ id: 'arc-1234abcd', prompt, relations: [], expected: task.expected, sourceSha256: task.sourceSha256, testInputs: 2 });
  assert.equal(published.representation, 'text-grid'); assert.equal(published.testInputs, 2);
  assert.ok(!Object.hasOwn(published, 'expected')); assert.ok(!Object.hasOwn(published, 'prompt'));
});

test('ARC exact pass@1 requires every test grid including dimensions and rejects alternative formats', () => {
  const expected = parseArcTask('1234abcd', fixture()).expected;
  const correct = 'OUTPUT 1\n98\nEND\nOUTPUT 2\n7\nEND';
  assert.deepEqual(gradeArc(correct, expected), { passed: true, failure: null, correctOutputs: 2, expectedOutputs: 2 });
  assert.equal(gradeArc(correct.replace('98', '99'), expected).failure, 'wrong_answer');
  assert.equal(gradeArc(correct.replace('98', '9\n8'), expected).failure, 'wrong_answer');
  assert.equal(gradeArc(correct.replace('98', '99'), expected).correctOutputs, 1);
  for (const text of [correct.split('OUTPUT 2')[0], `${correct}\nOUTPUT 3\n7\nEND`, `Reasoning\n${correct}`, `\`\`\`\n${correct}\n\`\`\``, correct.replace('98', '9 8'), correct.replace('98', '98\n9'), correct.replace('OUTPUT 2', 'OUTPUT 1'), correct.replace('END', 'END extra')]) {
    assert.equal(gradeArc(text, expected).failure, 'answer_format', text);
  }
  assert.equal(gradeTask({ id: 'arc-fixture', prompt: '', relations: [], expected }, correct).passed, true);
});

test('ARC shape validation rejects empty, ragged, over-sized and non-colour grids', () => {
  for (const bad of [[], [[]], [[0], [0, 1]], [[10]], [[-1]], [[1.5]], [['1']], Array.from({ length: 31 }, () => [0])]) {
    const raw: any = fixture(); raw.test[0].input = bad;
    assert.throws(() => parseArcTask('1234abcd', raw), /grid/);
  }
  assert.throws(() => parseArcTask('1234abcd', { train: [], test: [] }), /task/);
});

test('locally-unused selection is deterministic, content-blind and excludes all prior IDs', () => {
  const ids = [...ARC_KNOWN_DEVELOPMENT_IDS, ...Array.from({ length: 20 }, (_, index) => index.toString(16).padStart(8, '0'))];
  const excluded = [...ARC_KNOWN_DEVELOPMENT_IDS, '00000001'];
  const chosen = selectArcIds(ids, excluded, 'predeclared-review-seed', 6);
  assert.equal(chosen.length, 6); assert.ok(chosen.every(id => !excluded.includes(id)));
  assert.deepEqual(selectArcIds([...ids].reverse(), excluded, 'predeclared-review-seed', 6), chosen);
  assert.notDeepEqual(selectArcIds(ids, excluded, 'different-seed', 6), chosen);
  assert.throws(() => selectArcIds(ids, ids, 'seed', 6), /Insufficient/);
});

test('prior report inventory reads only identifier fields and omits prompt/answer bodies', () => {
  const ids = extractArcIds({ ids: ['88bcf3b4'], samples: [{ taskId: 'arc-2c181942' }], schedule: [{ id: '3dc255db' }], tasks: [{ id: '38007db0', task: { train: [], test: [] } }], prompt: { id: 'abcdef12' }, answer: { id: '1234abcd' }, expected: ['77777777'], messages: [{ id: '99999999' }], manifest: [{ id: 'bbbbbbbb', path: 'data/evaluation/bbbbbbbb.json' }] });
  assert.deepEqual(ids, [...ARC_KNOWN_DEVELOPMENT_IDS].sort());
});
