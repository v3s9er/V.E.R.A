import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const DISCORD_SANDBOX_IMAGE = 'python:3.12-slim';
export type SandboxFile = { id: string; name: string; data: Buffer };
export function attachmentWorkerSource(): string {
  const base = dirname(fileURLToPath(import.meta.url)).replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');
  const path = [join(base, 'integrations/discordbot/attachment_worker.py'), resolve(base, '../../../../integrations/discordbot/attachment_worker.py')].find(existsSync);
  if (!path) throw new Error('첨부 분석 구성 파일이 없습니다. 앱 설치를 복구하세요.');
  return readFileSync(path, 'utf8');
}
export function sandboxFilePath(file: { id: string; name: string }) {
  if (!/^[a-f0-9]{64}$/.test(file.id)) throw new Error('첨부 식별자가 올바르지 않습니다.');
  const suffix = /\.[a-z0-9]{1,10}$/i.exec(file.name)?.[0].toLowerCase() ?? '.bin';
  return `/work/attachments/${file.id}${suffix}`;
}
type Result = { code: number | null; output: string };
let wslDistribution = '';
/** Administrator-selected local engine only; never supplied by a Discord turn. */
export function configureDiscordSandboxEngine(distribution = '') {
  if (distribution && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(distribution)) throw new Error('WSL 배포판 이름이 올바르지 않습니다.');
  wslDistribution = distribution;
}
export type DockerCommand = (args: string[], input: string, signal?: AbortSignal, timeout?: number) => Promise<Result>;

/** Fixed arguments, no model-supplied daemon options, mounts or credentials. */
export const dockerCommand: DockerCommand = (args, input, signal, timeout = 20_000) => {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(wslDistribution ? 'wsl.exe' : 'docker', wslDistribution ? ['--distribution', wslDistribution, '--user', 'root', '--exec', 'docker', ...args] : args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', bytes = 0, done = false;
    const finish = (error?: Error, code: number | null = null) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { child.kill(); reject(error); } else resolve({ code, output });
    };
    const abort = () => finish(new Error('격리 실행이 중지되었습니다.'));
    const timer = setTimeout(() => finish(new Error('Docker 응답 시간이 초과되었습니다.')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(new Error('Docker를 사용할 수 없습니다. PC에서 Docker Desktop의 Linux 엔진을 켜 주세요. 로컬 실행으로 대체하지 않습니다.')));
    child.on('close', code => finish(undefined, code));
    const data = (decoder: StringDecoder) => (chunk: Buffer) => { bytes += chunk.length; if (bytes > 128 * 1024) finish(new Error('격리 출력 크기를 초과했습니다.')); else output += decoder.write(chunk); };
    child.stdout.on('data', data(new StringDecoder('utf8'))); child.stderr.on('data', data(new StringDecoder('utf8'))); child.stdin.on('error', () => {});
    child.stdin.end(input);
    if (signal?.aborted) abort();
  });
};

export function reusableSandboxArgs(name: string, image: string): string[] {
  return ['run', '--detach', '--rm', '--pull=never', '--name', name,
    '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    // Watchdog and user code have different unprivileged UIDs: model code
    // cannot stop/extend the watchdog after the host application crashes.
    '--user=65533:65533', '--pids-limit=32', '--memory=512m', '--memory-swap=512m', '--cpus=1', '--log-driver=none',
    '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m',
    '--tmpfs=/work:rw,noexec,nosuid,nodev,size=128m,uid=65534,gid=65534,mode=700', '--workdir=/work',
    ...['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy', 'no_proxy'].flatMap(key => ['--env', `${key}=`]),
    '--entrypoint=/bin/sleep', image, '900'];
}

type Session = { name: string; busy: boolean; created: number; idle?: NodeJS.Timeout; controller: AbortController; detach?: () => void };
/** Per-ticket, process-local reuse. Never adopt an existing container by name. */
export class DiscordSandboxPool {
  private sessions = new Map<string, Session>();
  private image?: Promise<string>;
  private closed = false;
  private shutdown = new AbortController();
  constructor(private command: DockerCommand = dockerCommand, private idleMs = 120_000, private documents = false) {}

  private prepare(): Promise<string> {
    if (!this.image) this.image = (async () => {
      const info = await this.command(['info', '--format', '{{.OSType}}'], '', this.shutdown.signal);
      if (info.code !== 0 || info.output.trim() !== 'linux') throw new Error('Docker Linux 엔진이 준비되지 않았습니다. PC에서 Docker Desktop을 켜 주세요. 검색·대화는 Docker 없이도 사용할 수 있습니다.');
      const worker = this.documents ? attachmentWorkerSource() : '';
      const imageName = this.documents ? `mrrobot-discord-documents:${createHash('sha256').update(worker + 'deps-v1').digest('hex').slice(0, 20)}` : DISCORD_SANDBOX_IMAGE;
      let inspect = await this.command(['image', 'inspect', imageName, '--format', '{{.Id}}'], '', this.shutdown.signal);
      if (inspect.code !== 0) {
        // Download only this host-defined base image, once; never accept image
        // names/installation commands from Discord users or model output.
        // Stdin-only Dockerfile: no host build context, user files or credentials.
        const dockerfile = `FROM python:3.12-slim-bookworm\nRUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-kor && rm -rf /var/lib/apt/lists/*\nRUN pip install --no-cache-dir pypdf==6.14.2 Pillow==12.2.0 xlrd==2.0.2 striprtf==0.0.32 olefile==0.47\nRUN python -c "import base64;open('/opt/attachment_worker.py','wb').write(base64.b64decode('${Buffer.from(worker).toString('base64')}'))"\nENV OMP_THREAD_LIMIT=1\n`;
        const pull = this.documents
          ? await this.command(['build', '--quiet', '--tag', imageName, '-'], dockerfile, this.shutdown.signal, 600_000)
          : await this.command(['pull', '--quiet', DISCORD_SANDBOX_IMAGE], '', this.shutdown.signal, 180_000);
        if (pull.code !== 0) throw new Error('격리 기본 이미지를 준비하지 못했습니다. Docker 연결을 확인하세요.');
        inspect = await this.command(['image', 'inspect', imageName, '--format', '{{.Id}}'], '', this.shutdown.signal);
      }
      const id = inspect.output.trim();
      if (inspect.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('격리 이미지 식별자 검증 실패');
      return id;
    })().catch(error => { this.image = undefined; throw error; });
    return this.image;
  }

  private async remove(key: string, session: Session) {
    if (this.sessions.get(key) === session) this.sessions.delete(key);
    clearTimeout(session.idle); session.detach?.(); session.controller.abort();
    // Only a host-generated unique name, never a user path/container selector.
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await this.command(['rm', '-f', session.name], '', undefined, 5000); } catch { /* bounded daemon-side watchdog remains */ }
    }
  }

  async execute(key: string, code: string, signal?: AbortSignal, files: SandboxFile[] = []): Promise<string> {
    if (!key || key.length > 200 || !code || code.length > 32_000) throw new Error('격리 작업 식별자 또는 코드 크기가 올바르지 않습니다.');
    if (files.length > 10 || files.reduce((size, f) => size + f.data.length, 0) > 50 * 1024 * 1024) throw new Error('한 번에 최대 10개·50MB까지 열 수 있습니다.');
    for (const file of files) if (file.data.length > 25 * 1024 * 1024 || createHash('sha256').update(file.data).digest('hex') !== file.id) throw new Error('첨부 무결성 검증 실패');
    signal?.throwIfAborted();
    if (this.closed) throw new Error('격리 실행 서비스가 종료되었습니다.');
    let session = this.sessions.get(key);
    if (session?.busy) throw new Error('이 티켓의 코드가 실행 중입니다. 순서대로 호출하세요.');
    if (session && Date.now() - session.created > 12 * 60_000) { await this.remove(key, session); return this.execute(key, code, signal, files); }
    let fresh = false;
    if (!session) {
      if (this.sessions.size >= 4) {
        const idle = [...this.sessions.entries()].find(([, s]) => !s.busy);
        if (!idle) throw new Error('격리 작업 공간이 모두 사용 중입니다. 잠시 후 시도하세요.');
        await this.remove(...idle);
        return this.execute(key, code, signal, files); // re-check capacity after the await
      }
      // Reserve the slot before the first await, including image preparation.
      session = { name: `mrrobot-ticket-${randomUUID()}`, busy: true, created: Date.now(), controller: new AbortController() };
      this.sessions.set(key, session); fresh = true;
    }
    session.busy = true; clearTimeout(session.idle);
    session.detach?.();
    if (signal) {
      const abort = () => { void this.remove(key, session!); };
      signal.addEventListener('abort', abort, { once: true });
      session.detach = () => signal.removeEventListener('abort', abort);
    }
    const activeSignal = signal ? AbortSignal.any([signal, session.controller.signal]) : session.controller.signal;
    try {
      if (fresh) {
        const image = await new Promise<string>((resolve, reject) => {
          const abort = () => reject(new Error('격리 준비가 중지되었습니다.'));
          activeSignal.addEventListener('abort', abort, { once: true });
          this.prepare().then(resolve, reject).finally(() => activeSignal.removeEventListener('abort', abort));
          if (activeSignal.aborted) abort();
        });
        activeSignal.throwIfAborted();
        const started = await this.command(reusableSandboxArgs(session.name, image), '', activeSignal);
        if (started.code !== 0) throw new Error('격리 컨테이너를 준비하지 못했습니다.');
      }
      activeSignal.throwIfAborted();
      const restore = files.length ? `import os,base64,stat\np='/work/attachments'\nif not os.path.lexists(p): os.mkdir(p,0o700)\nif not stat.S_ISDIR(os.lstat(p).st_mode): raise RuntimeError('Unsafe attachment directory')\n` + files.map(f => `p=${JSON.stringify(sandboxFilePath(f))}\nif os.path.lexists(p): os.unlink(p)\nwith open(p,'xb') as out: out.write(base64.b64decode('${f.data.toString('base64')}'))\n`).join('') : '';
      const result = await this.command(['exec', '--interactive', '--user=65534:65534', '--workdir=/work', session.name, '/usr/bin/timeout', '--signal=KILL', this.documents ? '90s' : '30s', 'python', '-I', '-B', '-'], restore + code, activeSignal, this.documents ? 95_000 : 35_000);
      activeSignal.throwIfAborted();
      if (result.code !== 0) throw new Error(`격리 코드 실행 실패: ${result.output.slice(-2000) || '실행 제한 또는 컨테이너 종료'}`);
      session.busy = false;
      session.idle = setTimeout(() => { void this.remove(key, session!); }, this.idleMs); session.idle.unref();
      return result.output;
    } catch (error) { await this.remove(key, session); throw error; }
  }
  async close() {
    this.closed = true;
    this.shutdown.abort();
    await Promise.all([...this.sessions.entries()].map(([key, session]) => this.remove(key, session)));
  }
}

let pool: DiscordSandboxPool | undefined;
let documents: DiscordSandboxPool | undefined;
export function runDiscordPython(ticket: string, code: string, signal?: AbortSignal) { return (pool ??= new DiscordSandboxPool()).execute(ticket, code, signal); }
export function runDiscordDocument(ticket: string, code: string, files: SandboxFile[], signal?: AbortSignal) { return (documents ??= new DiscordSandboxPool(dockerCommand, 120_000, true)).execute(ticket, code, signal, files); }
export async function closeDiscordSandboxes() { const current = pool, docs = documents; pool = documents = undefined; await Promise.all([current?.close(), docs?.close()]); }
