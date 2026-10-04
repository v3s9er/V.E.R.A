import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { spawnSync, type spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentLoop } from '../src/ai/loop.js';
import { ToolExecutor } from '../src/ai/executor.js';
import type { AiProvider, NativeAgentRequest } from '../src/ai/provider.js';
import type { PluginExecutionContext } from '../src/plugins/commands.js';
import { PluginCommandRegistry } from '../src/plugins/commands.js';
import {
  ManagedSandboxService, createManagedSandboxPlugin, createSandboxDockerCommand,
  MANAGED_SANDBOX_IMAGE, MANAGED_SANDBOX_LIMITS, SANDBOX_WATCHDOG, SANDBOX_WATCHDOG_CONTROL, type SandboxDockerCommand, type SandboxDockerResult,
} from '../src/plugins/managed-sandbox.js';

const OWNER = '12345678-1234-4234-8234-123456789abc';
const IMAGE = `sha256:${'a'.repeat(64)}`;
const endpoint = 'npipe:////./pipe/dockerDesktopLinuxEngine';
const execution = (scopeKey = 'conversation-A'): PluginExecutionContext => ({
  scopeKey, workspaceRoot: tmpdir(), permissionMode: 'ask', destructiveApproved: true, approvalSource: 'prompt',
});
const ok = (value = ''): SandboxDockerResult => ({ code: 0, stdout: value, stderr: '' });
const fail = (): SandboxDockerResult => ({ code: 1, stdout: '', stderr: 'synthetic failure' });

class FakeDocker {
  calls: string[][] = [];
  containers = new Map<string, any>();
  contextEndpoint = endpoint;
  daemon = true;
  info = { OSType: 'linux', MemoryLimit: true, SwapLimit: true, CPUShares: true, CpuCfsQuota: true, PidsLimit: true, SecurityOptions: ['name=seccomp,profile=builtin'] };
  image = { Id: IMAGE, Os: 'linux', Config: { Volumes: null, Env: ['PRIVATE_IMAGE_FIELD=not-returned'] } };
  imagePresent = true;
  execResult = ok('result\n');
  armResult = ok('armed\n');
  finishResult = ok('idle\n');
  hook?: (args: string[], options: Parameters<SandboxDockerCommand>[1]) => Promise<SandboxDockerResult | undefined>;
  private counter = 0;
  command: SandboxDockerCommand = async (full, options) => {
    this.calls.push([...full]);
    const args = full[0] === '--host' ? full.slice(2) : full;
    const override = await this.hook?.(args, options);
    if (override) return override;
    if (options?.signal?.aborted) return { ...fail(), aborted: true };
    if (args[0] === 'context' && args[1] === 'show') return ok('desktop-linux\n');
    if (args[0] === 'context' && args[1] === 'inspect') return ok(JSON.stringify(this.contextEndpoint));
    if (!this.daemon) return fail();
    if (args[0] === 'info') return ok(JSON.stringify(this.info));
    if (args[0] === 'image') return this.imagePresent ? ok(JSON.stringify(this.image)) : fail();
    if (args[0] === 'exec') return args.includes(SANDBOX_WATCHDOG_CONTROL) ? (args.at(-2) === 'arm' ? this.armResult : this.finishResult) : this.execResult;
    if (args[0] !== 'container') throw new Error(`Unexpected fake command ${args[0]}`);
    if (args[1] === 'create') {
      const labels: Record<string, string> = {};
      args.forEach((a, index) => { if (a === '--label') { const [key, value] = args[index + 1].split('='); labels[key] = value; } });
      const id = (++this.counter).toString(16).padStart(64, '0');
      const name = args[args.indexOf('--name') + 1];
      const container = {
        Id: id, Name: `/${name}`, Image: IMAGE, Config: { User: '65533:65533', WorkingDir: '/', Labels: labels, Entrypoint: ['/usr/local/bin/python'], Cmd: ['-I', '-B', '-c', SANDBOX_WATCHDOG] }, State: { Running: false }, Mounts: [],
        HostConfig: {
          ReadonlyRootfs: true, Privileged: false, NetworkMode: 'none', Memory: 512 * 1024 * 1024, MemorySwap: 512 * 1024 * 1024,
          NanoCpus: 1_000_000_000, PidsLimit: 64, ShmSize: 8 * 1024 * 1024, LogConfig: { Type: 'none' }, AutoRemove: true,
          CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'], Binds: null, Mounts: [], Devices: [],
          Tmpfs: { '/work': 'rw,noexec,nosuid,nodev,size=128m,uid=65534,gid=65534,mode=700', '/tmp': 'rw,noexec,nosuid,nodev,size=32m,mode=1777', '/guard': 'rw,noexec,nosuid,nodev,size=1m,uid=65533,gid=65533,mode=700' },
        },
      };
      this.containers.set(id, container); return ok(`${id}\n`);
    }
    if (args[1] === 'inspect') {
      const target = [...this.containers.values()].find(x => x.Id === args[2] || x.Name === `/${args[2]}`);
      return target ? ok(JSON.stringify(target)) : fail();
    }
    if (args[1] === 'ls') {
      const filter = args[args.indexOf('--filter') + 1];
      const found = [...this.containers.values()].filter(x => filter.startsWith('name=')
        ? `name=^${x.Name}$` === filter
        : x.Config.Labels['io.vera.managed-sandbox.owner'] === OWNER);
      return ok(found.map(x => x.Id).join('\n'));
    }
    if (args[1] === 'start') { const c = this.containers.get(args[2]); if (!c) return fail(); c.State.Running = true; return ok(c.Id); }
    if (args[1] === 'rm') return this.containers.delete(args.at(-1)!) ? ok('removed') : fail();
    throw new Error(`Unexpected fake container command ${args[1]}`);
  };
  count(action: string) { return this.calls.filter(x => x.includes(action) && !(action === 'exec' && x.includes(SANDBOX_WATCHDOG_CONTROL))).length; }
  first() { return this.containers.values().next().value!; }
}

test('prepare is idempotent, scope isolated and fully constrained; no pulls, mounts, host paths or arbitrary flags', async () => {
  const docker = new FakeDocker(); const service = new ManagedSandboxService(OWNER, docker.command);
  try {
    assert.deepEqual(await service.prepare(execution()), { state: 'ready', reused: false, ephemeral: true });
    assert.equal((await service.prepare(execution())).reused, true);
    assert.equal(docker.count('create'), 1);
    await service.prepare(execution('conversation-B'));
    assert.equal(docker.containers.size, 2);
    assert.equal((await service.execute({ command: 'printf result', timeoutSec: 5 }, execution())).ok, true);
    const create = docker.calls.find(x => x.includes('create'))!;
    for (const flag of ['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65533:65533', '--memory=512m', '--memory-swap=512m', '--cpus=1', '--pids-limit=64', '--shm-size=8m', '--log-driver=none', '--no-healthcheck', '--entrypoint=/usr/local/bin/python']) assert.ok(create.includes(flag), flag);
    assert.equal(create.at(-1), SANDBOX_WATCHDOG); assert.ok(create.includes(IMAGE));
    assert.ok(create.includes('--workdir=/'), 'watchdog UID cannot chdir into the command UID private /work');
    assert.ok(!create.some(a => /^(-v|--volume|--mount|--privileged|--device)/.test(a)));
    assert.ok(!create.includes(tmpdir()));
    const exec = docker.calls.find(x => x.includes('exec') && !x.includes(SANDBOX_WATCHDOG_CONTROL))!;
    assert.ok(exec.includes('--user=65534:65534')); assert.ok(exec.includes('-i')); assert.ok(exec.includes('HOME=/work'));
    assert.equal(docker.count('pull'), 0);
    assert.equal((await service.status(execution())).state, 'ready');
    await service.discard(execution());
    assert.equal(docker.containers.size, 1); assert.equal((await service.status(execution('conversation-B'))).state, 'ready');
    assert.equal((await service.discard(execution())).removed, false);
  } finally { await service.close(); }
  assert.equal(docker.containers.size, 0);
});

test('status reports unavailable daemon without starting it, WSL fallback or arbitrary daemon diagnostics', async () => {
  const docker = new FakeDocker(); docker.daemon = false;
  const service = new ManagedSandboxService(OWNER, docker.command);
  const status = await service.status();
  assert.equal(status.cli, true); assert.equal(status.localContext, true); assert.equal(status.daemon, false);
  assert.equal(status.wslDockerSupported, true); assert.equal(status.plainWslSandbox, false);
  await assert.rejects(service.prepare(execution()), /Docker Linux/);
  assert.equal(docker.count('create'), 0); assert.equal(docker.count('start'), 0);
  assert.ok(!JSON.stringify(status).includes('synthetic failure'));
});

test('remote Docker contexts, unsupported kernel limits, missing images and hidden image volumes fail closed', async () => {
  for (const change of [
    (d: FakeDocker) => { d.contextEndpoint = 'tcp://remote.invalid:2375'; },
    (d: FakeDocker) => { d.contextEndpoint = 'ssh://example.invalid'; },
    (d: FakeDocker) => { d.info.OSType = 'windows'; },
    (d: FakeDocker) => { d.info.SwapLimit = false; },
    (d: FakeDocker) => { d.info.PidsLimit = false; },
    (d: FakeDocker) => { d.info.SecurityOptions = []; },
    (d: FakeDocker) => { d.imagePresent = false; },
    (d: FakeDocker) => { d.image.Config.Volumes = { '/unsafe': {} } as any; },
  ]) {
    const docker = new FakeDocker(); change(docker); const service = new ManagedSandboxService(OWNER, docker.command);
    await assert.rejects(service.prepare(execution())); assert.equal(docker.count('create'), 0); assert.equal(docker.count('pull'), 0);
  }
});

test('approval and host-owned scope cannot be forged through tool parameters', async () => {
  const docker = new FakeDocker(); const service = new ManagedSandboxService(OWNER, docker.command);
  for (const changed of [
    { destructiveApproved: false }, { permissionMode: 'read-only' }, { scopeKey: undefined }, { workspaceRoot: undefined }, { workspaceRoot: '.' },
  ]) await assert.rejects(service.prepare({ ...execution(), ...changed } as PluginExecutionContext));
  assert.equal(docker.calls.length, 0);
  await service.prepare(execution());
  for (const raw of [
    { command: 'x', workspaceRoot: tmpdir() }, { command: 'x', containerId: docker.first().Id }, { command: 'x', network: true },
    { command: 'x', timeoutSec: 121 }, { command: 'x', timeoutSec: 0 }, { command: 'x', timeoutSec: NaN }, { command: 'x', timeoutSec: 1.1 },
    { command: '\0' }, { command: '한'.repeat(16384) }, { command: '' },
  ]) await assert.rejects(service.execute(raw, execution()));
  assert.equal(docker.count('exec'), 0);
  await assert.rejects(service.execute({ command: 'pwd' }, execution('other')), /먼저 준비/);
  await assert.rejects(service.discard({ ...execution(), permissionMode: 'workspace', approvalSource: 'run-capability' }), /개별 승인/);
  await assert.rejects(service.discard({ ...execution(), permissionMode: 'workspace', approvalSource: 'policy' }), /개별 승인/);
  await service.discard({ ...execution(), permissionMode: 'full', approvalSource: 'policy', isAdmin: false });
  await service.prepare(execution()); await service.discard({ ...execution(), isAdmin: true, approvalSource: 'policy' });
});

test('context changes cannot redirect execution or cleanup of a prepared session', async () => {
  const docker = new FakeDocker(); const service = new ManagedSandboxService(OWNER, docker.command);
  await service.prepare(execution()); docker.contextEndpoint = 'npipe:////./pipe/different-engine';
  await service.execute({ command: 'true' }, execution()); await service.discard(execution());
  for (const args of docker.calls.filter(a => a.includes('exec') || a.includes('rm'))) assert.deepEqual(args.slice(0, 2), ['--host', endpoint]);
});

test('label mismatch and altered isolation never execute or remove an unrelated container', async () => {
  const docker = new FakeDocker(); const service = new ManagedSandboxService(OWNER, docker.command);
  await service.prepare(execution()); const first = docker.first();
  first.Config.Labels['io.vera.managed-sandbox.owner'] = 'foreign-owner';
  await assert.rejects(service.execute({ command: 'true' }, execution()), /소유권/);
  assert.equal(docker.count('exec'), 0); assert.equal(docker.count('rm'), 0);
  assert.equal((await service.discard(execution())).state, 'cleanup-pending');
  assert.equal(docker.containers.size, 1);
  first.Config.Labels['io.vera.managed-sandbox.owner'] = OWNER;
  await service.discard(execution()); await service.prepare(execution());
  docker.first().HostConfig.Privileged = true;
  await assert.rejects(service.execute({ command: 'true' }, execution()), /격리 상태/);
  assert.equal(docker.count('exec'), 0); assert.equal(docker.containers.size, 0, 'own tampered container is safely removed');
});

test('all transport failure outcomes terminate only the owned execution container', async () => {
  for (const failure of [{ timedOut: true }, { aborted: true }, { overflow: true }, {}]) {
    const docker = new FakeDocker(); const service = new ManagedSandboxService(OWNER, docker.command);
    await service.prepare(execution()); await service.prepare(execution('other'));
    const other = [...docker.containers.keys()][1]; docker.execResult = { code: null, stdout: 'bounded', stderr: '', ...failure };
    const result = await service.execute({ command: 'long computation' }, execution());
    assert.equal(result.ok, false); assert.equal(result.workspaceDiscarded, true); assert.equal(docker.containers.size, 1);
    assert.ok(docker.containers.has(other)); await service.close();
  }
});

test('nonzero command exit does not falsely report success or unnecessarily discard ordinary state', async () => {
  const docker = new FakeDocker(); const service = new ManagedSandboxService(OWNER, docker.command);
  await service.prepare(execution()); docker.execResult = { code: 7, stdout: '', stderr: 'synthetic command failed' };
  const result = await service.execute({ command: 'exit 7' }, execution());
  assert.equal(result.ok, false); assert.equal(result.exitCode, 7); assert.equal(result.workspaceDiscarded, false);
  assert.equal(docker.containers.size, 1); await service.close();
});

test('daemon-side deadline is armed before code; failure refuses code; background work cannot silently extend its lease', async () => {
  const docker = new FakeDocker(); const service = new ManagedSandboxService(OWNER, docker.command);
  await service.prepare(execution()); docker.armResult = fail();
  await assert.rejects(service.execute({ command: 'must not execute' }, execution()), /보호된 실행 제한/);
  assert.equal(docker.count('exec'), 0); assert.equal(docker.containers.size, 0);
  docker.armResult = ok('armed'); await service.prepare(execution()); docker.finishResult = ok('background');
  assert.equal((await service.execute({ command: 'synthetic background' }, execution())).backgroundProcesses, true);
  const relevant = docker.calls.filter(args => args.includes('exec'));
  const codeIndex = relevant.findIndex(args => args.includes('synthetic background'));
  assert.ok(relevant[codeIndex - 1].includes(SANDBOX_WATCHDOG_CONTROL)); assert.equal(relevant[codeIndex - 1].at(-2), 'arm');
  assert.equal(relevant[codeIndex + 1].at(-2), 'finish');
  docker.armResult = { ...fail(), code: 75 };
  await assert.rejects(service.execute({ command: 'must not extend background' }, execution()), /백그라운드/);
  assert.equal(docker.count('exec'), 1); assert.equal(docker.containers.size, 0);
});

test('host watchdog Python executes against deterministic fake time and process table without Docker', t => {
  const result = spawnSync(process.env.VERA_TEST_PYTHON ?? 'python', ['-I', '-B', fileURLToPath(new URL('./fixtures/managed-sandbox-watchdog.py', import.meta.url))], {
    input: JSON.stringify({ watchdog: SANDBOX_WATCHDOG, control: SANDBOX_WATCHDOG_CONTROL }), encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 16384,
  });
  if ((result.error as NodeJS.ErrnoException)?.code === 'ENOENT'
    || process.platform === 'win32' && result.status === 9009 && /Python was not found/.test(result.stderr)) {
    t.skip('Python unavailable; set VERA_TEST_PYTHON to run the Docker watchdog fixture'); return;
  }
  assert.equal(result.status, 0, result.error?.message ?? result.stderr); assert.match(result.stdout, /background no-extension passed/);
});

test('concurrent prepare reserves slots before awaiting; same scope never creates duplicates', async () => {
  const docker = new FakeDocker(); const service = new ManagedSandboxService(OWNER, docker.command);
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  docker.hook = async args => { if (args[0] === 'context' && args[1] === 'show') await gate; return undefined; };
  const pending = ['one', 'two', 'three', 'four'].map(scope => service.prepare(execution(scope)));
  await assert.rejects(service.prepare(execution('five')), /4개/);
  await assert.rejects(service.prepare(execution('one')), /진행 중/);
  release(); await Promise.all(pending); assert.equal(docker.containers.size, 4); await service.close();
});

test('stop aborts pending exec; concurrent exec rejected; no other scope is stopped', async () => {
  const docker = new FakeDocker(); const service = new ManagedSandboxService(OWNER, docker.command);
  await service.prepare(execution()); await service.prepare(execution('other'));
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  docker.hook = async (args, options) => {
    if (args[0] !== 'exec' || args.includes(SANDBOX_WATCHDOG_CONTROL)) return;
    entered(); return new Promise(resolve => options?.signal?.addEventListener('abort', () => resolve({ ...fail(), aborted: true }), { once: true }));
  };
  const pending = service.execute({ command: 'wait' }, execution()); await started;
  await assert.rejects(service.execute({ command: 'duplicate' }, execution()), /진행 중/);
  await service.discard(execution()); await pending;
  assert.equal(docker.containers.size, 1); assert.equal((await service.status(execution('other'))).state, 'ready'); await service.close();
});

test('cancel during uncertain create quarantines slot and never starts a late container', async () => {
  const docker = new FakeDocker(); const service = new ManagedSandboxService(OWNER, docker.command);
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  docker.hook = async (args, options) => {
    if (args[0] !== 'container' || args[1] !== 'create') return;
    entered(); return new Promise(resolve => options?.signal?.addEventListener('abort', () => resolve({ ...fail(), code: null, aborted: true }), { once: true }));
  };
  const pending = service.prepare(execution()); await started;
  const stopped = await service.discard(execution()); assert.equal(stopped.state, 'cleanup-pending');
  await assert.rejects(pending); await assert.rejects(service.prepare(execution()), /정리/);
  assert.equal(docker.count('start'), 0); assert.equal(docker.count('create'), 1);
});

test('local owner leftovers count against cap without being adopted or deleted', async () => {
  const docker = new FakeDocker(); const previous = new ManagedSandboxService(OWNER, docker.command);
  for (let index = 0; index < 4; index++) await previous.prepare(execution(`old-${index}`));
  const fresh = new ManagedSandboxService(OWNER, docker.command);
  await assert.rejects(fresh.prepare(execution('new')), /한도/);
  assert.equal(docker.count('create'), 4); assert.equal(docker.count('rm'), 0);
  await fresh.close(); assert.equal(docker.count('rm'), 0); await previous.close();
});

test('plugin is inert on load, exact schemas reject forged options, commands use standard safety metadata', async () => {
  const docker = new FakeDocker(); const plugin = createManagedSandboxPlugin(docker.command); const registry = new PluginCommandRegistry();
  const storage = new Map<string, unknown>();
  await plugin.activate!({ storage: { get: <T>(key: string) => storage.get(key) as T, set: (key: string, value: unknown) => { storage.set(key, value); } },
    registerCommand: (name: string, handler: any, options: any) => registry.register('managed-sandbox', name, handler, options),
  } as any);
  assert.equal(docker.calls.length, 0);
  assert.equal(registry.list().length, 5); assert.equal(registry.get('sandbox.status')!.destructive, false);
  for (const name of ['prepare', 'exec', 'stop', 'remove']) assert.equal(registry.get(`sandbox.${name}`)!.destructive, true);
  assert.equal(registry.aiTools('hello').length, 0); assert.equal(registry.aiTools('Docker sandbox').length, 5);
  assert.throws(() => registry.get('sandbox.prepare')!.handler({ image: 'untrusted' }, execution()), /추가 인자/);
  await plugin.deactivate!({} as any);
  assert.equal(plugin.manifest.enabledByDefault, true); assert.equal(plugin.manifest.category, 'development');
});

test('transport captures combined output within byte cap and never forwards inherited daemon selectors', async () => {
  let launched: any;
  const launch = ((program: string, args: string[], options: any) => {
    const child = new EventEmitter() as any; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = undefined; child.exitCode = null; child.signalCode = null;
    launched = { program, args, options };
    queueMicrotask(() => { child.stdout.write(Buffer.alloc(512, 'a')); child.stderr.write(Buffer.alloc(4 * 1024 * 1024, 'b')); child.emit('close', 0); });
    return child;
  }) as typeof spawn;
  const command = createSandboxDockerCommand(launch);
  const result = await command(['context', 'show'], { maxBytes: 1024 });
  assert.equal(result.overflow, true); assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 1024);
  assert.equal(launched.program, 'docker'); assert.equal(launched.options.shell, false); assert.equal(launched.options.windowsHide, true);
  for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) assert.equal(launched.options.env[name], undefined);
  const abort = new AbortController(); abort.abort(); launched = undefined;
  assert.equal((await command([], { signal: abort.signal })).aborted, true); assert.equal(launched, undefined);
  assert.equal(MANAGED_SANDBOX_IMAGE, 'python:3.12-slim'); assert.equal(MANAGED_SANDBOX_LIMITS.outputBytes, 131072);
});

test('native provider bridge reaches real plugin handlers through ToolExecutor in full and workspace modes', async () => {
  for (const mode of ['full', 'workspace'] as const) {
    const docker = new FakeDocker(); const plugin = createManagedSandboxPlugin(docker.command); const registry = new PluginCommandRegistry();
    await plugin.activate!({ storage: { get: () => OWNER, set: () => {} }, registerCommand: (name: string, handler: any, options: any) => registry.register('managed-sandbox', name, handler, options) } as any);
    let confirmations = 0, nativeCalls = 0;
    const executor = new ToolExecutor({ computer: {} as any, safety: () => ({ mode } as any),
      pluginToolDestructive: name => registry.get(name)?.destructive ?? true,
      runPluginTool: async (name, input, context) => registry.get(name)!.handler(input, context),
    });
    const provider: AiProvider = {
      id: 'synthetic-codex', type: 'codex-cli', label: 'Synthetic native', model: 'synthetic-model', baseUrl: '', supportsTools: false,
      supportedReasoning: ['auto', 'low', 'high'], models: async () => ['synthetic-model'], ping: async () => ({ ok: true }),
      chat: async () => { throw new Error('Unexpected text-only path'); },
      runAgent: async (request: NativeAgentRequest) => {
        nativeCalls++;
        const bridge = request.hostTools!;
        assert.ok(bridge.tools.some(tool => tool.name === 'sandbox_exec'));
        assert.equal(bridge.authorize!('sandbox_exec', mode), true);
        assert.equal(bridge.authorize!('sandbox_exec', 'read-only'), false);
        assert.equal(bridge.timeoutMs!('sandbox_exec'), 150000);
        for (const [name, input] of [['sandbox_status', {}], ['sandbox_prepare', {}], ['sandbox_exec', { command: 'printf synthetic' }], ['sandbox_stop', {}]] as const) {
          const result = await bridge.execute(name, input, request.signal!);
          assert.equal(result.success, true, `${mode}:${name}:${JSON.stringify(result.contentItems)}`);
        }
        assert.equal(docker.containers.size, 0);
        return { text: 'synthetic done', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } };
      },
    };
    const providers = { default: () => provider, resolve: () => provider, costTier: () => 0, toolCapable: () => undefined };
    const loop = new AgentLoop(providers as any, executor);
    try {
      await loop.run([], 'Use the Docker sandbox to run a Python calculation in an isolated container.', { confirm: async () => { confirmations++; return true; } }, registry.aiTools('Docker sandbox'),
        { workspacePath: tmpdir(), cacheKey: 'synthetic-native-conversation', permissionMode: mode, routing: null, tokenPolicy: 'audit-only' });
      assert.equal(nativeCalls, 1); assert.equal(confirmations, mode === 'workspace' ? 3 : 0);
      assert.equal(docker.count('create'), 1); assert.equal(docker.count('exec'), 1); assert.equal(docker.count('rm'), 1);
    } finally { await plugin.deactivate!({} as any); }
  }
});

test('native read-only bridge exposes status only and declined workspace approval creates no container', async () => {
  for (const mode of ['read-only', 'workspace'] as const) {
    const docker = new FakeDocker(); const plugin = createManagedSandboxPlugin(docker.command); const registry = new PluginCommandRegistry();
    await plugin.activate!({ storage: { get: () => OWNER, set: () => {} }, registerCommand: (name: string, handler: any, options: any) => registry.register('managed-sandbox', name, handler, options) } as any);
    const executor = new ToolExecutor({ computer: {} as any, safety: () => ({ mode } as any),
      pluginToolDestructive: name => registry.get(name)?.destructive ?? true,
      runPluginTool: async (name, input, context) => registry.get(name)!.handler(input, context),
    });
    const provider = { id: 'synthetic-codex', type: 'codex-cli', label: 'Synthetic native', model: 'synthetic-model', baseUrl: '', supportsTools: false,
      supportedReasoning: ['auto', 'low'], models: async () => [], ping: async () => ({ ok: true }),
      chat: async () => { throw new Error('Unexpected text-only path'); },
      runAgent: async (request: NativeAgentRequest) => {
        const bridge = request.hostTools!;
        const sandboxTools = bridge.tools.filter(tool => tool.name.startsWith('sandbox_'));
        if (mode === 'read-only') assert.deepEqual(sandboxTools.map(tool => tool.name), ['sandbox_status']);
        else {
          const result = await bridge.execute('sandbox_prepare', {}, request.signal!);
          assert.equal(result.success, false); assert.match(JSON.stringify(result.contentItems), /cancelled/);
        }
        return { text: 'synthetic done', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } };
      },
    } as AiProvider;
    try {
      await new AgentLoop({ default: () => provider, resolve: () => provider, costTier: () => 0 } as any, executor).run([], 'Check the Docker sandbox environment.', { confirm: async () => false }, registry.aiTools('Docker'),
        { workspacePath: tmpdir(), cacheKey: 'synthetic-native-conversation', permissionMode: mode, routing: null, tokenPolicy: 'audit-only' });
      assert.equal(docker.count('create'), 0);
    } finally { await plugin.deactivate!({} as any); }
  }
});
