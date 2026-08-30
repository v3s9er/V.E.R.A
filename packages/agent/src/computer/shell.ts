import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { ShellResult } from '@mr-robot/shared';

export interface ShellOptions {
  shell?: 'powershell' | 'cmd';
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Truncate captured output to this many bytes (prevents memory blow-ups). */
  maxBytes?: number;
  signal?: AbortSignal;
}

/** Kill the full subprocess tree so PowerShell/cmd grandchildren cannot outlive a cancelled task. */
export function terminateProcessTree(child: ChildProcess, isolatedProcessGroup = false, force = false): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32') {
    const signal = force ? 'SIGKILL' : 'SIGTERM';
    if (isolatedProcessGroup) {
      try { process.kill(-child.pid, signal); return; } catch { /* fall back to the direct child */ }
    }
    try { child.kill(signal); } catch { /* already dead */ }
    return;
  }
  try {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', () => {
      try { child.kill(); } catch { /* already dead */ }
    });
    killer.unref();
  } catch {
    try { child.kill(); } catch { /* already dead */ }
  }
}

function appendLimited(current: string, chunk: string, maxBytes: number): string {
  if (current.length >= maxBytes) return current;
  const room = maxBytes - current.length;
  return current + chunk.slice(0, room);
}

/**
 * Run a shell command and capture stdout/stderr with a hard timeout.
 * Never resolves until the child is reaped — this is what keeps long
 * sessions from leaking zombie processes or sockets.
 */
export function runShell(command: string, opts: ShellOptions = {}): Promise<ShellResult> {
  const shell = opts.shell ?? 'powershell';
  const timeoutMs = opts.timeoutMs ?? 30000;
  const maxBytes = opts.maxBytes ?? 200_000;
  const started = Date.now();

  const program = shell === 'cmd' ? 'cmd.exe' : 'powershell.exe';
  const args =
    shell === 'cmd'
      ? ['/d', '/s', '/c', command]
      : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command];

  return new Promise<ShellResult>((resolve) => {
    let child;
    try {
      child = spawn(program, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        ok: false,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: null,
        durationMs: Date.now() - started,
        timedOut: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let aborted = false;

    const finish = (result: ShellResult): void => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', abort);
      resolve(result);
    };

    const abort = (): void => {
      aborted = true;
      terminateProcessTree(child);
    };
    if (opts.signal?.aborted) abort();
    else opts.signal?.addEventListener('abort', abort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);
    // Keep the event loop alive-safe: unref only the timer, not the child.
    timer.unref?.();

    child.stdout?.on('data', (d: Buffer) => {
      stdout = appendLimited(stdout, d.toString('utf8'), maxBytes);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr = appendLimited(stderr, d.toString('utf8'), maxBytes);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({
        ok: false,
        stdout,
        stderr: aborted ? '작업이 중지되었습니다.' : err.message,
        exitCode: null,
        durationMs: Date.now() - started,
        timedOut,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      finish({
        ok: code === 0 && !aborted,
        stdout,
        stderr: aborted && !stderr ? '작업이 중지되었습니다.' : stderr,
        exitCode: code,
        durationMs: Date.now() - started,
        timedOut,
      });
    });
  });
}
