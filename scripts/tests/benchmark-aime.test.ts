import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIME_REVISION, parseAimeTasks, selectAimeYear, readAimeCache, aimePrompt, gradeAime, summarizeAime, type AimeSample } from '../benchmark-aime-data.js';

const fixture = () => ({ dataset: 'AI-MO/aimo-validation-aime', revision: AIME_REVISION, declaredLicense: 'apache-2.0',
  records: ['I','II'].flatMap(exam => Array.from({ length: 15 }, (_, i) => ({ id: `2024-AIME-${exam}-${String(i + 1).padStart(2,'0')}`, year: 2024, exam, number: i + 1, problem: 'Synthetic one plus one', answer: 2, url: 'https://artofproblemsolving.com/wiki/fixture' }))) });
test('contest partition requires all 30 unique original IDs, not answer-selected tasks', () => {
  const tasks = parseAimeTasks(fixture()); assert.equal(selectAimeYear(tasks, 2024).length, 30);
  assert.throws(() => selectAimeYear(tasks.slice(1), 2024));
  const duplicate = fixture(); duplicate.records[1] = duplicate.records[0]!; assert.throws(() => parseAimeTasks(duplicate));
  const invalid = fixture(); invalid.records[0]!.answer = 1000; assert.throws(() => parseAimeTasks(invalid));
});
test('answer grading is exact, unambiguous and not a substring or executable expression', () => {
  assert.equal(gradeAime('Answer: 002', 2).passed, true);
  for (const text of ['Answer: 12', 'Answer: 2 or 3', 'Answer: 2\nAnswer: 3', '2', 'Answer: 1+1', '{"answer":2}', 'Answer: 1000']) assert.equal(gradeAime(text, 2).passed, false);
});
test('request contains only the problem, never reference answer, solution, or provenance URL', () => {
  const task = { ...parseAimeTasks(fixture())[0]!, answer: 917, solution: 'SECRET_REFERENCE_SOLUTION' };
  const prompt = aimePrompt(task); assert.match(prompt, /Synthetic one plus one/); assert.doesNotMatch(prompt, /917|SECRET_REFERENCE|artofproblemsolving/);
});
test('missing and failed tasks stay in denominator; unknown tokens are not zero', () => {
  const ids = parseAimeTasks(fixture()).map(t => t.id);
  const sample: AimeSample = { id: ids[0]!, passed: true, completed: true, failure: null, durationMs: 100, firstTextMs: null,
    actualEffort: 'medium', promptTokens: null, completionTokens: null, cachedPromptTokens: null, calls: 1, toolCalls: 0, predicted: 2 };
  const result = summarizeAime(ids, [sample]); assert.equal(result.accuracy, 1 / 30); assert.equal(result.missing, 29); assert.equal(result.tokensPerSuccess, null);
  assert.throws(() => summarizeAime(ids, [sample, sample]));
});
test('modified dataset cannot run under the pinned source identity', t => {
  const dir = mkdtempSync(join(tmpdir(), 'mrrobot-aime-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'cache.json'); writeFileSync(file, JSON.stringify(fixture()));
  assert.throws(() => readAimeCache(file), /checksum/);
});
test('unexpected source, version and licence cannot silently replace the fixture', () => {
  for (const patch of [{ revision: 'latest' }, { dataset: 'unverified' }, { declaredLicense: 'unknown' }]) {
    assert.throws(() => parseAimeTasks({ ...fixture(), ...patch }), /provenance/);
  }
  const invalid = fixture(); invalid.records[0]!.url = 'https://example.com/changed-source';
  assert.throws(() => parseAimeTasks(invalid), /record/);
});
test('deadlines count as failures, not missing or successful completions', () => {
  const ids = parseAimeTasks(fixture()).map(t => t.id);
  const samples: AimeSample[] = ids.map(id => ({ id, passed: false, completed: false, failure: 'deadline', durationMs: 120000,
    firstTextMs: null, actualEffort: null, promptTokens: null, completionTokens: null, cachedPromptTokens: null, calls: 1, toolCalls: 0, predicted: null }));
  const result = summarizeAime(ids, samples);
  assert.equal(result.accuracy, 0); assert.equal(result.attempted, 30); assert.equal(result.completed, 0);
  assert.equal(result.missing, 0); assert.equal(result.failures.deadline, 30); assert.equal(result.tokensPerSuccess, null);
  assert.deepEqual(result.byExam.map(exam => exam.passed), [0, 0]);
});
