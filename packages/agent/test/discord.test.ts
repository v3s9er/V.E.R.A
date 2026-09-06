import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createDiscordPlugin, validateDiscordSettings } from '../src/plugins/discord.js';

const dir = mkdtempSync(join(tmpdir(), 'mr-robot-discord-test-'));
const timers = new Set<NodeJS.Timeout>();
const commands = new Map<string, Function>();
const storage = new Map<string, unknown>();
const events = new Map<string, Function>();
const replies: any[] = [];
let enabled = true;
let revoked = 0;
const fake = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; } });
fake.stdin.on('data', chunk => { for (const line of chunk.toString().trim().split('\n')) replies.push(JSON.parse(line)); });
const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise<void>(resolve => server.once('listening', resolve));
let runId: number | undefined;
let socket: any;
let lastRun: any;
server.on('connection', ws => { socket = ws; ws.on('message', raw => {
  const req = JSON.parse(raw.toString());
  if (req.method === 'chat.start') {
    lastRun = req.params;
    assert.equal(req.params.permissionMode, 'full'); assert.equal(req.params.tokenPolicy, 'audit-only');
    runId = req.id;
    ws.send(JSON.stringify({ id: 0, event: 'chat.confirm', data: { conversationId: 'test-conversation', requestId: 'approval-1', summary: 'Test command' } }));
    return;
  }
  if (req.method === 'chat.confirmResponse') {
    assert.equal(req.params.requestId, 'approval-1');
    ws.send(JSON.stringify({ id: runId, ok: true, result: { text: 'Test finished' } }));
  }
  ws.send(JSON.stringify({ id: req.id, ok: true, result: req.method === 'auth' ? { ok: true, isAdmin: false, permissionCap: 'full', canUseAuditOnly: true } : req.method === 'conversations.create' ? { id: 'test-conversation' } : { ok: true } }));
}); });
const catalog = ['gpt-5.3-codex-spark', 'gpt-5.4-mini', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-astra', 'unknown', 'sol'];
const plugin = createDiscordPlugin({ port: () => (server.address() as any).port, enabled: () => enabled, issue: () => ({ id: 'test-link', token: 'fixture-token' }), revoke: () => { revoked++; }, models: (id) => id ? catalog : [{ providerId: 'provider', model: 'gpt-6-astra', isDefault: true }], permissionCeiling: () => 'full' }, { spawn: (() => fake) as any });
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
  const setup = commands.get('discord.workspace.setup')!({ channelName: 'ai_talk' });
  assert.equal(setup.workspace.state, 'pending');
  assert.ok(replies.some(r => r.event === 'workspace.setup' && r.channelName === 'ai_talk'));
  emit({ event: 'workspace.ready', guildId: '999999999999999999', channelId: identity.channelId, panelId: '777777777777777777', pinned: true });
  assert.equal(commands.get('discord.status')!().workspace.state, 'pending', 'unregistered guild cannot bind workspace');
  emit({ event: 'workspace.ready', guildId: identity.guildId, channelId: identity.channelId, panelId: '777777777777777777', pinned: true });
  await waitFor(() => commands.get('discord.status')!().workspace.state === 'ready');
  assert.equal((storage.get('threadState') as any).bindings[identity.guildId], identity.channelId);
  assert.ok(replies.some(r => r.event === 'thread.state'));
  enabled = false; events.get('plugins.changed')!();
  assert.ok(revoked > 0); assert.equal(commands.get('discord.status')!().running, false);
  console.log('Discord tests passed: registered guild administrator, explicit full permission, per-user approval isolation, unlimited RPC, results, disable/revoke');
} finally {
  await plugin.deactivate!(ctx);
  for (const t of timers) clearTimeout(t);
  socket?.terminate(); await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
}
