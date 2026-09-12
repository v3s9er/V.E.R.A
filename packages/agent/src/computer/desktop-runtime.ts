import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

export function desktopHelperPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const paths = [join(here.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'integrations/computer-use/runtime.ps1'),
    resolve(here, '../../../../integrations/computer-use/runtime.ps1')];
  const found = paths.find(existsSync);
  if (!found) throw new Error('화면 제어 구성 파일이 없습니다. 설치를 복구하세요.');
  return found;
}

/** Private stdio only. No listener, shell interpolation, credentials or payload files.
 * One pending operation; uncertain mutations are NEVER replayed after a crash. */
export class DesktopRuntime {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: { id: number; resolve(value: any): void; reject(error: Error): void; cleanup(): void };
  private nextId = 0;
  private idle?: NodeJS.Timeout;
  private retiring?: Promise<void>;
  private closing = false;
  constructor(private options: {
    command?: string; args?: string[]; timeoutMs?: number; idleMs?: number;
  } = {}) {}

  async request(owner: string, command: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted();
    if (this.closing) throw new Error('화면 제어가 종료되었습니다.');
    if (this.pending) throw new Error('화면 조작이 진행 중입니다. 완료 후 다시 확인하세요.');
    if (this.retiring) await this.retiring;
    signal?.throwIfAborted();
    // Recheck after awaiting retirement: two callers must not share the slot.
    if (this.closing || this.pending) throw new Error('화면 제어 실행 슬롯을 사용할 수 없습니다.');
    clearTimeout(this.idle);
    const child = this.ensureStarted();
    const id = ++this.nextId;
    const payload = JSON.stringify({ id, owner, command, input });
    if (Buffer.byteLength(payload) > 32_768) throw new Error('화면 도구 입력이 너무 큽니다.');
    return new Promise((resolveResult, reject) => {
      const abort = () => this.fail(new Error('화면 작업이 중지되었습니다. 이미 전달된 동작은 되돌리지 않으며 재시도 전 상태를 확인하세요.'));
      const timer = setTimeout(() => this.fail(new Error('화면 응답 시간이 초과되었습니다. 동작 결과가 불확실하므로 자동 반복하지 않습니다.')),
        this.options.timeoutMs ?? 20_000);
      this.pending = { id, resolve: resolveResult, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      child.stdin.write(payload + '\n', error => { if (error && this.child === child) this.fail(new Error('화면 도구 연결이 종료되었습니다.')); });
    });
  }

  private ensureStarted() {
    if (this.child) return this.child;
    if (!this.options.command && process.platform !== 'win32') throw new Error('현재 화면 제어는 Windows에서 지원됩니다.');
    const command = this.options.command ?? join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const args = this.options.args ?? ['-NoProfile', '-NonInteractive', '-Sta', '-File', desktopHelperPath()];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:systemroot|windir|comspec|path|pathext|temp|tmp|userprofile|appdata|localappdata|programdata|programfiles|programfiles\(x86\)|os|processor_architecture)$/i.test(key)));
    const child = spawn(command, args, { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let buffer = ''; const decoder = new StringDecoder('utf8');
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return;
      buffer += decoder.write(chunk);
      if (buffer.length > 2 * 1024 * 1024) { this.fail(new Error('화면 응답 크기 한도를 초과했습니다.')); return; }
      let end: number;
      while (this.child === child && (end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line), pending = this.pending;
          if (!pending || message.id !== pending.id || typeof message.ok !== 'boolean') throw new Error('화면 응답 식별자 검증 실패');
          this.pending = undefined; pending.cleanup();
          this.idle = setTimeout(() => this.stop(), this.options.idleMs ?? 120_000); this.idle.unref();
          if (message.ok) pending.resolve(message.result);
          else pending.reject(new Error(typeof message.error === 'string' ? message.error.slice(0, 500) : '화면 작업을 완료하지 못했습니다.'));
        } catch { this.fail(new Error('화면 도구 응답 검증에 실패했습니다. 새 상태를 읽으세요.')); }
      }
    });
    // Never retain UI contents or sensitive runtime diagnostics in application logs.
    child.stderr.resume();
    child.stdin.on('error', () => { if (this.child === child) this.fail(new Error('화면 입력 연결이 종료되었습니다.')); });
    child.on('error', () => { if (this.child === child) this.fail(new Error('Windows 화면 도구를 시작하지 못했습니다. 실행 정책을 확인하세요.')); });
    child.on('close', () => { if (this.child === child) this.fail(new Error('화면 도구가 종료되었습니다. 결과를 확인한 뒤 다시 요청하세요.')); });
    return child;
  }

  private fail(error: Error) {
    const pending = this.pending; this.pending = undefined;
    this.stop(); pending?.cleanup(); pending?.reject(error);
  }
  private stop() {
    clearTimeout(this.idle);
    const child = this.child; this.child = undefined;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    // Do not start a replacement while an old process could still emit input.
    this.retiring = new Promise<void>(resolveExit => {
      child.once('close', () => { this.retiring = undefined; resolveExit(); });
      child.kill();
    });
  }
  dispose() { this.closing = true; this.fail(new Error('화면 제어가 종료되었습니다.')); }
  reset() { this.fail(new Error('화면 제어 연결이 재설정되었습니다.')); }
}
