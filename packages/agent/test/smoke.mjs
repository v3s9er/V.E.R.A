/**
 * Smoke test for the Mr.Robot agent core. Run after `npm run build:agent`:
 *   node packages/agent/test/smoke.mjs
 *
 * Covers: event bus, plugin attach/detach leak-freedom, plugin commands,
 * computer shell/screen, HTTP API + pairing, WebSocket RPC.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const here = dirnameOf(import.meta);
const dist = resolve(here, '..', 'dist');

const { AgentServer } = await import(pathToFileURL(join(dist, 'server', 'server.js')).href);
const { CLOUDFLARE_ACCESS_BOOTSTRAP_PROBE, CLOUDFLARE_ACCESS_PAIR_PROBE, CLOUDFLARE_ACCESS_PAIR_PROBE_ERROR } = await import(pathToFileURL(join(dist, 'access-probe.js')).href);
const { browserOriginAllowed, createByteLimitStream, isSecurePlainPeerTransport, isTailnetAddress, normalizePeerBase, resolveConfinedPath } = await import(pathToFileURL(join(dist, 'server', 'http.js')).href);
const { createRemoteLinkPlugin, localTunnelCredentialsFromToken, localTunnelIngressConfig, namedTunnelReady, normalizeNamedTunnelHostname, normalizeRemoteLinkLocalUrl, parseQuickTunnelUrl, redactRemoteLinkDiagnostics } = await import(pathToFileURL(join(dist, 'plugins', 'remote-link.js')).href);
const { SecretVault, unprotectRemoteLinkWithLegacyProviderFallback } = await import(pathToFileURL(join(dist, 'secrets.js')).href);
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
check('loopback and literal Tailscale peer bases accepted', normalizePeerBase('http://127.0.0.1:8787').origin === 'http://127.0.0.1:8787'
  && normalizePeerBase('http://100.100.10.20:8787').origin === 'http://100.100.10.20:8787');
let plainLanBlocked = false;
try { normalizePeerBase('http://192.168.10.20:8787'); } catch { plainLanBlocked = true; }
check('ordinary private-LAN plaintext peer blocked', plainLanBlocked);
check('actual plaintext socket must stay on loopback or a verified Tailscale adapter',
  isSecurePlainPeerTransport('127.0.0.1', '127.0.0.1')
  && isSecurePlainPeerTransport('100.90.1.2', '100.101.2.3', new Set(['100.101.2.3']))
  && !isSecurePlainPeerTransport('100.90.1.2', '192.168.1.10', new Set(['100.101.2.3']))
  && !isSecurePlainPeerTransport('100.90.1.2', '100.101.2.3', new Set())
  && !isSecurePlainPeerTransport('192.168.1.20', '192.168.1.10', new Set()));
let metadataBlocked = false;
try { normalizePeerBase('http://169.254.169.254'); } catch { metadataBlocked = true; }
check('cloud metadata/link-local peer blocked', metadataBlocked);
check('custom public HTTPS peer origin accepted for later DNS pinning',
  normalizePeerBase('https://example.com').origin === 'https://example.com');
for (const unsafePeer of ['https://127.0.0.1', 'https://192.168.10.20', 'https://printer.local', 'https://example.com:8443']) {
  let rejected = false;
  try { normalizePeerBase(unsafePeer); } catch { rejected = true; }
  check(`unsafe HTTPS peer origin rejected: ${unsafePeer}`, rejected);
}
let publicPlaintextBlocked = false;
try { normalizePeerBase('http://example.com'); } catch { publicPlaintextBlocked = true; }
check('custom public peer remains HTTPS-only', publicPlaintextBlocked);
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
const diagnosticAccessSecret = `cfast_${'B'.repeat(48)}`;
check('remote diagnostics redact current-format Access service secrets even without a header label',
  !redactRemoteLinkDiagnostics(`failure ${diagnosticAccessSecret}`).includes(diagnosticAccessSecret));
check('remote link only accepts loopback', normalizeRemoteLinkLocalUrl('http://127.0.0.1:8787') === 'http://127.0.0.1:8787');
let arbitraryLocalServiceBlocked = false;
try { normalizeRemoteLinkLocalUrl('http://192.168.10.20:8787'); } catch { arbitraryLocalServiceBlocked = true; }
check('remote link rejects non-loopback targets', arbitraryLocalServiceBlocked);
check('remote link plugin defaults off', createRemoteLinkPlugin().manifest.enabledByDefault === false);
if (process.platform === 'win32') {
  const vault = new SecretVault();
  const firstCiphertext = vault.protect('smoke-secret-no-plaintext-cache');
  const secondCiphertext = vault.protect('smoke-secret-no-plaintext-cache');
  check('DPAPI vault does not retain and reuse a plaintext-keyed process cache', firstCiphertext !== secondCiphertext);
  check('DPAPI vault still round-trips without a plaintext cache', vault.unprotect(firstCiphertext) === 'smoke-secret-no-plaintext-cache');
  const remoteLinkVault = new SecretVault('remote-link');
  const legacyProviderCiphertext = vault.protect('legacy-remote-link-secret');
  const purposeOrder = [];
  const migratedSecret = unprotectRemoteLinkWithLegacyProviderFallback(
    legacyProviderCiphertext,
    (value) => { purposeOrder.push('remote-link'); return remoteLinkVault.unprotect(value); },
    (value) => { purposeOrder.push('provider'); return vault.unprotect(value); },
  );
  check('remote-link DPAPI migration tries the isolated purpose before the legacy provider purpose',
    purposeOrder.join(',') === 'remote-link,provider'
    && migratedSecret.migratedFromLegacyProvider === true
    && migratedSecret.plaintext === 'legacy-remote-link-secret');
  let corruptLegacyCiphertextRejected = false;
  try {
    unprotectRemoteLinkWithLegacyProviderFallback(
      'dpapi:v1:not-valid-ciphertext',
      (value) => remoteLinkVault.unprotect(value),
      (value) => vault.unprotect(value),
    );
  } catch (error) {
    corruptLegacyCiphertextRejected = !String(error).includes('not-valid-ciphertext');
  }
  check('damaged ciphertext fails closed without echoing protected input', corruptLegacyCiphertextRejected);
}
const trustFakeCloudflared = (candidate) => ({ trusted: true, executable: candidate, diagnostic: 'test Authenticode trusted' });
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
const racePlugin = createRemoteLinkPlugin({ findExecutable: () => 'fake-cloudflared', verifyExecutable: trustFakeCloudflared, spawnProcess: () => tunnelQueue.shift() });
const fakePluginContext = {
  pluginId: 'remote-link',
  logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } },
  storage: { get: (key) => remoteStorage.get(key), set: (key, value) => remoteStorage.set(key, value) },
  registerCommand: (name, handler) => remoteCommands.set(name, handler),
  on() {}, once() {}, emit() {},
  setInterval, setTimeout, clearInterval, clearTimeout,
  computer: {}, ai: { providerCount: () => 0 },
};
let untrustedSpawned = false;
const untrustedCommands = new Map();
const untrustedPlugin = createRemoteLinkPlugin({
  findExecutable: () => 'path-hijacked-cloudflared.exe',
  verifyExecutable: (candidate) => ({ trusted: false, executable: candidate, diagnostic: 'Authenticode 거부: status=NotSigned, publisher=없음' }),
  spawnProcess: () => { untrustedSpawned = true; throw new Error('must not spawn'); },
});
untrustedPlugin.activate({ ...fakePluginContext, registerCommand: (name, handler) => untrustedCommands.set(name, handler) });
const untrustedStatus = await untrustedCommands.get('remote-link.status')({});
let untrustedStartRejected = false;
try { await untrustedCommands.get('remote-link.start')({}); } catch (error) { untrustedStartRejected = /신뢰 검증 실패/.test(String(error)); }
check('unsigned PATH cloudflared is unavailable and rejected before spawn', untrustedStatus.installed === false && untrustedStartRejected && !untrustedSpawned);
await untrustedPlugin.deactivate(fakePluginContext);
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

const namedTunnelId = '61355f59-342f-45e9-af9f-9607cfd4280a';
const namedToken = Buffer.from(JSON.stringify({
  a: '0123456789abcdef0123456789abcdef',
  t: namedTunnelId,
  s: Buffer.from('test-tunnel-secret-material-32bytes').toString('base64'),
})).toString('base64url');
const accessClientId = 'mr-robot-test-client-0123456789.access';
const accessClientSecret = 'mr-robot-test-secret-0123456789abcdef';
const fakeAccessAssertion = [
  Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({
    type: 'app',
    aud: ['0123456789abcdef0123456789abcdef'],
    exp: Math.floor(Date.now() / 1000) + 600,
    iss: 'https://test-team.cloudflareaccess.com',
    common_name: accessClientId,
    sub: '',
  })).toString('base64url'),
  's'.repeat(64),
].join('.');
const decodedNamed = localTunnelCredentialsFromToken(namedToken);
check('connector token becomes local credentials without changing tunnel identity',
  decodedNamed.tunnelId === namedTunnelId && JSON.parse(decodedNamed.contents).TunnelID === namedTunnelId);
check('local credential diagnostics redact the derived tunnel secret',
  !redactRemoteLinkDiagnostics(`TUNNEL_CRED_CONTENTS=${decodedNamed.contents}`).includes('test-tunnel-secret-material'));
check('local named config has one exact Agent ingress and a deny catch-all',
  localTunnelIngressConfig(namedTunnelId, 'pc1.example.com', 'http://127.0.0.1:8787').includes('hostname: "pc1.example.com"')
  && localTunnelIngressConfig(namedTunnelId, 'pc1.example.com', 'http://127.0.0.1:8787').includes('service: http_status:404'));

const trustCacheBase = mkdtempSync(join(tmpdir(), 'mr-robot-cloudflared-trust-'));
const trustCacheExecutable = join(trustCacheBase, 'cloudflared.exe');
const trustCacheRuntime = join(trustCacheBase, 'runtime');
writeFileSync(trustCacheExecutable, 'test-cloudflared-v1');
const trustCacheChildOne = new FakeTunnelProcess(106);
const trustCacheChildTwo = new FakeTunnelProcess(107);
const trustCacheChildren = [trustCacheChildOne, trustCacheChildTwo];
const trustCacheCommands = new Map();
const trustCacheStorage = new Map();
let trustVerifierCalls = 0;
const trustCachePlugin = createRemoteLinkPlugin({
  findExecutable: () => trustCacheExecutable,
  verifyExecutable: (candidate) => {
    trustVerifierCalls += 1;
    return { trusted: true, executable: candidate, diagnostic: `test Authenticode trusted ${trustVerifierCalls}` };
  },
  protectSecret: (value) => `protected:${value}`,
  unprotectSecret: (value) => value.replace(/^protected:/, ''),
  runtimeDirectory: trustCacheRuntime,
  spawnProcess: () => trustCacheChildren.shift(),
  fetchUrl: async (url, options) => {
    const headers = options?.headers ?? {};
    if (!headers['CF-Access-Client-Id'] || !headers['CF-Access-Client-Secret']) {
      return new Response('Access denied', { status: 403 });
    }
    if (url.pathname === '/api/pair') {
      return new Response(JSON.stringify({ error: CLOUDFLARE_ACCESS_PAIR_PROBE_ERROR, app: 'mr-robot' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/api/ws-ticket') {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, app: 'mr-robot' }), { status: 200, headers: { 'content-type': 'application/json', 'content-length': '28' } });
  },
});
const trustCacheContext = {
  ...fakePluginContext,
  storage: { get: (key) => trustCacheStorage.get(key), set: (key, value) => trustCacheStorage.set(key, value) },
  registerCommand: (name, handler) => trustCacheCommands.set(name, handler),
};
trustCachePlugin.activate(trustCacheContext);
trustCacheCommands.get('remote-link.status')({});
trustCacheCommands.get('remote-link.status')({});
trustCacheCommands.get('remote-link.status')({});
check('repeated remote-link status reuses one Authenticode result for an unchanged executable', trustVerifierCalls === 1, `verifier calls=${trustVerifierCalls}`);
writeFileSync(trustCacheExecutable, 'test-cloudflared-version-two-is-different');
trustCacheCommands.get('remote-link.status')({});
check('cloudflared file identity change invalidates the status trust cache', trustVerifierCalls === 2, `verifier calls=${trustVerifierCalls}`);
await trustCacheCommands.get('remote-link.config.set')({
  provider: 'cloudflare-named', localUrl: 'http://127.0.0.1:8787', hostname: 'cache.example.com', tunnelToken: namedToken,
  accessClientId, accessClientSecret, autoStart: false,
});
const trustStartOne = trustCacheCommands.get('remote-link.start')({});
trustCacheChildOne.stderr.write('INF Registered tunnel connection connIndex=0');
await trustStartOne;
check('first named start forces a fresh Authenticode verification despite a warm status cache', trustVerifierCalls === 3, `verifier calls=${trustVerifierCalls}`);
const trustStopOne = trustCacheCommands.get('remote-link.stop')({});
trustCacheChildOne.close();
await trustStopOne;
const trustStartTwo = trustCacheCommands.get('remote-link.start')({});
trustCacheChildTwo.stderr.write('INF Registered tunnel connection connIndex=0');
await trustStartTwo;
check('every later named start forces another fresh Authenticode verification', trustVerifierCalls === 4, `verifier calls=${trustVerifierCalls}`);
const trustStopTwo = trustCacheCommands.get('remote-link.stop')({});
trustCacheChildTwo.close();
await trustStopTwo;
await trustCachePlugin.deactivate(trustCacheContext);
rmSync(trustCacheBase, { recursive: true, force: true });

const namedChild = new FakeTunnelProcess(103);
const namedCommands = new Map();
const namedStorage = new Map();
let spawnedArgs = [];
let spawnedCredentials = '';
let spawnedConfig = '';
let spawnedConfigPath = '';
let verifyRequestHeaders = {};
let anonymousProbeCount = 0;
let exposeAgentWithoutAccess = false;
let exposeTicketWithoutAccess = false;
let namedBootstrapEvent;
let legacyPurposeDecrypts = 0;
let remotePurposeDecrypts = 0;
const remoteRuntime = mkdtempSync(join(tmpdir(), 'mr-robot-remote-runtime-'));
const namedPlugin = createRemoteLinkPlugin({
  findExecutable: () => 'fake-cloudflared',
  verifyExecutable: trustFakeCloudflared,
  protectSecret: (value) => `protected:${value}`,
  unprotectSecret: (value) => {
    remotePurposeDecrypts += 1;
    if (!value.startsWith('protected:')) throw new Error('wrong current purpose');
    return value.slice('protected:'.length);
  },
  unprotectLegacySecret: (value) => {
    legacyPurposeDecrypts += 1;
    if (!value.startsWith('legacy-provider:')) throw new Error('wrong legacy purpose');
    return value.slice('legacy-provider:'.length);
  },
  runtimeDirectory: remoteRuntime,
  spawnProcess: (_executable, args, options) => {
    spawnedArgs = [...args];
    spawnedCredentials = options.env?.TUNNEL_CRED_CONTENTS ?? '';
    spawnedConfigPath = args[args.indexOf('--config') + 1] ?? '';
    spawnedConfig = readFileSync(spawnedConfigPath, 'utf8');
    return namedChild;
  },
  fetchUrl: async (url, options) => {
    const headers = options?.headers ?? {};
    const hasAccess = Boolean(headers['CF-Access-Client-Id'] && headers['CF-Access-Client-Secret']);
    const hasBootstrapToken = headers['cf-access-token'] === fakeAccessAssertion;
    if (url.pathname === '/api/pair' && JSON.parse(String(options?.body ?? '{}')).probe === CLOUDFLARE_ACCESS_BOOTSTRAP_PROBE) {
      if (!hasAccess && !hasBootstrapToken) return new Response('Access denied', { status: 403 });
      const request = JSON.parse(String(options?.body ?? '{}'));
      return new Response(JSON.stringify({
        app: 'mr-robot',
        probe: CLOUDFLARE_ACCESS_BOOTSTRAP_PROBE,
        challenge: request.challenge,
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': `__Host-MrRobot-Access-Bootstrap=${fakeAccessAssertion}; Max-Age=60; Path=/; Secure; HttpOnly; SameSite=Strict`,
        },
      });
    }
    if (url.pathname === '/api/pair') {
      if (!hasAccess) {
        anonymousProbeCount += 1;
        return new Response('Access denied', { status: 403 });
      }
      verifyRequestHeaders = headers;
      return new Response(JSON.stringify({ error: CLOUDFLARE_ACCESS_PAIR_PROBE_ERROR, app: 'mr-robot' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/api/ws-ticket') {
      if (!hasAccess) {
        anonymousProbeCount += 1;
        if (!exposeTicketWithoutAccess) return new Response('Access denied', { status: 403 });
      } else {
        verifyRequestHeaders = headers;
      }
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    if (!hasAccess) {
      anonymousProbeCount += 1;
      if (!exposeAgentWithoutAccess) return new Response('Access denied', { status: 403 });
    } else {
      verifyRequestHeaders = headers;
    }
    return new Response(JSON.stringify({ ok: true, app: 'mr-robot' }), { status: 200, headers: { 'content-type': 'application/json', 'content-length': '28' } });
  },
});
const namedContext = {
  ...fakePluginContext,
  storage: { get: (key) => namedStorage.get(key), set: (key, value) => namedStorage.set(key, value) },
  registerCommand: (name, handler) => namedCommands.set(name, handler),
  emit: (event, data) => { if (event === 'remote-link.bootstrap.created') namedBootstrapEvent = data; },
};
namedPlugin.activate(namedContext);
const savedNamed = await namedCommands.get('remote-link.config.set')({
  provider: 'cloudflare-named', localUrl: 'http://127.0.0.1:8787', hostname: 'pc1.example.com', tunnelToken: namedToken,
  peerHostnames: ['pc2.example.com'], accessClientId, accessClientSecret, autoStart: true,
});
const persistedNamed = namedStorage.get('config');
check('named tunnel token is protected at rest and omitted from config responses', persistedNamed.tunnelTokenProtected === `protected:${namedToken}` && !JSON.stringify(savedNamed).includes(namedToken) && savedNamed.hasTunnelToken === true);
check('Access service credential is protected at rest and omitted from config responses',
  persistedNamed.accessCredentialsProtected === `protected:${JSON.stringify({ clientId: accessClientId, clientSecret: accessClientSecret })}`
  && !JSON.stringify(savedNamed).includes(accessClientSecret)
  && savedNamed.hasAccessCredentials === true);
check('new remote-link credentials are explicitly marked with the isolated purpose',
  persistedNamed.tunnelTokenPurpose === 'remote-link-v1'
  && persistedNamed.accessCredentialsPurpose === 'remote-link-v1');
// Reproduce a v0.3.9 config: provider-purpose ciphertexts had no purpose
// marker. Access is consumed first and Tunnel later, so each field must carry
// its own one-time migration state.
namedStorage.set('config', {
  ...persistedNamed,
  tunnelTokenProtected: `legacy-provider:${namedToken}`,
  accessCredentialsProtected: `legacy-provider:${JSON.stringify({ clientId: accessClientId, clientSecret: accessClientSecret })}`,
  tunnelTokenPurpose: undefined,
  accessCredentialsPurpose: undefined,
});
const exactPeerHeaders = namedPlugin.peerRequestHeaders(new URL('https://pc1.example.com/api/files/download'));
check('agent-side peer requests use the local Access credential only for the exact named-Tunnel host',
  exactPeerHeaders['CF-Access-Client-Id'] === accessClientId
  && exactPeerHeaders['CF-Access-Client-Secret'] === accessClientSecret
  && namedPlugin.peerRequestHeaders(new URL('https://pc2.example.com/api/ping'))['CF-Access-Client-Id'] === accessClientId
  && Object.keys(namedPlugin.peerRequestHeaders(new URL('https://pc1.example.com.evil/api/ping'))).length === 0
  && Object.keys(namedPlugin.peerRequestHeaders(new URL('https://other.example.com/api/ping'))).length === 0
  && Object.keys(namedPlugin.peerRequestHeaders(new URL('http://pc1.example.com/api/ping'))).length === 0);
const accessMigratedConfig = namedStorage.get('config');
check('legacy Access ciphertext is immediately re-encrypted and marked without exposing plaintext',
  accessMigratedConfig.accessCredentialsProtected === `protected:${JSON.stringify({ clientId: accessClientId, clientSecret: accessClientSecret })}`
  && accessMigratedConfig.accessCredentialsPurpose === 'remote-link-v1'
  && accessMigratedConfig.tunnelTokenProtected === `legacy-provider:${namedToken}`
  && accessMigratedConfig.tunnelTokenPurpose === undefined);
const apexNamed = await namedCommands.get('remote-link.config.set')({
  provider: 'cloudflare-named', localUrl: 'http://127.0.0.1:8787', hostname: 'example.com',
  peerHostnames: ['pc2.example.com'], autoStart: false,
});
check('an owned apex hostname may authorize an exact subdomain peer',
  apexNamed.hostname === 'example.com'
  && namedPlugin.peerRequestHeaders(new URL('https://pc2.example.com/api/ping'))['CF-Access-Client-Id'] === accessClientId);
await namedCommands.get('remote-link.config.set')({
  provider: 'cloudflare-named', localUrl: 'http://127.0.0.1:8787', hostname: 'pc1.example.com',
  peerHostnames: ['pc2.example.com'], autoStart: true,
});
let privateSuffixPeerRejected = false;
try {
  await namedCommands.get('remote-link.config.set')({
    provider: 'cloudflare-named', localUrl: 'http://127.0.0.1:8787', hostname: 'pc1.github.io',
    peerHostnames: ['pc2.github.io'], autoStart: false,
  });
} catch {
  privateSuffixPeerRejected = true;
}
let publicSuffixPeerRejected = false;
try {
  await namedCommands.get('remote-link.config.set')({
    provider: 'cloudflare-named', localUrl: 'http://127.0.0.1:8787', hostname: 'pc1.co.uk',
    peerHostnames: ['pc2.co.uk'], autoStart: false,
  });
} catch {
  publicSuffixPeerRejected = true;
}
check('peer Access allowlists reject siblings across private and ICANN public suffix ownership boundaries',
  privateSuffixPeerRejected && publicSuffixPeerRejected);
let preStartPairingRejected = false;
try {
  await namedCommands.get('remote-link.pairing.payload')({
    host: 'https://pc1.example.com', pin: '123456789012', expiresAt: Date.now() + 60_000,
  });
} catch {
  preStartPairingRejected = true;
}
check('named tunnel refuses Access QR before a running protected link is verified', preStartPairingRejected);
const namedStart = namedCommands.get('remote-link.start')({});
const namedStartFollower = namedCommands.get('remote-link.start')({});
namedChild.stderr.write(`INF Registered tunnel connection connIndex=0 token=${namedToken}`);
const [namedStatus, namedFollowerStatus] = await Promise.all([namedStart, namedStartFollower]);
check('concurrent named start callers share one launch and one completed Access verification',
  namedFollowerStatus.publicUrl === namedStatus.publicUrl
  && namedFollowerStatus.accessProtected === true
  && namedFollowerStatus.reachable === true);
check('named tunnel uses local in-memory credentials instead of a remotely-managed token',
  JSON.parse(spawnedCredentials).TunnelID === namedTunnelId
  && !spawnedArgs.join(' ').includes(namedToken)
  && !spawnedArgs.includes('--token')
  && spawnedArgs.includes(namedTunnelId));
const fullyMigratedConfig = namedStorage.get('config');
check('legacy Tunnel ciphertext migrates independently before process launch and fallback is one-time',
  fullyMigratedConfig.tunnelTokenProtected === `protected:${namedToken}`
  && fullyMigratedConfig.tunnelTokenPurpose === 'remote-link-v1'
  && fullyMigratedConfig.accessCredentialsPurpose === 'remote-link-v1'
  && legacyPurposeDecrypts === 2
  && remotePurposeDecrypts >= 2);
const legacyDecryptsAfterMigration = legacyPurposeDecrypts;
const damagedMarkedCiphertext = 'damaged-marked-access-ciphertext';
namedStorage.set('config', { ...fullyMigratedConfig, accessCredentialsProtected: damagedMarkedCiphertext });
let damagedMarkedRejected = false;
try {
  namedPlugin.peerRequestHeaders(new URL('https://pc1.example.com/api/ping'));
} catch (error) {
  damagedMarkedRejected = !String(error).includes(damagedMarkedCiphertext);
}
check('a marked remote-link ciphertext never reopens legacy fallback and fails without plaintext logging',
  damagedMarkedRejected && legacyPurposeDecrypts === legacyDecryptsAfterMigration);
namedStorage.set('config', {
  ...fullyMigratedConfig,
  accessCredentialsProtected: `legacy-provider:${JSON.stringify({ clientId: accessClientId, clientSecret: accessClientSecret })}`,
  accessCredentialsPurpose: 'unknown-purpose',
});
let unknownPurposeRejected = false;
try {
  namedPlugin.peerRequestHeaders(new URL('https://pc1.example.com/api/ping'));
} catch {
  unknownPurposeRejected = true;
}
check('an unknown purpose marker is rejected without trying provider fallback',
  unknownPurposeRejected && legacyPurposeDecrypts === legacyDecryptsAfterMigration);
namedStorage.set('config', fullyMigratedConfig);
check('named tunnel process is locked to one loopback Agent route plus catch-all 404',
  spawnedConfig.includes('hostname: "pc1.example.com"')
  && spawnedConfig.includes('service: "http://127.0.0.1:8787"')
  && spawnedConfig.includes('service: http_status:404'));
check('named tunnel exposes only the validated stable origin', namedStatus.publicUrl === 'https://pc1.example.com' && namedStatus.temporary === false);
check('named tunnel status diagnostics never return the connector token', !String(namedStatus.diagnostics).includes(namedToken));
const protectedPairing = JSON.parse(await namedCommands.get('remote-link.pairing.payload')({
  host: 'https://pc1.example.com', pin: '123456789012', expiresAt: Date.now() + 60_000,
}));
check('protected pairing payload is one-use and never exports the long-lived Access credential',
  protectedPairing.version === 5
  && protectedPairing.expiresAt > Date.now()
  && protectedPairing.expiresAt <= Date.now() + 5 * 60_000
  && protectedPairing.cloudflareBootstrap?.type === 'cf-authorization'
  && protectedPairing.cloudflareBootstrap?.token === fakeAccessAssertion
  && !Object.hasOwn(protectedPairing, 'cloudflareAccess')
  && !JSON.stringify(protectedPairing).includes(accessClientSecret)
  && namedBootstrapEvent?.origin === 'https://pc1.example.com'
  && !JSON.stringify(namedBootstrapEvent).includes(fakeAccessAssertion));
const verifiedNamed = await namedCommands.get('remote-link.verify')({});
check('named tunnel verifies the public endpoint before pairing', verifiedNamed.ok === true && verifiedNamed.url === 'https://pc1.example.com');
check('named tunnel verification crosses Access with the protected service credential',
  anonymousProbeCount >= 3
  &&
  verifyRequestHeaders['CF-Access-Client-Id'] === accessClientId
  && verifyRequestHeaders['CF-Access-Client-Secret'] === accessClientSecret);
check('named tunnel status records verified Access enforcement',
  namedCommands.get('remote-link.status')({}).accessProtected === true);
exposeTicketWithoutAccess = true;
let publicTicketRejected = false;
try {
  await namedCommands.get('remote-link.verify')({});
} catch (error) {
  publicTicketRejected = /ws-ticket 경로를 보호하지 않습니다/.test(error instanceof Error ? error.message : String(error));
}
check('named tunnel rejects path-scoped Access that protects ping but leaves WebSocket admission public',
  publicTicketRejected && namedCommands.get('remote-link.status')({}).running === false
  && /ws-ticket 경로를 보호하지 않습니다/.test(String(namedCommands.get('remote-link.status')({}).lastError)));
exposeTicketWithoutAccess = false;
const namedStop = Promise.resolve(namedCommands.get('remote-link.stop')({}));
namedChild.close();
await namedStop;
check('ephemeral local tunnel config is removed when connector stops', !existsSync(spawnedConfigPath));
const clearedNamed = await namedCommands.get('remote-link.config.set')({ ...savedNamed, clearTunnelToken: true });
check('saved tunnel credential can be explicitly cleared', clearedNamed.hasTunnelToken === false && !namedStorage.get('config').tunnelTokenProtected);
check('saving corrected remote settings clears the stopped endpoint previous failure', namedCommands.get('remote-link.status')({}).lastError === undefined);
const clearedAccess = await namedCommands.get('remote-link.config.set')({ ...clearedNamed, clearAccessCredentials: true });
check('saved Access credential can be explicitly cleared', clearedAccess.hasAccessCredentials === false
  && !namedStorage.get('config').accessCredentialsProtected
  && Object.keys(namedPlugin.peerRequestHeaders(new URL('https://pc1.example.com/api/ping'))).length === 0);
await namedPlugin.deactivate(namedContext);
check('deactivated remote-link plugin cannot provide peer Access headers',
  Object.keys(namedPlugin.peerRequestHeaders(new URL('https://pc1.example.com/api/ping'))).length === 0);

const pairLeakChild = new FakeTunnelProcess(110);
pairLeakChild.kill = function killAndClose() {
  this.killed = true;
  setImmediate(() => this.close());
  return true;
};
const pairLeakCommands = new Map();
const pairLeakStorage = new Map();
const pairLeakPlugin = createRemoteLinkPlugin({
  findExecutable: () => 'fake-cloudflared',
  verifyExecutable: trustFakeCloudflared,
  protectSecret: (value) => `protected:${value}`,
  unprotectSecret: (value) => value.replace(/^protected:/, ''),
  runtimeDirectory: remoteRuntime,
  spawnProcess: () => pairLeakChild,
  fetchUrl: async (url, options) => {
    const headers = options?.headers ?? {};
    const hasAccess = Boolean(headers['CF-Access-Client-Id'] && headers['CF-Access-Client-Secret']);
    if (url.pathname === '/api/ws-ticket') {
      if (!hasAccess) return new Response('Access denied', { status: 403 });
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/api/pair') {
      // This intentionally simulates a path-scoped Access app that forgot to
      // protect enrollment: both anonymous and authenticated requests reach
      // the exact Agent probe response.
      return new Response(JSON.stringify({ error: CLOUDFLARE_ACCESS_PAIR_PROBE_ERROR, app: 'mr-robot' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    if (!hasAccess) return new Response('Access denied', { status: 403 });
    return new Response(JSON.stringify({ ok: true, app: 'mr-robot' }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
pairLeakPlugin.activate({
  ...fakePluginContext,
  storage: { get: (key) => pairLeakStorage.get(key), set: (key, value) => pairLeakStorage.set(key, value) },
  registerCommand: (name, handler) => pairLeakCommands.set(name, handler),
});
await pairLeakCommands.get('remote-link.config.set')({
  provider: 'cloudflare-named', localUrl: 'http://127.0.0.1:8787', hostname: 'pair-leak.example.com', tunnelToken: namedToken,
  accessClientId, accessClientSecret, autoStart: false,
});
const pairLeakStart = pairLeakCommands.get('remote-link.start')({});
pairLeakChild.stderr.write('INF Registered tunnel connection connIndex=0');
let publicPairRejected = false;
try { await pairLeakStart; } catch (error) { publicPairRejected = /\/api\/pair 경로를 보호하지 않습니다/.test(String(error)); }
check('named tunnel rejects path-scoped Access that leaves pairing enrollment public',
  publicPairRejected && pairLeakCommands.get('remote-link.status')({}).running === false
  && /\/api\/pair 경로를 보호하지 않습니다/.test(String(pairLeakCommands.get('remote-link.status')({}).lastError)));
await pairLeakPlugin.deactivate(fakePluginContext);

const transientQuickChild = new FakeTunnelProcess(104);
const restoredNamedChild = new FakeTunnelProcess(105);
const transientQuickUnsafeChild = new FakeTunnelProcess(108);
const restoredNamedUnsafeChild = new FakeTunnelProcess(109);
restoredNamedUnsafeChild.kill = function killAndClose() {
  this.killed = true;
  setImmediate(() => this.close());
  return true;
};
const transientCommands = new Map();
const transientStorage = new Map();
const transientQueue = [transientQuickChild, restoredNamedChild, transientQuickUnsafeChild, restoredNamedUnsafeChild];
let exposeRestoredNamedWithoutAccess = false;
const transientPlugin = createRemoteLinkPlugin({
  findExecutable: () => 'fake-cloudflared',
  verifyExecutable: trustFakeCloudflared,
  protectSecret: (value) => `protected:${value}`,
  unprotectSecret: (value) => value.replace(/^protected:/, ''),
  runtimeDirectory: remoteRuntime,
  spawnProcess: () => transientQueue.shift(),
  fetchUrl: async (url, options) => {
    const headers = options?.headers ?? {};
    const hasAccess = Boolean(headers['CF-Access-Client-Id'] && headers['CF-Access-Client-Secret']);
    if (!hasAccess && !exposeRestoredNamedWithoutAccess) return new Response('Access denied', { status: 403 });
    if (url.pathname === '/api/pair') {
      return new Response(JSON.stringify({ error: CLOUDFLARE_ACCESS_PAIR_PROBE_ERROR, app: 'mr-robot' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/api/ws-ticket') {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, app: 'mr-robot' }), { status: 200, headers: { 'content-type': 'application/json', 'content-length': '28' } });
  },
});
const transientContext = {
  ...fakePluginContext,
  storage: { get: (key) => transientStorage.get(key), set: (key, value) => transientStorage.set(key, value) },
  registerCommand: (name, handler) => transientCommands.set(name, handler),
};
transientPlugin.activate(transientContext);
await transientCommands.get('remote-link.config.set')({
  provider: 'cloudflare-named', localUrl: 'http://127.0.0.1:8787', hostname: 'pc2.example.com', tunnelToken: namedToken,
  accessClientId, accessClientSecret, autoStart: true,
});
const savedBeforeTransientQuick = JSON.stringify(transientStorage.get('config'));
const transientQuickStart = transientCommands.get('remote-link.quick.start')({ localUrl: 'http://127.0.0.1:8787' });
const namedDuringQuick = await Promise.resolve(transientCommands.get('remote-link.start')({})).catch((error) => error);
check('a named Access-protected start never adopts an in-flight Quick Tunnel result',
  namedDuringQuick instanceof Error && /다른 원격 연결 시작 작업/.test(namedDuringQuick.message));
transientQuickChild.stderr.write('INF route https://temporary-safe.trycloudflare.com ready');
const transientQuickStatus = await transientQuickStart;
check('transient Quick Link preserves the saved named tunnel credential and auto-start configuration',
  JSON.stringify(transientStorage.get('config')) === savedBeforeTransientQuick
  && transientQuickStatus.provider === 'cloudflare-quick'
  && transientQuickStatus.config.provider === 'cloudflare-named'
  && transientQuickStatus.config.autoStart === true
  && /WAF.+레이트리밋/.test(transientQuickStatus.warning));
const restoreNamed = transientCommands.get('remote-link.quick.stop')({});
transientQuickChild.close();
await new Promise((resolve) => setImmediate(resolve));
restoredNamedChild.stderr.write('INF Registered tunnel connection connIndex=0');
const restoredNamedStatus = await restoreNamed;
check('stopping a transient Quick Link restores the saved auto-start named tunnel',
  restoredNamedStatus.running === true
  && restoredNamedStatus.provider === 'cloudflare-named'
  && restoredNamedStatus.publicUrl === 'https://pc2.example.com'
  && restoredNamedStatus.accessProtected === true
  && JSON.stringify(transientStorage.get('config')) === savedBeforeTransientQuick);
const namedNotDowngraded = await transientCommands.get('remote-link.quick.start')({});
check('Quick Link request never interrupts or downgrades an already-running named tunnel',
  namedNotDowngraded.provider === 'cloudflare-named'
  && namedNotDowngraded.processId === restoredNamedStatus.processId
  && namedNotDowngraded.publicUrl === restoredNamedStatus.publicUrl);
const stopRestoredNamed = transientCommands.get('remote-link.stop')({});
restoredNamedChild.close();
await stopRestoredNamed;

const transientUnsafeStart = transientCommands.get('remote-link.quick.start')({ localUrl: 'http://127.0.0.1:8787' });
transientQuickUnsafeChild.stderr.write('INF route https://temporary-unsafe.trycloudflare.com ready');
await transientUnsafeStart;
exposeRestoredNamedWithoutAccess = true;
const unsafeRestore = transientCommands.get('remote-link.quick.stop')({});
transientQuickUnsafeChild.close();
await new Promise((resolve) => setImmediate(resolve));
restoredNamedUnsafeChild.stderr.write('INF Registered tunnel connection connIndex=0');
const unsafeRestoreStatus = await unsafeRestore;
check('Quick Link stop fails closed when restored named Tunnel is reachable without Access',
  unsafeRestoreStatus.running === false
  && unsafeRestoreStatus.accessProtected === undefined
  && /Access 없이 공개/.test(String(unsafeRestoreStatus.lastError)));
await transientPlugin.deactivate(transientContext);

const failedQuickCommands = new Map();
const failedQuickStorage = new Map();
const failedQuickPlugin = createRemoteLinkPlugin({
  findExecutable: () => 'fake-cloudflared',
  verifyExecutable: trustFakeCloudflared,
  protectSecret: (value) => `protected:${value}`,
  unprotectSecret: (value) => value.replace(/^protected:/, ''),
  runtimeDirectory: remoteRuntime,
  spawnProcess: () => { throw new Error('simulated Quick Link failure'); },
});
const failedQuickContext = {
  ...fakePluginContext,
  storage: { get: (key) => failedQuickStorage.get(key), set: (key, value) => failedQuickStorage.set(key, value) },
  registerCommand: (name, handler) => failedQuickCommands.set(name, handler),
};
failedQuickPlugin.activate(failedQuickContext);
await failedQuickCommands.get('remote-link.config.set')({
  provider: 'cloudflare-named', localUrl: 'http://127.0.0.1:8787', hostname: 'pc3.example.com', tunnelToken: namedToken, autoStart: false,
});
const savedBeforeFailedQuick = JSON.stringify(failedQuickStorage.get('config'));
const failedQuickStart = Promise.resolve(failedQuickCommands.get('remote-link.quick.start')({})).catch((error) => error);
const failedQuickError = await failedQuickStart;
check('failed transient Quick Link leaves the saved named tunnel security configuration untouched',
  failedQuickError instanceof Error && JSON.stringify(failedQuickStorage.get('config')) === savedBeforeFailedQuick);
await failedQuickPlugin.deactivate(failedQuickContext);
rmSync(remoteRuntime, { recursive: true, force: true });

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

const pairProbeResponses = [];
for (let index = 0; index < 8; index += 1) {
  const response = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-ray': `abcd1234ef5678${index}-icn`,
      'cf-connecting-ip': '203.0.113.11',
    },
    body: JSON.stringify({ probe: CLOUDFLARE_ACCESS_PAIR_PROBE }),
  });
  pairProbeResponses.push({ status: response.status, body: await response.json() });
}
check('Access pairing probes are exact, side-effect-free invalid requests outside pairing rate limits',
  pairProbeResponses.every(({ status, body }) => status === 400
    && body.app === 'mr-robot'
    && body.error === CLOUDFLARE_ACCESS_PAIR_PROBE_ERROR));

const reflectionHandoff = server.createRemoteHandoff(10);
const reflectionChallenge = randomBytes(32).toString('base64url');
const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');
server.bus.emit('remote-link.bootstrap.challenge', {
  pinHash: sha256Hex(reflectionHandoff.pin),
  challengeHash: sha256Hex(reflectionChallenge),
  clientIdHash: sha256Hex(accessClientId),
  origin: 'https://robot.example.com',
  expiresAt: Date.now() + 30_000,
});
const reflectionRequest = () => new Promise((resolve, reject) => {
  const body = JSON.stringify({ probe: CLOUDFLARE_ACCESS_BOOTSTRAP_PROBE, challenge: reflectionChallenge });
  const request = httpRequest(`${base}/api/pair`, {
    method: 'POST',
    headers: {
      host: 'robot.example.com',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'cf-ray': 'abcd1234ef567890-icn',
      'cf-connecting-ip': '203.0.113.19',
      'cf-access-jwt-assertion': fakeAccessAssertion,
    },
  }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    response.on('end', () => resolve({
      status: response.statusCode ?? 0,
      cookie: Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'].join(', ') : '',
      text: Buffer.concat(chunks).toString('utf8'),
    }));
  });
  request.on('error', reject);
  request.end(body);
});
const bootstrapProbe = await reflectionRequest();
const bootstrapProbeText = bootstrapProbe.text;
const bootstrapCookie = bootstrapProbe.cookie;
check('Access bootstrap assertion is delivered only in a short HttpOnly host cookie, never reflected in JSON',
  bootstrapProbe.status === 200
  && /__Host-MrRobot-Access-Bootstrap=/.test(bootstrapCookie)
  && /HttpOnly/i.test(bootstrapCookie)
  && !bootstrapProbeText.includes(fakeAccessAssertion),
  JSON.stringify({ status: bootstrapProbe.status, cookiePresent: Boolean(bootstrapCookie), httpOnly: /HttpOnly/i.test(bootstrapCookie), reflected: bootstrapProbeText.includes(fakeAccessAssertion) }));
const replayedBootstrapProbe = await reflectionRequest();
check('Access bootstrap challenge is consumed atomically and rejects replay', replayedBootstrapProbe.status === 404);
server.revokeRemoteHandoff('bootstrap reflection regression test complete');

const proxiedShortPin = await fetch(`${base}/api/pair`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'cf-ray': 'abcd1234ef567891-icn',
    'cf-connecting-ip': '203.0.113.11',
  },
  body: JSON.stringify({ pin: localPairing.pin }),
});
check('public Cloudflare enrollment rejects the ordinary six-digit PIN', proxiedShortPin.status === 400
  && /12자리/.test((await proxiedShortPin.json()).error ?? ''));

const bad = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '000000' }) });
check('wrong pin rejected', bad.status === 400);
const malformedJson = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
const malformedBody = await malformedJson.text();
check('malformed JSON returns a bounded production error without stack or local paths',
  malformedJson.status === 400
  && malformedJson.headers.get('content-type')?.includes('application/json')
  && !/<pre>|node_modules|[A-Z]:\\/i.test(malformedBody));

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

const remoteHandoff = server.createRemoteHandoff(60);
const remoteHandoffResponse = await fetch(`${base}/api/pair`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'cf-ray': 'abcd1234ef567892-icn',
    'cf-connecting-ip': '203.0.113.12',
  },
  body: JSON.stringify({ pin: remoteHandoff.pin, permissionCap: 'full', deviceName: 'remote-smoke' }),
});
const remoteHandoffPaired = await remoteHandoffResponse.json();
check('public Cloudflare enrollment accepts only the strong one-use handoff and caps it at ask', remoteHandoffResponse.status === 200
  && typeof remoteHandoffPaired.secret === 'string'
  && server.authenticate(remoteHandoffPaired.secret)?.permissionCap === 'ask');

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
  headers: { 'content-type': 'application/json', 'x-mr-robot-token': paired.secret },
  body: JSON.stringify({ text: 'REST auth bridge' }),
});
server.chatOnce = originalChatOnce;
check('REST chat forwards paired permission context', restChat.status === 200 && observedRestAuth?.permissionCap === 'ask' && observedRestAuth?.isAdmin === false);
const readOnlyRestChat = await fetch(`${base}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-mr-robot-token': readOnlyPaired.secret },
  body: JSON.stringify({ text: 'must not spend provider tokens' }),
});
check('REST chat rejects read-only devices before model execution', readOnlyRestChat.status === 400
  && /읽기 전용/.test(String((await readOnlyRestChat.json()).error ?? '')));
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
server.config.patchDeviceLink(paired.linkId, { capabilities: ['work-sync', 'file-transfer'] });
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
const blockedLanGrantResponse = await fetch(`${base}/api/transfers/grant`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-mr-robot-token': server.secret },
  body: JSON.stringify({ kind: 'file', path: 'smoke/direct-transfer.txt' }),
});
const blockedLanGrant = (await blockedLanGrantResponse.json()).grant;
const blockedLanPull = await fetch(`${base}/api/files/pull`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-mr-robot-token': server.secret },
  body: JSON.stringify({ sourceBase: 'http://192.168.10.20:8787', sourceGrant: blockedLanGrant, sourcePath: 'smoke/direct-transfer.txt', targetPath: 'smoke/plain-lan-copy.txt' }),
});
const preservedBlockedGrant = await fetch(`${base}/api/files/download?path=${encodeURIComponent('smoke/direct-transfer.txt')}`, {
  headers: { 'x-mr-robot-transfer': blockedLanGrant },
});
check('blocked plaintext-LAN pull never forwards or consumes its one-use grant', blockedLanPull.status === 400
  && preservedBlockedGrant.status === 200 && await preservedBlockedGrant.text() === 'direct bytes without an AI call');
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

const publicWsHeaders = (hostName, ray, clientIp) => ({
  Host: hostName,
  'CF-Ray': ray,
  'CF-Connecting-IP': clientIp,
});
const issuePublicWsTicket = (secret, hostName, ray, clientIp) => new Promise((resolveTicket, rejectTicket) => {
  // Node fetch intentionally owns the Host header. Use the low-level client so
  // this loopback integration test reproduces the public tunnel authority that
  // the browser/mobile client reaches over HTTPS in production.
  const request = httpRequest(`${base}/api/ws-ticket`, {
    method: 'POST',
    headers: {
      ...publicWsHeaders(hostName, ray, clientIp),
      'x-mr-robot-token': secret,
      accept: 'application/json',
    },
  }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    response.on('end', () => {
      let ticket = {};
      try { ticket = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* asserted by caller */ }
      resolveTicket({ response: { status: response.statusCode ?? 0 }, ticket });
    });
  });
  request.on('error', rejectTicket);
  request.end();
});
const rejectedPublicWsStatus = (hostName, ray, clientIp, protocols) => new Promise((resolveStatus) => {
  const socket = protocols
    ? new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols, { headers: publicWsHeaders(hostName, ray, clientIp) })
    : new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: publicWsHeaders(hostName, ray, clientIp) });
  const timer = setTimeout(() => { try { socket.terminate(); } catch {} resolveStatus(0); }, 1_500);
  socket.once('unexpected-response', (_request, response) => {
    clearTimeout(timer);
    response.resume();
    resolveStatus(response.statusCode ?? 0);
  });
  socket.once('open', () => { clearTimeout(timer); socket.close(); resolveStatus(101); });
  socket.once('error', () => { /* unexpected-response carries the status */ });
});

const foreignOriginClosed = await new Promise((resolveClose, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://foreign.example' });
  const timer = setTimeout(() => resolveClose(0), 1_000);
  socket.once('close', (code) => { clearTimeout(timer); resolveClose(code); });
  socket.once('error', (error) => { if (socket.readyState !== WebSocket.CLOSED) reject(error); });
});
check('WS rejects an explicit foreign browser Origin before authentication', foreignOriginClosed === 1008);

const oversizedPreAuthWs = await new Promise((resolveWs, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  socket.on('open', () => resolveWs(socket));
  socket.on('error', reject);
});
const oversizedPreAuthClosed = new Promise((resolveClose) => {
  const timer = setTimeout(() => resolveClose(0), 1_000);
  oversizedPreAuthWs.once('close', (code) => { clearTimeout(timer); resolveClose(code); });
});
oversizedPreAuthWs.send(JSON.stringify({ id: 1, method: 'auth', params: { secret: 'x'.repeat(5_000) } }));
check('WS accepts only one small text authentication frame before auth', await oversizedPreAuthClosed === 1008);

const missingPublicTicketStatus = await rejectedPublicWsStatus(
  'robot.v3s9er.com:443', 'abcd1234ef567893-icn', '203.0.113.13', undefined,
);
check('public Cloudflare WS is rejected before occupying an unauthenticated slot without a ticket', missingPublicTicketStatus === 401);

const issuedCloudflareTicket = await issuePublicWsTicket(
  paired.secret, 'robot.v3s9er.com:443', 'abcd1234ef567893-icn', '203.0.113.13',
);
check('authenticated HTTPS issues a short-lived WS protocol ticket', issuedCloudflareTicket.response.status === 200
  && /^mr-robot-ticket\.[A-Za-z0-9_-]{43}$/.test(issuedCloudflareTicket.ticket.protocol ?? '')
  && Number(issuedCloudflareTicket.ticket.expiresAt) > Date.now());
const cloudflareNativeWs = await new Promise((resolveWs, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['mr-robot-rpc-v1', issuedCloudflareTicket.ticket.protocol], {
    origin: 'https://robot.v3s9er.com:443',
    headers: publicWsHeaders('robot.v3s9er.com:443', 'abcd1234ef567893-icn', '203.0.113.13'),
  });
  socket.on('open', () => resolveWs(socket));
  socket.on('error', reject);
});
const cloudflareNativeAuth = await rpc(cloudflareNativeWs, 'auth', { secret: paired.secret });
check('WS normalizes an explicit Cloudflare HTTPS default port', cloudflareNativeAuth.result?.ok === true);
cloudflareNativeWs.close();
const replayedPublicTicketStatus = await rejectedPublicWsStatus(
  'robot.v3s9er.com:443', 'abcd1234ef567893-icn', '203.0.113.13',
  ['mr-robot-rpc-v1', issuedCloudflareTicket.ticket.protocol],
);
check('public WS upgrade ticket is single-use', replayedPublicTicketStatus === 401);

const issuedDesktopTicket = await issuePublicWsTicket(
  paired.secret, 'robot.v3s9er.com', 'abcd1234ef567894-icn', '203.0.113.14',
);
const desktopControllerWs = await new Promise((resolveWs, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['mr-robot-rpc-v1', issuedDesktopTicket.ticket.protocol], {
    origin: 'http://127.0.0.1:8787',
    headers: publicWsHeaders('robot.v3s9er.com', 'abcd1234ef567894-icn', '203.0.113.14'),
  });
  socket.on('open', () => resolveWs(socket));
  socket.on('error', reject);
});
const desktopControllerAuth = await rpc(desktopControllerWs, 'auth', { secret: paired.secret });
check('registered desktop controller may use an authenticated remote Cloudflare hop from loopback UI', desktopControllerAuth.result?.ok === true);
desktopControllerWs.close();

const rejectedAuthWs = await new Promise((resolveWs, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  socket.on('open', () => resolveWs(socket));
  socket.on('error', reject);
});
const rejectedAuthClosed = new Promise((resolveClose) => {
  const timer = setTimeout(() => resolveClose(0), 1_000);
  rejectedAuthWs.once('close', (code) => { clearTimeout(timer); resolveClose(code); });
});
const rejectedAuth = await rpc(rejectedAuthWs, 'auth', { secret: 'not-a-valid-secret' });
check('failed WS authentication is answered once and the socket is closed', rejectedAuth.result?.ok === false
  && await rejectedAuthClosed === 4003);

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
