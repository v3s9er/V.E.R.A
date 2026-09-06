import assert from 'node:assert/strict';
import { chatFileLinks } from '../../shared/src/chat-files.js';
import { chatFileRoot } from '../src/server/chat-file-access.js';
import { cliProgress, createCliProgress } from '../src/ai/cli-progress.js';
import { parseCodexOutput, parseClaudeOutput } from '../src/ai/cli.js';

const path = String.raw`C:\Users\fixture\Downloads\[로폼]금전차용증.pdf`;
const text = `다운로드: [[로폼]금전차용증.pdf](<${path}>)`;
const messages = [{ role: 'assistant', content: text }];
const root = String.raw`C:\Users\fixture\Downloads`;
assert.deepEqual(chatFileLinks(text), [{ path, name: '[로폼]금전차용증.pdf' }]);
assert.equal(chatFileLinks(text + text).length, 1);
assert.deepEqual(chatFileLinks('[bad](https://example.invalid/file) [bad](file://host/file)'), []);
assert.equal(chatFileRoot(path, messages, undefined, root, false), undefined);
assert.equal(chatFileRoot(path, messages, undefined, root, true), root);
assert.equal(chatFileRoot(path, [{ role: 'user', content: text }], undefined, root, true), undefined);
assert.equal(chatFileRoot(path, [], root, root, true), undefined);
assert.equal(chatFileRoot(path, messages, root, root, false), root);
for (const suffix of ['../private.pdf', '.ssh/id_rsa', '.env', 'private.key', 'doc.pdf:secret', 'folder/../../outside.pdf']) {
  const candidate = `${root}\\${suffix}`;
  assert.equal(chatFileRoot(candidate, [{ role: 'assistant', content: `[x](<${candidate}>)` }], undefined, root, true), undefined, suffix);
}
const output: string[] = [], feed = createCliProgress(s => output.push(s));
const event = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', phase: 'commentary', text: '파일을 확인했어요' } }) + '\n';
for (const character of event) feed(character);
feed(event);
feed('x'.repeat(70_000)); feed('\n');
feed(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'SECRET' } }) + '\n');
assert.deepEqual(output, ['파일을 확인했어요', '명령을 실행하고 있습니다']);
assert.equal(cliProgress({ type: 'item.completed', item: { type: 'reasoning', text: 'PRIVATE_THINKING' } }), '요청을 분석하고 있습니다');
assert.equal(cliProgress({ type: 'content_block_delta', delta: { thinking: 'PRIVATE_THINKING' } }), undefined);
assert.equal(parseCodexOutput(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'PRIVATE_THINKING' } })).text, '');
const claude = parseClaudeOutput('{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"PRIVATE"}]}}\n{"type":"result","result":"완료","usage":{"input_tokens":12,"output_tokens":3}}\n');
assert.equal(claude.text, '완료'); assert.equal(claude.usage.promptTokens, 12);
console.log('Chat files and progress: Korean links, conversation provenance, permission roots, credential exclusions, bounded fragmented events, private reasoning exclusion passed');
