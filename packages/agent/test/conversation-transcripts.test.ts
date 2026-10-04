import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConversationStore } from '../src/conversations.js';
import { TranscriptStore } from '../src/transcript-store.js';
import type { Turn } from '../src/ai/provider.js';

const usage = { promptTokens: 11, completionTokens: 7, cachedPromptTokens: 5 };
const turn = (index: number, size = 20): Turn => ({ role: index % 2 ? 'assistant' : 'user', content: `${index}: ${'가'.repeat(size)} exact-tail-${index}` });
function fixture(t: { after: (callback: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), 'mr-robot-transcripts-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new ConversationStore(home);
  const conversation = store.create();
  return { home, store, id: conversation.id };
}
function snapshot(store: ConversationStore, id: string): any { return store.exportSnapshot(true).find((item: any) => item.id === id); }
function chunkPath(home: string, ref: { archiveId: string; head: string }): string {
  return join(home, 'private', 'conversation-transcripts', ref.archiveId, `${ref.head}.json`);
}
function sameMessages(actual: { role: string; content: string }[] | undefined, expected: Turn[]): void {
  assert.ok(actual);
  assert.equal(actual.length, expected.length);
  actual.forEach((message, index) => {
    assert.equal(message.role, expected[index].role);
    assert.ok(message.content === expected[index].content, `message ${index} must preserve the complete original text`);
  });
}

test('compaction bounds the prompt while exact original text survives reload', t => {
  const { home, store, id } = fixture(t);
  const originals = Array.from({ length: 40 }, (_, i) => turn(i, 4_000));
  store.appendResult(id, originals, usage, { operationId: 'run-1' });
  assert.equal(store.turns(id).length, 12);
  assert.ok(store.contextSummary(id)?.includes('- user:'));
  sameMessages(store.get(id)?.messages, originals);
  sameMessages(new ConversationStore(home).get(id)?.messages, originals);
  assert.equal(store.get(id)?.history?.missingMessages, 0);
  assert.equal(store.get(id)?.history?.archivedTurns, 40);
  assert.equal(snapshot(store, id).turns.length, 12);
  assert.equal((store.exportSnapshot()[0] as any).transcript, undefined);
});

test('ultra preference survives reload while unknown protocol efforts are rejected', t => {
  const { home, store, id } = fixture(t);
  store.update(id, { reasoningEffort: 'ultra' });
  assert.equal(new ConversationStore(home).get(id)?.reasoningEffort, 'ultra');
  assert.throws(() => store.update(id, { reasoningEffort: 'future' as never }), /추론 단계/);
  assert.equal(store.get(id)?.reasoningEffort, 'ultra');
  assert.throws(() => store.create({ reasoningEffort: 'future' as never }), /추론 단계/);
});

test('paged history crosses chunk boundaries in chronological order without duplicates', t => {
  const { store, id } = fixture(t);
  const originals = Array.from({ length: 350 }, (_, i) => turn(i, 350));
  store.appendResult(id, originals, usage);
  let cursor: string | undefined;
  let restored: { role: string; content: string }[] = [];
  do {
    const detail = store.get(id, { limit: 37, before: cursor })!;
    assert.ok(detail.messages.length <= 37);
    restored = [...detail.messages, ...restored];
    cursor = detail.history?.nextCursor;
    assert.equal(detail.history?.hasMore, Boolean(cursor));
  } while (cursor);
  sameMessages(restored, originals);
  assert.equal(store.get(id)?.messages.length, 100);
  assert.throws(() => store.get(id, { limit: 201 }));
  assert.throws(() => store.get(id, { before: '../../config.json' }));
});

test('legacy summaries remain labelled missing and available originals are migrated', t => {
  const { home, store, id } = fixture(t);
  const originals = Array.from({ length: 20 }, (_, i) => turn(i));
  store.appendResult(id, originals, usage);
  const legacy = snapshot(store, id);
  delete legacy.transcript;
  legacy.compactedMessages = 42;
  legacy.summary = '- user: only a surviving excerpt';
  writeFileSync(join(home, 'conversations.json'), JSON.stringify([legacy]));
  const loaded = new ConversationStore(home);
  assert.equal(loaded.get(id)?.history?.missingMessages, 42);
  const next = [...loaded.turns(id), turn(20), turn(21)];
  loaded.appendResult(id, next, usage);
  sameMessages(new ConversationStore(home).get(id)?.messages, next);
  assert.equal(loaded.get(id)?.history?.missingMessages, 42);
  assert.equal(loaded.get(id)?.messages.some(message => message.content.includes('surviving excerpt')), false);
});

test('append retries are idempotent across restart and reject changed payloads', t => {
  const { home, store, id } = fixture(t);
  const originals = Array.from({ length: 40 }, (_, i) => turn(i, 4_000));
  const first = store.appendResult(id, originals, usage, { operationId: 'stable-run' });
  const before = readFileSync(join(home, 'conversations.json'), 'utf8');
  assert.deepEqual(store.appendResult(id, originals, usage, { operationId: 'stable-run' }), first);
  assert.deepEqual(new ConversationStore(home).appendResult(id, originals, usage, { operationId: 'stable-run' }), first);
  assert.equal(readFileSync(join(home, 'conversations.json'), 'utf8'), before);
  assert.throws(() => store.appendResult(id, [turn(999)], usage, { operationId: 'stable-run' }), /다른 결과/);
});

test('durable retry receipts survive beyond the bounded hot receipt window', t => {
  const { home, store, id } = fixture(t);
  const first = [turn(0)];
  store.appendResult(id, first, usage, { operationId: 'oldest-run' });
  for (let index = 1; index <= 66; index++) {
    store.appendResult(id, [...store.turns(id), turn(index)], usage, { operationId: `run-${index}` });
  }
  const before = store.get(id);
  assert.equal(snapshot(store, id).transcript.recentAppends.length, 64);
  assert.deepEqual(new ConversationStore(home).appendResult(id, first, usage, { operationId: 'oldest-run' }), before);
  assert.equal(store.get(id)?.history?.archivedTurns, 67);
});

test('an empty result has a durable receipt without a fabricated message', t => {
  const { home, store, id } = fixture(t);
  store.appendResult(id, [], usage, { operationId: 'empty-run' });
  assert.equal(store.get(id)?.messages.length, 0);
  for (let index = 0; index < 65; index++) {
    store.appendResult(id, [...store.turns(id), turn(index)], usage, { operationId: `next-${index}` });
  }
  const before = store.get(id);
  assert.deepEqual(new ConversationStore(home).appendResult(id, [], usage, { operationId: 'empty-run' }), before);
});

test('failed commit and simulated crash preserve prior history and retry reuses orphan chunks', t => {
  const { home, store, id } = fixture(t);
  store.appendResult(id, [turn(0), turn(1)], usage);
  const before = store.get(id);
  const persisted = readFileSync(join(home, 'conversations.json'), 'utf8');
  const next = [...store.turns(id), turn(2), turn(3)];
  const originalSave = (store as any).save;
  (store as any).save = () => { throw new Error('injected commit failure'); };
  assert.throws(() => store.appendResult(id, next, usage, { operationId: 'retry' }), /injected/);
  (store as any).save = originalSave;
  assert.deepEqual(store.get(id), before);
  assert.equal(readFileSync(join(home, 'conversations.json'), 'utf8'), persisted);
  const reloaded = new ConversationStore(home);
  assert.deepEqual(reloaded.get(id), before);
  const directory = join(home, 'private', 'conversation-transcripts', snapshot(store, id).transcript.archiveId);
  const orphanedFileCount = readdirSync(directory).length;
  reloaded.appendResult(id, next, usage, { operationId: 'retry' });
  assert.equal(readdirSync(directory).length, orphanedFileCount);
  sameMessages(reloaded.get(id)?.messages, next);
  assert.equal(reloaded.get(id)?.usage.promptTokens, usage.promptTokens * 2);
});

test('a truncated archive is preserved, reported unavailable, and blocks compaction writes', t => {
  const { home, store, id } = fixture(t);
  store.appendResult(id, [turn(0), turn(1)], usage);
  const file = chunkPath(home, snapshot(store, id).transcript);
  const corrupt = '{"interrupted":';
  writeFileSync(file, corrupt);
  const detail = store.get(id)!;
  assert.equal(detail.history?.unavailable, true);
  sameMessages(detail.messages, [turn(0), turn(1)]);
  assert.ok(store.recovery.diagnostics.some(item => item.code === 'conversation-transcript-unavailable'));
  const persisted = readFileSync(join(home, 'conversations.json'), 'utf8');
  assert.throws(() => store.appendResult(id, [...store.turns(id), turn(2)], usage));
  assert.equal(readFileSync(file, 'utf8'), corrupt);
  assert.equal(readFileSync(join(home, 'conversations.json'), 'utf8'), persisted);
  assert.equal(new ConversationStore(home).get(id)?.history?.unavailable, true);
});

test('malformed archive with matching content hash is rejected without replacing it', t => {
  const { home, store, id } = fixture(t);
  store.appendResult(id, [turn(0)], usage);
  const item = snapshot(store, id);
  const raw = JSON.stringify({ version: 1, offset: 0, turns: [{ role: 'invalid', content: 'bad' }] });
  item.transcript.head = createHash('sha256').update(raw).digest('hex');
  const file = chunkPath(home, item.transcript);
  writeFileSync(file, raw);
  writeFileSync(join(home, 'conversations.json'), JSON.stringify([item]));
  const reloaded = new ConversationStore(home);
  assert.equal(reloaded.get(id)?.history?.unavailable, true);
  assert.equal(readFileSync(file, 'utf8'), raw);
});

test('deletion tombstones survive backup recovery, while failed deletions roll back', t => {
  const { home, store, id } = fixture(t);
  store.appendResult(id, [turn(0), turn(1)], usage);
  const before = store.get(id);
  const originalSave = (store as any).save;
  (store as any).save = () => { throw new Error('delete failed'); };
  assert.throws(() => store.delete(id), /delete failed/);
  (store as any).save = originalSave;
  assert.deepEqual(store.get(id), before);
  assert.equal(new ConversationStore(home).get(id)?.id, id);
  assert.equal(store.delete(id), true);
  // The old backup still contains the deleted item; the durable tombstone wins.
  writeFileSync(join(home, 'conversations.json'), '[');
  assert.equal(new ConversationStore(home).get(id), undefined);
});

test('a crash after deletion intent cannot resurrect an old committed snapshot', t => {
  const { home, store, id } = fixture(t);
  store.appendResult(id, [turn(0)], usage);
  const tombstones = join(home, 'private', 'conversation-transcripts', 'deleted');
  mkdirSync(tombstones, { recursive: true });
  writeFileSync(join(tombstones, `${createHash('sha256').update(id).digest('hex')}.json`), '{"version":1}');
  assert.equal(new ConversationStore(home).get(id), undefined);
});

test('prompt tool-output rewrites do not replace archived originals when newTurns is supplied', t => {
  const { store, id } = fixture(t);
  const originals: Turn[] = [turn(0), { role: 'tool', content: '', toolResults: [{ id: 'call-1', name: 'file', content: 'exact original tool output' }] }, turn(1)];
  store.appendResult(id, originals, usage);
  const next: Turn[] = [turn(2), turn(3)];
  const rewritten = structuredClone(store.turns(id));
  rewritten[1].toolResults![0].content = 'short prompt excerpt';
  store.appendResult(id, [...rewritten, ...next], usage, { operationId: 'tool-run', newTurns: next });
  assert.equal(store.get(id)?.messages[1].content, 'file: exact original tool output');
  assert.equal(store.get(id)?.messages.length, 5);
  assert.equal(store.turns(id)[1].toolResults?.[0].content, 'short prompt excerpt');
});

test('paging reads recent chunks without loading an older malformed chunk', t => {
  const { home } = fixture(t);
  const archive = new TranscriptStore(home, value => value as Turn);
  let ref = archive.append(archive.empty('bounded-read'), [turn(0)]);
  const olderFile = chunkPath(home, ref as any);
  ref = archive.append(ref, [turn(1), turn(2), turn(3)]);
  writeFileSync(olderFile, 'bad old bytes');
  const latest = archive.page(ref, { limit: 2 });
  assert.deepEqual(latest.turns, [turn(2), turn(3)]);
  assert.equal(latest.hasMore, true);
  assert.throws(() => archive.page(ref, { limit: 2, before: latest.nextCursor }));
  assert.ok(existsSync(olderFile));
});

test('page cursors are authenticated and cannot select an uncommitted orphan', t => {
  const { home } = fixture(t);
  const archive = new TranscriptStore(home, value => value as Turn);
  const ref = archive.append(archive.empty('signed-pages'), [turn(0), turn(1), turn(2)]);
  const orphan = archive.append(ref, [turn(3)]);
  const page = archive.page(ref, { limit: 1 });
  assert.ok(page.nextCursor);
  const parts = page.nextCursor.split(':');
  parts[1] = orphan.head!;
  assert.throws(() => archive.page(ref, { before: parts.join(':') }), /커서/);
  assert.throws(() => archive.page(orphan, { before: page.nextCursor }), /변경/);
});

test('oversized display turns are labelled and bounded while complete archive bytes survive', t => {
  const { home, store, id } = fixture(t);
  const hugeUser: Turn = { role: 'user', content: `${'가'.repeat(120_000)} exact-user-end` };
  const hugeTool: Turn = { role: 'tool', content: '', toolResults: [
    { id: 'tool-1', name: 'file', content: `${'x'.repeat(400_000)} exact-tool-end` },
  ] };
  const hugeAssistant: Turn = { role: 'assistant', content: '', toolCalls: [
    { id: 'tool-1', name: 'file', args: `{"value":"${'y'.repeat(200_000)}"}` },
  ] };
  store.appendResult(id, [hugeUser, hugeAssistant, hugeTool], usage);
  const ref = snapshot(store, id).transcript;
  const archived: Turn[] = [];
  let head = ref.head;
  while (head) {
    const chunk = JSON.parse(readFileSync(chunkPath(home, { ...ref, head }), 'utf8'));
    archived.unshift(...chunk.turns);
    head = chunk.previous;
  }
  assert.deepEqual(archived, [hugeUser, hugeAssistant, hugeTool]);
  let cursor: string | undefined;
  let count = 0;
  do {
    const detail = store.get(id, { limit: 1, before: cursor })!;
    assert.equal(detail.messages.length, 1);
    assert.equal(detail.history?.displayTruncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(detail.messages[0])) <= 128 * 1024);
    assert.ok(JSON.stringify(detail.messages[0]).includes('표시 제한'));
    cursor = detail.history?.nextCursor;
    count++;
  } while (cursor);
  assert.equal(count, 3);
  assert.equal(new ConversationStore(home).get(id)?.history?.displayTruncated, true);
  assert.equal(store.turns(id)[0].content, hugeUser.content);
});

test('archive and legacy pages stay below 2 MiB and continue through byte-limited windows', t => {
  const { home, store, id } = fixture(t);
  const originals = Array.from({ length: 40 }, (_, index): Turn => ({ role: index % 2 ? 'assistant' : 'user', content: `${index}: ${'x'.repeat(64_000)}` }));
  store.appendResult(id, originals, usage);
  const first = store.get(id, { limit: 200 })!;
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 2 * 1024 * 1024);
  assert.ok(first.messages.length < 40);
  assert.equal(first.history?.hasMore, true);
  assert.equal(first.history?.displayTruncated, undefined);
  const second = store.get(id, { limit: 200, before: first.history?.nextCursor })!;
  sameMessages([...second.messages, ...first.messages], originals);
  const legacy = snapshot(store, id);
  delete legacy.transcript;
  legacy.turns = originals;
  writeFileSync(join(home, 'conversations.json'), JSON.stringify([legacy]));
  const reloaded = new ConversationStore(home);
  const legacyFirst = reloaded.get(id, { limit: 200 })!;
  assert.ok(Buffer.byteLength(JSON.stringify(legacyFirst)) < 2 * 1024 * 1024);
  const legacySecond = reloaded.get(id, { limit: 200, before: legacyFirst.history?.nextCursor })!;
  sameMessages([...legacySecond.messages, ...legacyFirst.messages], originals);
});

test('local rollback preserves archive pointers and remote imports ignore forged pointers', t => {
  const { home, store, id } = fixture(t);
  const originals = Array.from({ length: 40 }, (_, i) => turn(i, 4_000));
  store.appendResult(id, originals, usage);
  const saved = store.exportSnapshot(true);
  store.appendResult(id, [...store.turns(id), turn(40)], usage);
  store.restoreSnapshot(saved);
  sameMessages(new ConversationStore(home).get(id)?.messages, originals);
  const other = new ConversationStore(join(home, 'other'));
  const forged = structuredClone(saved) as any[];
  forged[0].transcript = { archiveId: '../../escape', head: 'bad' };
  other.mergeSnapshot(forged);
  assert.equal(other.get(id)?.history?.unavailable, undefined);
  assert.equal(other.get(id)?.history?.missingMessages, 28);
  assert.equal(other.get(id)?.messages.length, 12);
});
