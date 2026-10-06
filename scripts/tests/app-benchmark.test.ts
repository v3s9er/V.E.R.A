import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KNOWLEDGE_RECALL_MEMORY_ADD_INTERVAL_MS, assertKnowledgeTelemetry, assertWorkspacePermission, canonicalJson, datasetProvenance, gradeTask, knowledgeRecallTasks, loadTasks, parseOptions, publicTask, relationTasks, schedule, sha256, usageCounts, verifyKnowledgeRecallSetup } from '../app-benchmark-protocol.js';
import { retrieveKnowledge } from '../../packages/agent/src/ontology.js';

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

const recallBase = base.map(value => value === 'relations' ? 'knowledge-recall' : value);
test('knowledge recall is an optional version comparison with three cases and six calls by default', () => {
  const options = parseOptions([...recallBase, '--plan-only', 'yes']);
  assert.deepEqual(options.arms, ['ontology-adaptive']);
  assert.equal(options.repetitions, 2);
  assert.equal(options.seed, 'vera-knowledge-recall-v1');
  assert.equal(options.allowUsage, false);
  const tasks = loadTasks(options), rows = schedule(tasks, options.arms, options.repetitions);
  assert.equal(tasks.length, 3); assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map(row => `${row.taskId}:${row.arm}:${row.repetition}`)).size, 6);
  assert.equal(parseOptions([...recallBase, '--preflight-only', 'yes', '--repetitions', '1']).repetitions, 1);
  assert.throws(() => parseOptions(recallBase), /allow-account-usage/);
  for (const arms of ['single', 'adaptive', 'single,ontology-adaptive', 'adaptive,ontology-adaptive']) {
    assert.throws(() => parseOptions([...recallBase, '--plan-only', 'yes', '--arms', arms]), /only ontology-adaptive/);
  }
  for (const [name, value] of [['cache', 'cache.json'], ['year', '2022'], ['ids', '2022-AIME-I-01'], ['arc-selection', 'development'], ['repetitions', '0'], ['plan-hash', 'invalid']]) {
    assert.throws(() => parseOptions([...recallBase, '--plan-only', 'yes', `--${name}`, value]));
  }
  assert.equal(parseOptions([...recallBase, '--allow-account-usage', 'yes', '--plan-hash', 'a'.repeat(64)]).planHash, 'a'.repeat(64));
  const provenance = datasetProvenance(options);
  assert.equal(provenance.heldOut, false);
  assert.match(String(provenance.source), /knowledge-recall-v1/);
  assert.match(JSON.stringify(provenance), /not mode superiority/);
});

test('recall fixtures are deterministic, independent and retain all distractors and conflicting evidence', () => {
  const tasks = knowledgeRecallTasks('fixed-seed');
  assert.deepEqual(tasks, knowledgeRecallTasks('fixed-seed'));
  assert.notDeepEqual(tasks.map(task => task.id), knowledgeRecallTasks('other-seed').map(task => task.id));
  assert.deepEqual(tasks.map(task => task.recallCase), ['exact', 'absent', 'hub']);
  assert.deepEqual(tasks.map(task => task.relations.length), [101, 101, 206]);
  const exact = tasks[0], absent = tasks[1], hub = tasks[2];
  assert.match(exact.relations[0].subject, /^@recall_[a-f0-9]{8}\/name$/);
  assert.equal(exact.relations[0].object, 'blocked');
  assert.equal(exact.relations.slice(1).filter(fact => fact.subject.startsWith(exact.relations[0].subject) && fact.object === 'ready').length, 100);
  const absentEntity = absent.prompt.match(/@recall_[a-f0-9]{8}\/missing/)![0];
  assert.ok(absent.relations.every(fact => fact.subject !== absentEntity && fact.object !== absentEntity));
  const edges = hub.relations.filter(fact => fact.predicate === 'depends_on');
  assert.equal(edges.length, 3);
  assert.equal(edges[0].object, edges[1].subject); assert.equal(edges[1].object, edges[2].subject);
  assert.equal(hub.relations.filter(fact => fact.predicate === 'part_of').length, 201);
  assert.deepEqual(hub.relations.filter(fact => fact.subject === edges[2].object).map(fact => fact.object), ['blocked', 'ready']);
  assert.ok(tasks.every(task => task.relations.every(fact => fact.predicate !== 'owner')));
});

test('recall questions and public plans exclude supplied facts, answer keys and extra entity anchors', () => {
  for (const task of knowledgeRecallTasks('leak-check')) {
    assert.ok(!task.prompt.includes(String(task.expected)));
    assert.doesNotMatch(task.prompt, /blocked|ready/);
    for (const fact of task.relations) {
      assert.ok(!task.prompt.includes(`${fact.subject} | ${fact.predicate} | ${fact.object}`));
      assert.ok(!task.prompt.includes(`${fact.subject} / ${fact.predicate}: ${fact.object}`));
    }
    const visible = publicTask(task), serialized = JSON.stringify(visible);
    assert.equal(visible.relationCount, task.relations.length);
    assert.equal(visible.representation, 'scoped-memory-only');
    assert.equal(visible.relationsSha256, sha256(canonicalJson(task.relations)));
    for (const key of ['expected', 'relations', 'prompt', 'answerLines']) assert.ok(!Object.hasOwn(visible, key));
    assert.doesNotMatch(serialized, /@recall_|blocked|ready|CONFLICT|UNKNOWN/);
    const queryEntities = [...new Set(task.prompt.match(/@recall_[a-f0-9]{8}\/[a-z0-9]+/g))];
    assert.equal(queryEntities.length, 1, 'Only the requested entity may seed retrieval');
    if (task.recallCase !== 'absent') assert.equal(queryEntities[0], task.relations[0].subject);
  }
});

test('recall grading requires exact supported claims, UNKNOWN and conflict with no sibling output', () => {
  for (const task of knowledgeRecallTasks('grading')) {
    const answer = String(task.expected);
    assert.deepEqual(gradeTask(task, answer), { passed: true, failure: null });
    assert.equal(gradeTask(task, answer.replace('UNKNOWN', 'ready')).failure, 'wrong_answer');
    for (const output of [`Reasoning\n${answer}`, `${answer}\n@scope/name0: ready`, answer.split('\n')[0], answer.replace('Q2:', 'Q1:')]) {
      assert.deepEqual(gradeTask(task, output), { passed: false, failure: 'answer_format' });
    }
  }
  const [exact, absent, hub] = knowledgeRecallTasks('grading');
  assert.equal(gradeTask(exact, 'Q1: ready\nQ2: UNKNOWN').failure, 'wrong_answer');
  assert.equal(gradeTask(absent, 'Q1: blocked\nQ2: UNKNOWN').failure, 'wrong_answer');
  assert.equal(gradeTask(hub, 'Q1: YES\nQ2: YES\nQ3: UNKNOWN').failure, 'wrong_answer');
});

test('memory setup verifies RPC receipts and persisted scope, count, identities and fact content', () => {
  const relations = knowledgeRecallTasks('stored')[0].relations, scope = { workspaceId: 'project', conversationId: 'conversation' };
  const receipts = relations.map((relation, i) => ({ id: `receipt-${i}`, ...scope, relationMode: 'fact', relation }));
  const result = verifyKnowledgeRecallSetup(relations, receipts, [...receipts].reverse(), scope);
  assert.deepEqual(result, { verified: true, expectedRelations: 101, receiptCount: 101, storedCount: 101, relationsSha256: sha256(canonicalJson(relations)) });
  assert.doesNotMatch(JSON.stringify(result), /@recall_|blocked|ready|receipt-/);
  assert.doesNotThrow(() => verifyKnowledgeRecallSetup(relations, receipts, [...receipts, { ...receipts[0], conversationId: 'previous' }], scope));
  for (const alter of [
    (rows: any[]) => rows.pop(),
    (rows: any[]) => rows.push(rows[0]),
    (rows: any[]) => { rows[0].id = rows[1].id; },
    (rows: any[]) => { rows[0].workspaceId = 'wrong'; },
    (rows: any[]) => { rows[0].conversationId = 'wrong'; },
    (rows: any[]) => { rows[0].relationMode = undefined; },
    (rows: any[]) => { rows[0].supersededBy = 'replacement'; },
    (rows: any[]) => { rows[0].relation.object = 'wrong'; },
  ]) {
    const rows = structuredClone(receipts); alter(rows);
    assert.throws(() => verifyKnowledgeRecallSetup(relations, rows, receipts, scope), /memory_setup_mismatch/);
    assert.throws(() => verifyKnowledgeRecallSetup(relations, receipts, rows, scope), /memory_setup_mismatch/);
  }
  assert.throws(() => verifyKnowledgeRecallSetup(relations, receipts, [...receipts, { id: 'global', relation: relations[0] }], scope), /memory_setup_mismatch/);
  assert.throws(() => verifyKnowledgeRecallSetup(relations, receipts, null, scope), /memory_setup_mismatch/);
});

test('zero-fact recall is valid while the original relations ontology telemetry gate remains strict', () => {
  for (const knowledge of [undefined, { asserted: 0, inferred: 0 }, { asserted: 1, inferred: 0 }]) {
    assert.doesNotThrow(() => assertKnowledgeTelemetry('knowledge-recall', 'ontology-adaptive', knowledge));
    assert.throws(() => assertKnowledgeTelemetry('relations', 'ontology-adaptive', knowledge), /ontology_not_observed/);
    assert.doesNotThrow(() => assertKnowledgeTelemetry('relations', 'adaptive', knowledge));
  }
  assert.doesNotThrow(() => assertKnowledgeTelemetry('relations', 'ontology-adaptive', { asserted: 1, inferred: 1 }));
});

test('recall setup pacing is frozen in the plan and precedes every memory write outside the inference timer', () => {
  assert.equal(KNOWLEDGE_RECALL_MEMORY_ADD_INTERVAL_MS, 250);
  const harness = readFileSync(new URL('../app-benchmark.ts', import.meta.url), 'utf8');
  assert.match(harness, /memorySetupPacingMs: KNOWLEDGE_RECALL_MEMORY_ADD_INTERVAL_MS/);
  const caseSetup = harness.indexOf("report.preflightStage = 'case_setup'"), memorySetup = harness.indexOf("report.preflightStage = 'memory_setup'");
  const execution = harness.indexOf("report.preflightStage = 'sample_execution'"), timer = harness.indexOf('started = performance.now();');
  assert.ok(caseSetup > 0 && memorySetup > caseSetup && execution > memorySetup && timer > execution);
  const seeding = harness.slice(memorySetup, execution);
  assert.match(seeding, /for \(const relation of task\.relations\) \{\s*if \(options\.suite === 'knowledge-recall'\) await new Promise\(resolveWait => setTimeout\(resolveWait, KNOWLEDGE_RECALL_MEMORY_ADD_INTERVAL_MS\)\);\s*receipts\.push\(await call\('memory\.add'/);
  assert.ok(seeding.includes('verifyKnowledgeRecallSetup'));
});

test('complete recall questions exercise exact, absent and narrow hub retrieval without model calls', () => {
  const results = knowledgeRecallTasks('query-check').map(task => ({ task, result: retrieveKnowledge(task.relations.map((relation, i) => ({
    id: `row-${i}`, text: `${relation.subject} / ${relation.predicate}: ${relation.object}`, tags: [], createdAt: i + 1, updatedAt: i + 1,
    relationMode: 'fact', relation,
  })), task.prompt) }));
  assert.equal(results[0].result.metrics.asserted, 1);
  assert.equal(results[0].result.facts[0].object, 'blocked');
  assert.equal(results[1].result.context, '');
  const hub = results[2], edges = hub.task.relations.filter(fact => fact.predicate === 'depends_on');
  assert.ok(hub.result.facts.some(fact => fact.subject === edges[0].subject && fact.predicate === 'depends_on' && fact.object === edges[2].object && fact.status === 'inferred'));
  assert.ok(hub.result.conflicts.some(conflict => conflict.subject === edges[2].object && conflict.kind === 'single_value'));
});
