import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MrRobotPlugin } from './loader.js';

const IMAGE = 'mr-robot/ctf-toolbox:0.2.0';
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

function run(args: string[], cwd?: string, timeoutMs = 30 * 60_000): Promise<{ ok: boolean; exitCode: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn('docker', args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk: Buffer) => { if (output.length < 2_000_000) output += chunk.toString(); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolvePromise({ ok: exitCode === 0, exitCode, output: output.trim().slice(-500_000) });
    };
    child.once('error', (error) => { output += error.message; finish(null); });
    child.once('close', finish);
    const timer = setTimeout(() => { child.kill(); finish(null); }, timeoutMs);
  });
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
      id: 'docker-sandbox', name: 'Docker Sandbox', version: '0.2.0', kind: 'tool', enabledByDefault: true,
      description: 'CTF와 위험한 분석 명령을 호스트와 격리된 제한 컨테이너에서 실행합니다.',
      capabilities: ['container.health', 'container.image.build', 'container.ctf.exec'],
      permissions: ['container.execute', 'process.execute', 'filesystem.read', 'filesystem.write'],
      dependencies: [{ id: 'docker', name: 'Docker Desktop', required: true }],
    },
    activate(ctx) {
      ctx.registerCommand('docker.status', async () => {
        const version = await run(['version', '--format', '{{json .}}'], undefined, 15_000);
        const image = version.ok ? await run(['image', 'inspect', IMAGE], undefined, 15_000) : { ok: false, output: '', exitCode: null };
        return { installed: !/ENOENT|not found/i.test(version.output), daemon: version.ok, image: image.ok, imageName: IMAGE, error: version.ok ? undefined : version.output };
      }, { destructive: false });
      ctx.registerCommand('docker.ctf.image.ensure', async () => {
        const inspect = await run(['image', 'inspect', IMAGE], undefined, 15_000);
        if (inspect.ok) return { ok: true, created: false, image: IMAGE };
        const dir = imageDir();
        const built = await run(['build', '--pull', '--tag', IMAGE, dir], dir, 45 * 60_000);
        if (!built.ok) throw new Error(`CTF 이미지 빌드 실패: ${built.output}`);
        return { ok: true, created: true, image: IMAGE, output: built.output.slice(-5000) };
      }, { destructive: true, adminOnly: true });
      ctx.registerCommand('docker.ctf.run', async (raw) => {
        const body = (raw ?? {}) as { challengePath?: string; command?: string; outputPath?: string; network?: boolean; ptrace?: boolean; timeoutSec?: number };
        const challenge = resolve(String(body.challengePath ?? ''));
        if (!existsSync(challenge)) throw new Error('challengePath를 찾을 수 없습니다.');
        const output = resolve(body.outputPath ? String(body.outputPath) : join(challenge, '.mr-robot-output'));
        mkdirSync(output, { recursive: true });
        const inspect = await run(['image', 'inspect', IMAGE], undefined, 15_000);
        if (!inspect.ok) throw new Error('CTF 도구 이미지를 먼저 준비하세요. docker.ctf.image.ensure를 실행하면 됩니다.');
        const args = [
          'run', '--rm', '--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
          '--memory=4g', '--cpus=2', '--pids-limit=512', '--tmpfs', '/tmp:rw,noexec,nosuid,size=1g',
          '--network', body.network === true ? 'bridge' : 'none',
          '--mount', `type=bind,src=${challenge},dst=/challenge,readonly`,
          '--mount', `type=bind,src=${output},dst=/work`,
          ...(body.ptrace === true ? ['--cap-add=SYS_PTRACE'] : []),
          IMAGE, 'bash', '-lc', String(body.command ?? 'find /challenge -maxdepth 2 -type f -printf "%p %s bytes\\n" | head -200'),
        ];
        const result = await run(args, undefined, Math.max(5, Math.min(3600, body.timeoutSec ?? 300)) * 1000);
        return { ...result, image: IMAGE, outputPath: output, network: body.network === true };
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
