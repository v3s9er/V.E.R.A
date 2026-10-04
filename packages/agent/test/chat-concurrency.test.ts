import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRunQueue } from '../src/server/project-run-queue.js';

test('project queue is FIFO, abortable and does not block independent projects', async () => {
  const queue = new ProjectRunQueue(), order: string[] = [];
  const first = await queue.acquire({ workspaceId: 'a', permissionMode: 'full' });
  const abort = new AbortController();
  const cancelled = queue.acquire({ workspaceId: 'a', permissionMode: 'full' }, abort.signal);
  const cancelledCheck = assert.rejects(cancelled);
  const second = queue.acquire({ workspaceId: 'a', permissionMode: 'full' }).then(release => { order.push('second'); return release; });
  const third = queue.acquire({ workspaceId: 'a', permissionMode: 'read-only' }).then(release => { order.push('third'); return release; });
  const other = await queue.acquire({ workspaceId: 'b', permissionMode: 'full' });
  abort.abort(); await cancelledCheck; assert.deepEqual(order, []);
  first(); const releaseSecond = await second; assert.deepEqual(order, ['second']);
  releaseSecond(); const releaseThird = await third; assert.deepEqual(order, ['second', 'third']);
  releaseThird(); other(); first();
  const readers = await Promise.all([1, 2].map(() => queue.acquire({ workspaceId: 'a', permissionMode: 'read-only' })));
  readers.forEach(release => release());
});

async function fixture(run: (state: any) => Promise<void>) {
  const previous = process.env.MR_ROBOT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'vera-chat-concurrency-'));
  process.env.MR_ROBOT_HOME = home;
  const { AgentServer } = await import('../src/server/server.js');
  const { ChatSession } = await import('../src/server/chat.js');
  const server: any = new AgentServer();
  const events: any[] = [], started: string[] = [], finish = new Map<string, () => void>(), options = new Map<string, any>(), hooks = new Map<string, any>();
  const client = { id: 'admin-test', directLoopback: true, state: { authed: true, auth: { isAdmin: true, permissionCap: 'full' }, chat: new ChatSession() }, sendEvent: (event: string, data: any) => events.push({ event, data }) };
  server.hub = { clients: [client], close() {} };
  server.plugins.aiTools = () => [];
  server.loop.run = async (history: any[], text: string, callbacks: any, _tools: unknown, config: any) => {
    started.push(text); options.set(text, config); hooks.set(text, callbacks);
    await new Promise<void>((resolve, reject) => {
      finish.set(text, resolve);
      callbacks.signal.addEventListener('abort', () => reject(callbacks.signal.reason), { once: true });
      if (callbacks.signal.aborted) reject(callbacks.signal.reason);
    });
    return { text: `answer:${text}`, turns: [...history, { role: 'user', content: text }, { role: 'assistant', content: `answer:${text}` }], usage: { promptTokens: 1, completionTokens: 1 } };
  };
  try { await run({ server, handlers: server.handlers(), client, events, started, finish, options, hooks, home }); }
  finally {
    server.cancelAllRuns(); for (const release of finish.values()) release();
    await server.stop();
    if (previous === undefined) delete process.env.MR_ROBOT_HOME; else process.env.MR_ROBOT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('same connection runs distinct conversations concurrently; cancellation is conversation scoped', () => fixture(async ({ server, handlers, client, started, finish }: any) => {
  const a = server.conversations.create(), b = server.conversations.create();
  const one = handlers.get('chat.start')({ conversationId: a.id, text: 'first' }, client);
  const two = handlers.get('chat.start')({ conversationId: b.id, text: 'second' }, client);
  await tick(); assert.deepEqual(started, ['first', 'second']);
  assert.throws(() => handlers.get('chat.start')({ conversationId: a.id, text: 'duplicate' }, client), /already running/);
  handlers.get('chat.cancel')({ conversationId: a.id }, client);
  assert.equal((await one).ok, false); assert.equal(server.activeRuns.size, 1);
  finish.get('second')(); assert.equal((await two).ok, true);
  assert.equal(server.conversations.turns(b.id).at(-1).content, 'answer:second');
  assert.equal(server.chatRunAdmission.snapshot().globalActive, 0);
}));

test('same-project writes queue instead of returning chat already running and queued cancellation is isolated', () => fixture(async ({ server, handlers, client, started, finish, home }: any) => {
  const path = join(home, 'workspace'); mkdirSync(path);
  const project = server.config.createProject('fixture', path);
  const a = server.conversations.create({ workspaceId: project.id }), b = server.conversations.create({ workspaceId: project.id });
  const one = handlers.get('chat.start')({ conversationId: a.id, text: 'first' }, client);
  const two = handlers.get('chat.start')({ conversationId: b.id, text: 'queued' }, client);
  for (let attempt = 0; attempt < 50 && !started.length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(started, ['first']);
  const runs = handlers.get('chat.runs')({}, client);
  assert.equal(runs.find((run: any) => run.conversationId === b.id).queued, true);
  handlers.get('chat.cancel')({ conversationId: b.id }, client);
  assert.equal((await two).ok, false); assert.deepEqual(started, ['first']);
  finish.get('first')(); assert.equal((await one).ok, true);
}));

test('active configuration edits preserve effective snapshot; stopping applies settings without replay', () => fixture(async ({ server, handlers, client, started, options }: any) => {
  const conversation = server.conversations.create({ providerModel: 'old-model', reasoningEffort: 'high' });
  const result = handlers.get('chat.start')({ conversationId: conversation.id, text: 'running' }, client);
  await tick();
  const run = handlers.get('chat.runs')({}, client)[0];
  const changed = await handlers.get('chat.configure')({ conversationId: conversation.id, patch: { providerModel: 'new-model', daybreakEnabled: true }, apply: 'next-run' }, client);
  assert.equal(changed.application, 'pending'); assert.equal(changed.run.effectiveConfig.providerModel, 'old-model');
  assert.equal(options.get('running').providerModel, 'old-model');
  await assert.rejects(handlers.get('chat.configure')({ conversationId: conversation.id, patch: {}, apply: 'stop-current', expectedRunId: 'stale' }, client), /변경/);
  await assert.rejects(handlers.get('chat.configure')({ conversationId: conversation.id, patch: { permissionMode: 'invalid' }, apply: 'stop-current', expectedRunId: run.runId }, client), /권한/);
  assert.equal(server.activeRuns.size, 1);
  const stopped = await handlers.get('chat.configure')({ conversationId: conversation.id, patch: {}, apply: 'stop-current', expectedRunId: run.runId }, client);
  assert.equal(stopped.application, 'stopped'); assert.equal(stopped.conversation.providerModel, 'new-model');
  assert.equal((await result).ok, false); assert.deepEqual(started, ['running']); assert.equal(server.activeRuns.size, 0);
  assert.equal(server.conversations.turns(conversation.id).at(-2).content, 'running', 'Continuation retains the interrupted request without replaying it.');
  assert.match(server.conversations.turns(conversation.id).at(-1).content, /설정 변경/);
}));

test('configuration ownership and permission ceilings cannot be bypassed', () => fixture(async ({ server, handlers, client }: any) => {
  const conversation = server.conversations.create();
  const result = handlers.get('chat.start')({ conversationId: conversation.id, text: 'owned' }, client);
  await tick();
  const stranger = { ...client, id: 'stranger', state: { ...client.state, auth: { isAdmin: false, linkId: 'other', permissionCap: 'workspace' } } };
  await assert.rejects(handlers.get('chat.configure')({ conversationId: conversation.id, patch: { providerModel: 'stolen' }, apply: 'next-run' }, stranger), /권한|다른|소유|제어/);
  handlers.get('chat.cancel')({ conversationId: conversation.id }, client); await result;
  const changed = await handlers.get('chat.configure')({ conversationId: conversation.id, patch: { permissionMode: 'full' }, apply: 'next-run' }, stranger);
  assert.notEqual(changed.conversation.permissionMode, 'full');
}));

test('progress and run polling compare metadata without rereading transcript pages', () => fixture(async ({ server, handlers, client, hooks, finish }: any) => {
  const conversation = server.conversations.create();
  server.conversations.appendResult(conversation.id, [{ role: 'user', content: 'old request' }, { role: 'assistant', content: 'old answer' }], { promptTokens: 1, completionTokens: 1 });
  const result = handlers.get('chat.start')({ conversationId: conversation.id, text: 'metadata' }, client);
  await tick();
  const original = server.conversations.transcripts.page;
  let pages = 0;
  server.conversations.transcripts.page = function(...args: any[]) { pages++; return original.apply(this, args); };
  hooks.get('metadata').onStatus('working');
  hooks.get('metadata').onText('public partial');
  hooks.get('metadata').onTool({ name: 'fixture', status: 'start', callId: 'a' });
  hooks.get('metadata').onTool({ name: 'fixture', status: 'done', callId: 'a' });
  for (let index = 0; index < 10; index++) handlers.get('chat.runs')({}, client);
  assert.equal(pages, 0);
  finish.get('metadata')(); await result;
}));
