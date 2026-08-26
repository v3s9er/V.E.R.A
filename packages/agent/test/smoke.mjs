/**
 * Smoke test for the Mr.Robot agent core. Run after `npm run build:agent`:
 *   node packages/agent/test/smoke.mjs
 *
 * Covers: event bus, plugin attach/detach leak-freedom, plugin commands,
 * computer shell/screen, HTTP API + pairing, WebSocket RPC.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const here = dirnameOf(import.meta);
const dist = resolve(here, '..', 'dist');

const { AgentServer } = await import(pathToFileURL(join(dist, 'server', 'server.js')).href);
const { EventBus } = await import(pathToFileURL(join(dist, 'eventbus.js')).href);
const { runShell } = await import(pathToFileURL(join(dist, 'computer', 'shell.js')).href);
const { screenSize } = await import(pathToFileURL(join(dist, 'computer', 'screen.js')).href);

function dirnameOf(meta) {
  return fileURLToPath(new URL('.', meta.url));
}

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name} ${detail}`);
  }
}

// ---------------------------------------------------------------------------
console.log('1. event bus');
const bus = new EventBus();
let count = 0;
const off = bus.on('x', () => count++);
bus.emit('x');
check('on/emit', count === 1);
off();
bus.emit('x');
check('off stops delivery', count === 1);

// ---------------------------------------------------------------------------
console.log('2. plugins: leak-free attach/detach');
const home = mkdtempSync(join(tmpdir(), 'mr-robot-test-'));
process.env.MR_ROBOT_HOME = home;

const server = new AgentServer();
const helloPath = resolve(here, '..', '..', '..', 'examples', 'plugins', 'hello', 'index.js');
const monitorPath = resolve(here, '..', '..', '..', 'examples', 'plugins', 'monitor', 'index.js');

const logListenersBefore = server.bus.listenerCount('log');

const hello = await server.plugins.load(helloPath);
check('hello loads', hello.status === 'loaded' && hello.commands.includes('hello.greet'));

const greet = await server.plugins.call('hello.greet', { name: 'Mr.Robot' });
check('plugin command call', greet?.reply === 'Hello, Mr.Robot!');

const monitor = await server.plugins.load(monitorPath);
check('monitor loads with tracked resources', monitor.subscriptions >= 1 && monitor.timers >= 1);

await server.plugins.unload('monitor');
const afterMonitor = server.plugins.list();
check('monitor unloaded', !afterMonitor.some((p) => p.id === 'monitor'));

// Re-load/unload in a loop — listener/timer counts must never creep up.
for (let i = 0; i < 50; i++) {
  await server.plugins.load(monitorPath);
  await server.plugins.unload('monitor');
}
const logListenersAfter = server.bus.listenerCount('log');
check('listener count stable after 50 cycles', logListenersAfter === logListenersBefore, `${logListenersBefore} -> ${logListenersAfter}`);
check('no plugins left', server.plugins.list().length === 1 && server.plugins.list()[0].id === 'hello');

await server.plugins.unload('hello');
check('hello unloaded', server.plugins.list().length === 0);

// CJS-style cache test: loading the same ESM file twice yields fresh modules.
await server.plugins.load(helloPath);
const first = await server.plugins.call('hello.greet', {});
await server.plugins.unload('hello');
await server.plugins.load(helloPath);
const second = await server.plugins.call('hello.greet', {});
check('fresh module on re-load', first.reply === second.reply);

// ---------------------------------------------------------------------------
console.log('3. computer: shell + screen');
const echo = await runShell('echo mr-robot-shell-ok', { shell: 'cmd', timeoutMs: 8000 });
check('cmd echo', echo.ok && echo.stdout.includes('mr-robot-shell-ok'), echo.stdout);
const size = await screenSize();
check('screen size', size.width > 0 && size.height > 0, JSON.stringify(size));

// ---------------------------------------------------------------------------
console.log('4. HTTP API + pairing + WS RPC');
const { host, port } = await server.start({ port: 8799, host: '127.0.0.1' });
const base = `http://127.0.0.1:${port}`;

const builtInOrca = server.plugins.list().find((plugin) => plugin.id === 'orca');
check('built-in Orca integration loads', builtInOrca?.commands.includes('orca.delegate'));
check('Orca plugin defaults to disabled', builtInOrca?.enabled === false);
check('Orca schemas hidden for ordinary chat', !server.plugins.aiTools('안녕').some((tool) => tool.name.startsWith('orca.')));
check('disabled Orca schemas hidden for coding chat', !server.plugins.aiTools('이 저장소 버그를 코딩해서 고쳐줘').some((tool) => tool.name === 'orca.delegate'));
server.plugins.setEnabled('orca', true);
check('enabled Orca schemas available for coding chat', server.plugins.aiTools('이 저장소 버그를 코딩해서 고쳐줘').some((tool) => tool.name === 'orca.delegate'));
const orcaStatus = await server.plugins.call('orca.status', {});
check('Orca status is bounded and structured', typeof orcaStatus?.installed === 'boolean' && typeof orcaStatus?.runtimeConnected === 'boolean');
check('Orca delegation defaults to off', orcaStatus?.enabled === false);
server.plugins.setEnabled('orca', false);

const ping = await (await fetch(`${base}/api/ping`)).json();
check('GET /api/ping', ping.ok === true);

const pairing = await (await fetch(`${base}/api/pairing`)).json();
check('pairing info (loopback)', pairing.pin && pairing.qrPayload && pairing.maskedSecret && pairing.hosts?.includes(pairing.host));

const bad = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '000000' }) });
check('wrong pin rejected', bad.status === 400);

const paired = await (
  await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: pairing.pin }) })
).json();
check('pin exchange returns secret', typeof paired.secret === 'string' && paired.secret.length > 32);

const noAuth = await fetch(`${base}/api/status`);
check('status requires auth', noAuth.status === 401);

const authed = await fetch(`${base}/api/status`, { headers: { 'x-mr-robot-token': paired.secret } });
const status = await authed.json();
check('status with token', authed.status === 200 && status.ok === true, JSON.stringify(status));

const uploaded = await fetch(`${base}/api/files/upload?path=${encodeURIComponent('smoke/direct-transfer.txt')}`, {
  method: 'PUT',
  headers: { 'content-type': 'application/octet-stream', 'x-mr-robot-token': paired.secret },
  body: 'direct bytes without an AI call',
});
check('paired device uploads direct file stream', uploaded.status === 200 && (await uploaded.json()).size === 31);
const fileList = await (await fetch(`${base}/api/files?path=${encodeURIComponent('smoke')}`, { headers: { 'x-mr-robot-token': paired.secret } })).json();
check('paired device lists shared files', fileList.items?.some((entry) => entry.name === 'direct-transfer.txt'));
const downloaded = await fetch(`${base}/api/files/download?path=${encodeURIComponent('smoke/direct-transfer.txt')}`, { headers: { 'x-mr-robot-token': paired.secret } });
check('paired device downloads direct file stream', downloaded.status === 200 && await downloaded.text() === 'direct bytes without an AI call');
const directPull = await fetch(`${base}/api/files/pull`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-mr-robot-token': paired.secret },
  body: JSON.stringify({ sourceBase: base, sourceSecret: paired.secret, sourcePath: 'smoke/direct-transfer.txt', targetPath: 'smoke/direct-copy.txt' }),
});
check('PC-to-PC endpoint performs direct stream pull', directPull.status === 200 && (await directPull.json()).transport === 'direct-device-stream');
const traversal = await fetch(`${base}/api/files/download?path=${encodeURIComponent('../config.json')}`, { headers: { 'x-mr-robot-token': paired.secret } });
check('shared-file traversal is blocked', traversal.status === 404);
const syncSnapshot = await (await fetch(`${base}/api/sync/snapshot`, { headers: { 'x-mr-robot-token': paired.secret } })).json();
check('paired device exports versioned work snapshot', syncSnapshot.version === 1 && Array.isArray(syncSnapshot.conversations) && Array.isArray(syncSnapshot.routingPresets));
const syncPull = await fetch(`${base}/api/sync/pull`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-mr-robot-token': paired.secret },
  body: JSON.stringify({ sourceBase: base, sourceSecret: paired.secret }),
});
check('device work sync uses direct transport and zero AI tokens', syncPull.status === 200 && (await syncPull.json()).aiTokens === 0);

// WS RPC
const ws = await new Promise((resolveWs, reject) => {
  const s = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  s.on('open', () => resolveWs(s));
  s.on('error', reject);
});
const rpc = (socket, method, params) =>
  new Promise((resolveRpc) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === id) {
        socket.off('message', onMsg);
        resolveRpc(msg);
      }
    };
    socket.on('message', onMsg);
    socket.send(JSON.stringify({ id, method, params }));
  });

const unauthStatus = await rpc(ws, 'status', {});
check('ws rejects before auth', unauthStatus.ok === false && unauthStatus.error?.code === 1001);

const authRes = await rpc(ws, 'auth', { secret: paired.secret });
check('ws auth', authRes.ok === true && authRes.result?.ok === true);

const wsStatus = await rpc(ws, 'status', {});
check('ws status after auth', wsStatus.ok === true && wsStatus.result?.hostname);

const createdConversation = await rpc(ws, 'conversations.create', { title: '테스트 대화', reasoningEffort: 'high' });
check('persistent conversation create', createdConversation.ok === true && createdConversation.result?.title === '테스트 대화');
const modelConversation = await rpc(ws, 'conversations.update', { id: createdConversation.result.id, providerId: 'provider-test', providerModel: 'model-for-this-chat' });
check('conversation-specific model persists', modelConversation.ok === true && modelConversation.result?.providerId === 'provider-test' && modelConversation.result?.providerModel === 'model-for-this-chat');
const scenarioConversation = await rpc(ws, 'conversations.update', { id: createdConversation.result.id, routingPresetId: 'builtin:efficient-quality' });
check('conversation-specific scenario persists', scenarioConversation.ok === true && scenarioConversation.result?.routingPresetId === 'builtin:efficient-quality');
const directConversation = await rpc(ws, 'conversations.update', { id: createdConversation.result.id, routingPresetId: null });
check('conversation scenario can be disabled for single-model mode', directConversation.ok === true && !directConversation.result?.routingPresetId);
const conversationList = await rpc(ws, 'conversations.list', { status: 'active' });
check('persistent conversation list', conversationList.ok === true && conversationList.result?.some((c) => c.id === createdConversation.result.id));

const blockedEscalation = await rpc(ws, 'settings.set', { safety: { mode: 'full' } });
check('device token cannot escalate global permission', blockedEscalation.ok === false);
const adminAuth = await rpc(ws, 'auth', { secret: pairing.localSecret });
check('loopback admin auth', adminAuth.ok === true && adminAuth.result?.ok === true);
const presetList = await rpc(ws, 'routing.presets.list', {});
check('routing presets exposed over RPC', presetList.ok === true && presetList.result?.length >= 4);
const presetSave = await rpc(ws, 'routing.presets.save', { name: 'RPC 테스트 트리' });
check('routing preset saves over RPC', presetSave.ok === true && presetSave.result?.builtin === false);
const presetApply = await rpc(ws, 'routing.presets.apply', { id: presetSave.result.id });
check('routing preset applies over RPC', presetApply.ok === true && presetApply.result?.activePresetId === presetSave.result.id);
const presetDelete = await rpc(ws, 'routing.presets.delete', { id: presetSave.result.id });
check('routing preset deletes over RPC', presetDelete.ok === true && presetDelete.result?.ok === true);
await rpc(ws, 'settings.set', { safety: { mode: 'full' } });
const elevatedLink = await rpc(ws, 'pairing.link.update', { id: paired.linkId, permissionCap: 'full' });
check('admin can set per-device permission cap', elevatedLink.ok === true && elevatedLink.result?.permissionCap === 'full');
await rpc(ws, 'auth', { secret: paired.secret });
const shellRes = await rpc(ws, 'computer.shell', { command: 'echo ws-shell-ok', shell: 'cmd' });
check('ws computer.shell', shellRes.ok === true && shellRes.result?.stdout?.includes('ws-shell-ok'));

const chatRes = await rpc(ws, 'chat.start', { text: '안녕' });
check('ws chat without provider -> graceful', chatRes.ok === true && chatRes.result?.ok === true);

ws.close();

await server.stop();
rmSync(home, { recursive: true, force: true });

console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
