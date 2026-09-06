import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export const DISCORD_SANDBOX_IMAGE = 'python:3.12-slim';
type Result = { code: number | null; output: string };
export type DockerCommand = (args: string[], input: string, signal?: AbortSignal, timeout?: number) => Promise<Result>;

/** Fixed arguments, no model-supplied daemon options, mounts or credentials. */
export const dockerCommand: DockerCommand = (args, input, signal, timeout = 20_000) => {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
    '--user=65533:65533', '--pids-limit=32', '--memory=256m', '--memory-swap=256m', '--cpus=1', '--log-driver=none',
    '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--tmpfs=/work:rw,noexec,nosuid,nodev,size=32m,uid=65534,gid=65534,mode=700', '--workdir=/work',
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
  constructor(private command: DockerCommand = dockerCommand, private idleMs = 120_000) {}

  private prepare(): Promise<string> {
    if (!this.image) this.image = (async () => {
      const info = await this.command(['info', '--format', '{{.OSType}}'], '', this.shutdown.signal);
      if (info.code !== 0 || info.output.trim() !== 'linux') throw new Error('Docker Linux 엔진이 준비되지 않았습니다. PC에서 Docker Desktop을 켜 주세요. 검색·대화는 Docker 없이도 사용할 수 있습니다.');
      let inspect = await this.command(['image', 'inspect', DISCORD_SANDBOX_IMAGE, '--format', '{{.Id}}'], '', this.shutdown.signal);
      if (inspect.code !== 0) {
        // Download only this host-defined base image, once; never accept image
        // names/installation commands from Discord users or model output.
        const pull = await this.command(['pull', '--quiet', DISCORD_SANDBOX_IMAGE], '', this.shutdown.signal, 180_000);
        if (pull.code !== 0) throw new Error('격리 기본 이미지를 준비하지 못했습니다. Docker 연결을 확인하세요.');
        inspect = await this.command(['image', 'inspect', DISCORD_SANDBOX_IMAGE, '--format', '{{.Id}}'], '', this.shutdown.signal);
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

  async execute(key: string, code: string, signal?: AbortSignal): Promise<string> {
    if (!key || key.length > 200 || !code || code.length > 32_000) throw new Error('격리 작업 식별자 또는 코드 크기가 올바르지 않습니다.');
    signal?.throwIfAborted();
    if (this.closed) throw new Error('격리 실행 서비스가 종료되었습니다.');
    let session = this.sessions.get(key);
    if (session?.busy) throw new Error('이 티켓의 코드가 실행 중입니다. 순서대로 호출하세요.');
    if (session && Date.now() - session.created > 12 * 60_000) { await this.remove(key, session); return this.execute(key, code, signal); }
    let fresh = false;
    if (!session) {
      if (this.sessions.size >= 4) {
        const idle = [...this.sessions.entries()].find(([, s]) => !s.busy);
        if (!idle) throw new Error('격리 작업 공간이 모두 사용 중입니다. 잠시 후 시도하세요.');
        await this.remove(...idle);
        return this.execute(key, code, signal); // re-check capacity after the await
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
      const result = await this.command(['exec', '--interactive', '--user=65534:65534', '--workdir=/work', session.name, '/usr/bin/timeout', '--signal=KILL', '30s', 'python', '-I', '-B', '-'], code, activeSignal, 35_000);
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
export function runDiscordPython(ticket: string, code: string, signal?: AbortSignal) { return (pool ??= new DiscordSandboxPool()).execute(ticket, code, signal); }
export async function closeDiscordSandboxes() { const current = pool; pool = undefined; await current?.close(); }
