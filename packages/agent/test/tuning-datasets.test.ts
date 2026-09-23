import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalTuningDatasets, TUNING_DATASET_LIMITS, type TuningExample, tuningTextRisks } from '../src/tuning-datasets.js';

const row = (question: string, answer = 'Synthetic example answer.', group?: string): TuningExample => ({ messages: [{ role: 'user', content: question }, { role: 'assistant', content: answer }], ...(group ? { group } : {}) });
const jsonl = (rows: TuningExample[]): string => rows.map(value => JSON.stringify(value)).join('\n');
const examples = (): TuningExample[] => Array.from({ length: 20 }, (_, i) => row(`Independent synthetic task number ${i}?`));
function fixture(): { store: LocalTuningDatasets; home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'mrrobot-tuning-test-'));
  return { store: new LocalTuningDatasets(home), home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('JSONL validation is read-only, strict, bounded and does not expose message text', () => {
  const f = fixture();
  try {
    const good = f.store.validate({ jsonl: jsonl(examples()) });
    assert.equal(good.valid, true); assert.equal(good.trainRows, 16); assert.equal(good.evalRows, 4);
    assert.deepEqual(f.store.list(), []);
    assert.equal(JSON.stringify(good).includes('Independent synthetic'), false);
    for (const invalid of ['{bad', JSON.stringify({ messages: [{ role: 'assistant', content: 'x' }, { role: 'user', content: 'y' }] }), JSON.stringify({ ...row('test'), path: '../private' }), JSON.stringify({ messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'text', text: 'y' }] }] })]) {
      assert.equal(f.store.validate({ jsonl: invalid }).valid, false);
    }
    assert.equal(f.store.validate({ jsonl: ' '.repeat(TUNING_DATASET_LIMITS.bytes + 1) }).valid, false);
    assert.equal(f.store.validate({ jsonl: jsonl(examples()), evalFraction: 0.99 }).valid, false);
    assert.equal(f.store.validate({ jsonl: jsonl(examples()), seed: '' }).valid, false);
  } finally { f.cleanup(); }
});

test('credential risks cannot be acknowledged away; PII requires explicit review', () => {
  const f = fixture();
  try {
    // Synthetic test markers are assembled so public secret scanners do not mistake fixtures for live credentials.
    const secret = ['api', '_key=', 'fixtureOnly'.repeat(3)].join('');
    const raw = jsonl([row(secret), ...examples()]);
    const result = f.store.validate({ jsonl: raw });
    assert.equal(result.credentialRisks, 1); assert.equal(result.valid, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.throws(() => f.store.import({ name: 'blocked', jsonl: raw, acknowledgePii: true }), /검증/);
    const pii = jsonl([row('Contact learner@example.invalid'), ...examples()]);
    assert.equal(f.store.validate({ jsonl: pii }).importable, false);
    assert.throws(() => f.store.import({ name: 'review needed', jsonl: pii }), /개인정보/);
    assert.equal(f.store.import({ name: 'reviewed', jsonl: pii, acknowledgePii: true }).piiReviewed, true);
  } finally { f.cleanup(); }
});

test('normalization duplicates and overlapping prompts stay on one side, independent of input order', () => {
  const f = fixture();
  try {
    const rows = [...examples(), row('  INDEPENDENT  synthetic task number 0? ', 'Other answer.'), row('Independent synthetic task number 0?'), row('Independent synthetic task number 1?', 'Other answer.', 'related-source'), row('A related question?', 'Answer.', 'related-source')];
    const a = f.store.import({ name: 'a', jsonl: jsonl(rows), seed: 'stable' });
    const b = f.store.import({ name: 'b', jsonl: jsonl([...rows].reverse()), seed: 'stable' });
    assert.equal(a.counts.duplicateRows, 1);
    const first = f.store.export(a.id); const second = f.store.export(b.id);
    assert.equal(readFileSync(first.trainPath, 'utf8'), readFileSync(second.trainPath, 'utf8'));
    assert.equal(readFileSync(first.evalPath, 'utf8'), readFileSync(second.evalPath, 'utf8'));
    const train = readFileSync(first.trainPath, 'utf8'); const evaluation = readFileSync(first.evalPath, 'utf8');
    assert.equal(train.includes('related-source') || evaluation.includes('related-source'), false);
    const prompts = (text: string): Set<string> => new Set(text.trim().split('\n').flatMap(line => (JSON.parse(line) as TuningExample).messages.filter(message => message.role === 'user').map(message => message.content.toLowerCase().replace(/\s+/g, ' ').trim())));
    const trainPrompts = prompts(train);
    for (const prompt of prompts(evaluation)) assert.equal(trainPrompts.has(prompt), false);
    assert.equal(trainPrompts.has('a related question?'), trainPrompts.has('independent synthetic task number 1?'));
  } finally { f.cleanup(); }
});

test('duplicate examples with different source groups preserve transitive grouping', () => {
  const f = fixture();
  try {
    const rows = [row('bridge', 'same answer', 'first'), row('bridge', 'same answer', 'second'), row('first side', 'a', 'first'), row('second side', 'b', 'second'), ...examples()];
    const saved = f.store.import({ name: 'groups', jsonl: jsonl(rows) });
    assert.equal(saved.counts.duplicateRows, 1);
    assert.equal(saved.counts.groups, 21);
    const exported = f.store.export(saved.id);
    const train = readFileSync(exported.trainPath, 'utf8');
    assert.equal(train.includes('first side'), train.includes('second side'));
    assert.equal(train.includes('bridge'), train.includes('second side'));
  } finally { f.cleanup(); }
});

test('single connected group cannot produce misleading held-out evaluation', () => {
  const f = fixture();
  try {
    const validation = f.store.validate({ jsonl: jsonl(examples().map(value => ({ ...value, group: 'one-source' }))) });
    assert.equal(validation.groups, 1); assert.equal(validation.valid, false); assert.equal(validation.evalRows, 0);
  } finally { f.cleanup(); }
});

test('private storage validates IDs, content hashes, export checksums and refuses link redirection', () => {
  const f = fixture(); const elsewhere = fixture();
  try {
    assert.throws(() => f.store.export('../../config'), /식별자/);
    const saved = f.store.import({ name: 'fixture', jsonl: jsonl(examples()) });
    assert.deepEqual(f.store.list(), [saved]);
    const result = f.store.export(saved.id);
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
    assert.equal(manifest.kind, 'mr-robot-local-sft'); assert.equal(manifest.trainingStarted, false); assert.equal(manifest.network, 'disabled');
    const storedPath = join(f.store.root, 'datasets', `${saved.id}.json`);
    const original = JSON.parse(readFileSync(storedPath, 'utf8'));
    original.examples[0].messages[0].content = 'changed';
    writeFileSync(storedPath, JSON.stringify(original));
    assert.throws(() => f.store.export(saved.id), /무결성/);
    symlinkSync(f.home, join(elsewhere.home, 'private'), 'junction');
    assert.throws(() => elsewhere.store.import({ name: 'link', jsonl: jsonl(examples()) }), /링크/);
  } finally { f.cleanup(); elsewhere.cleanup(); }
});

test('risk screening recognizes credential families without returning matches', () => {
  for (const value of [['Bearer ', 'a'.repeat(32)].join(''), ['-----BEGIN ', 'PRIVATE KEY-----'].join(''), ['https://user:', 'fake-password@host.invalid'].join(''), ['eyJ', 'a'.repeat(10), '.', 'b'.repeat(12), '.', 'c'.repeat(12)].join(''), ['AIza', 'x'.repeat(35)].join(''), ['xoxb-', 'x'.repeat(25)].join(''), ['cfast_', 'x'.repeat(48)].join(''), ['dpapi:v1:', 'x'.repeat(32)].join(''), ['M', 'x'.repeat(24), '.', 'x'.repeat(6), '.', 'x'.repeat(30)].join('')]) {
    assert.equal(tuningTextRisks(value).credentials, true);
  }
  assert.equal(tuningTextRisks('Ordinary architecture task and answer.').credentials, false);
});
