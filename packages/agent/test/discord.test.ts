import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createDiscordPlugin, validateDiscordSettings } from '../src/plugins/discord.js';
import { discordAttachmentStore } from '../src/server/discord-attachment-store.js';

const dir = mkdtempSync(join(tmpdir(), 'mr-robot-discord-test-'));
const previousHome = process.env.MR_ROBOT_HOME;
process.env.MR_ROBOT_HOME = dir;
const timers = new Set<NodeJS.Timeout>();
const commands = new Map<string, Function>();
const storage = new Map<string, unknown>();
const events = new Map<string, Function>();
const replies: any[] = [];
let enabled = true;
let fileReads = 0, readOnlyLock = false;
let revoked = 0;
const fake = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; } });
fake.stdin.on('data', chunk => { for (const line of chunk.toString().trim().split('\n')) replies.push(JSON.parse(line)); });
const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise<void>(resolve => server.once('listening', resolve));
let runId: number | undefined;
let socket: any;
let lastRun: any;
let deferIsolated = false;
let createdConversations = 0;
const held = new Map<any, number>();
server.on('connection', ws => { socket = ws; ws.on('message', raw => {
  const req = JSON.parse(raw.toString());
  if (req.method === 'conversations.get' && req.params.id === 'deleted-ticket') {
    ws.send(JSON.stringify({ id: req.id, error: { message: 'conversation not found' } })); return;
  }
  if (req.method === 'conversations.create') {
    createdConversations++; assert.equal(req.params.origin, 'discord');
  }
  if (req.method === 'chat.start') {
    lastRun = req.params;
    if (req.params.discordIsolation) {
      assert.equal(req.params.permissionMode, 'workspace');
      if (deferIsolated) { held.set(ws, req.id); return; }
      ws.send(JSON.stringify({ id: req.id, result: { text: 'isolated result' } }));
      return;
    }
    assert.equal(req.params.permissionMode, 'full'); assert.equal(req.params.tokenPolicy, 'audit-only');
    runId = req.id;
    ws.send(JSON.stringify({ id: 0, event: 'chat.confirm', data: { conversationId: 'test-conversation', requestId: 'approval-1', summary: 'Test command' } }));
    return;
  }
  if (req.method === 'chat.confirmResponse') {
    assert.equal(req.params.requestId, 'approval-1');
    ws.send(JSON.stringify({ id: runId, ok: true, result: { text: 'Test finished' } }));
  }
  if (req.method === 'chat.cancel' && held.has(ws)) {
    ws.send(JSON.stringify({ id: held.get(ws), result: { ok: false, error: 'fixture cancellation' } }));
    held.delete(ws);
  }
  ws.send(JSON.stringify({ id: req.id, ok: true, result: req.method === 'auth' ? { ok: true, isAdmin: false, permissionCap: 'full', canUseAuditOnly: true } : req.method === 'conversations.create' ? { id: 'test-conversation' } : { ok: true } }));
}); });
const catalog = ['gpt-5.3-codex-spark', 'gpt-5.4-mini', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-astra', 'unknown', 'sol'];
const plugin = createDiscordPlugin({ port: () => (server.address() as any).port, enabled: () => enabled, issue: () => ({ id: 'test-link', token: 'fixture-token' }), revoke: () => { revoked++; }, models: (id) => id ? catalog : [{ providerId: 'provider', type: 'codex-cli', model: 'gpt-6-astra', isDefault: true }], permissionCeiling: () => readOnlyLock ? 'read-only' : 'full', readChatFile: (id) => { assert.equal(id, 'test-conversation'); fileReads++; return { data: 'ZmlsZQ==' }; } }, { spawn: (() => fake) as any });
const ctx: any = {
  storage: { get: (key: string) => storage.get(key), set: (key: string, value: unknown) => storage.set(key, value) },
  registerCommand: (name: string, fn: Function, opts: any) => { assert.equal(opts.adminOnly, true); assert.equal(opts.tool, false); commands.set(name, fn); },
  setTimeout: (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); timers.add(t); return t; },
  clearTimeout: (t: NodeJS.Timeout) => { clearTimeout(t); timers.delete(t); },
  setInterval: (fn: () => void, ms: number) => { const t = setInterval(fn, ms); timers.add(t); return t; },
  on: (name: string, fn: Function) => events.set(name, fn),
};
const waitFor = async (predicate: () => boolean) => {
  const limit = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > limit) throw new Error('test timeout'); await new Promise(r => setTimeout(r, 10)); }
};
const emit = (value: unknown) => fake.stdout.write('__MR_ROBOT_DISCORD__' + JSON.stringify(value) + '\n');
try {
  writeFileSync(join(dir, 'config.json'), '{"bot_token":"test-only"}');
  assert.throws(() => validateDiscordSettings({ botDirectory: '.', pythonPath: 'python' }));
  assert.equal(validateDiscordSettings({ botDirectory: dir, pythonPath: process.execPath }).mode, 'standalone', 'config-only standalone needs no old bot source');
  assert.throws(() => validateDiscordSettings({ botDirectory: dir, pythonPath: process.execPath, mode: 'legacy' }));
  assert.throws(() => validateDiscordSettings({ botDirectory: dir, pythonPath: process.execPath, mode: 'unknown' }));
  await plugin.activate!(ctx);
  storage.set('config', { botDirectory: dir, pythonPath: process.execPath, autoStart: false });
  assert.equal(commands.get('discord.config.get')!().mode, 'legacy', 'old installations preserve news/KTX unless owner switches');
  await commands.get('discord.config.set')!({ botDirectory: dir, pythonPath: process.execPath, autoStart: false });
  enabled = false; await assert.rejects(commands.get('discord.start')!()); enabled = true;
  await commands.get('discord.start')!();
  assert.equal(replies[0].mode, 'standalone');
  assert.equal(JSON.stringify(replies).includes('test-only'), false, 'Discord credentials are read locally, not sent in boot payload');
  assert.throws(() => commands.get('discord.config.set')!({ botDirectory: dir, pythonPath: 'missing' }));
  assert.equal(commands.get('discord.status')!().running, true, 'invalid settings must not kill running plugin');
  assert.equal(JSON.stringify(replies).includes('fixture-token'), false, 'credentials never enter Python pipe');
  emit({ event: 'ready', owner: '123456789012345678', guilds: ['222222222222222222'] });
  emit({ id: 'denied', userId: '999999999999999999', channelId: '111111111111111111', action: 'ask', text: 'No' });
  await waitFor(() => replies.some(r => r.id === 'denied')); assert.ok(replies.find(r => r.id === 'denied').error);
  const identity = { userId: '333333333333333333', channelId: '111111111111111111', guildId: '222222222222222222', guildAdmin: true };
  emit({ ...identity, id: 'foreign', guildId: '444444444444444444', action: 'status' });
  await waitFor(() => replies.some(r => r.id === 'foreign')); assert.ok(replies.find(r => r.id === 'foreign').error);
  emit({ ...identity, id: 'unconfirmed', action: 'access', mode: 'full' });
  await waitFor(() => replies.some(r => r.id === 'unconfirmed')); assert.ok(replies.find(r => r.id === 'unconfirmed').error);
  emit({ ...identity, id: 'full', action: 'access', mode: 'full', confirmFull: true });
  await waitFor(() => replies.some(r => r.id === 'full')); assert.equal(replies.find(r => r.id === 'full').result.permission, 'full');
  let requestSerial = 0;
  const request = async (params: any) => {
    const id = `policy-${++requestSerial}`; emit({ ...identity, ...params, id });
    await waitFor(() => replies.some(r => r.id === id)); return replies.find(r => r.id === id);
  };
  for (const action of ['access', 'model-limit']) {
    assert.ok((await request({ action, guildAdmin: false, mode: 'full', confirmFull: true, targetUserId: identity.userId, ceiling: 'unlimited' })).error, 'non-admin policy mutation denied by host');
  }
  assert.equal((await request({ action: 'model-limit', targetUserId: identity.userId, ceiling: 'sol' })).result.modelCeiling, 'sol');
  assert.deepEqual((await request({ action: 'models', providerId: 'provider' })).result, catalog.slice(0, 5));
  assert.equal((await request({ action: 'models' })).result[0].model, '', 'above-cap configured default not offered');
  assert.equal((await request({ action: 'status', channelId: '666666666666666666' })).result.modelCeiling, 'sol', 'new channels cannot reset per-user cap');
  assert.equal((await request({ action: 'status', userId: '555555555555555555' })).result.modelCeiling, 'unlimited', 'other users isolated');
  const basic = { guildAdmin: false, allowAi: true, userId: '555555555555555555' };
  const basicKey = `${identity.guildId}:${identity.channelId}:${basic.userId}:isolated`;
  storage.set('conversations', { [basicKey]: 'deleted-ticket' });
  const original = discordAttachmentStore().put('deleted-ticket', 'fixture.txt', Buffer.from('synthetic continuity attachment'));
  const createsBeforeRepair = createdConversations;
  assert.equal((await request({ ...basic, action: 'status' })).result.access, 'isolated');
  assert.equal((await request({ ...basic, action: 'models' })).result[0].type, 'codex-cli', 'ordinary users see the same owner subscriptions');
  assert.equal((await request({ ...basic, action: 'ask', text: 'create a safe report' })).result.text, 'isolated result');
  assert.equal(createdConversations, createsBeforeRepair + 1, 'deleted ticket repaired exactly once');
  const repairedId = lastRun.conversationId;
  assert.equal((storage.get('conversations') as any)[basicKey], repairedId);
  assert.equal(discordAttachmentStore().get(repairedId, original.id).data.toString(), 'synthetic continuity attachment');
  assert.equal((await request({ ...basic, action: 'ask', text: 'continue this same ticket' })).result.text, 'isolated result');
  assert.equal(lastRun.conversationId, repairedId, 'follow-up uses the repaired persistent ID');
  assert.equal(createdConversations, createsBeforeRepair + 1, 'follow-up never creates another conversation');
  assert.equal(lastRun.discordIsolation, 'isolated');
  assert.equal(lastRun.providerId, 'provider');
  assert.equal(lastRun.providerModel, 'gpt-6-astra', 'ordinary users follow the owner default within their ceiling');
  const oldPdf = discordAttachmentStore().put(repairedId, 'old-only-fixture.pdf', Buffer.from('old PDF fixture'));
  const currentAudio = discordAttachmentStore().put(repairedId, 'current-only-fixture.wav', Buffer.from('synthetic voice fixture'));
  storage.set('attachmentFocus', { [basicKey]: [currentAudio.id] });
  assert.equal((await request({ ...basic, action: 'ask', text: '내용 분석하고 핵심 말해 내용 평문으로 다 출력하고' })).result.text, 'isolated result');
  assert.deepEqual(lastRun.discordAttachmentIds, [currentAudio.id]);
  assert.ok(lastRun.text.includes(currentAudio.name));
  assert.ok(!lastRun.text.includes(oldPdf.name) && !lastRun.text.includes(original.name));
  assert.equal(lastRun.conversationId, repairedId, 'attachment focus never replaces the ticket session');
  await request({ ...basic, action: 'ask', text: 'old-only-fixture.pdf 내용을 요약해' });
  assert.deepEqual((storage.get('attachmentFocus') as any)[basicKey], [oldPdf.id]);
  await request({ ...basic, action: 'ask', text: '음성 원문 다시 보여줘' });
  assert.deepEqual((storage.get('attachmentFocus') as any)[basicKey], [currentAudio.id]);
  await request({ ...basic, action: 'ask', text: '안녕' });
  assert.deepEqual(lastRun.discordAttachmentIds, []);
  assert.ok(!lastRun.text.includes(currentAudio.name));
  const attachment = { name: 'input.pdf', text: 'attachment fixture about public squares', size: 100, sha256: 'a'.repeat(64), status: 'extracted', warning: '' };
  assert.equal((await request({ ...basic, action: 'ask', text: 'summarize', attachments: [attachment] })).result.text, 'isolated result');
  assert.match(lastRun.text, /attachment fixture about public squares/);
  assert.equal(lastRun.discordIsolation, 'isolated', 'attachments do not grant PC authority');
  assert.ok((storage.get('conversations') as any)[`${identity.guildId}:${identity.channelId}:${basic.userId}:isolated`]);
  assert.match((await request({ ...basic, guildAdmin: true, action: 'result' })).result.message, /^아직 저장된 답변이 없습니다/, 'full scope does not reuse isolated cached reply');
  lastRun = undefined;
  assert.ok((await request({ ...basic, action: 'user-access', targetUserId: basic.userId, mode: 'full', confirmFull: true })).error);
  assert.ok((await request({ ...basic, action: 'thread.bind' })).error);
  assert.ok((await request({ ...basic, allowAi: false, action: 'status' })).error);
  assert.ok((await request({ action: 'user-access', targetUserId: basic.userId, mode: 'full' })).error);
  assert.ok((await request({ action: 'user-access', targetUserId: basic.userId, mode: 'search' })).result);
  assert.equal((await request({ ...basic, action: 'status', channelId: '666666666666666666' })).result.access, 'search');
  assert.ok((await request({ ...basic, action: 'file.read', path: 'C:\\private.txt', offset: 0, limit: 100 })).error);
  assert.ok((await request({ action: 'user-access', targetUserId: basic.userId, mode: 'blocked' })).result);
  assert.ok((await request({ ...basic, action: 'models' })).error);
  assert.ok((await request({ action: 'user-access', targetUserId: basic.userId, mode: 'default' })).result);
  assert.equal((await request({ ...basic, action: 'status' })).result.access, 'isolated');
  assert.ok((await request({ action: 'settings', providerId: 'provider', model: 'gpt-6-astra', effort: 'auto' })).error);
  assert.ok((await request({ action: 'ask', text: 'blocked explicit', model: 'gpt-6-astra' })).error);
  assert.ok((await request({ action: 'ask', text: 'blocked default' })).error);
  assert.equal(lastRun, undefined, 'rejected requests never invoke the agent');
  assert.ok((await request({ action: 'model-limit', targetUserId: identity.userId, ceiling: 'invented' })).error);
  assert.equal((storage.get('modelLimits') as any)[`${identity.guildId}:${identity.userId}`], 'sol', 'policy persisted and invalid update did not widen it');
  assert.ok((await request({ action: 'settings', providerId: 'provider', model: 'gpt-5.6-sol', effort: 'auto' })).result);
  emit({ ...identity, id: 'ask', action: 'ask', text: '한글 명령' });
  await waitFor(() => replies.some(r => r.event === 'approval'));
  assert.equal(lastRun.discordModelCeiling, 'sol');
  assert.equal(lastRun.providerModel, 'gpt-5.6-sol');
  assert.ok((await request({ action: 'model-limit', targetUserId: identity.userId, ceiling: 'astra' })).error, 'in-flight policy change rejected');
  assert.throws(() => commands.get('discord.config.set')!({ botDirectory: dir, pythonPath: process.execPath }));
  assert.equal(commands.get('discord.status')!().busy, true, 'mode change must not interrupt active work');
  emit({ ...identity, userId: '555555555555555555', id: 'other-admin', action: 'approve', requestId: 'approval-1', approve: true });
  await waitFor(() => replies.some(r => r.id === 'other-admin')); assert.ok(replies.find(r => r.id === 'other-admin').error);
  emit({ ...identity, id: 'wrong', action: 'approve', requestId: 'wrong', approve: true });
  await waitFor(() => replies.some(r => r.id === 'wrong')); assert.ok(replies.find(r => r.id === 'wrong').error);
  emit({ ...identity, id: 'approve', action: 'approve', requestId: 'approval-1', approve: true });
  await waitFor(() => replies.some(r => r.id === 'ask')); assert.equal(replies.find(r => r.id === 'ask').result.text, 'Test finished');
  assert.equal(commands.get('discord.status')!().busy, false);
  assert.equal((await request({ action: 'model-limit', targetUserId: identity.userId, ceiling: 'astra' })).result.modelCeiling, 'astra');
  assert.deepEqual((await request({ action: 'models', providerId: 'provider' })).result, catalog.slice(0, 6));
  assert.equal((await request({ action: 'model-limit', targetUserId: identity.userId, ceiling: 'show' })).result.modelCeiling, 'astra');
  assert.ok((await request({ action: 'model-limit', targetUserId: identity.userId, ceiling: 'unlimited' })).result);
  assert.deepEqual((await request({ action: 'models', providerId: 'provider' })).result, catalog);
  emit({ ...identity, id: 'result', action: 'result' });
  await waitFor(() => replies.some(r => r.id === 'result')); assert.equal(replies.find(r => r.id === 'result').result.text, 'Test finished');
  assert.equal((await request({ action: 'file.read', path: 'fixture', offset: 0, limit: 100 })).result.data, 'ZmlsZQ==');
  assert.ok((await request({ action: 'file.read', userId: '999999999999999999', path: 'fixture', offset: 0, limit: 100 })).error);
  assert.ok((await request({ action: 'file.read', guildAdmin: false, path: 'fixture', offset: 0, limit: 100 })).error);
  readOnlyLock = true;
  assert.ok((await request({ action: 'file.read', path: 'fixture', offset: 0, limit: 100 })).error);
  readOnlyLock = false;
  await request({ action: 'access', mode: 'workspace' });
  assert.ok((await request({ action: 'file.read', path: 'fixture', offset: 0, limit: 100 })).error);
  assert.equal(fileReads, 1, 'denied Discord identities/scopes never reach the filesystem');
  const setup = commands.get('discord.workspace.setup')!({ channelName: 'ai_talk' });
  assert.equal(setup.workspace.state, 'pending');
  assert.ok(replies.some(r => r.event === 'workspace.setup' && r.channelName === 'ai_talk'));
  emit({ event: 'workspace.ready', guildId: '999999999999999999', channelId: identity.channelId, panelId: '777777777777777777', pinned: true });
  assert.equal(commands.get('discord.status')!().workspace.state, 'pending', 'unregistered guild cannot bind workspace');
  emit({ event: 'workspace.ready', guildId: identity.guildId, channelId: identity.channelId, panelId: '777777777777777777', pinned: true });
  await waitFor(() => commands.get('discord.status')!().workspace.state === 'ready');
  assert.equal((storage.get('threadState') as any).bindings[identity.guildId], identity.channelId);
  assert.ok(replies.some(r => r.event === 'thread.state'));
  deferIsolated = true;
  const peer = { ...basic, userId: '777777777777777777', channelId: '888888888888888888' };
  emit({ ...identity, ...basic, id: 'parallel-a', action: 'ask', text: 'parallel A' });
  emit({ ...identity, ...peer, id: 'parallel-b', action: 'ask', text: 'parallel B' });
  await waitFor(() => held.size === 2);
  assert.equal(commands.get('discord.status')!().activeCount, 2);
  assert.ok((await request({ ...basic, userId: '666666666666666666', action: 'ask', text: 'third' })).error);
  assert.ok((await request({ action: 'ask', text: 'full exclusive' })).error);
  assert.ok((await request({ ...basic, action: 'stop' })).result);
  await waitFor(() => replies.some(r => r.id === 'parallel-a'));
  assert.equal(held.size, 1, 'stop affects only the caller websocket/session');
  assert.equal(replies.some(r => r.id === 'parallel-b'), false);
  for (const [ws, id] of held) ws.send(JSON.stringify({ id, result: { text: 'peer result' } }));
  held.clear();
  await waitFor(() => replies.some(r => r.id === 'parallel-b'));
  assert.equal(replies.find(r => r.id === 'parallel-b').result.text, 'peer result');
  assert.equal(commands.get('discord.status')!().activeCount, 0);
  emit({ event: 'disconnected' });
  assert.match((await request({ ...basic, action: 'status' })).error, /재연결/);
  emit({ event: 'ready', owner: '123456789012345678', guilds: [identity.guildId] });
  assert.equal((await request({ ...basic, action: 'status' })).result.access, 'isolated');
  enabled = false; events.get('plugins.changed')!();
  assert.ok(revoked > 0); assert.equal(commands.get('discord.status')!().running, false);
  console.log('Discord tests passed: registered guild administrator, explicit full permission, per-user approval isolation, unlimited RPC, results, disable/revoke');
} finally {
  await plugin.deactivate!(ctx);
  for (const t of timers) clearTimeout(t);
  socket?.terminate(); await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.MR_ROBOT_HOME; else process.env.MR_ROBOT_HOME = previousHome;
}
