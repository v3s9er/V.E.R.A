// Explicitly opted-in integration test. Never starts Docker, pulls an image,
// mounts a host directory, or adopts/prunes an existing container.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PluginCommandRegistry, type PluginExecutionContext } from '../src/plugins/commands.js';
import type { PluginContext } from '../src/plugins/context.js';
import {
  createManagedSandboxPlugin, createSandboxDockerCommand,
  MANAGED_SANDBOX_LIMITS, type ManagedSandboxStatus, type SandboxDockerCommand,
} from '../src/plugins/managed-sandbox.js';

const enabled = process.env.VERA_TEST_MANAGED_SANDBOX_LIVE === '1';
const python = (source: string) => `python -I -B -c '${source.replaceAll("'", "'\\''")}'`;

test('installed Docker plugin: isolation, reuse, bounds, watchdog and exact cleanup', {
  skip: enabled ? false : 'Set VERA_TEST_MANAGED_SANDBOX_LIVE=1 after preparing a local Linux engine and existing python:3.12-slim image.',
  timeout: 180_000,
}, async (t) => {
  const owner = randomUUID();
  const workspace = await mkdtemp(join(tmpdir(), 'vera-sandbox-acceptance-'));
  const registry = new PluginCommandRegistry();
  const transport = createSandboxDockerCommand();
  const created = new Set<string>();
  let endpoint: string | undefined;
  let verifyCleanup = false;
  let onUserExec: (() => void) | undefined;
  const command: SandboxDockerCommand = async (args, options) => {
    if (args[0] === '--host') endpoint = args[1];
    const operation = args[0] === '--host' ? args.slice(2) : args;
    if (operation[0] === 'exec' && operation.includes('/usr/bin/env')) onUserExec?.();
    const result = await transport(args, options);
    if (operation[0] === 'container' && operation[1] === 'create' && result.code === 0) {
      assert.match(result.stdout.trim(), /^[a-f0-9]{64}$/);
      created.add(result.stdout.trim());
    }
    return result;
  };
  const plugin = createManagedSandboxPlugin(command);
  const partialContext: Pick<PluginContext, 'storage' | 'registerCommand'> = {
    storage: { get: <T>() => owner as T, set: () => assert.fail('The test owner must not be persisted.') },
    registerCommand: (name, handler, options) => registry.register('managed-sandbox', name, handler, options),
  };
  const context = partialContext as PluginContext;
  const execution = (scope: string, signal?: AbortSignal): PluginExecutionContext => ({
    scopeKey: `${owner}:${scope}`, workspaceRoot: workspace, permissionMode: 'full',
    destructiveApproved: true, approvalSource: 'prompt', signal,
  });
  const call = async (name: string, params: unknown = {}, scope = 'A', signal?: AbortSignal): Promise<any> =>
    registry.get(`sandbox.${name}`)!.handler(params, execution(scope, signal));
  const owned = async (): Promise<string[]> => {
    assert.ok(endpoint, 'A verified local engine endpoint is required.');
    const result = await transport(['--host', endpoint, 'container', 'ls', '--all', '--no-trunc',
      '--filter', `label=io.vera.managed-sandbox.owner=${owner}`, '--format', '{{.ID}}']);
    assert.equal(result.code, 0, 'The engine must confirm the remaining owned containers.');
    return result.stdout.trim().split(/\s+/).filter(Boolean);
  };
  const run = async (source: string, scope = 'A', timeoutSec = 10) => {
    const result = await call('exec', { command: python(source), timeoutSec }, scope);
    assert.equal(result.ok, true, `The harmless ${scope} fixture must complete.`);
    assert.equal(result.backgroundProcesses, false);
    return result.stdout.trim();
  };
  let activated = false;
  try {
    await plugin.activate!(context); activated = true;
    const status = await call('status') as ManagedSandboxStatus;
    assert.equal(status.state, 'unprepared', status.reason ?? 'An existing ready engine/image is required.');
    assert.ok(status.daemon && status.linux && status.resourceLimits && status.imageReady);
    assert.deepEqual(await owned(), []);
    verifyCleanup = true;
    assert.equal((await call('prepare')).reused, false);
    assert.equal((await call('prepare')).reused, true);
    assert.equal((await call('prepare', {}, 'B')).reused, false);
    assert.equal((await owned()).length, 2);
    assert.equal(await run('from pathlib import Path\nPath("fixture.txt").write_text("retained")\nprint("written")'), 'written');
    assert.equal(await run('from pathlib import Path\nprint(Path("fixture.txt").read_text())'), 'retained');
    assert.equal(await run('from pathlib import Path\nprint(Path("fixture.txt").exists())', 'B'), 'False');
    assert.equal(await run(`import os,socket
from pathlib import Path
assert os.getuid()==65534 and os.getgid()==65534
assert os.getcwd()=="/work"
assert not Path("/var/run/docker.sock").exists()
assert not os.access("/guard/deadline",os.R_OK) and not os.access("/guard",os.W_OK)
status=dict(line.split(":",1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
assert int(status["CapEff"].strip(),16)==0
assert status["NoNewPrivs"].strip()=="1" and status["Seccomp"].strip()=="2"
mounts=[line.split() for line in Path("/proc/mounts").read_text().splitlines()]
assert any(m[1]=="/" and "ro" in m[3].split(",") for m in mounts)
assert any(m[1]=="/work" and {"noexec","nosuid","nodev"}<=set(m[3].split(",")) for m in mounts)
assert not {"HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","DOCKER_HOST","DOCKER_CONTEXT"}&set(os.environ)
cg=Path("/sys/fs/cgroup")
if (cg/"cgroup.controllers").exists():
 assert (cg/"memory.max").read_text().strip()=="536870912"
 assert (cg/"pids.max").read_text().strip()=="64"
 quota,period=map(int,(cg/"cpu.max").read_text().split())
else:
 assert (cg/"memory/memory.limit_in_bytes").read_text().strip()=="536870912"
 assert (cg/"pids/pids.max").read_text().strip()=="64"
 quota=int((cg/"cpu/cpu.cfs_quota_us").read_text())
 period=int((cg/"cpu/cpu.cfs_period_us").read_text())
assert quota==period
with socket.socket() as sock:
 sock.settimeout(0.25)
 try:
  sock.connect(("192.0.2.1",443))
 except OSError:
  pass
 else:
  raise AssertionError("External network is unexpectedly reachable")
print("isolated")`), 'isolated');
    t.diagnostic('Actual container UID, capabilities, seccomp, read-only root, tmpfs, cgroup quotas and scope isolation passed.');

    const timed = await call('exec', { command: python('import time\ntime.sleep(10)'), timeoutSec: 1 });
    assert.equal(timed.ok, false);
    assert.equal(timed.workspaceDiscarded, true);
    assert.equal(timed.cleanupPending, false);
    assert.equal((await owned()).length, 1);
    assert.equal(await run('print("other-scope-alive")', 'B'), 'other-scope-alive');

    await call('prepare');
    const overflow = await call('exec', { command: python('print("x"*200000)'), timeoutSec: 10 });
    assert.equal(overflow.ok, false);
    assert.equal(overflow.outputTruncated, true);
    assert.equal(overflow.workspaceDiscarded, true);
    assert.ok(Buffer.byteLength(overflow.stdout) + Buffer.byteLength(overflow.stderr) <= MANAGED_SANDBOX_LIMITS.outputBytes);
    assert.equal((await owned()).length, 1);

    await call('prepare');
    const cancellation = new AbortController();
    onUserExec = () => { onUserExec = undefined; setTimeout(() => cancellation.abort(), 250).unref(); };
    const cancelled = await call('exec', { command: python('import time\ntime.sleep(10)'), timeoutSec: 10 }, 'A', cancellation.signal);
    assert.equal(cancelled.aborted, true);
    assert.equal(cancelled.workspaceDiscarded, true);
    assert.equal((await owned()).length, 1);

    await call('prepare');
    const background = await call('exec', {
      command: python('import subprocess\nsubprocess.Popen(["python","-I","-B","-c","import time; time.sleep(30)"],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)\nprint("spawned")'), timeoutSec: 2,
    });
    assert.equal(background.ok, true);
    assert.equal(background.backgroundProcesses, true);
    // No execution/discard requests after this command: the container's actual
    // PID1 watchdog, not a host-side test timer, must enforce this deadline.
    const deadline = Date.now() + 8_000;
    while ((await owned()).length > 1 && Date.now() < deadline) await delay(100);
    assert.equal((await owned()).length, 1, 'The independent watchdog must remove the background scope.');
    assert.equal(await run('print("other-scope-still-alive")', 'B'), 'other-scope-still-alive');
    assert.equal((await call('stop', {}, 'B')).workspaceDiscarded, true);
    assert.equal((await call('remove', {}, 'B')).removed, false);
    assert.deepEqual(await owned(), []);
    t.diagnostic('Timeout, output overflow, cancellation, independent watchdog and exact scoped cleanup passed.');
  } finally {
    onUserExec = undefined;
    try { if (activated) await plugin.deactivate!(context); }
    finally {
      // Only this fixture's mkdtemp directory is removed. No user workspace is
      // mounted, copied, enumerated or deleted, and no daemon-wide prune exists.
      await rm(workspace, { recursive: true, force: true });
      if (verifyCleanup) {
        const leftovers = await owned();
        assert.deepEqual(leftovers, [], `Cleanup must be independently verified for ${created.size} fixture-owned containers.`);
      }
    }
  }
});
