import { getEventListeners } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const dist = resolve(here, '..', 'dist');
const scratch = mkdtempSync(join(tmpdir(), 'mr-robot-plugin-security-'));
const { ToolExecutor } = await import(pathToFileURL(join(dist, 'ai', 'executor.js')).href);
const { createDockerPlugin, confineDockerWorkspacePaths, revalidateDockerWorkspacePaths } = await import(pathToFileURL(join(dist, 'plugins', 'docker.js')).href);
const { runOrcaCommand } = await import(pathToFileURL(join(dist, 'plugins', 'orca.js')).href);

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name} ${detail}`);
  }
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return predicate();
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

console.log('1. plugin execution context is host-scoped and cancellable');
{
  const workspace = join(scratch, 'context-workspace');
  mkdirSync(workspace, { recursive: true });
  const controller = new AbortController();
  let observed;
  let confirmations = 0;
  const executor = new ToolExecutor({
    computer: {},
    safety: () => ({ mode: 'workspace', maxReadBytes: 64, maxShellBytes: 64, allowedRoots: [workspace] }),
    pluginToolDestructive: () => true,
    runPluginTool: async (_name, _params, execution) => {
      observed = execution;
      await new Promise((resolveRun, rejectRun) => {
        const abort = () => rejectRun(execution.signal?.reason ?? new Error('aborted'));
        if (execution.signal?.aborted) abort();
        else execution.signal?.addEventListener('abort', abort, { once: true });
      });
      return { unreachable: true };
    },
  });
  const pending = executor.execute(
    'docker.ctf.run',
    { challengePath: 'model-controlled-value' },
    async () => { confirmations++; return true; },
    'workspace',
    controller.signal,
    { workspaceRoot: workspace, approvedPluginTools: new Set(['docker.ctf.run']) },
  );
  await Promise.resolve();
  controller.abort(new Error('test cancellation'));
  let cancellation = '';
  try { await pending; } catch (error) { cancellation = error instanceof Error ? error.message : String(error); }
  check('aggregate approval remains workspace-scoped rather than full', observed?.permissionMode === 'workspace' && observed?.workspaceRoot === workspace);
  check('capability covers only the preapproved tool without a second prompt', confirmations === 0 && observed?.destructiveApproved === true && observed?.approvalSource === 'run-capability');
  check('the exact chat AbortSignal reaches the plugin handler', observed?.signal === controller.signal && /test cancellation/.test(cancellation), cancellation);
}

console.log('2. Docker mounts remain under the trusted workspace realpath');
{
  const workspace = join(scratch, 'docker-workspace');
  const challenge = join(workspace, 'challenge');
  const outside = join(scratch, 'outside');
  mkdirSync(challenge, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(challenge, 'flag.bin'), 'challenge');

  const confined = confineDockerWorkspacePaths(workspace, 'challenge');
  check('relative challenge and default output resolve inside workspace', relative(workspace, confined.challengePath) === 'challenge' && !relative(workspace, confined.outputPath).startsWith('..'));

  let outsideChallengeRejected = false;
  let outsideOutputRejected = false;
  let writableAncestorRejected = false;
  try { confineDockerWorkspacePaths(workspace, outside); } catch { outsideChallengeRejected = true; }
  try { confineDockerWorkspacePaths(workspace, challenge, outside); } catch { outsideOutputRejected = true; }
  try { confineDockerWorkspacePaths(workspace, challenge, workspace); } catch { writableAncestorRejected = true; }
  check('absolute challenge/output escape attempts are rejected', outsideChallengeRejected && outsideOutputRejected);
  check('writable output cannot remount the whole challenge', writableAncestorRejected);

  const junction = join(workspace, 'junction-escape');
  let junctionSupported = true;
  let junctionRejected = false;
  try {
    symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
    try { confineDockerWorkspacePaths(workspace, junction); } catch { junctionRejected = true; }
  } catch {
    junctionSupported = false;
  }
  check('symlink/junction traversal is rejected', !junctionSupported || junctionRejected, junctionSupported ? '' : '(link creation unavailable)');

  const movedOutput = `${confined.outputPath}.original`;
  renameSync(confined.outputPath, movedOutput);
  mkdirSync(confined.outputPath);
  let replacementRejected = false;
  try { revalidateDockerWorkspacePaths(confined); } catch { replacementRejected = true; }
  check('same-path replacement is caught by pre-run inode revalidation', replacementRejected);
  check('Docker plugin and toolbox release line is 0.3.3', createDockerPlugin().manifest.version === '0.3.3');
}

console.log('3. Orca cancellation reaps its subprocess tree');
{
  const marker = join(scratch, 'pre-abort-marker');
  const preAborted = new AbortController();
  preAborted.abort(new Error('already cancelled'));
  let preAbortRejected = false;
  try {
    await runOrcaCommand(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`], 5000, preAborted.signal);
  } catch { preAbortRejected = true; }
  await wait(50);
  check('pre-aborted execution never spawns Orca', preAbortRejected && !existsSync(marker));

  const grandchildPidFile = join(scratch, 'orca-grandchild.pid');
  const childProgram = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "writeFileSync(process.argv[1], String(grandchild.pid));",
    "setInterval(() => {}, 1000);",
  ].join(' ');
  const runningController = new AbortController();
  const started = Date.now();
  const running = runOrcaCommand(process.execPath, ['-e', childProgram, grandchildPidFile], 20_000, runningController.signal);
  const pidWritten = await waitFor(() => existsSync(grandchildPidFile));
  const grandchildPid = pidWritten ? Number(readFileSync(grandchildPidFile, 'utf8')) : 0;
  runningController.abort(new Error('cancel delegated work'));
  let cancelled = false;
  try { await running; } catch (error) { cancelled = /cancel delegated work/.test(error instanceof Error ? error.message : String(error)); }
  const grandchildExited = grandchildPid > 0 ? await waitFor(() => !processAlive(grandchildPid)) : false;
  check('abort rejects promptly after reaping the CLI', pidWritten && cancelled && Date.now() - started < 5000);
  check('abort terminates the CLI process tree, including grandchildren', grandchildExited, String(grandchildPid));
  check('abort listener is removed after settlement', getEventListeners(runningController.signal, 'abort').length === 0);

  const timeoutStarted = Date.now();
  let timedOut = false;
  try { await runOrcaCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 100); } catch (error) {
    timedOut = /100ms/.test(error instanceof Error ? error.message : String(error));
  }
  check('timeout uses the same tree-termination and reap path', timedOut && Date.now() - timeoutStarted < 5000);
}

rmSync(scratch, { recursive: true, force: true });
console.log(failures === 0 ? '\nPLUGIN EXECUTION SECURITY TESTS PASSED' : `\n${failures} PLUGIN EXECUTION SECURITY FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
