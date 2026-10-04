import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorkspacePermission, canonicalJson, gradeTask, parseOptions, publicTask, relationTasks, schedule, sha256, usageCounts } from '../app-benchmark-protocol.js';

const base = ['--app-path', 'packages/desktop/.stage', '--expected-version', '0.6.17', '--model', 'gpt-6-sol', '--effort', 'high', '--out-prefix', 'release/validation/test-only', '--suite', 'relations'];
test('execution requires explicit subscription usage; planning does not infer consent', () => {
  assert.throws(() => parseOptions(base), /allow-account-usage/);
  assert.equal(parseOptions([...base, '--plan-only', 'yes']).allowUsage, false);
  assert.equal(parseOptions([...base, '--preflight-only', 'yes']).allowUsage, false);
  assert.equal(parseOptions([...base, '--allow-account-usage', 'yes']).model, 'gpt-6-sol');
  assert.throws(() => parseOptions([...base, '--plan-only', 'yes', '--model', 'other']), /repeated/);
});
test('finite budgets cannot silently disable the adaptive treatment', () => {
  assert.equal(parseOptions([...base, '--plan-only', 'yes']).tokenPolicy, 'audit-only');
  assert.throws(() => parseOptions([...base, '--plan-only', 'yes', '--token-policy', 'quality']), /Adaptive helpers/);
  assert.equal(parseOptions([...base, '--plan-only', 'yes', '--arms', 'single', '--token-policy', 'quality']).tokenPolicy, 'quality');
});
test('server-clamped approval mode is rejected before model invocation', () => {
  assert.doesNotThrow(() => assertWorkspacePermission('workspace'));
  for (const effective of ['ask', 'read-only', 'full', undefined]) assert.throws(() => assertWorkspacePermission(effective), /effective_permission_mismatch/);
});
test('AIME cannot pretend an empty ontology is a treatment', () => {
  assert.throws(() => parseOptions([...base.filter((_, index) => index < 10), '--suite', 'aime', '--cache', 'cache.json', '--arms', 'single,ontology-adaptive', '--plan-only', 'yes']), /no supplied ontology/);
});
test('paired schedule reverses order and includes every task-arm-repetition once', () => {
  const tasks = [{ id: 'a' }, { id: 'b' }], rows = schedule(tasks, ['single', 'adaptive'], 2);
  assert.deepEqual(rows.map(row => row.arm), ['single', 'adaptive', 'adaptive', 'single', 'adaptive', 'single', 'single', 'adaptive']);
  assert.equal(new Set(rows.map(row => `${row.taskId}:${row.arm}:${row.repetition}`)).size, 8);
  const triple = schedule([{ id: 'a' }], ['single', 'adaptive', 'ontology-adaptive'], 2);
  assert.deepEqual(triple.slice(3).map(row => row.arm), triple.slice(0, 3).map(row => row.arm).reverse());
});
test('grading requires one exact final answer and public manifest excludes the key', () => {
  const task = { id: 'fake', expected: 42, prompt: 'Example problem only', relations: [] };
  assert.equal(gradeTask(task, 'Answer: 042').passed, true);
  for (const text of ['Reasoning: 42\nAnswer: 42', 'Answer: 42 or 41', 'Answer: 41']) assert.equal(gradeTask(task, text).passed, false);
  const visible = publicTask(task);
  assert.deepEqual(Object.keys(visible).sort(), ['id', 'promptSha256', 'relationsSha256']);
  assert.ok(!JSON.stringify(visible).includes(task.prompt));
});
test('missing usage never becomes a free run and cache input is not double-counted', () => {
  assert.equal(usageCounts(undefined).totalTokens, null);
  assert.equal(usageCounts({ promptTokens: 0, completionTokens: 0 }).totalTokens, null);
  assert.equal(usageCounts({ promptTokens: 100, completionTokens: 20, reportStatus: 'invalid' }).totalTokens, null);
  assert.equal(usageCounts({ promptTokens: 100, completionTokens: 20, cachedPromptTokens: 80 }).totalTokens, 120);
  assert.equal(usageCounts({ promptTokens: -1, completionTokens: 20 }).totalTokens, null);
});
test('plan hashing is stable under object key order but sensitive to protocol changes', () => {
  assert.equal(sha256(canonicalJson({ effort: 'high', model: 'gpt-6-sol' })), sha256(canonicalJson({ model: 'gpt-6-sol', effort: 'high' })));
  assert.notEqual(sha256(canonicalJson({ effort: 'high' })), sha256(canonicalJson({ effort: 'medium' })));
});
test('generated ontology tasks have same explicit givens in every arm and deterministic ground truth', () => {
  const tasks = relationTasks('fixed-seed');
  assert.equal(tasks.length, 6);
  assert.deepEqual(tasks, relationTasks('fixed-seed'));
  assert.notDeepEqual(tasks.map(task => task.id), relationTasks('new-seed').map(task => task.id));
  for (const task of tasks) {
    for (const fact of task.relations) assert.ok(task.prompt.includes(`${fact.subject} | ${fact.predicate} | ${fact.object}`));
    assert.equal(gradeTask(task, String(task.expected)).passed, true);
    assert.equal(gradeTask(task, String(task.expected).replace('CONFLICT', 'YES')).passed, false);
  }
});
