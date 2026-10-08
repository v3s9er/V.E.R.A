import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHarnessKnowledge, HARNESS_KNOWLEDGE_LIMITS, type HarnessKnowledge, type HarnessKnowledgeOptions, type HostAcceptanceReceipt, type KnowledgeClaim } from '../src/harness-knowledge.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const scope = { workspaceId: 'project-a', conversationId: 'conversation-a' };
function fixture(t: any) {
  const base = mkdtempSync(join(tmpdir(), 'vera-harness-knowledge-')), root = join(base, 'project'); mkdirSync(root);
  t.after(() => { assert.ok(base.startsWith(join(tmpdir(), 'vera-harness-knowledge-'))); rmSync(base, { recursive: true, force: true }); });
  const write = (path: string, text: string | Buffer) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  const open = (documents: string[], extra: Partial<HarnessKnowledgeOptions> = {}) => createHarnessKnowledge({ workspaceRoot: root, scope, documents, now: () => new Date('2026-10-08T00:00:00Z'), ...extra });
  return { base, root, write, open };
}
async function proposal(store: HarnessKnowledge, path: string, quote: string, claim: KnowledgeClaim = { subject: '@sample/api', predicate: 'owner', object: 'team-a' }) {
  const result = await store.documents.search('@sample/api');
  const source = result.matches.find(match => match.path === path)!;
  return store.candidates.propose({ claim, evidence: [{ path, sha256: source.sha256, quote }] });
}
const accepted = { verification: 'deterministic-check', checkId: 'fixture-check-v1' } as const;

test('only explicit documents are read, with hashed scoped provenance and untrusted line snippets', async t => {
  const { open, write } = fixture(t); write('docs/guide.md', '# Guide\n@sample/api owner team-a\nDeployment notes.\n'); write('unselected.txt', '@sample/api PRIVATE_NOT_SELECTED');
  const store = await open(['docs/guide.md']), result = await store.documents.search('@sample/api');
  assert.equal(result.partial, false); assert.equal(result.matches.length, 1); assert.equal(result.metrics.selected, 1);
  assert.equal(result.matches[0].sha256, digest('# Guide\n@sample/api owner team-a\nDeployment notes.\n'));
  assert.equal(result.matches[0].path, 'docs/guide.md'); assert.equal(result.matches[0].trust, 'untrusted-document');
  assert.equal(result.matches[0].observedAt, '2026-10-08T00:00:00.000Z'); assert.match(result.matches[0].version, /^harness-documents-v1:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_NOT_SELECTED/);
  const empty = await open([]); assert.deepEqual((await empty.documents.search('@sample/api')).matches, []);
});

test('exact qualified entities never retrieve prefix siblings or absent-entity fallbacks', async t => {
  const { open, write } = fixture(t); write('notes.md', '@sample/api-extra owner team-extra\nAPI deployment information');
  const store = await open(['notes.md']);
  assert.equal((await store.documents.search('@sample/api owner')).matches.length, 0);
  assert.equal((await store.documents.search('@sample/missing deployment')).matches.length, 0);
  assert.equal((await store.documents.search('@sample/api-extra')).matches.length, 1);
});

test('cache is scoped by canonical root/scope/content and refreshes same-size timestamp-preserving edits', async t => {
  const { open, write, root } = fixture(t); write('guide.md', '@sample/api owner team-a');
  const one = await open(['guide.md']), original = await one.documents.search('@sample/api');
  assert.equal((await one.documents.search('@sample/api')).metrics.cacheHits, 1);
  write('guide.md', '@sample/api owner team-b'); utimesSync(join(root, 'guide.md'), new Date(0), new Date(0));
  const changed = await one.documents.search('@sample/api'); assert.equal(changed.metrics.cacheHits, 0); assert.notEqual(changed.matches[0].sha256, original.matches[0].sha256);
  assert.match(changed.matches[0].snippet, /team-b/);
  const other = await open(['guide.md'], { scope: { workspaceId: 'project-b' } });
  assert.notEqual((await other.documents.search('@sample/api')).matches[0].sourceId, changed.matches[0].sourceId);
  rmSync(join(root, 'guide.md')); const missing = await one.documents.search('@sample/api');
  assert.deepEqual(missing.matches, []); assert.equal(missing.issues[0].code, 'document_missing');
});

test('selection rejects traversal, hidden/secret paths, absolute paths, alternate streams and non-document types', async t => {
  const { open, root } = fixture(t);
  for (const path of ['../outside.txt', '/outside.txt', join(root, 'file.txt'), 'docs\\file.txt', '.env', '.git/info.txt', 'auth.json', 'my-secrets.md', 'file.txt:stream', 'file.js', 'CON.txt', 'docs./a.txt', 'a//b.txt']) {
    await assert.rejects(open([path]), /document_/);
  }
  await assert.rejects(open(Array.from({ length: 25 }, (_, index) => `${index}.md`)), /options/);
});

test('junctions and hardlinks cannot expose documents outside the selected workspace', async t => {
  const { open, root, base, write } = fixture(t); const outside = join(base, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'private.md'), 'PRIVATE_OUTSIDE @sample/api');
  symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  linkSync(join(outside, 'private.md'), join(root, 'hard.md')); write('normal.md', '@sample/api safe');
  const store = await open(['linked/private.md', 'hard.md', 'normal.md']), result = await store.documents.search('@sample/api');
  assert.equal(result.matches.length, 1); assert.equal(result.issues.length, 2); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_OUTSIDE/);
  await assert.rejects(createHarnessKnowledge({ workspaceRoot: join(root, 'linked'), scope, documents: ['private.md'] }), /scope_changed/);
});

test('invalid UTF-8, binary data, malformed JSON, oversized and secret-bearing documents fail closed', async t => {
  const { open, write } = fixture(t);
  write('bad.txt', Buffer.from([0xc3, 0x28])); write('binary.txt', 'text\0data'); write('bad.json', '{');
  write('large.md', 'x'.repeat(HARNESS_KNOWLEDGE_LIMITS.documentBytes + 1));
  write('credentials-in-notes.md', 'not reached');
  write('guide.md', '@sample/api\napi_key: example-secret-value');
  const store = await open(['bad.txt', 'binary.txt', 'bad.json', 'large.md', 'guide.md']), result = await store.documents.search('@sample/api text');
  assert.equal(result.matches.length, 0); assert.equal(result.issues.length, 5);
  assert.deepEqual(new Set(result.issues.map(issue => issue.code)), new Set(['document_encoding', 'document_binary', 'document_json_invalid', 'document_too_large', 'document_sensitive']));
  assert.doesNotMatch(JSON.stringify(result), /example-secret-value/);
});

test('results and total document consumption stay bounded and invalid query options are rejected', async t => {
  const { open, write } = fixture(t); const paths = Array.from({ length: 12 }, (_, index) => `document-${index}.md`);
  for (const path of paths) write(path, ('retrieval evidence content '.repeat(6) + '\n').repeat(750));
  const store = await open(paths), result = await store.documents.search('retrieval', { limit: 2 });
  assert.ok(result.metrics.bytes <= HARNESS_KNOWLEDGE_LIMITS.totalBytes); assert.equal(result.matches.length, 2); assert.equal(result.partial, true);
  assert.ok(result.matches.every(match => match.snippet.length <= HARNESS_KNOWLEDGE_LIMITS.snippetChars));
  assert.ok(result.matches.reduce((sum, match) => sum + Buffer.byteLength(match.snippet), 0) <= HARNESS_KNOWLEDGE_LIMITS.resultBytes);
  for (const query of ['', 'x'.repeat(2001), '\0bad']) await assert.rejects(store.documents.search(query), /query_invalid/);
  for (const limit of [0, 9, 1.5, NaN]) await assert.rejects(store.documents.search('retrieval', { limit }), /limit_invalid/);
  await assert.rejects(store.documents.search('retrieval', { workspaceRoot: 'other' } as any), /options_invalid/);
});

test('candidate claims never become reusable through model fields, self-verdicts or JSON-forged receipts', async t => {
  const { open, write } = fixture(t); write('guide.md', '@sample/api owner team-a'); const store = await open(['guide.md']);
  const candidate = await proposal(store, 'guide.md', '@sample/api owner team-a'); assert.equal(candidate.status, 'candidate');
  assert.deepEqual(await store.candidates.getReusable(), []); assert.equal('accept' in store.candidates, false); assert.equal('promote' in store.candidates, false);
  await assert.rejects(store.candidates.propose({ claim: candidate.claim, evidence: candidate.evidence, status: 'verified' } as any), /candidate_invalid/);
  await assert.rejects(store.host.promote({ id: candidate.id, verified: true } as unknown as HostAcceptanceReceipt), /receipt_invalid/);
  await assert.rejects(store.host.accept(candidate.id, { verification: 'model-says-done', checkId: 'self' } as any), /acceptance_invalid/);
  const receipt = await store.host.accept(candidate.id, accepted); assert.equal((await store.candidates.list())[0].status, 'verified');
  assert.deepEqual(await store.candidates.getReusable(), []);
  await assert.rejects(store.host.promote(JSON.parse(JSON.stringify(receipt))), /receipt_invalid/);
  const promoted = await store.host.promote(receipt); assert.equal(promoted.status, 'promoted'); assert.equal(promoted.stale, false);
  assert.equal((await store.candidates.getReusable('@sample/api')).length, 1); assert.equal((await store.candidates.getReusable('@sample/missing')).length, 0);
  await assert.rejects(store.host.promote(receipt), /receipt_invalid/);
});

test('candidate evidence must be selected, current, exact and free of common secret values', async t => {
  const { open, write } = fixture(t); write('guide.md', '@sample/api owner team-a'); const store = await open(['guide.md']);
  const good = await proposal(store, 'guide.md', '@sample/api owner team-a');
  for (const evidence of [[{ ...good.evidence[0], path: 'other.md' }], [{ ...good.evidence[0], sha256: '0'.repeat(64) }], [{ ...good.evidence[0], quote: 'not present' }]])
    await assert.rejects(store.candidates.propose({ claim: good.claim, evidence }), /evidence_/);
  await assert.rejects(store.candidates.propose({ claim: { subject: 'account', predicate: 'password', object: 'private-value' }, evidence: good.evidence }), /claim_sensitive/);
});

test('fresh-source check invalidates pending receipts and reusable claims after source edits', async t => {
  const { open, write } = fixture(t); write('guide.md', '@sample/api owner team-a'); const store = await open(['guide.md']);
  const first = await proposal(store, 'guide.md', '@sample/api owner team-a'), receipt = await store.host.accept(first.id, accepted);
  write('guide.md', '@sample/api owner team-b'); await assert.rejects(store.host.promote(receipt), /stale_or_missing/);
  assert.equal((await store.candidates.list())[0].stale, true);
  const second = await proposal(store, 'guide.md', '@sample/api owner team-b', { ...first.claim, object: 'team-b' });
  await store.host.promote(await store.host.accept(second.id, accepted)); assert.equal((await store.candidates.getReusable()).length, 1);
  write('guide.md', '@sample/api owner team-c'); assert.deepEqual(await store.candidates.getReusable(), []);
});

test('conflicting claims remain separate and require explicit retraction before replacement', async t => {
  const { open, write } = fixture(t); write('guide.md', '@sample/api owner team-a\n@sample/api owner team-b'); const store = await open(['guide.md']);
  const first = await proposal(store, 'guide.md', '@sample/api owner team-a'); await store.host.promote(await store.host.accept(first.id, accepted));
  const second = await proposal(store, 'guide.md', '@sample/api owner team-b', { ...first.claim, object: 'team-b' });
  assert.deepEqual(second.conflictIds, [first.id]); const receipt = await store.host.accept(second.id, accepted);
  await assert.rejects(store.host.promote(receipt), /knowledge_conflict/); assert.equal((await store.candidates.getReusable())[0].claim.object, 'team-a');
  await store.host.retract(first.id, 'user-correction'); await store.host.promote(receipt);
  assert.equal((await store.candidates.getReusable())[0].claim.object, 'team-b');
  const audit = await store.candidates.list(); assert.equal(audit.length, 2); assert.equal(audit[0].status, 'retracted'); assert.equal(audit[0].retraction?.reason, 'user-correction');
});

test('persistent state is separate from MemoryStore, scope-bound, immutable to callers and reusable after restart', async t => {
  const { open, write, base } = fixture(t); write('guide.md', '@sample/api owner team-a'); const stateFile = join(base, 'accepted-knowledge.json');
  const store = await open(['guide.md'], { stateFile }), item = await proposal(store, 'guide.md', '@sample/api owner team-a');
  await store.host.promote(await store.host.accept(item.id, accepted)); item.claim.object = 'caller-mutated';
  const restarted = await open(['guide.md'], { stateFile }); assert.equal((await restarted.candidates.getReusable())[0].claim.object, 'team-a');
  assert.equal(existsSync(join(base, 'memory.json')), false);
  await assert.rejects(open(['guide.md'], { stateFile, scope: { workspaceId: 'other' } }), /state_invalid/);
  const other = await open(['guide.md']); const pending = await proposal(other, 'guide.md', '@sample/api owner team-a');
  await assert.rejects(restarted.host.promote(await other.host.accept(pending.id, accepted)), /receipt_invalid/);
});

test('state cannot be placed in the model workspace or silently overwrite external changes', async t => {
  const { open, write, root, base } = fixture(t); write('guide.md', '@sample/api owner team-a');
  await assert.rejects(open(['guide.md'], { stateFile: join(root, 'store.json') }), /state_in_workspace/);
  const stateFile = join(base, 'store.json'), store = await open(['guide.md'], { stateFile });
  const item = await proposal(store, 'guide.md', '@sample/api owner team-a'); const original = readFileSync(stateFile, 'utf8');
  writeFileSync(stateFile, original + ' '); await assert.rejects(store.host.accept(item.id, accepted), /state_changed/);
  await assert.rejects(store.candidates.list(), /state_changed/); assert.equal(readFileSync(stateFile, 'utf8'), original + ' ');
});

test('invalid persisted acceptance does not enter the candidate store', async t => {
  const { open, write, base } = fixture(t); write('guide.md', '@sample/api owner team-a'); const stateFile = join(base, 'store.json');
  const store = await open(['guide.md'], { stateFile }); await proposal(store, 'guide.md', '@sample/api owner team-a');
  const json = JSON.parse(readFileSync(stateFile, 'utf8')); json.records[0].status = 'promoted'; writeFileSync(stateFile, JSON.stringify(json));
  await assert.rejects(open(['guide.md'], { stateFile }), /state_invalid/);
});

test('secret-bearing edits evict previously safe cached snippets and consume the read budget', async t => {
  const { open, write } = fixture(t); write('guide.md', '@sample/api owner team-a'); const store = await open(['guide.md']);
  assert.equal((await store.documents.search('@sample/api')).matches.length, 1);
  const changed = '@sample/api\npassword: SHOULD_NOT_BE_RETURNED'; write('guide.md', changed);
  const result = await store.documents.search('@sample/api'); assert.deepEqual(result.matches, []); assert.equal(result.metrics.cacheHits, 0);
  assert.equal(result.metrics.bytes, Buffer.byteLength(changed)); assert.doesNotMatch(JSON.stringify(result), /SHOULD_NOT_BE_RETURNED/);
});

test('concurrent host operations serialize without allowing conflicting promotion or retracted receipt reuse', async t => {
  const { open, write } = fixture(t); write('guide.md', '@sample/api owner team-a\n@sample/api owner team-b'); const store = await open(['guide.md']);
  const first = await proposal(store, 'guide.md', '@sample/api owner team-a');
  const second = await proposal(store, 'guide.md', '@sample/api owner team-b', { ...first.claim, object: 'team-b' });
  const [one, two] = await Promise.all([store.host.accept(first.id, accepted), store.host.accept(second.id, accepted)]);
  const outcomes = await Promise.allSettled([store.host.promote(one), store.host.promote(two)]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await store.candidates.getReusable()).length, 1);
  await store.host.retract(second.id, 'failed-check'); await assert.rejects(store.host.promote(two), /candidate_state/);
});

test('state parent junction replacement fails closed without changing its new target', async t => {
  const { open, write, base } = fixture(t); write('guide.md', '@sample/api owner team-a');
  const parent = join(base, 'host-state'), outside = join(base, 'other-state'); mkdirSync(parent); mkdirSync(outside);
  const stateFile = join(parent, 'knowledge.json'), store = await open(['guide.md'], { stateFile });
  const item = await proposal(store, 'guide.md', '@sample/api owner team-a');
  // Only directories created for this test are removed; no live user state is involved.
  rmSync(stateFile); rmSync(parent, { recursive: true }); symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.host.accept(item.id, accepted), /state_path/); assert.equal(existsSync(join(outside, 'knowledge.json')), false);
});
