import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const dist = resolve(here, '..', 'dist');
const scratch = mkdtempSync(join(tmpdir(), 'mr-robot-plugin-security-'));
const { ToolExecutor } = await import(pathToFileURL(join(dist, 'ai', 'executor.js')).href);
const { createDockerPlugin, confineDockerWorkspacePaths, revalidateDockerWorkspacePaths } = await import(pathToFileURL(join(dist, 'plugins', 'docker.js')).href);

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name} ${detail}`);
  }
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
  const outputStat = statSync(confined.outputPath, { bigint: true });
  check('file identity preserves the exact 64-bit ID and creation timestamp',
    confined.outputIdentity.ino === outputStat.ino.toString()
    && confined.outputIdentity.dev === outputStat.dev.toString()
    && confined.outputIdentity.birthtimeNs === outputStat.birthtimeNs.toString());
  let unchangedAccepted = true;
  try { revalidateDockerWorkspacePaths(confined); } catch { unchangedAccepted = false; }
  check('unchanged file identity remains usable', unchangedAccepted);
  const forged = { ...confined, outputIdentity: { ...confined.outputIdentity, ino: (outputStat.ino + 1n).toString() } };
  let nearbyIdentityRejected = false;
  try { revalidateDockerWorkspacePaths(forged); } catch { nearbyIdentityRejected = true; }
  check('adjacent file IDs never compare equal through floating-point rounding', nearbyIdentityRejected);
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
  check('Docker plugin release line is 0.3.7', createDockerPlugin().manifest.version === '0.3.7');
}

rmSync(scratch, { recursive: true, force: true });
console.log(failures === 0 ? '\nPLUGIN EXECUTION SECURITY TESTS PASSED' : `\n${failures} PLUGIN EXECUTION SECURITY FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
