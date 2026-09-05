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
server.on('connection', ws => { socket = ws; ws.on('message', raw => {
  const req = JSON.parse(raw.toString());
  if (req.method === 'chat.start') {
    assert.equal(req.params.permissionMode, 'ask'); assert.equal(req.params.tokenPolicy, 'adaptive');
    runId = req.id;
    ws.send(JSON.stringify({ id: 0, event: 'chat.confirm', data: { conversationId: 'test-conversation', requestId: 'approval-1', summary: 'Test command' } }));
    return;
  }
  if (req.method === 'chat.confirmResponse') {
    assert.equal(req.params.requestId, 'approval-1');
    ws.send(JSON.stringify({ id: runId, ok: true, result: { text: 'Test finished' } }));
  }
  ws.send(JSON.stringify({ id: req.id, ok: true, result: req.method === 'auth' ? { ok: true, isAdmin: false, permissionCap: 'ask' } : req.method === 'conversations.create' ? { id: 'test-conversation' } : { ok: true } }));
}); });
const plugin = createDiscordPlugin({ port: () => (server.address() as any).port, enabled: () => enabled, issue: () => ({ id: 'test-link', token: 'fixture-token' }), revoke: () => { revoked++; }, models: () => [] }, { spawn: (() => fake) as any });
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
  mkdirSync(join(dir, 'bot')); writeFileSync(join(dir, 'bot', 'client.py'), ''); writeFileSync(join(dir, 'main.py'), '');
  assert.throws(() => validateDiscordSettings({ botDirectory: '.', pythonPath: 'python' }));
  await plugin.activate!(ctx);
  await commands.get('discord.config.set')!({ botDirectory: dir, pythonPath: process.execPath, autoStart: false });
  enabled = false; await assert.rejects(commands.get('discord.start')!()); enabled = true;
  await commands.get('discord.start')!();
  assert.equal(JSON.stringify(replies).includes('fixture-token'), false, 'credentials never enter Python pipe');
  emit({ event: 'ready', owner: '123456789012345678' });
  emit({ id: 'denied', userId: '999999999999999999', channelId: '111111111111111111', action: 'ask', text: 'No' });
  await waitFor(() => replies.some(r => r.id === 'denied')); assert.ok(replies.find(r => r.id === 'denied').error);
  const identity = { userId: '123456789012345678', channelId: '111111111111111111' };
  emit({ ...identity, id: 'ask', action: 'ask', text: '한글 명령' });
  await waitFor(() => replies.some(r => r.event === 'approval'));
  emit({ ...identity, id: 'wrong', action: 'approve', requestId: 'wrong', approve: true });
  await waitFor(() => replies.some(r => r.id === 'wrong')); assert.ok(replies.find(r => r.id === 'wrong').error);
  emit({ ...identity, id: 'approve', action: 'approve', requestId: 'approval-1', approve: true });
  await waitFor(() => replies.some(r => r.id === 'ask')); assert.equal(replies.find(r => r.id === 'ask').result.text, 'Test finished');
  assert.equal(commands.get('discord.status')!().busy, false);
  enabled = false; events.get('plugins.changed')!();
  assert.ok(revoked > 0); assert.equal(commands.get('discord.status')!().running, false);
  console.log('Discord integration tests passed: owner gate, private credential, RPC events, approval binding, completion, disable/revoke');
} finally {
  await plugin.deactivate!(ctx);
  for (const t of timers) clearTimeout(t);
  socket?.terminate(); await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
}
