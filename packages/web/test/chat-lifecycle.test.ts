import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watchChatSettlement, ChatRequestOwnership } from '../../shared/src/chat-lifecycle.js';

test('late request completion cannot own a newer attempt or another conversation', () => {
  const ownership = new ChatRequestOwnership();
  const old = ownership.begin('a'); const other = ownership.begin('b');
  ownership.finish('a'); const next = ownership.begin('a');
  assert.equal(ownership.owns('a', old), false);
  assert.equal(ownership.owns('a', next), true);
  assert.equal(ownership.owns('b', other), true);
  ownership.clear(); assert.equal(ownership.owns('a', next), false);
});

test('cancellation stays pending through active runs, network failures and invalid snapshots', async () => {
  const values: unknown[] = [[{ conversationId: 'a', running: true }], Error('offline'), null, [{ conversationId: 'a' }], [{ conversationId: 'a', running: true }], []];
  let polls = 0; const states: string[] = [];
  await watchChatSettlement({ conversationId: 'a', signal: { aborted: false }, wait: async () => {},
    loadRuns: async () => { const value = values[polls++]; if (value instanceof Error) throw value; return value; },
    onRunning: () => states.push('running'), onUnavailable: () => states.push('unknown'), onSettled: () => states.push('settled'),
  });
  assert.equal(polls, 6);
  assert.deepEqual(states, ['running', 'unknown', 'unknown', 'unknown', 'running', 'settled']);
});

test('a stale cancellation cannot finish a new server run', async () => {
  await watchChatSettlement({ conversationId: 'a', runId: 'old', signal: { aborted: false }, wait: async () => {},
    loadRuns: async () => [{ conversationId: 'a', runId: 'new', running: true }],
    onRunning: () => assert.fail('new run'), onSettled: () => assert.fail('new run'), onUnavailable: () => assert.fail('new run'),
  });
});

test('unmount or terminal event aborts an in-flight snapshot without later UI updates', async () => {
  const signal = { aborted: false };
  await watchChatSettlement({ conversationId: 'a', signal, wait: async () => {},
    loadRuns: async () => { signal.aborted = true; return []; },
    onRunning: () => assert.fail('unmounted'), onSettled: () => assert.fail('unmounted'), onUnavailable: () => assert.fail('unmounted'),
  });
});
