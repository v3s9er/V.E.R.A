import assert from 'node:assert/strict';
import { closeSync, fstatSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CLOUDFLARE_ACCESS_PAIR_PROBE_ERROR } from '../src/access-probe.js';
import { ConfigStore, type SecretProtector } from '../src/config.js';
import {
  TOOL_PORTAL_ACCESS_PROBE_CODE,
  TOOL_PORTAL_ACCESS_PROBE_HEADER,
  createRemoteLinkPlugin,
  remoteLinkPortalVerificationFresh,
} from '../src/plugins/remote-link.js';
import {
  ToolPortalArtifactStore,
  ToolPortalError,
  ToolPortalSessionManager,
  createToolPortalPasswordVerifier,
  isToolPortalPasswordVerifier,
  normalizeToolPortalMaxCipherTests,
  normalizeToolPortalResourceLimits,
  normalizeToolPortalSslScanMode,
  normalizeToolPortalTargetHost,
  toolPortalResourceFetchMissing,
  verifyToolPortalPassword,
  TOOL_PORTAL_REQUEST_PROOF_HEADER,
} from '../src/tool-portal.js';

class TestProtector implements SecretProtector {
  protect(value: string): string { return `test-v1:${Buffer.from(value, 'utf8').toString('base64url')}`; }
  unprotect(value: string): string {
    if (!value.startsWith('test-v1:')) throw new Error('invalid test envelope');
    return Buffer.from(value.slice('test-v1:'.length), 'base64url').toString('utf8');
  }
}

test('portal password uses an async salted scrypt verifier and never stores plaintext', async () => {
  const password = 'correct horse portal battery';
  const first = await createToolPortalPasswordVerifier(password);
  const second = await createToolPortalPasswordVerifier(password);
  assert.equal(isToolPortalPasswordVerifier(first), true);
  assert.notEqual(first, second);
  assert.equal(first.includes(password), false);
  assert.equal(await verifyToolPortalPassword(password, first), true);
  assert.equal(await verifyToolPortalPassword('incorrect password value', first), false);

  const home = await mkdtemp(join(tmpdir(), 'mr-robot-portal-config-'));
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  try {
    const protector = new TestProtector();
    const config = new ConfigStore(home, { providerVault: protector, pairingVault: protector });
    const registered = config.addWorkspace(workspace, 'Portal Workspace');
    await config.configureToolPortal({
      password,
      portalWorkspaceId: registered.id,
      allowedTargetHosts: ['BÜCHER.Example', 'api.example.com'],
      hookMutationEnabled: true,
    });
    const persisted = readFileSync(join(home, 'config.json'), 'utf8');
    assert.equal(persisted.includes(password), false);
    assert.doesNotMatch(persisted, /"password"\s*:/);
    assert.match(persisted, /"passwordVerifier"\s*:\s*"scrypt-v1\$/);
    assert.deepEqual(config.toolPortalStatus().allowedTargetHosts, ['api.example.com', 'xn--bcher-kva.example']);
    assert.equal(await config.verifyToolPortalPassword(password), true);

    const configuredSessions = new ToolPortalSessionManager(
      () => config.toolPortalStatus(),
      (candidate) => config.verifyToolPortalPassword(candidate),
    );
    const beforeRotation = await configuredSessions.login(password, 'native-config-test');
    await config.configureToolPortal({ allowedTargetHosts: ['api.example.com'] });
    assert.equal(configuredSessions.authenticate(beforeRotation.token, beforeRotation.requestProof), undefined);

    const reopened = new ConfigStore(home, { providerVault: protector, pairingVault: protector });
    assert.equal(await reopened.verifyToolPortalPassword(password), true);
    await reopened.disableToolPortal();
    const disabled = readFileSync(join(home, 'config.json'), 'utf8');
    assert.doesNotMatch(disabled, /passwordVerifier/);
    assert.equal(reopened.toolPortalStatus().enabled, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('portal target authorization is exact IDNA DNS only', () => {
  assert.equal(normalizeToolPortalTargetHost('BÜCHER.Example.'), 'xn--bcher-kva.example');
  assert.equal(normalizeToolPortalTargetHost('Api.Example.COM'), 'api.example.com');
  for (const blocked of ['*.example.com', 'https://example.com', '127.0.0.1', '0x7f.0.0.1', '2130706433', '2606:4700::1111', 'localhost', 'example.com:443']) {
    assert.throws(() => normalizeToolPortalTargetHost(blocked), undefined, blocked);
  }
});

test('portal sessions cap KDF concurrency, pre-reserve failures, expire, and follow config revision', async () => {
  let now = 10_000;
  let revision = 1;
  let releaseVerification!: (value: boolean) => void;
  const pendingVerifier = () => new Promise<boolean>((resolve) => { releaseVerification = resolve; });
  const concurrency = new ToolPortalSessionManager(
    () => ({ enabled: true, revision }),
    pendingVerifier,
    { now: () => now, maxConcurrentVerifications: 1 },
  );
  const firstLogin = concurrency.login('password', 'client-a');
  await assert.rejects(concurrency.login('password', 'client-b'), (error: unknown) => error instanceof ToolPortalError && error.code === 'LOGIN_VERIFICATION_BUSY');
  releaseVerification(true);
  const first = await firstLogin;
  assert.equal(concurrency.authenticate(first.token), undefined);
  assert.equal(concurrency.authenticate(first.token, 'Z'.repeat(43)), undefined);
  assert.equal(concurrency.authenticate(first.token, first.requestProof)?.expiresAt, now + 30 * 60_000);
  revision += 1;
  assert.equal(concurrency.authenticate(first.token, first.requestProof), undefined);

  let expiryNow = 20_000;
  const expiring = new ToolPortalSessionManager(
    () => ({ enabled: true, revision: 1 }),
    async () => true,
    { now: () => expiryNow, sessionTtlMs: 1_000 },
  );
  const expiringLogin = await expiring.login('password', 'expiring-client');
  expiryNow += 1_001;
  assert.equal(expiring.authenticate(expiringLogin.token, expiringLogin.requestProof), undefined);

  const failures = new ToolPortalSessionManager(
    () => ({ enabled: true, revision: 1 }),
    async () => false,
    { now: () => now, maxFailuresPerClient: 2, maxGlobalFailures: 3 },
  );
  await assert.rejects(failures.login('bad', 'one'), (error: unknown) => error instanceof ToolPortalError && error.code === 'INVALID_CREDENTIALS');
  await assert.rejects(failures.login('bad', 'one'), (error: unknown) => error instanceof ToolPortalError && error.code === 'INVALID_CREDENTIALS');
  await assert.rejects(failures.login('bad', 'one'), (error: unknown) => error instanceof ToolPortalError && error.code === 'LOGIN_RATE_LIMITED');
  await assert.rejects(failures.login('bad', 'two'), ToolPortalError);
  await assert.rejects(failures.login('bad', 'three'), (error: unknown) => error instanceof ToolPortalError && error.code === 'LOGIN_RATE_LIMITED');
  now += 15 * 60_000 + 1;
  await assert.rejects(failures.login('bad', 'three'), (error: unknown) => error instanceof ToolPortalError && error.code === 'INVALID_CREDENTIALS');
});

test('resource portal limits retain the low-traffic server hard caps', () => {
  const defaults = normalizeToolPortalResourceLimits(undefined, true);
  assert.deepEqual(defaults, {
    maxResources: 100,
    maxNetworkRequests: 12,
    maxResourceBytes: 2 * 1024 * 1024,
    maxTotalBytes: 8 * 1024 * 1024,
    maxDepth: 1,
    concurrency: 1,
    timeoutMs: 5_000,
    retries: 0,
    maxRedirects: 2,
    minRequestIntervalMs: 300,
    overallTimeoutMs: 30_000,
  });
  assert.deepEqual(normalizeToolPortalResourceLimits({
    maxResources: 5_000,
    maxNetworkRequests: 5_000,
    maxResourceBytes: 64 * 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
    maxDepth: 9,
    concurrency: 9,
    timeoutMs: 90_000,
    retries: 9,
    maxRedirects: 9,
    minRequestIntervalMs: 100,
    overallTimeoutMs: 900_000,
  }, true), {
    maxResources: 200,
    maxNetworkRequests: 20,
    maxResourceBytes: 8 * 1024 * 1024,
    maxTotalBytes: 16 * 1024 * 1024,
    maxDepth: 2,
    concurrency: 2,
    timeoutMs: 15_000,
    retries: 1,
    maxRedirects: 2,
    minRequestIntervalMs: 300,
    overallTimeoutMs: 60_000,
  });
  assert.equal(normalizeToolPortalResourceLimits({ maxNetworkRequests: 20 }, false).maxNetworkRequests, 0);
  assert.throws(() => normalizeToolPortalResourceLimits('wide-open', true), ToolPortalError);
  assert.equal(toolPortalResourceFetchMissing('archive', true), true);
  assert.equal(toolPortalResourceFetchMissing('preview', true), false);
  assert.equal(toolPortalResourceFetchMissing('validate', true), false);
  assert.throws(() => toolPortalResourceFetchMissing('archive', 'yes'), ToolPortalError);
});

test('TLS portal exposes only quick and bounded standard scan modes', () => {
  assert.equal(normalizeToolPortalSslScanMode(undefined), 'quick');
  assert.equal(normalizeToolPortalSslScanMode('standard'), 'standard');
  assert.throws(() => normalizeToolPortalSslScanMode('deep'), ToolPortalError);
  assert.equal(normalizeToolPortalMaxCipherTests('quick', 999), 0);
  assert.equal(normalizeToolPortalMaxCipherTests('standard', undefined), 12);
  assert.equal(normalizeToolPortalMaxCipherTests('standard', 999), 12);
});

test('archive capabilities are bounded, session-bound, one-use, and opened as verified ZIP files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-robot-portal-artifact-'));
  const outside = await mkdtemp(join(tmpdir(), 'mr-robot-portal-outside-'));
  const zip = join(root, 'result.zip');
  const foreign = join(outside, 'foreign.zip');
  // Minimal empty ZIP end-of-central-directory record.
  const emptyZip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
  await writeFile(zip, emptyZip);
  await writeFile(foreign, emptyZip);
  try {
    const store = new ToolPortalArtifactStore();
    assert.throws(() => store.issue('session-a', foreign, root), /밖/);
    const issued = store.issue('session-a', zip, root);
    assert.match(issued.capability, /^[A-Za-z0-9_-]{43}$/);
    assert.throws(() => store.consume(issued.capability, 'session-b', root), ToolPortalError);
    assert.throws(() => store.consume(issued.capability, 'session-a', root), ToolPortalError);

    const second = store.issue('session-a', zip, root);
    const opened = store.consume(second.capability, 'session-a', root);
    assert.equal(opened.size, emptyZip.length);
    assert.equal(statSync(opened.path).isFile(), true);
    closeSync(opened.fd);
    assert.throws(() => store.consume(second.capability, 'session-a', root), ToolPortalError);

    const changed = store.issue('session-a', zip, root);
    writeFileSync(zip, Buffer.concat([emptyZip, Buffer.from('changed')]));
    assert.throws(() => store.consume(changed.capability, 'session-a', root), /변경/);
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  }
});

test('remote-link portal verification expires and rejects future timestamps', () => {
  const now = 1_900_000_000_000;
  assert.equal(remoteLinkPortalVerificationFresh(now, now), true);
  assert.equal(remoteLinkPortalVerificationFresh(now - 10 * 60_000 - 1, now), false);
  assert.equal(remoteLinkPortalVerificationFresh(now + 60_001, now), false);
});

test('running named tunnels stop when only the portal path becomes anonymously exposed', async () => {
  class FakeTunnelProcess extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly pid = 4_242;
    exitCode: number | null = null;
    killed = false;

    kill(): boolean {
      if (this.exitCode !== null) return false;
      this.killed = true;
      this.exitCode = 0;
      setImmediate(() => this.emit('close', 0, null));
      return true;
    }
  }

  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'mr-robot-portal-reverify-'));
  const child = new FakeTunnelProcess();
  const storage = new Map<string, unknown>();
  const commands = new Map<string, (raw?: unknown) => unknown | Promise<unknown>>();
  let anonymousPortalExposed = false;
  const tunnelToken = Buffer.from(JSON.stringify({
    a: '0123456789abcdef0123456789abcdef',
    t: '61355f59-342f-45e9-af9f-9607cfd4280a',
    s: Buffer.from('periodic-test-tunnel-secret-material').toString('base64'),
  })).toString('base64url');
  const accessClientId = 'portal-periodic-client-0123456789.access';
  const accessClientSecret = 'portal-periodic-secret-0123456789abcdef';
  const plugin = createRemoteLinkPlugin({
    findExecutable: () => 'fake-cloudflared',
    verifyExecutable: (candidate) => ({ trusted: true, executable: candidate, diagnostic: 'test trusted' }),
    spawnProcess: () => child as never,
    protectSecret: (value) => `protected:${value}`,
    unprotectSecret: (value) => {
      if (!value.startsWith('protected:')) throw new Error('invalid envelope');
      return value.slice('protected:'.length);
    },
    runtimeDirectory,
    accessReverifyIntervalMs: 1_000,
    fetchUrl: async (url, options) => {
      const headers = (options?.headers ?? {}) as Record<string, string>;
      const authenticated = Boolean(headers['CF-Access-Client-Id'] && headers['CF-Access-Client-Secret']);
      const json = (body: unknown, status: number, extraHeaders: Record<string, string> = {}) => new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...extraHeaders },
      });
      if (url.pathname === '/api/tool-portal/session'
        && headers[TOOL_PORTAL_ACCESS_PROBE_HEADER] === TOOL_PORTAL_ACCESS_PROBE_CODE) {
        if (!authenticated && !anonymousPortalExposed) return new Response('Access denied', { status: 403 });
        return json(
          { app: 'mr-robot', code: TOOL_PORTAL_ACCESS_PROBE_CODE, error: 'tool portal Access verification marker' },
          503,
          { 'cache-control': 'no-store, max-age=0' },
        );
      }
      if (!authenticated) {
        return new Response('Access denied', { status: 403 });
      }
      if (url.pathname === '/api/ws-ticket') return json({ error: 'unauthorized' }, 401);
      if (url.pathname === '/api/pair') {
        return json({ app: 'mr-robot', error: CLOUDFLARE_ACCESS_PAIR_PROBE_ERROR }, 400);
      }
      return json({ ok: true, app: 'mr-robot' }, 200);
    },
  });
  const context = {
    pluginId: 'remote-link',
    logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } },
    storage: { get: (key: string) => storage.get(key), set: (key: string, value: unknown) => storage.set(key, value) },
    registerCommand: (name: string, handler: (raw?: unknown) => unknown | Promise<unknown>) => commands.set(name, handler),
    on() {}, once() {}, emit() {},
    setInterval, setTimeout, clearInterval, clearTimeout,
    computer: {}, ai: { providerCount: () => 0 },
  };
  try {
    await plugin.activate(context as never);
    await commands.get('remote-link.config.set')!({
      provider: 'cloudflare-named',
      localUrl: 'http://127.0.0.1:8787',
      hostname: 'portal-reverify.example.com',
      tunnelToken,
      accessClientId,
      accessClientSecret,
      autoStart: false,
    });
    const starting = Promise.resolve(commands.get('remote-link.start')!({}));
    child.stderr.write('INF Registered tunnel connection connIndex=0');
    await starting;
    assert.equal(plugin.portalOriginAllowed(new URL('https://portal-reverify.example.com')), true);

    // Ping, WebSocket admission, and pairing remain protected. Only the newly
    // probed portal path regresses to an anonymous path-scoped bypass.
    anonymousPortalExposed = true;
    const deadline = Date.now() + 3_000;
    while ((commands.get('remote-link.status')!({}) as { running: boolean }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const failed = commands.get('remote-link.status')!({}) as { running: boolean; lastError?: string };
    assert.equal(failed.running, false);
    assert.match(failed.lastError ?? '', /\/api\/tool-portal\/session 경로를 보호하지 않습니다/);
    assert.equal(plugin.portalOriginAllowed(new URL('https://portal-reverify.example.com')), false);
  } finally {
    await plugin.deactivate(context as never);
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test('runtime portal status never discloses another portal or native observer session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mr-robot-portal-runtime-status-'));
  const previousHome = process.env.MR_ROBOT_HOME;
  process.env.MR_ROBOT_HOME = home;
  const timers = [setTimeout(() => undefined, 60_000), setTimeout(() => undefined, 60_000)];
  timers.forEach((timer) => timer.unref?.());
  try {
    const { AgentServer } = await import('../src/server/server.js');
    const server = new AgentServer();
    const internal = server as unknown as {
      toolPortalObserverSessions: Map<string, { owner: string; timer: NodeJS.Timeout }>;
      plugins: { call: (name: string, params: unknown, execution?: unknown) => Promise<unknown> };
      callPortalRuntime: (
        session: { key: string; expiresAt: number },
        action: 'status',
        raw: unknown,
        signal: AbortSignal,
      ) => Promise<unknown>;
    };
    internal.toolPortalObserverSessions.set('session-a-observer', { owner: 'owner-a', timer: timers[0] });
    internal.toolPortalObserverSessions.set('session-b-observer', { owner: 'owner-b', timer: timers[1] });
    const calls: Array<{ name: string; params: unknown }> = [];
    internal.plugins.call = async (name, params) => {
      calls.push({ name, params });
      const sessionId = (params as { sessionId?: string }).sessionId ?? 'native-secret-session';
      return { ok: true, activeSessions: 1, session: { sessionId } };
    };
    const session = (key: string) => ({ key, expiresAt: Date.now() + 60_000 });

    assert.deepEqual(await internal.callPortalRuntime(session('owner-c'), 'status', {}, AbortSignal.timeout(1_000)), {
      ok: true,
      activeSessions: 0,
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(await internal.callPortalRuntime(session('owner-a'), 'status', {}, AbortSignal.timeout(1_000)), {
      ok: true,
      activeSessions: 1,
      session: { sessionId: 'session-a-observer' },
    });
    assert.deepEqual(calls.at(-1), { name: 'webcrypto-observer.status', params: { sessionId: 'session-a-observer' } });
    await assert.rejects(
      internal.callPortalRuntime(session('owner-a'), 'status', { sessionId: 'session-b-observer' }, AbortSignal.timeout(1_000)),
      (error: unknown) => error instanceof ToolPortalError && error.code === 'SESSION_NOT_FOUND',
    );
  } finally {
    timers.forEach(clearTimeout);
    if (previousHome === undefined) delete process.env.MR_ROBOT_HOME;
    else process.env.MR_ROBOT_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('runtime portal stop survives caller abort and retains ownership until a terminal result', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mr-robot-portal-runtime-stop-'));
  const previousHome = process.env.MR_ROBOT_HOME;
  process.env.MR_ROBOT_HOME = home;
  const timer = setTimeout(() => undefined, 60_000);
  timer.unref?.();
  try {
    const { AgentServer } = await import('../src/server/server.js');
    const server = new AgentServer();
    const internal = server as unknown as {
      toolPortalObserverSessions: Map<string, { owner: string; timer: NodeJS.Timeout }>;
      plugins: { call: (name: string, params: unknown, execution?: unknown) => Promise<unknown> };
      callPortalRuntime: (
        session: { key: string; expiresAt: number },
        action: 'stop',
        raw: unknown,
        signal: AbortSignal,
      ) => Promise<unknown>;
    };
    const sessionId = 'owned-observer-session';
    internal.toolPortalObserverSessions.set(sessionId, { owner: 'owner-a', timer });
    let attempts = 0;
    internal.plugins.call = async (name, params, execution) => {
      attempts += 1;
      assert.equal(name, 'webcrypto-observer.stop');
      assert.deepEqual(params, { sessionId });
      assert.equal((execution as { signal?: AbortSignal }).signal?.aborted, false);
      if (attempts === 1) throw new Error('simulated stop transport failure');
      return { sessionId, stopped: true, status: 'stopped' };
    };
    const caller = new AbortController();
    caller.abort(new Error('caller disconnected'));
    const session = { key: 'owner-a', expiresAt: Date.now() + 60_000 };

    await assert.rejects(
      internal.callPortalRuntime(session, 'stop', { sessionId }, caller.signal),
      /simulated stop transport failure/,
    );
    assert.equal(internal.toolPortalObserverSessions.has(sessionId), true);

    assert.deepEqual(
      await internal.callPortalRuntime(session, 'stop', { sessionId }, caller.signal),
      { sessionId, stopped: true, status: 'stopped' },
    );
    assert.equal(internal.toolPortalObserverSessions.has(sessionId), false);
  } finally {
    clearTimeout(timer);
    if (previousHome === undefined) delete process.env.MR_ROBOT_HOME;
    else process.env.MR_ROBOT_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('loopback HTTP portal requires a per-tab request proof in addition to the port-shared cookie', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mr-robot-portal-http-'));
  const web = join(home, 'web');
  const zip = join(home, 'download.zip');
  await mkdir(web);
  await writeFile(join(web, 'index.html'), '<!doctype html><title>portal</title>');
  await writeFile(zip, Buffer.from('504b0506000000000000000000000000000000000000', 'hex'));
  const previousHome = process.env.MR_ROBOT_HOME;
  process.env.MR_ROBOT_HOME = home;
  try {
    const [{ createHttpApi }, { WsUpgradeTickets }] = await Promise.all([
      import('../src/server/http.js'),
      import('../src/server/ws.js'),
    ]);
    const token = 'A'.repeat(43);
    const requestProof = 'P'.repeat(43);
    let artifactCalls = 0;
    let sessionActive = false;
    let streamedFd: number | undefined;
    const host = {
      toolPortalSession: (candidate: unknown, candidateProof: unknown) => ({
        enabled: true,
        authenticated: sessionActive && candidate === token && candidateProof === requestProof,
        ...(sessionActive && candidate === token && candidateProof === requestProof ? { expiresAt: Date.now() + 60_000, hookMutationEnabled: false } : {}),
      }),
      toolPortalLogin: async () => {
        sessionActive = true;
        return { token, requestProof, session: { key: 'session-key', expiresAt: Date.now() + 60_000 } };
      },
      toolPortalLogout: async (candidate: unknown, candidateProof: unknown) => {
        const active = sessionActive && candidate === token && candidateProof === requestProof;
        if (active) sessionActive = false;
        return active;
      },
      toolPortalCall: async (candidate: unknown, candidateProof: unknown, tool: string, action: string) => {
        if (!sessionActive || candidate !== token || candidateProof !== requestProof) {
          throw new ToolPortalError('unauthorized', 401, 'PORTAL_UNAUTHORIZED');
        }
        return { tool, action };
      },
      toolPortalArtifact: (candidate: unknown, candidateProof: unknown) => {
        if (!sessionActive || candidate !== token || candidateProof !== requestProof) {
          throw new ToolPortalError('unauthorized', 401, 'PORTAL_UNAUTHORIZED');
        }
        artifactCalls += 1;
        streamedFd = openSync(zip, 'r');
        return { path: zip, name: 'download.zip', size: statSync(zip).size, fd: streamedFd };
      },
      toolPortalOriginAllowed: () => false,
      authenticate: () => null,
      verifySecret: () => false,
      isAdminSecret: () => false,
      isSyncSecret: () => false,
      peerRequestHeaders: () => ({}),
    } as never;
    const app = createHttpApi(host, web, new Set(), new WsUpgradeTickets());
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const page = await fetch(`${origin}/tools/resource-archiver`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('cache-control') ?? '', /no-store/);
      assert.match(page.headers.get('content-security-policy') ?? '', /connect-src 'self'/);
      assert.doesNotMatch(page.headers.get('content-security-policy') ?? '', /connect-src[^;]*https:/);

      const accessPayload = Buffer.from(JSON.stringify({
        iss: 'https://mr-robot.cloudflareaccess.com',
        aud: ['portal-audience'],
        exp: Math.floor((Date.now() + 60_000) / 1_000),
      })).toString('base64url');
      const staleRemote = await fetch(`${origin}/tools/resource-archiver`, {
        headers: {
          host: 'portal.example.com',
          'cf-connecting-ip': '203.0.113.10',
          'cf-ray': '0123456789abcdef-ICN',
          'cf-access-jwt-assertion': `eyJhbGciOiJSUzI1NiJ9.${accessPayload}.${'A'.repeat(64)}`,
          'x-forwarded-proto': 'https',
        },
      });
      assert.equal(staleRemote.status, 503);

      const portalAccessProbe = await fetch(`${origin}/api/tool-portal/session`, {
        headers: {
          host: 'portal.example.com',
          'cf-connecting-ip': '203.0.113.10',
          'cf-ray': '0123456789abcdef-ICN',
          'cf-access-jwt-assertion': `eyJhbGciOiJSUzI1NiJ9.${accessPayload}.${'A'.repeat(64)}`,
          'x-forwarded-proto': 'https',
          [TOOL_PORTAL_ACCESS_PROBE_HEADER]: TOOL_PORTAL_ACCESS_PROBE_CODE,
        },
      });
      assert.equal(portalAccessProbe.status, 503);
      assert.match(portalAccessProbe.headers.get('cache-control') ?? '', /(?:^|,)\s*no-store(?:\s*(?:,|$))/i);
      assert.deepEqual(await portalAccessProbe.json(), {
        app: 'mr-robot',
        code: TOOL_PORTAL_ACCESS_PROBE_CODE,
        error: 'tool portal Access verification marker',
      });

      const adjacentPortalPath = await fetch(`${origin}/api/tool-portal/session/`, {
        headers: {
          host: 'portal.example.com',
          'cf-ray': '0123456789abcdef-ICN',
          [TOOL_PORTAL_ACCESS_PROBE_HEADER]: TOOL_PORTAL_ACCESS_PROBE_CODE,
        },
      });
      assert.equal(adjacentPortalPath.status, 503);
      assert.equal((await adjacentPortalPath.json() as { code?: unknown }).code, undefined);

      const missingOrigin = await fetch(`${origin}/api/tool-portal/session`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'anything' }),
      });
      assert.equal(missingOrigin.status, 403);
      const login = await fetch(`${origin}/api/tool-portal/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({ password: 'anything' }),
      });
      assert.equal(login.status, 200);
      const setCookie = login.headers.get('set-cookie') ?? '';
      assert.match(setCookie, /^mr-robot-tool-portal-local=/);
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Strict/i);
      assert.doesNotMatch(setCookie, /; Secure/i);
      const cookie = setCookie.split(';', 1)[0];
      const loginPayload = await login.json() as { authenticated: boolean; requestProof?: string };
      assert.equal(loginPayload.authenticated, true);
      assert.equal(loginPayload.requestProof, requestProof);

      // Browser cookies are shared across ports. Possessing that ambient
      // cookie without the origin-scoped sessionStorage proof must be useless.
      const cookieOnlySession = await fetch(`${origin}/api/tool-portal/session`, { headers: { cookie } });
      assert.equal((await cookieOnlySession.json() as { authenticated: boolean }).authenticated, false);
      const cookieOnlyCall = await fetch(`${origin}/api/tool-portal/tools/sslscan/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, cookie, 'sec-fetch-site': 'same-origin' },
        body: '{}',
      });
      assert.equal(cookieOnlyCall.status, 401);

      const call = await fetch(`${origin}/api/tool-portal/tools/sslscan/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, cookie, 'sec-fetch-site': 'same-origin', [TOOL_PORTAL_REQUEST_PROOF_HEADER]: requestProof },
        body: '{}',
      });
      assert.deepEqual(await call.json(), { tool: 'sslscan', action: 'status' });
      const authenticatedSession = await fetch(`${origin}/api/tool-portal/session`, {
        headers: { cookie, [TOOL_PORTAL_REQUEST_PROOF_HEADER]: requestProof },
      });
      const authenticatedPayload = await authenticatedSession.json() as { authenticated: boolean; requestProof?: unknown };
      assert.equal(authenticatedPayload.authenticated, true);
      assert.equal(authenticatedPayload.requestProof, undefined);

      const crossSite = await fetch(`${origin}/api/tool-portal/artifacts/${'B'.repeat(43)}`, {
        headers: { cookie, 'sec-fetch-site': 'cross-site' },
      });
      assert.equal(crossSite.status, 403);
      assert.equal(artifactCalls, 0);
      const cookieOnlyDownload = await fetch(`${origin}/api/tool-portal/artifacts/${'B'.repeat(43)}`, {
        headers: { cookie, 'sec-fetch-site': 'same-origin' },
      });
      assert.equal(cookieOnlyDownload.status, 401);
      assert.equal(artifactCalls, 0);
      const download = await fetch(`${origin}/api/tool-portal/artifacts/${'B'.repeat(43)}`, {
        headers: { cookie, 'sec-fetch-site': 'same-origin', [TOOL_PORTAL_REQUEST_PROOF_HEADER]: requestProof },
      });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('content-type'), 'application/zip');
      assert.match(download.headers.get('cache-control') ?? '', /no-store/);
      assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
      assert.match(download.headers.get('content-disposition') ?? '', /attachment/);
      assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0, 2).toString('ascii'), 'PK');
      assert.equal(artifactCalls, 1);
      if (streamedFd === undefined) throw new Error('artifact descriptor was not opened');
      // The client can finish consuming a loopback response one event-loop turn
      // before the server-side pipeline reaches its finally block.
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.throws(() => fstatSync(streamedFd!), /EBADF|bad file descriptor/i);

      const cookieOnlyLogout = await fetch(`${origin}/api/tool-portal/logout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, cookie, 'sec-fetch-site': 'same-origin' },
        body: '{}',
      });
      assert.equal(cookieOnlyLogout.status, 200);
      const stillAuthenticated = await fetch(`${origin}/api/tool-portal/session`, {
        headers: { cookie, [TOOL_PORTAL_REQUEST_PROOF_HEADER]: requestProof },
      });
      assert.equal((await stillAuthenticated.json() as { authenticated: boolean }).authenticated, true);

      const logout = await fetch(`${origin}/api/tool-portal/logout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, cookie, 'sec-fetch-site': 'same-origin', [TOOL_PORTAL_REQUEST_PROOF_HEADER]: requestProof },
        body: '{}',
      });
      assert.equal(logout.status, 200);
      assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/i);
      const loggedOut = await fetch(`${origin}/api/tool-portal/session`, {
        headers: { cookie, [TOOL_PORTAL_REQUEST_PROOF_HEADER]: requestProof },
      });
      assert.equal((await loggedOut.json() as { authenticated: boolean }).authenticated, false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    if (previousHome === undefined) delete process.env.MR_ROBOT_HOME;
    else process.env.MR_ROBOT_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
