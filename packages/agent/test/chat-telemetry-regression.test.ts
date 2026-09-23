import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Turn } from '../src/ai/provider.js';
import type { RoutingTrace } from '../src/telemetry.js';

async function withServer(run: (server: any, handlers: Map<string, any>, client: any, events: Array<{ event: string; data: any }>, logErrors: string[]) => Promise<void>): Promise<void> {
  const previousHome = process.env.MR_ROBOT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'mrrobot-chat-telemetry-test-'));
  process.env.MR_ROBOT_HOME = home;
  const { AgentServer } = await import('../src/server/server.js');
  const { ChatSession } = await import('../src/server/chat.js');
  const server = new AgentServer();
  const events: Array<{ event: string; data: any }> = [];
  const logErrors: string[] = [];
  const client = { id: 'synthetic-admin', directLoopback: true, state: { auth: { isAdmin: true, permissionCap: 'full' }, authed: true, chat: new ChatSession() }, sendEvent: (event: string, data: any) => events.push({ event, data }) };
  (server as any).hub = { clients: [client], close: () => {} };
  server.logger.error = message => { logErrors.push(message); };
  server.plugins.aiTools = () => [];
  server.memory.context = () => '';
  try { await run(server, (server as any).handlers(), client, events, logErrors); }
  finally {
    await server.stop();
    if (previousHome === undefined) delete process.env.MR_ROBOT_HOME; else process.env.MR_ROBOT_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

const usage = { promptTokens: 9, completionTokens: 4, cachedPromptTokens: 3, reasoningTokens: 1, accountedTokens: 13 };
const route = { providerId: 'synthetic-provider', providerLabel: 'Fixture', model: 'synthetic-model', role: 'general', effort: 'auto' };

test('chat.start remains successful if telemetry persistence throws, and emits done rather than error', () => withServer(async (server, handlers, client, events, errors) => {
  const attempts: RoutingTrace[] = [];
  server.telemetry.record = (trace: RoutingTrace) => { attempts.push(trace); throw new Error('synthetic telemetry disk failure'); };
  server.loop.run = async (history: Turn[], text: string, callbacks: any) => {
    callbacks.onStatus('synthetic work in progress');
    callbacks.onText('');
    callbacks.onText('Completed answer.');
    callbacks.onModelUsage(usage, route);
    return { text: 'Completed answer.', turns: [...history, { role: 'user', content: text }, { role: 'assistant', content: 'Completed answer.' }], usage, route };
  };
  const result = await handlers.get('chat.start')({ text: 'Synthetic question', permissionMode: 'ask' }, client);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Completed answer.');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].ok, true);
  assert.equal(attempts[0].cachedPromptTokens, 3);
  assert.ok(typeof attempts[0].firstTextMs === 'number');
  assert.ok(attempts[0].firstTextMs! >= 0 && attempts[0].firstTextMs! <= attempts[0].latencyMs);
  assert.equal(errors.length, 1);
  assert.equal(events.filter(item => item.event === 'chat.done').length, 1);
  assert.equal(events.some(item => item.event === 'chat.error'), false);
  assert.equal(server.conversations.turns(result.conversationId).at(-1).content, 'Completed answer.');
  assert.equal(client.state.chat.busy, false);
  assert.equal(server.activeRuns.size, 0);
  assert.equal(server.busyConversations.size, 0);
  assert.equal(server.chatRunAdmission.snapshot().globalActive, 0);
}));

test('tool metrics reset per request, count start events only and ignore older transcript tool calls', () => withServer(async (server, handlers, client) => {
  const traces: RoutingTrace[] = [];
  server.telemetry.record = (trace: RoutingTrace) => traces.push(trace);
  const conversation = server.conversations.create({ permissionMode: 'ask' });
  const oldTurns: Turn[] = [{ role: 'user', content: 'Earlier synthetic request' }, { role: 'assistant', content: 'Earlier tool work', toolCalls: [0, 1, 2].map(index => ({ id: `old-${index}`, name: 'read_file', args: '{}' })) }, { role: 'assistant', content: 'Earlier result' }];
  server.conversations.appendResult(conversation.id, oldTurns, { promptTokens: 1, completionTokens: 1 });
  let turn = 0;
  server.loop.run = async (history: Turn[], text: string, callbacks: any) => {
    turn++;
    if (turn === 1) {
      assert.equal(history.reduce((sum, item) => sum + (item.toolCalls?.length ?? 0), 0), 3);
      callbacks.onTool({ name: 'list_files', input: {}, status: 'start' });
      callbacks.onTool({ name: 'list_files', input: {}, status: 'done' });
      callbacks.onTool({ name: 'read_file', input: {}, status: 'start' });
      callbacks.onTool({ name: 'read_file', input: {}, status: 'error' });
      callbacks.onText('New result');
    } else {
      callbacks.onStatus('No answer stream observed');
      callbacks.onText('');
    }
    return { text: 'New result', turns: [...history, { role: 'user', content: text }, { role: 'assistant', content: 'New result' }], usage, route };
  };
  const first = await handlers.get('chat.start')({ text: 'First request', conversationId: conversation.id }, client);
  const second = await handlers.get('chat.start')({ text: 'Second request', conversationId: conversation.id }, client);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.equal(traces[0].toolCalls, 2, 'Not five from previous transcript plus this request, nor four start/end notifications.');
  assert.equal(traces[1].toolCalls, 0, 'Counter is request-local.');
  assert.equal(typeof traces[0].firstTextMs, 'number');
  assert.equal(traces[1].firstTextMs, undefined, 'Absent observation must not fabricate zero latency.');
}));

test('failed chat retains its real provider error and partial usage despite telemetry persistence failure', () => withServer(async (server, handlers, client, events, errors) => {
  const traces: RoutingTrace[] = [];
  server.telemetry.record = (trace: RoutingTrace) => { traces.push(trace); throw new Error('synthetic telemetry failure'); };
  server.loop.run = async (_history: Turn[], _text: string, callbacks: any) => {
    callbacks.onTool({ name: 'list_files', input: {}, status: 'start' });
    callbacks.onModelUsage(usage, route);
    throw new Error('synthetic original provider failure');
  };
  const result = await handlers.get('chat.start')({ text: 'Failing synthetic request' }, client);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'synthetic original provider failure');
  assert.equal(traces.length, 1); assert.equal(traces[0].ok, false);
  assert.equal(traces[0].toolCalls, 1); assert.equal(traces[0].promptTokens, 9);
  assert.equal(traces[0].firstTextMs, undefined); assert.equal(traces[0].cancelled, false);
  assert.equal(events.filter(item => item.event === 'chat.error').length, 1);
  assert.equal(events.some(item => item.event === 'chat.done'), false);
  assert.equal(errors.length, 1);
  assert.equal(server.chatRunAdmission.snapshot().globalActive, 0);
}));

test('REST completion also survives telemetry write failure and records only once', () => withServer(async (server, _handlers, _client, _events, errors) => {
  let records = 0;
  server.telemetry.record = () => { records++; throw new Error('synthetic storage failure'); };
  server.loop.run = async () => ({ text: 'REST result', turns: [{ role: 'assistant', content: 'REST result' }], usage, route });
  const result = await server.chatOnce('Synthetic REST request', { isAdmin: true, permissionCap: 'full' });
  assert.equal(result.text, 'REST result'); assert.equal(records, 1); assert.equal(errors.length, 1);
  assert.equal(server.chatRunAdmission.snapshot().globalActive, 0);
}));

test('failed runs attribute one observed model and enrich its label from actual usage', () => withServer(async (server, handlers, client) => {
  const traces: RoutingTrace[] = [];
  server.telemetry.record = (trace: RoutingTrace) => traces.push(trace);
  server.loop.run = async (_history: Turn[], _text: string, callbacks: any) => {
    callbacks.beforeModelCall({ providerId: 'actual-provider', model: 'actual-model' });
    callbacks.onModelUsage(usage, { providerId: 'actual-provider', model: 'actual-model', providerLabel: 'Observed provider label' });
    callbacks.beforeModelCall({ providerId: 'actual-provider', model: 'actual-model' });
    throw new Error('synthetic provider failure');
  };
  const result = await handlers.get('chat.start')({ text: 'Synthetic attempt', providerId: 'unobserved-request-id', providerModel: 'unobserved-request-model' }, client);
  assert.equal(result.ok, false);
  assert.equal(traces[0].providerId, 'actual-provider');
  assert.equal(traces[0].model, 'actual-model');
  assert.equal(traces[0].providerLabel, 'Observed provider label');
}));

test('failed runs with multiple exact provider/model tuples are explicitly marked without guessed provider', () => withServer(async (server, handlers, client) => {
  const traces: RoutingTrace[] = [];
  server.telemetry.record = (trace: RoutingTrace) => traces.push(trace);
  server.loop.run = async (_history: Turn[], _text: string, callbacks: any) => {
    // These tuples collide if naively joined by a colon rather than encoded separately.
    callbacks.beforeModelCall({ providerId: 'fixture:a', model: 'b' });
    callbacks.onModelUsage(usage, { providerId: 'fixture:a', model: 'b', providerLabel: 'First provider' });
    callbacks.beforeModelCall({ providerId: 'fixture', model: 'a:b' });
    throw new Error('synthetic mixed-model failure');
  };
  const result = await handlers.get('chat.start')({ text: 'Synthetic mixed-model attempt' }, client);
  assert.equal(result.ok, false);
  assert.equal(traces[0].model, '복수 모델');
  assert.equal(traces[0].providerId, undefined);
  assert.equal(traces[0].providerLabel, undefined);
}));

test('a Discord-denied model is never recorded as an executed model', () => withServer(async (server, handlers, client) => {
  const traces: RoutingTrace[] = [];
  server.telemetry.record = (trace: RoutingTrace) => traces.push(trace);
  client.state.auth.trustedDiscord = true;
  server.loop.run = async (_history: Turn[], _text: string, callbacks: any) => {
    callbacks.beforeModelCall({ providerId: 'denied-provider', model: 'gpt-6-astra' });
    assert.fail('Discord ceiling must reject before the provider call.');
  };
  const result = await handlers.get('chat.start')({ text: 'Synthetic denied selection', discordModelCeiling: 'luna' }, client);
  assert.equal(result.ok, false);
  assert.match(result.error, /모델 상한/);
  assert.equal(traces[0].providerId, undefined);
  assert.equal(traces[0].providerLabel, undefined);
  assert.equal(traces[0].model, undefined);
  assert.equal(traces[0].promptTokens, 0);
}));
