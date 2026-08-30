import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { terminateProcessTree } from '../computer/shell.js';
import type { PluginExecutionContext } from './commands.js';
import type { MrRobotPlugin } from './loader.js';

const IMAGE = 'mr-robot/ctf-toolbox:0.3.0';
const DOCKERFILE = `FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update && apt-get install -y --no-install-recommends \\
  python3 python3-pip python3-venv git curl wget ca-certificates file jq unzip p7zip-full \\
  build-essential gdb gdbserver binutils patchelf strace ltrace radare2 \\
  netcat-openbsd nmap socat openssh-client dnsutils iproute2 \\
  binwalk foremost exiftool steghide pngcheck imagemagick \\
  tshark tcpdump john hashcat sqlite3 libssl-dev libffi-dev \\
  && rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages --no-cache-dir \\
  pwntools capstone unicorn ropper z3-solver angr sympy pycryptodome \\
  requests beautifulsoup4 lxml scapy ipython
RUN if id ubuntu >/dev/null 2>&1; then usermod -l analyst -d /home/analyst -m ubuntu; else useradd --create-home --uid 1000 analyst; fi
WORKDIR /work
USER analyst
CMD ["bash"]
`;

interface ContainerLifecycle {
  name: string;
  cidFile: string;
}

interface DockerResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
  timedOut?: boolean;
  aborted?: boolean;
}

interface PathIdentity {
  dev: number;
  ino: number;
}

export interface ConfinedDockerPaths {
  workspaceRoot: string;
  challengePath: string;
  outputPath: string;
  challengeIdentity: PathIdentity;
  outputIdentity: PathIdentity;
}

function safeUnlink(path: string): void {
  try { unlinkSync(path); } catch { /* already absent */ }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref?.();
  });
}

function removeContainerOnce(container: ContainerLifecycle): Promise<void> {
  let target = container.name;
  try {
    const cid = readFileSync(container.cidFile, 'utf8').trim();
    if (/^[a-f0-9]{12,64}$/i.test(cid)) target = cid;
  } catch {
    // The CLI may have been cancelled before Docker wrote the cidfile. The
    // unique reserved name remains a safe cleanup target.
  }
  return new Promise((resolveCleanup) => {
    const cleanup = spawn('docker', ['rm', '-f', target], {
      shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore',
    });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolveCleanup();
    };
    cleanup.once('error', finish);
    cleanup.once('close', finish);
    timer = setTimeout(() => {
      terminateProcessTree(cleanup, true);
      forceTimer = setTimeout(() => terminateProcessTree(cleanup, true, true), 1_000);
      forceTimer.unref?.();
    }, 4_000);
    timer.unref?.();
  });
}

async function removeContainer(container: ContainerLifecycle): Promise<void> {
  // A killed Docker CLI can race with daemon-side container registration.
  // Retrying the unique name/cid catches a container that appeared just after
  // the first rm request without ever targeting an unrelated container.
  for (const delayMs of [0, 250, 750]) {
    if (delayMs) await delay(delayMs);
    await removeContainerOnce(container);
  }
}

function run(
  args: string[],
  cwd?: string,
  timeoutMs = 30 * 60_000,
  signal?: AbortSignal,
  container?: ContainerLifecycle,
): Promise<DockerResult> {
  signal?.throwIfAborted();
  return new Promise((resolvePromise) => {
    const child = spawn('docker', args, {
      cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (chunk: Buffer) => { if (output.length < 2_000_000) output += chunk.toString(); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    let settled = false;
    let stopping = false;
    let timedOut = false;
    let aborted = false;
    let markClosed!: () => void;
    const closed = new Promise<void>((resolveClosed) => { markClosed = resolveClosed; });
    let timer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      if (container) safeUnlink(container.cidFile);
      resolvePromise({ ok: exitCode === 0 && !timedOut && !aborted, exitCode, output: output.trim().slice(-500_000), timedOut, aborted });
    };
    const stop = (reason: 'abort' | 'timeout'): void => {
      if (stopping || settled) return;
      stopping = true;
      aborted = reason === 'abort';
      timedOut = reason === 'timeout';
      terminateProcessTree(child, true);
      forceTimer = setTimeout(() => terminateProcessTree(child, true, true), 2_000);
      forceTimer.unref?.();
      const cleanup = container ? removeContainer(container) : Promise.resolve();
      void Promise.allSettled([
        cleanup,
        Promise.race([closed, delay(5_000)]),
      ]).then(() => finish(null));
    };
    const abort = (): void => stop('abort');
    child.once('error', (error) => {
      output += error.message;
      markClosed();
      if (!stopping) finish(null);
    });
    child.once('close', (exitCode) => {
      markClosed();
      if (!stopping) finish(exitCode);
    });
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    timer.unref?.();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function assertWithin(root: string, target: string, label: string): void {
  if (!isWithin(root, target)) throw new Error(`${label}는 선택한 작업 폴더 안에 있어야 합니다.`);
}

function assertNoRedirectingComponents(root: string, target: string, label: string): void {
  assertWithin(root, target, label);
  const rel = relative(root, target);
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) throw new Error(`${label}에 symlink 또는 junction을 사용할 수 없습니다.`);
    assertWithin(root, realpathSync(current), label);
  }
}

function workspaceRealpath(workspaceRoot: string): string {
  const requested = workspaceRoot.trim();
  if (!requested) throw new Error('선택된 작업 폴더가 없어 Docker CTF 도구를 실행할 수 없습니다.');
  const root = resolve(requested);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error('선택된 작업 폴더를 찾을 수 없습니다.');
  return realpathSync(root);
}

function existingConfinedPath(root: string, candidate: string, label: string): string {
  assertNoRedirectingComponents(root, candidate, label);
  if (!existsSync(candidate)) throw new Error(`${label}를 찾을 수 없습니다.`);
  const kind = lstatSync(candidate);
  if (kind.isSymbolicLink()) throw new Error(`${label}에 symlink 또는 junction을 사용할 수 없습니다.`);
  if (!kind.isDirectory() && !kind.isFile()) throw new Error(`${label}는 파일 또는 폴더여야 합니다.`);
  const canonical = realpathSync(candidate);
  assertWithin(root, canonical, label);
  return canonical;
}

function identity(path: string): PathIdentity {
  const value = statSync(path);
  return { dev: value.dev, ino: value.ino };
}

function samePath(left: string, right: string): boolean {
  return relative(left, right) === '' && relative(right, left) === '';
}

function assertOutputDoesNotExposeChallenge(challenge: string, output: string): void {
  if (isWithin(output, challenge)) {
    throw new Error('outputPath는 challengePath 자체나 그 상위 폴더일 수 없습니다. challenge를 writable mount로 다시 노출할 수 있습니다.');
  }
}

/** Resolve and create only host paths confined to the selected trusted workspace. */
export function confineDockerWorkspacePaths(workspaceRoot: string, challengeInput: string, outputInput?: string): ConfinedDockerPaths {
  const root = workspaceRealpath(workspaceRoot);
  const challengeValue = challengeInput.trim();
  if (!challengeValue) throw new Error('challengePath가 필요합니다.');
  const challengeCandidate = resolve(isAbsolute(challengeValue) ? challengeValue : join(root, challengeValue));
  const challenge = existingConfinedPath(root, challengeCandidate, 'challengePath');

  const defaultOutput = join(lstatSync(challenge).isDirectory() ? challenge : dirname(challenge), '.mr-robot-output');
  const outputValue = outputInput?.trim();
  const outputCandidate = resolve(outputValue ? (isAbsolute(outputValue) ? outputValue : join(root, outputValue)) : defaultOutput);
  assertNoRedirectingComponents(root, outputCandidate, 'outputPath');
  mkdirSync(outputCandidate, { recursive: true });
  assertNoRedirectingComponents(root, outputCandidate, 'outputPath');
  if (!lstatSync(outputCandidate).isDirectory()) throw new Error('outputPath는 폴더여야 합니다.');
  const output = realpathSync(outputCandidate);
  assertWithin(root, output, 'outputPath');
  assertOutputDoesNotExposeChallenge(challenge, output);
  return {
    workspaceRoot: root,
    challengePath: challenge,
    outputPath: output,
    challengeIdentity: identity(challenge),
    outputIdentity: identity(output),
  };
}

export function revalidateDockerWorkspacePaths(paths: ConfinedDockerPaths): void {
  const root = workspaceRealpath(paths.workspaceRoot);
  if (!samePath(root, paths.workspaceRoot)) throw new Error('Docker 실행 전에 작업 폴더 대상이 변경되었습니다.');
  const challenge = existingConfinedPath(root, paths.challengePath, 'challengePath');
  const output = existingConfinedPath(root, paths.outputPath, 'outputPath');
  if (!lstatSync(output).isDirectory()) throw new Error('outputPath는 폴더여야 합니다.');
  const challengeIdentity = identity(challenge);
  const outputIdentity = identity(output);
  if (!samePath(challenge, paths.challengePath)
    || challengeIdentity.dev !== paths.challengeIdentity.dev || challengeIdentity.ino !== paths.challengeIdentity.ino) {
    throw new Error('Docker 실행 전에 challengePath 대상이 변경되었습니다.');
  }
  if (!samePath(output, paths.outputPath)
    || outputIdentity.dev !== paths.outputIdentity.dev || outputIdentity.ino !== paths.outputIdentity.ino) {
    throw new Error('Docker 실행 전에 outputPath 대상이 변경되었습니다.');
  }
  assertOutputDoesNotExposeChallenge(challenge, output);
}

function imageDir(): string {
  const dir = join(homedir(), '.mr-robot', 'docker', 'ctf-toolbox');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'Dockerfile');
  if (!existsSync(file) || readFileSync(file, 'utf8') !== DOCKERFILE) writeFileSync(file, DOCKERFILE, 'utf8');
  return dir;
}

export function createDockerPlugin(): MrRobotPlugin {
  return {
    manifest: {
      id: 'docker-sandbox', name: 'Docker Sandbox', version: '0.3.0', kind: 'tool', enabledByDefault: true,
      description: 'CTF와 위험한 분석 명령을 호스트와 격리된 제한 컨테이너에서 실행합니다.',
      capabilities: ['container.health', 'container.image.build', 'container.ctf.exec'],
      permissions: ['container.execute', 'process.execute', 'filesystem.read', 'filesystem.write'],
      dependencies: [{ id: 'docker', name: 'Docker Desktop', required: true }],
    },
    activate(ctx) {
      ctx.registerCommand('docker.status', async (_raw, execution) => {
        const version = await run(['version', '--format', '{{json .}}'], undefined, 15_000, execution?.signal);
        const image = version.ok ? await run(['image', 'inspect', IMAGE], undefined, 15_000, execution?.signal) : { ok: false, output: '', exitCode: null };
        return { installed: !/ENOENT|not found/i.test(version.output), daemon: version.ok, image: image.ok, imageName: IMAGE, error: version.ok ? undefined : version.output };
      }, { destructive: false });
      ctx.registerCommand('docker.ctf.image.ensure', async (_raw, execution) => {
        const inspect = await run(['image', 'inspect', IMAGE], undefined, 15_000, execution?.signal);
        if (inspect.ok) return { ok: true, created: false, image: IMAGE };
        const dir = imageDir();
        const built = await run(['build', '--pull', '--tag', IMAGE, dir], dir, 45 * 60_000, execution?.signal);
        if (!built.ok) throw new Error(`CTF 이미지 빌드 실패: ${built.output}`);
        return { ok: true, created: true, image: IMAGE, output: built.output.slice(-5000) };
      }, { destructive: true, adminOnly: true });
      ctx.registerCommand('docker.ctf.run', async (raw, execution?: PluginExecutionContext) => {
        const body = (raw ?? {}) as { challengePath?: string; command?: string; outputPath?: string; network?: boolean; ptrace?: boolean; timeoutSec?: number };
        if (!execution?.destructiveApproved || execution.permissionMode === 'read-only') throw new Error('Docker CTF 실행 승인이 필요합니다.');
        if (!execution.workspaceRoot) throw new Error('선택된 작업 폴더가 없어 Docker CTF 도구를 실행할 수 없습니다.');
        if (execution.approvalSource === 'run-capability' && (body.network === true || body.ptrace === true)) {
          throw new Error('network 또는 ptrace 활성화는 이 호출에 대한 개별 승인이 필요합니다.');
        }
        const paths = confineDockerWorkspacePaths(execution.workspaceRoot, String(body.challengePath ?? ''), body.outputPath === undefined ? undefined : String(body.outputPath));
        const inspect = await run(['image', 'inspect', IMAGE], undefined, 15_000, execution.signal);
        if (!inspect.ok) throw new Error('CTF 도구 이미지를 먼저 준비하세요. docker.ctf.image.ensure를 실행하면 됩니다.');
        execution.signal?.throwIfAborted();
        revalidateDockerWorkspacePaths(paths);
        const runId = randomUUID().replace(/-/g, '');
        const container = {
          name: `mr-robot-ctf-${process.pid}-${runId}`,
          cidFile: join(tmpdir(), `mr-robot-ctf-${process.pid}-${runId}.cid`),
        };
        const args = [
          'run', '--rm', '--name', container.name, '--cidfile', container.cidFile,
          '--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
          '--memory=4g', '--cpus=2', '--pids-limit=512', '--tmpfs', '/tmp:rw,noexec,nosuid,size=1g',
          '--network', body.network === true ? 'bridge' : 'none',
          '--mount', `type=bind,src=${paths.challengePath},dst=/challenge,readonly`,
          '--mount', `type=bind,src=${paths.outputPath},dst=/work`,
          ...(body.ptrace === true ? ['--cap-add=SYS_PTRACE'] : []),
          IMAGE, 'bash', '-lc', String(body.command ?? 'find /challenge -maxdepth 2 -type f -printf "%p %s bytes\\n" | head -200'),
        ];
        const requestedTimeout = Number(body.timeoutSec);
        const timeoutSec = Number.isFinite(requestedTimeout) ? Math.max(5, Math.min(3600, requestedTimeout)) : 300;
        const result = await run(args, undefined, timeoutSec * 1000, execution.signal, container);
        execution.signal?.throwIfAborted();
        revalidateDockerWorkspacePaths(paths);
        return { ...result, image: IMAGE, outputPath: paths.outputPath, network: body.network === true };
      }, {
        tool: true, destructive: true, description: '승인된 CTF 파일을 격리 컨테이너에서 분석하거나 도구 명령을 실행합니다. 기본적으로 네트워크는 차단됩니다.',
        toolWhen: (message) => /ctf|워게임|드림핵|pwn|리버싱|포렌식|암호|web challenge|reverse engineering/i.test(message),
        parameters: { type: 'object', properties: {
          challengePath: { type: 'string' }, command: { type: 'string' }, outputPath: { type: 'string' },
          network: { type: 'boolean' }, ptrace: { type: 'boolean' }, timeoutSec: { type: 'number' },
        }, required: ['challengePath', 'command'] },
      });
    },
  };
}
