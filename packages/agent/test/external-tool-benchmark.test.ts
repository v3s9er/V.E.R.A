import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BENCHMARK_CATEGORIES, parseBenchmarkJson, parseBenchmarkTasks, parseBenchmarkAnswers,
  prepareBenchmarkTask, normalizeBenchmarkSchema, selectBenchmarkTasks, validateBenchmarkCall, gradeBenchmarkCalls,
  type BenchmarkCategory, type BenchmarkCall, type BenchmarkTask } from '../src/evaluation/external-tool-benchmark.js';

const fn = (name = 'math.add', parameters: Record<string, unknown> = { type: 'dict', properties: {
  x: { type: 'integer' }, label: { type: 'string' }, flag: { type: 'boolean' },
}, required: ['x'] }) => ({ name, description: 'Public synthetic function', parameters });
const rawTask = (category: BenchmarkCategory = 'simple_python', index = 0, functions = [fn()]) => ({ id: `${category}_${index}`,
  question: [[{ role: 'user', content: 'Use the relevant function for synthetic data.' }]], function: functions });
const task = (category: BenchmarkCategory = 'simple_python', functions = [fn()]) => parseBenchmarkTasks(JSON.stringify(rawTask(category, 0, functions)), category)[0]!;
const answer = (ground_truth: unknown[], category: BenchmarkCategory = 'simple_python') =>
  parseBenchmarkAnswers(JSON.stringify({ id: `${category}_0`, ground_truth }), category).get(`${category}_0`)!;
const prepared = () => prepareBenchmarkTask(task());
const call = (input: unknown, name = prepared().tools[0]!.name): BenchmarkCall => ({ name, input });

test('strict JSON rejects duplicates, prototype pollution, invalid values, trailing text and deep/large inputs', () => {
  for (const raw of ['{"x":1,"x":2}', '{"__proto__":{}}', '{"x":NaN}', '{"x":1e999}', '[1,]', 'true false', '{"x":undefined}', '"bad\nstring"', '\vtrue']) {
    assert.throws(() => parseBenchmarkJson(raw), /Invalid/);
  }
  assert.throws(() => parseBenchmarkJson('['.repeat(30) + '0' + ']'.repeat(30)), /Invalid/);
  assert.throws(() => parseBenchmarkJson(' '.repeat(512 * 1024 + 1)), /Invalid/);
  assert.equal(parseBenchmarkJson('null'), null);
  assert.equal(JSON.stringify(parseBenchmarkJson('{"a":[null,true,"한글\\n",-1.25e2]}')), '{"a":[null,true,"한글\\n",-125]}');
});
test('task parser rejects duplicate IDs, invalid category/shape/extra fields without answer parsing', () => {
  const raw = JSON.stringify(rawTask());
  assert.throws(() => parseBenchmarkTasks(`${raw}\n${raw}`, 'simple_python'));
  assert.throws(() => parseBenchmarkTasks(raw, 'multiple'));
  assert.throws(() => parseBenchmarkTasks(JSON.stringify({ ...rawTask(), answer: 'leaked' }), 'simple_python'));
  assert.throws(() => parseBenchmarkTasks(JSON.stringify({ ...rawTask(), question: [] }), 'simple_python'));
  assert.throws(() => parseBenchmarkTasks(JSON.stringify(rawTask('simple_python', 0, [fn(), fn()])), 'simple_python'));
});
test('unsupported schema fails preparation loudly but remains available for denominator/selection', () => {
  const unsupported = task('simple_python', [fn('unknown', { type: 'executable' })]);
  assert.equal(unsupported.id, 'simple_python_0');
  assert.throws(() => prepareBenchmarkTask(unsupported));
  assert.throws(() => normalizeBenchmarkSchema({ type: 'string', pattern: '.*' }));
  assert.throws(() => normalizeBenchmarkSchema({ type: 'integer', properties: {} }));
  assert.throws(() => normalizeBenchmarkSchema({ type: 'array', minItems: -1 }));
});
test('BFCL types normalize and source metadata remains intact without answers', () => {
  const input = fn('tuple.inspect', { type: 'dict', properties: {
    points: { type: 'tuple', items: { type: 'float' }, description: 'Coordinates', default: [0, 0], optional: true },
    extra: { type: 'any' }, obj: { type: 'dict', required: ['nested'] },
  }, required: ['points'] });
  const p = prepareBenchmarkTask(task('simple_python', [input]));
  const schema = p.tools[0]!.parameters as any;
  assert.equal(schema.type, 'object'); assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.points.type, 'array'); assert.equal(schema.properties.points.items.type, 'number');
  assert.equal(schema.properties.obj.additionalProperties, true);
  assert.deepEqual(p.originalFunctions, [input]);
  assert.ok(!JSON.stringify(p).includes('ground_truth')); assert.ok(!JSON.stringify(p).includes('expected'));
  assert.equal(validateBenchmarkCall(p, { name: p.tools[0]!.name, input: { points: [1.5, 2], extra: null } }).valid, true);
});
test('function name aliases are bijective for dot/underscore collisions and bounded native names', () => {
  const p = prepareBenchmarkTask(task('multiple', [fn('a.b'), fn('a_b'), fn('a-b'), fn('a'.repeat(190))]));
  assert.equal(new Set(p.tools.map(t => t.name)).size, 4);
  p.tools.forEach(t => assert.match(t.name, /^[A-Za-z0-9_]{1,64}$/));
  assert.deepEqual(Object.values(p.nameMap), ['a.b', 'a_b', 'a-b', 'a'.repeat(190)]);
});
test('nonstandard optional annotations are preserved without changing required validation', () => {
  for (const optional of [true, false, 'True', 'true', 'yes', [], ['x']]) {
    const p = prepareBenchmarkTask(task('simple_python', [fn('f', { type: 'dict', optional,
      properties: { x: { type: 'integer', optional } }, required: ['x'] })]));
    assert.deepEqual(p.originalFunctions[0]!.parameters.optional, optional);
    assert.deepEqual(validateBenchmarkCall(p, { name: p.tools[0]!.name, input: {} }), { valid: false, code: 'missing_required' });
  }
  assert.throws(() => normalizeBenchmarkSchema({ type: 'integer', optional: {} }));
  assert.throws(() => normalizeBenchmarkSchema({ type: 'integer', minItems: 5 }), /unsupported/);
});
test('schema validation distinguishes required, extra, type, null and enum constraints', () => {
  const p = prepared();
  const code = (input: unknown) => validateBenchmarkCall(p, call(input));
  assert.deepEqual(code({}), { valid: false, code: 'missing_required' });
  assert.deepEqual(code({ x: 1, extra: 1 }), { valid: false, code: 'extra_argument' });
  for (const input of [{ x: null }, { x: 1.2 }, { x: '1' }, { x: true }, { x: 1, flag: 'true' }]) {
    assert.deepEqual(code(input), { valid: false, code: 'argument_type' });
  }
  assert.deepEqual(code(null), { valid: false, code: 'invalid_arguments' });
  for (const input of [{ x: NaN }, { x: Infinity }, { x: undefined }, { x: 1, label: undefined }]) {
    assert.deepEqual(code(input), { valid: false, code: 'invalid_arguments' });
  }
  assert.deepEqual(validateBenchmarkCall(p, call({ x: 1 }, 'native_shell')), { valid: false, code: 'unknown_tool' });
  const enumP = prepareBenchmarkTask(task('simple_python', [fn('f', { type: 'dict', properties: { x: { type: 'string', enum: ['yes'] } }, required: ['x'] })]));
  assert.deepEqual(validateBenchmarkCall(enumP, { name: enumP.tools[0]!.name, input: { x: 'no' } }), { valid: false, code: 'argument_constraint' });
});
test('strict grader accepts only declared alternatives; no case, coercion, whitespace or fuzzy matching', () => {
  const p = prepared(), a = answer([{ 'math.add': { x: [1, 2], label: ['A', 'B', ''], flag: ['', true] } }]);
  assert.equal(gradeBenchmarkCalls(p, a, [call({ x: 2 })]).passed, true);
  assert.equal(gradeBenchmarkCalls(p, a, [call({ x: 1, label: 'B', flag: true })]).passed, true);
  for (const input of [{ x: 3 }, { x: 1, label: 'a' }, { x: 1, label: ' A' }, { x: 1, flag: false }]) {
    assert.equal(gradeBenchmarkCalls(p, a, [call(input)]).code, 'arguments_mismatch');
  }
});
test('empty-string omission sentinel does not excuse required fields or turn null into omission', () => {
  const p = prepared(), a = answer([{ 'math.add': { x: ['', 1], label: ['', 'yes'] } }]);
  assert.equal(gradeBenchmarkCalls(p, a, [call({})]).code, 'missing_required');
  assert.equal(gradeBenchmarkCalls(p, a, [call({ x: 1, label: null })]).code, 'argument_type');
  assert.equal(gradeBenchmarkCalls(p, a, [call({ x: 1 })]).passed, true);
  assert.equal(gradeBenchmarkCalls(p, a, [call({ x: 1, label: '' })]).passed, true);
});
test('required explicit null is a value, not missing, and any does not imply answer acceptance', () => {
  const p = prepareBenchmarkTask(task('simple_python', [fn('f', { type: 'dict', properties: { x: { type: 'any' } }, required: ['x'] })]));
  const a = answer([{ f: { x: [null] } }]);
  assert.equal(gradeBenchmarkCalls(p, a, [{ name: p.tools[0]!.name, input: { x: null } }]).passed, true);
  assert.equal(gradeBenchmarkCalls(p, a, [{ name: p.tools[0]!.name, input: {} }]).code, 'missing_required');
  assert.equal(gradeBenchmarkCalls(p, a, [{ name: p.tools[0]!.name, input: { x: '' } }]).code, 'arguments_mismatch');
});
test('arrays and nested dictionary alternatives preserve ordering, values and keys', () => {
  const p = prepareBenchmarkTask(task('simple_python', [fn('f', { type: 'dict', properties: { data: { type: 'dict' }, list: { type: 'array', items: { type: 'integer' } } }, required: ['data', 'list'] })]));
  const a = answer([{ f: { data: [{ x: [1, 2], children: [[3, 4]], nest: [{ value: [null, true] }] }], list: [[7, 8], [8, 7]] } }]);
  const c = (data: unknown, list: unknown = [7, 8]) => [{ name: p.tools[0]!.name, input: { data, list } }];
  assert.equal(gradeBenchmarkCalls(p, a, c({ x: 2, children: [3, 4], nest: { value: null } }, [8, 7])).passed, true);
  for (const data of [{ x: 2, children: [4, 3], nest: { value: true } }, { x: 2, children: [3, 4] },
    { x: 2, children: [3, 4], nest: { value: true, extra: 1 } }]) assert.equal(gradeBenchmarkCalls(p, a, c(data)).code, 'arguments_mismatch');
});
test('unordered calls require one-to-one bipartite matching, including overlapping alternatives', () => {
  const p = prepareBenchmarkTask(task('parallel'));
  const a = answer([{ 'math.add': { x: [1, 2] } }, { 'math.add': { x: [1] } }], 'parallel');
  assert.equal(gradeBenchmarkCalls(p, a, [call({ x: 1 }), call({ x: 2 })]).passed, true);
  assert.equal(gradeBenchmarkCalls(p, a, [call({ x: 2 }), call({ x: 1 })]).passed, true);
  assert.equal(gradeBenchmarkCalls(p, a, [call({ x: 2 }), call({ x: 2 })]).code, 'arguments_mismatch');
});
test('missing, extra and duplicated calls cannot be hidden by a successful call', () => {
  const p = prepared(), a = answer([{ 'math.add': { x: [1] } }]);
  assert.equal(gradeBenchmarkCalls(p, a, []).code, 'missing_call');
  assert.equal(gradeBenchmarkCalls(p, a, [call({ x: 1 }), call({ x: 1 })]).code, 'extra_call');
  const parallel = prepareBenchmarkTask(task('parallel'));
  const b = answer([{ 'math.add': { x: [1] } }, { 'math.add': { x: [2] } }], 'parallel');
  assert.equal(gradeBenchmarkCalls(parallel, b, [call({ x: 1 }), call({ x: 1 })]).code, 'arguments_mismatch');
});
test('irrelevance has no reference and every attempted call is failure', () => {
  const p = prepareBenchmarkTask(task('irrelevance'));
  assert.deepEqual(gradeBenchmarkCalls(p, undefined, []), { passed: true, code: 'passed', expectedCalls: 0, actualCalls: 0 });
  assert.equal(gradeBenchmarkCalls(p, undefined, [call({ x: 1 })]).code, 'irrelevant_call');
});
test('malformed/missing references fail closed with safe output', () => {
  const p = prepared(); assert.equal(gradeBenchmarkCalls(p, undefined, []).code, 'reference_invalid');
  for (const ground_truth of ['execute()', [{ f: { x: 1 } }], [{ f: { x: [] } }], [{ f: { x: [{ nested: 1 }] } }], [{ f: {}, g: {} }]]) {
    assert.throws(() => answer(ground_truth as unknown[]));
  }
  const a = answer([{ 'math.add': { x: [1] } }]);
  const result = gradeBenchmarkCalls(p, a, [call({ x: 'PRIVATE_SAMPLE' })]);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SAMPLE'), false);
  assert.equal(Object.keys(result).length, 4);
});
test('deterministic exact per-category sampling is disjoint, order-independent and answer-free', () => {
  const tasks = BENCHMARK_CATEGORIES.flatMap(category => Array.from({ length: 80 }, (_, index) =>
    parseBenchmarkTasks(JSON.stringify(rawTask(category, index)), category)[0]!));
  const options = { seed: 'mrrobot-bfcl-v1', perCategory: 10 };
  const dev = selectBenchmarkTasks(tasks, { ...options, split: 'dev' });
  const holdout = selectBenchmarkTasks(tasks, { ...options, split: 'holdout' });
  assert.equal(dev.length, 40); assert.equal(holdout.length, 40);
  assert.ok(dev.every(t => !holdout.some(h => h.id === t.id)));
  assert.deepEqual(dev.map(t => t.id), selectBenchmarkTasks([...tasks].reverse(), { ...options, split: 'dev' }).map(t => t.id));
  for (const category of BENCHMARK_CATEGORIES) assert.equal(dev.filter(t => t.category === category).length, 10);
  const changed: BenchmarkTask[] = tasks.map(t => ({ ...t, functions: [fn('unsupported', { type: 'never_supported' })] }));
  assert.deepEqual(dev.map(t => t.id), selectBenchmarkTasks(changed, { ...options, split: 'dev' }).map(t => t.id));
  assert.throws(() => selectBenchmarkTasks(tasks, { ...options, perCategory: 100, split: 'dev' }));
});
