import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectDiscordAttachments as select } from '../src/plugins/discord-attachment-selection.js';
import { attachmentInstructions, stageNativeAttachments } from '../src/server/discord-documents.js';
import { DiscordAttachmentStore } from '../src/server/discord-attachment-store.js';
import { createDiscordIsolation } from '../src/server/discord-isolation.js';

const file = (id: string, name: string, time: number) => ({ id: id.repeat(64), sha256: id.repeat(64), name, size: 10, expiresAt: time });
const pdf = file('a', 'old-square.pdf', 1000), wav = file('b', 'current-voice.wav', 10000), olderAudio = file('c', 'old-voice.wav', 500);
const files = [wav, olderAudio, pdf]; // Deliberately NOT chronological.
for (const text of ['내용 분석하고 핵심 말해\n내용 평문으로 다 출력하고', '내용 전부 출력', '전체 내용 정리해', '이거 읽어', 'summarize this file']) {
  assert.deepEqual(select(text, files, [], [wav.id]).files, [wav]);
  assert.deepEqual(select(text, files, [wav.id], [pdf.id]).files, [wav]);
  assert.deepEqual(select(text, files, []).files, [wav]);
}
assert.deepEqual(select('PDF 내용', files, [], [wav.id]).files, [pdf]);
assert.deepEqual(select('음성 분석', files, [], [pdf.id]).files, [wav]);
assert.deepEqual(select('old-voice.wav 읽어', files, [], [wav.id]).files, [olderAudio]);
assert.deepEqual(select('모든 첨부 파일 분석', files, [], [wav.id]).files, files);
assert.deepEqual(select('파일 전부 분석', files, [], [wav.id]).files, files);
assert.deepEqual(select('안녕 오늘 날씨는?', files, [], [wav.id]).files, []);
assert.deepEqual(select('음성 파일 분석', [pdf], [], [pdf.id]).files, []);
assert.equal(select('내용 분석', [wav, { ...pdf, expiresAt: 10001 }], []).reason, 'ambiguous');
assert.deepEqual(select('이거 요약', [wav], [], ['foreign-ticket-id']).files, [wav]);
const prompt = attachmentInstructions([wav], { [wav.id]: 'fixture/current-voice.wav' });
assert.ok(!prompt.includes(pdf.name) && !prompt.includes(olderAudio.name));
assert.match(prompt, /이전 대화의 다른 파일/);
assert.match(prompt, /인식 원문과 추정·교정은 구분/);

const previous = process.env.MR_ROBOT_HOME;
const root = mkdtempSync(join(tmpdir(), 'mrrobot-attachment-focus-'));
process.env.MR_ROBOT_HOME = root;
try {
  // Store uses the same default path as production functions, but isolated home.
  const store = new DiscordAttachmentStore();
  const a = store.put('ticket', 'old.pdf', Buffer.from('old fixture'));
  const b = store.put('ticket', 'current.wav', Buffer.from('voice fixture'));
  const run = stageNativeAttachments('ticket', [b]);
  assert.deepEqual(Object.keys(run.paths), [b.id]);
  assert.equal(run.paths[a.id], undefined);
  assert.ok(existsSync(run.paths[b.id]!)); run.cleanup(); assert.ok(!existsSync(run.paths[b.id]!));
  const scoped = createDiscordIsolation('ticket', false, [b.id]);
  assert.deepEqual(JSON.parse(await scoped.execute('attachment_list', {})).map((f: any) => f.id), [b.id]);
  await assert.rejects(scoped.execute('attachment_read', { attachment_id: a.id }), /선택한 첨부가 아닙니다/);
  await assert.rejects(scoped.execute('isolated_python', { attachment_id: a.id, code: 'print(1)' }), /선택한 첨부가 아닙니다/);
  assert.deepEqual(JSON.parse(await createDiscordIsolation('ticket', false, []).execute('attachment_list', {})), []);
  await assert.rejects(createDiscordIsolation('foreign-ticket', false, [b.id]).execute('attachment_read', { attachment_id: b.id }));
  assert.throws(() => createDiscordIsolation('ticket', false, ['bad']));
  assert.throws(() => createDiscordIsolation('ticket', false, 'bad'));
} finally {
  if (previous === undefined) delete process.env.MR_ROBOT_HOME; else process.env.MR_ROBOT_HOME = previous;
  rmSync(root, { recursive: true, force: true });
}
console.log('Attachment selection passed: current audio only, persistent focus, explicit older/all, ambiguous recovery, scoped tools and native staging.');
