import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationDisplayTitle, groupProjectConversations, parseCollapsedProjects } from '../../shared/src/projects.js';
import { ChatRequestOwnership, ConversationSaveBarrier } from '../../shared/src/chat-lifecycle.js';

test('reopened settings wait for their own save, without blocking another conversation', async () => {
  const saves = new ConversationSaveBarrier();
  saves.add('a'); saves.add('a');
  let reopened = false;
  const pending = saves.wait('a').then(() => { reopened = true; });
  await saves.wait('b');
  assert.equal(reopened, false);
  saves.delete('a'); await pending;
  assert.equal(reopened, true); assert.equal(saves.has('a'), false);
  saves.add('a'); saves.delete('a'); await saves.wait('a');
});

test('dispatch ownership remains independent across selected conversations', () => {
  const ownership = new ChatRequestOwnership();
  const first = ownership.begin('a');
  ownership.begin('b');
  assert.equal(ownership.has('a'), true); assert.equal(ownership.has('b'), true);
  ownership.finish('b');
  assert.equal(ownership.owns('a', first), true); assert.equal(ownership.has('b'), false);
});

test('empty titles are useful without exposing draft text or overriding user titles', () => {
  assert.equal(conversationDisplayTitle({ title: '  ', messageCount: 0 }), '새 대화');
  assert.equal(conversationDisplayTitle({ title: '새 대화', messageCount: 0 }, true), '작성 중인 새 대화');
  assert.equal(conversationDisplayTitle({ title: '  My\n project ', messageCount: 0 }, true), 'My project');
  assert.equal(conversationDisplayTitle({ title: '', messageCount: 2 }), '제목 없는 대화');
});

test('groups preserve conversation order and retain detached/unassigned conversations', () => {
  const projects = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  const chats = [{ id: '1', workspaceId: 'a' }, { id: '2', workspaceId: 'gone' }, { id: '3' }, { id: '4', workspaceId: 'a' }];
  assert.deepEqual(groupProjectConversations(projects, chats).map(g => [g.id, g.conversations.map(c => c.id)]), [['a', ['1', '4']], ['__unassigned__', ['2', '3']]]);
  assert.deepEqual(groupProjectConversations(projects, chats, 'b'), [{ id: 'b', name: 'B', conversations: [] }]);
});

test('persisted collapse preferences tolerate malformed or excessive input', () => {
  assert.deepEqual(parseCollapsedProjects('{bad'), []);
  assert.deepEqual(parseCollapsedProjects('{"a":true}'), []);
  assert.deepEqual(parseCollapsedProjects('["a","a",1,null,"b"]'), ['a', 'b']);
  assert.equal(parseCollapsedProjects(JSON.stringify(Array.from({ length: 300 }, (_, i) => String(i)))).length, 200);
});
