/**
 * Smoke test for the Mr.Robot agent core. Run after `npm run build:agent`:
 *   node packages/agent/test/smoke.mjs
 *
 * Covers: event bus, plugin attach/detach leak-freedom, plugin commands,
 * computer shell/screen, HTTP API + pairing, WebSocket RPC.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const here = dirnameOf(import.meta);
const dist = resolve(here, '..', 'dist');

const { AgentServer } = await import(pathToFileURL(join(dist, 'server', 'server.js')).href);
const { browserOriginAllowed, createByteLimitStream, isTailnetAddress, normalizePeerBase, resolveConfinedPath } = await import(pathToFileURL(join(dist, 'server', 'http.js')).href);
const { createRemoteLinkPlugin, namedTunnelReady, normalizeNamedTunnelHostname, normalizeRemoteLinkLocalUrl, parseQuickTunnelUrl, redactRemoteLinkDiagnostics } = await import(pathToFileURL(join(dist, 'plugins', 'remote-link.js')).href);
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

console.log('1b. transport + HTTP security helpers');
check('Tailscale CGNAT transport range accepted', isTailnetAddress('100.64.0.1') && isTailnetAddress('100.127.255.254') && isTailnetAddress('::ffff:100.100.10.20'));
check('look-alike non-Tailscale ranges rejected', !isTailnetAddress('100.63.255.255') && !isTailnetAddress('100.128.0.1') && !isTailnetAddress('192.168.10.20'));
check('private peer base accepted', normalizePeerBase('http://192.168.10.20:8787').origin === 'http://192.168.10.20:8787');
let metadataBlocked = false;
try { normalizePeerBase('http://169.254.169.254'); } catch { metadataBlocked = true; }
check('cloud metadata/link-local peer blocked', metadataBlocked);
let publicPeerBlocked = false;
try { normalizePeerBase('https://example.com'); } catch { publicPeerBlocked = true; }
check('arbitrary public peer blocked', publicPeerBlocked);
check('same browser origin accepted', browserOriginAllowed('http://127.0.0.1:8787', '127.0.0.1:8787', '127.0.0.1'));
check('foreign browser origin rejected', !browserOriginAllowed('https://evil.example', '127.0.0.1:8787', '127.0.0.1'));
let byteLimitBlocked = false;
try {
  await pipeline(
    Readable.from(Buffer.alloc(9)),
    createByteLimitStream(8, 'test limit'),
    new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
  );
} catch { byteLimitBlocked = true; }
check('stream byte limit counts actual bytes', byteLimitBlocked);
check('quick tunnel URL parser', parseQuickTunnelUrl('INF route https://quiet-tree.trycloudflare.com ready') === 'https://quiet-tree.trycloudflare.com');
const cloudflared2026QuickOutput = [
  '2026-08-30T22:37:45Z INF | Your quick Tunnel has been created! Visit it at (it may take some time to be reachable): |',
  '2026-08-30T22:37:45Z INF | https://paradise-motorola-absorption-colony.trycloudflare.com |',
].join('\n');
check('quick tunnel URL parser accepts cloudflared 2026.8 boxed output', parseQuickTunnelUrl(cloudflared2026QuickOutput) === 'https://paradise-motorola-absorption-colony.trycloudflare.com');
check('named tunnel readiness parser', namedTunnelReady('INF Registered tunnel connection connIndex=0'));
check('named tunnel hostname normalizer', normalizeNamedTunnelHostname('https://PC1.Example.com/') === 'pc1.example.com');
let unsafeNamedHostBlocked = false;
try { normalizeNamedTunnelHostname('https://user:pass@example.com/private'); } catch { unsafeNamedHostBlocked = true; }
check('named tunnel rejects credential and path injection', unsafeNamedHostBlocked);
let privateNamedHostBlocked = false;
try { normalizeNamedTunnelHostname('https://127.0.0.1'); } catch { privateNamedHostBlocked = true; }
check('named tunnel verification cannot target an IP literal', privateNamedHostBlocked);
let internalNamedHostBlocked = false;
try { normalizeNamedTunnelHostname('https://metadata.service.internal'); } catch { internalNamedHostBlocked = true; }
check('named tunnel verification rejects internal DNS suffixes', internalNamedHostBlocked);
const diagnosticSecret = `eyJ${'A'.repeat(120)}`;
check('remote diagnostics redact tunnel credentials', !redactRemoteLinkDiagnostics(`token=${diagnosticSecret}`).includes(diagnosticSecret));
check('remote link only accepts loopback', normalizeRemoteLinkLocalUrl('http://127.0.0.1:8787') === 'http://127.0.0.1:8787');
let arbitraryLocalServiceBlocked = false;
try { normalizeRemoteLinkLocalUrl('http://192.168.10.20:8787'); } catch { arbitraryLocalServiceBlocked = true; }
check('remote link rejects non-loopback targets', arbitraryLocalServiceBlocked);
check('remote link plugin defaults off', createRemoteLinkPlugin().manifest.enabledByDefault === false);
class FakeTunnelProcess extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.killed = false;
  }
  kill() { this.killed = true; return true; }
  close(code = 0) { this.exitCode = code; this.emit('close', code, null); }
}
const tunnelA = new FakeTunnelProcess(101);
const tunnelB = new FakeTunnelProcess(102);
const tunnelQueue = [tunnelA, tunnelB];
const remoteCommands = new Map();
const remoteStorage = new Map();
const racePlugin = createRemoteLinkPlugin({ findExecutable: () => 'fake-cloudflared', spawnProcess: () => tunnelQueue.shift() });
const fakePluginContext = {
  pluginId: 'remote-link',
  logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } },
  storage: { get: (key) => remoteStorage.get(key), set: (key, value) => remoteStorage.set(key, value) },
  registerCommand: (name, handler) => remoteCommands.set(name, handler),
  on() {}, once() {}, emit() {},
  setInterval, setTimeout, clearInterval, clearTimeout,
  computer: {}, ai: { providerCount: () => 0 },
};
racePlugin.activate(fakePluginContext);
const startA = Promise.resolve(remoteCommands.get('remote-link.start')({})).catch((error) => error);
const stopA = Promise.resolve(remoteCommands.get('remote-link.stop')({}));
const startB = Promise.resolve(remoteCommands.get('remote-link.start')({}));
tunnelB.stderr.write('INF route https://generation-b.trycloudflare.com ready');
const startedB = await startB;
tunnelA.stderr.write('INF stale https://generation-a.trycloudflare.com ready');
tunnelA.close();
const stoppedA = await stopA;
const canceledA = await startA;
const afterStaleClose = await remoteCommands.get('remote-link.status')({});
check('remote link stop/start race preserves new child state', startedB.publicUrl?.includes('generation-b') && stoppedA.publicUrl?.includes('generation-b') && afterStaleClose.publicUrl?.includes('generation-b') && canceledA instanceof Error);
const stopB = Promise.resolve(remoteCommands.get('remote-link.stop')({}));
tunnelB.close();
await stopB;
await racePlugin.deactivate(fakePluginContext);

const namedToken = `eyJ${'B'.repeat(160)}`;
const namedChild = new FakeTunnelProcess(103);
const namedCommands = new Map();
const namedStorage = new Map();
let spawnedArgs = [];
let spawnedToken = '';
const namedPlugin = createRemoteLinkPlugin({
  findExecutable: () => 'fake-cloudflared',
  protectSecret: (value) => `protected:${value}`,
  unprotectSecret: (value) => value.replace(/^protected:/, ''),
  spawnProcess: (_executable, args, options) => {
    spawnedArgs = [...args];
    spawnedToken = options.env?.TUNNEL_TOKEN ?? '';
    return namedChild;
  },
  fetchUrl: async () => new Response(JSON.stringify({ ok: true, app: 'mr-robot' }), { status: 200, headers: { 'content-type': 'application/json', 'content-length': '28' } }),
});
const namedContext = {
  ...fakePluginContext,
  storage: { get: (key) => namedStorage.get(key), set: (key, value) => namedStorage.set(key, value) },
  registerCommand: (name, handler) => namedCommands.set(name, handler),
};
namedPlugin.activate(namedContext);
const savedNamed = await namedCommands.get('remote-link.config.set')({
  provider: 'cloudflare-named', localUrl: 'http://127.0.0.1:8787', hostname: 'pc1.example.com', tunnelToken: namedToken, autoStart: true,
});
const persistedNamed = namedStorage.get('config');
check('named tunnel token is protected at rest and omitted from config responses', persistedNamed.tunnelTokenProtected === `protected:${namedToken}` && !JSON.stringify(savedNamed).includes(namedToken) && savedNamed.hasTunnelToken === true);
const namedStart = namedCommands.get('remote-link.start')({});
namedChild.stderr.write(`INF Registered tunnel connection connIndex=0 token=${namedToken}`);
const namedStatus = await namedStart;
check('named tunnel uses environment credential instead of process arguments', spawnedToken === namedToken && !spawnedArgs.join(' ').includes(namedToken));
check('named tunnel exposes only the validated stable origin', namedStatus.publicUrl === 'https://pc1.example.com' && namedStatus.temporary === false);
check('named tunnel status diagnostics never return the connector token', !String(namedStatus.diagnostics).includes(namedToken));
const verifiedNamed = await namedCommands.get('remote-link.verify')({});
check('named tunnel verifies the public endpoint before pairing', verifiedNamed.ok === true && verifiedNamed.url === 'https://pc1.example.com');
const namedStop = Promise.resolve(namedCommands.get('remote-link.stop')({}));
namedChild.close();
await namedStop;
const clearedNamed = await namedCommands.get('remote-link.config.set')({ ...savedNamed, clearTunnelToken: true });
check('saved tunnel credential can be explicitly cleared', clearedNamed.hasTunnelToken === false && !namedStorage.get('config').tunnelTokenProtected);
await namedPlugin.deactivate(namedContext);
const confineBase = mkdtempSync(join(tmpdir(), 'mr-robot-confine-'));
const confineRoot = join(confineBase, 'root');
const confineOutside = join(confineBase, 'outside');
mkdirSync(confineRoot);
mkdirSync(confineOutside);
symlinkSync(confineOutside, join(confineRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
let junctionBlocked = false;
try { resolveConfinedPath(confineRoot, 'escape/secret.txt'); } catch { junctionBlocked = true; }
check('confined path rejects symlink/junction ancestors', junctionBlocked);
let lexicalEscapeBlocked = false;
try { resolveConfinedPath(confineRoot, '../outside/secret.txt'); } catch { lexicalEscapeBlocked = true; }
check('confined path rejects lexical traversal', lexicalEscapeBlocked);
rmSync(confineBase, { recursive: true, force: true });

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
const pingHeaders = await fetch(`${base}/api/ping`);
check('public responses suppress framework identity and add browser hardening', !pingHeaders.headers.has('x-powered-by') && /frame-ancestors 'none'/.test(pingHeaders.headers.get('content-security-policy') ?? '') && pingHeaders.headers.get('x-frame-options') === 'DENY');
check('API responses are never cached and advertise HTTPS persistence through a tunnel', /no-store/.test(pingHeaders.headers.get('cache-control') ?? '') && /max-age=31536000/.test(pingHeaders.headers.get('strict-transport-security') ?? ''));

const foreignOrigin = await fetch(`${base}/api/ping`, { headers: { origin: 'https://evil.example' } });
check('foreign browser Origin rejected', foreignOrigin.status === 403);
const pairingWithoutAuth = await fetch(`${base}/api/pairing`);
check('pairing info requires auth even on loopback', pairingWithoutAuth.status === 401);
const pairingResponse = await fetch(`${base}/api/pairing`, { headers: { 'x-mr-robot-token': server.secret } });
const pairing = await pairingResponse.json();
check('pairing HTTP info omits every administrator credential hint', pairingResponse.status === 200
  && !Object.hasOwn(pairing, 'pin')
  && !Object.hasOwn(pairing, 'qrPayload')
  && !Object.hasOwn(pairing, 'maskedSecret')
  && !Object.hasOwn(pairing, 'localSecret')
  && pairing.hosts?.includes(pairing.host));
const localPairing = server.pairingInfo(false, true);
check('local administrator can request a short-lived pairing code', typeof localPairing.pin === 'string' && localPairing.pin.length === 6 && typeof localPairing.qrPayload === 'string' && Number(localPairing.pinExpiresAt) > Date.now());
const proxiedPairingResponse = await fetch(`${base}/api/pairing`, {
  headers: {
    'x-mr-robot-token': server.secret,
    origin: 'https://safe-link.trycloudflare.com',
    'cf-ray': 'abcd1234ef567890-icn',
    'cf-connecting-ip': '203.0.113.10',
  },
});
const proxiedPairing = await proxiedPairingResponse.json();
check('proxied loopback pairing response also omits localSecret', proxiedPairingResponse.status === 200 && !Object.hasOwn(proxiedPairing, 'localSecret'));

const bad = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '000000' }) });
check('wrong pin rejected', bad.status === 400);

const paired = await (
  await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: localPairing.pin }) })
).json();
check('pin exchange returns secret', typeof paired.secret === 'string' && paired.secret.length > 32);
const reusedPin = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: localPairing.pin }) });
check('successful pairing consumes the PIN', reusedPin.status === 400);
const fullRequestPin = server.config.regeneratePin();
const requestedFullPair = await (
  await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: fullRequestPin, permissionCap: 'full' }) })
).json();
check('PIN cannot self-grant full access', server.authenticate(requestedFullPair.secret)?.permissionCap === 'ask' && server.authenticate(requestedFullPair.secret)?.isAdmin === false);
const readOnlyPin = server.config.regeneratePin();
const readOnlyPaired = await (
  await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: readOnlyPin, permissionCap: 'read-only' }) })
).json();
check('read-only pin exchange returns scoped secret', typeof readOnlyPaired.secret === 'string' && readOnlyPaired.secret.length > 32);

const noAuth = await fetch(`${base}/api/status`);
check('status requires auth', noAuth.status === 401);

const authed = await fetch(`${base}/api/status`, { headers: { 'x-mr-robot-token': paired.secret } });
const status = await authed.json();
check('status with token', authed.status === 200 && status.ok === true, JSON.stringify(status));

const originalChatOnce = server.chatOnce;
let observedRestAuth;
server.chatOnce = async (text, auth) => { observedRestAuth = auth; return { text }; };
const restChat = await fetch(`${base}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-mr-robot-token': readOnlyPaired.secret },
  body: JSON.stringify({ text: 'REST auth bridge' }),
});
server.chatOnce = originalChatOnce;
check('REST chat forwards paired permission context', restChat.status === 200 && observedRestAuth?.permissionCap === 'read-only' && observedRestAuth?.isAdmin === false);
const blockedPluginCall = await fetch(`${base}/api/plugins/call`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-mr-robot-token': paired.secret },
  body: JSON.stringify({ name: 'remote-link.config.set', params: { provider: 'cloudflare-quick', enabled: false, autoStart: false, localUrl: 'http://127.0.0.1:8787' } }),
});
check('REST plugin call enforces paired permission context', blockedPluginCall.status === 400);
const blockedProviderProbe = await fetch(`${base}/api/providers/test/missing-provider`, { headers: { 'x-mr-robot-token': readOnlyPaired.secret } });
check('provider connection details are administrator-only', blockedProviderProbe.status === 403);

const limitedUpload = await fetch(`${base}/api/files/upload?path=${encodeURIComponent('smoke/denied.txt')}`, {
  method: 'PUT',
  headers: { 'content-type': 'application/octet-stream', 'x-mr-robot-token': readOnlyPaired.secret },
  body: 'must not be written by an ask/read-only device',
});
check('read-only paired device cannot mutate shared files', limitedUpload.status === 403);
const askSharedUpload = await fetch(`${base}/api/files/upload?path=${encodeURIComponent('smoke/paired-transfer.txt')}`, {
  method: 'PUT',
  headers: { 'content-type': 'application/octet-stream', 'x-mr-robot-token': paired.secret },
  body: 'paired shared bytes',
});
check('ask paired device can write only the shared transfer area', askSharedUpload.status === 200);
const rootUpload = await fetch(`${base}/api/files/upload?path=`, {
  method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-mr-robot-token': paired.secret }, body: 'must not escape as a root sibling',
});
check('shared upload rejects an empty/root target before streaming', rootUpload.status === 400 && !readdirSync(home).some((name) => name.startsWith('shared.upload-')));
const directoryUpload = await fetch(`${base}/api/files/upload?path=${encodeURIComponent('smoke')}`, {
  method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-mr-robot-token': paired.secret }, body: 'must not replace a directory',
});
check('shared upload rejects a directory target', directoryUpload.status === 400);
const uploaded = await fetch(`${base}/api/files/upload?path=${encodeURIComponent('smoke/direct-transfer.txt')}`, {
  method: 'PUT',
  headers: { 'content-type': 'application/octet-stream', 'x-mr-robot-token': server.secret },
  body: 'direct bytes without an AI call',
});
check('paired device uploads direct file stream', uploaded.status === 200 && (await uploaded.json()).size === 31);
const fileList = await (await fetch(`${base}/api/files?path=${encodeURIComponent('smoke')}`, { headers: { 'x-mr-robot-token': paired.secret } })).json();
check('paired device lists shared files', fileList.items?.some((entry) => entry.name === 'direct-transfer.txt'));
const downloaded = await fetch(`${base}/api/files/download?path=${encodeURIComponent('smoke/direct-transfer.txt')}`, { headers: { 'x-mr-robot-token': paired.secret } });
check('paired device downloads direct file stream', downloaded.status === 200 && await downloaded.text() === 'direct bytes without an AI call');
const fileGrantResponse = await fetch(`${base}/api/transfers/grant`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-mr-robot-token': server.secret },
  body: JSON.stringify({ kind: 'file', path: 'smoke/direct-transfer.txt' }),
});
const fileGrant = (await fileGrantResponse.json()).grant;
check('source PC issues a short-lived file-scoped transfer grant', fileGrantResponse.status === 200 && typeof fileGrant === 'string' && fileGrant.length >= 32);
const directPull = await fetch(`${base}/api/files/pull`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-mr-robot-token': server.secret },
  body: JSON.stringify({ sourceBase: base, sourceGrant: fileGrant, sourcePath: 'smoke/direct-transfer.txt', targetPath: 'smoke/direct-copy.txt' }),
});
check('PC-to-PC endpoint performs direct stream pull', directPull.status === 200 && (await directPull.json()).transport === 'direct-device-stream');
const reusedGrantPull = await fetch(`${base}/api/files/pull`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-mr-robot-token': server.secret },
  body: JSON.stringify({ sourceBase: base, sourceGrant: fileGrant, sourcePath: 'smoke/direct-transfer.txt', targetPath: 'smoke/direct-reuse.txt' }),
});
check('file transfer grant is single-use', reusedGrantPull.status === 400);
const leakedSecretPull = await fetch(`${base}/api/files/pull`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-mr-robot-token': server.secret },
  body: JSON.stringify({ sourceBase: base, sourceSecret: server.secret, sourcePath: 'smoke/direct-transfer.txt', targetPath: 'smoke/no-secret-forwarding.txt' }),
});
check('target PC rejects legacy long-lived source credentials', leakedSecretPull.status === 400);
const rootPull = await fetch(`${base}/api/files/pull`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-mr-robot-token': server.secret },
  body: JSON.stringify({ sourceBase: base, sourceGrant: 'x'.repeat(43), sourcePath: 'smoke/direct-transfer.txt', targetPath: '.' }),
});
check('PC-to-PC pull rejects shared root as a file target', rootPull.status === 400);
const ssrfPull = await fetch(`${base}/api/files/pull`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-mr-robot-token': server.secret },
  body: JSON.stringify({ sourceBase: 'http://169.254.169.254', sourceGrant: 'x'.repeat(43), sourcePath: 'metadata', targetPath: 'smoke/blocked.txt' }),
});
check('PC-to-PC pull blocks link-local SSRF target', ssrfPull.status === 400);
const traversal = await fetch(`${base}/api/files/download?path=${encodeURIComponent('../config.json')}`, { headers: { 'x-mr-robot-token': paired.secret } });
check('shared-file traversal is blocked', traversal.status === 403);
const deniedSyncSnapshot = await fetch(`${base}/api/sync/snapshot`, { headers: { 'x-mr-robot-token': readOnlyPaired.secret } });
check('read-only paired device cannot export private work history', deniedSyncSnapshot.status === 403);
const syncSnapshotResponse = await fetch(`${base}/api/sync/snapshot`, { headers: { 'x-mr-robot-token': paired.secret } });
const syncSnapshot = await syncSnapshotResponse.json();
check('default ask device exports versioned work snapshot through its narrow capability', syncSnapshotResponse.status === 200 && syncSnapshot.version === 1 && Array.isArray(syncSnapshot.conversations) && Array.isArray(syncSnapshot.routingPresets));
const syncGrantResponse = await fetch(`${base}/api/transfers/grant`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-mr-robot-token': paired.secret }, body: JSON.stringify({ kind: 'sync' }),
});
const syncGrant = (await syncGrantResponse.json()).grant;
const syncPull = await fetch(`${base}/api/sync/pull`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-mr-robot-token': paired.secret },
  body: JSON.stringify({ sourceBase: base, sourceGrant: syncGrant }),
});
check('default ask device work sync uses direct transport and zero AI tokens', syncPull.status === 200 && (await syncPull.json()).aiTokens === 0);
server.config.patchDeviceLink(paired.linkId, { capabilities: [] });
const disabledSyncGrant = await fetch(`${base}/api/transfers/grant`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-mr-robot-token': paired.secret }, body: JSON.stringify({ kind: 'sync' }),
});
check('revoking only work-sync capability blocks sync without changing chat permission', disabledSyncGrant.status === 403 && server.authenticate(paired.secret)?.permissionCap === 'ask');
server.config.patchDeviceLink(paired.linkId, { capabilities: ['work-sync'] });
for (let attempt = 0; attempt < 5; attempt++) {
  await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-ray': 'feedface12345678-icn',
      'cf-connecting-ip': '203.0.113.44',
    },
    body: JSON.stringify({ pin: '111111' }),
  });
}
const pairingRateLimited = await fetch(`${base}/api/pair`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'cf-ray': 'feedface12345678-icn',
    'cf-connecting-ip': '203.0.113.44',
  },
  body: JSON.stringify({ pin: '111111' }),
});
check('pairing failures are rate limited per proxied client', pairingRateLimited.status === 429 && Number(pairingRateLimited.headers.get('retry-after')) > 0);

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

const adminEventWs = await new Promise((resolveWs, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  socket.on('open', () => resolveWs(socket));
  socket.on('error', reject);
});
await rpc(adminEventWs, 'auth', { secret: server.secret });
const pairedEvents = [];
const adminEvents = [];
const collectPaired = (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.id === 0) pairedEvents.push(message);
};
const collectAdmin = (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.id === 0) adminEvents.push(message);
};
ws.on('message', collectPaired);
adminEventWs.on('message', collectAdmin);
server.bus.emit('scheduler.changed', [{ id: 'private-job', prompt: 'PRIVATE_PROMPT', command: 'PRIVATE_COMMAND', lastResult: 'PRIVATE_STDOUT' }]);
server.bus.emit('log', { ts: Date.now(), level: 'error', scope: 'private', message: 'PRIVATE_LOG' });
server.bus.emit('voice.command', { text: 'PRIVATE_VOICE_TRANSCRIPT' });
server.bus.emit('providers.changed', [{ id: 'private-provider', label: 'PRIVATE_PROVIDER' }]);
server.bus.emit('remote-link.changed', { running: true, publicUrl: 'https://private-route.trycloudflare.com' });
server.bus.emit('pairing.changed', { at: Date.now() });
server.bus.emit('future.unreviewed.secret', { secret: 'PRIVATE_FUTURE_EVENT' });
await new Promise((resolveTimer) => setTimeout(resolveTimer, 30));
ws.off('message', collectPaired);
adminEventWs.off('message', collectAdmin);
const sensitiveEvents = new Set(['scheduler.changed', 'log', 'voice.command', 'providers.changed', 'remote-link.changed', 'pairing.changed']);
check('non-admin WS receives no scheduler, log, voice, provider, or remote-link administrator events', !pairedEvents.some((message) => sensitiveEvents.has(message.event)));
check('administrator WS receives reviewed sensitive events', [...sensitiveEvents].every((event) => adminEvents.some((message) => message.event === event)));
check('unreviewed event types fail closed for every WS client', !pairedEvents.some((message) => message.event === 'future.unreviewed.secret') && !adminEvents.some((message) => message.event === 'future.unreviewed.secret'));
adminEventWs.close();

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
const adminAuth = await rpc(ws, 'auth', { secret: server.secret });
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
const liveLinkedWs = await new Promise((resolveWs, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  socket.on('open', () => resolveWs(socket));
  socket.on('error', reject);
});
const liveLinkedAuth = await rpc(liveLinkedWs, 'auth', { secret: paired.secret });
const liveLinkedClosed = new Promise((resolveClose) => {
  const timer = setTimeout(() => resolveClose(false), 1500);
  liveLinkedWs.once('close', () => { clearTimeout(timer); resolveClose(true); });
});
const elevatedLink = await rpc(ws, 'pairing.link.update', { id: paired.linkId, permissionCap: 'full', capabilities: [] });
check('admin can set per-device permission cap while independently revoking sync', elevatedLink.ok === true && elevatedLink.result?.permissionCap === 'full' && elevatedLink.result?.capabilities?.length === 0 && server.isSyncSecret(paired.secret) === false);
check('permission change immediately closes already-authenticated device sockets', liveLinkedAuth.result?.ok === true && await liveLinkedClosed);
const syncEnabledLink = await rpc(ws, 'pairing.link.update', { id: paired.linkId, capabilities: ['work-sync'] });
check('admin can grant the narrow work-sync capability separately', syncEnabledLink.ok === true && syncEnabledLink.result?.capabilities?.includes('work-sync') && server.isSyncSecret(paired.secret) === true);
await rpc(ws, 'auth', { secret: paired.secret });
const promotedAdminApi = await fetch(`${base}/api/settings`, {
  method: 'PUT', headers: { 'content-type': 'application/json', 'x-mr-robot-token': paired.secret }, body: JSON.stringify({ deviceName: 'must-not-change' }),
});
check('promoted full link is still not a control-plane administrator', promotedAdminApi.status === 403);
const promotedSync = await fetch(`${base}/api/sync/pull`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-mr-robot-token': paired.secret },
  body: JSON.stringify({
    sourceBase: base,
    sourceGrant: (await (await fetch(`${base}/api/transfers/grant`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-mr-robot-token': server.secret }, body: JSON.stringify({ kind: 'sync' }),
    })).json()).grant,
  }),
});
check('capability-enabled link may run cross-PC sync', promotedSync.status === 200 && (await promotedSync.json()).aiTokens === 0);
const shellRes = await rpc(ws, 'computer.shell', { command: 'echo ws-shell-ok', shell: 'cmd' });
check('ws computer.shell', shellRes.ok === true && shellRes.result?.stdout?.includes('ws-shell-ok'));

const chatRes = await rpc(ws, 'chat.start', { text: '안녕' });
check('ws chat without provider -> graceful', chatRes.ok === true && chatRes.result?.ok === true);

ws.close();

await server.stop();
rmSync(home, { recursive: true, force: true });

console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
