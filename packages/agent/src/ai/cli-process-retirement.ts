import type { ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { terminateProcessTree } from '../computer/shell.js';

const closing = new Map<CliProcessRetirement, { runtime: string; done: Promise<void> }>();
const runtimeKey = (env: NodeJS.ProcessEnv) => {
  const path = resolve(env.CODEX_HOME ?? join(env.USERPROFILE ?? env.HOME ?? homedir(), '.codex'));
  return process.platform === 'win32' ? path.toLowerCase() : path;
};

/** A retired CLI must release its handles before another worker opens its DB.
 * Live workers still run concurrently; only shutdowns in the same CLI home wait.
 */
export class CliProcessRetirement {
  private closed = false;
  private done: Promise<void>;
  private runtime: string;
  constructor(private child: ChildProcess, env: NodeJS.ProcessEnv) {
    this.runtime = runtimeKey(env);
    this.done = new Promise(resolve => child.once('close', () => {
      this.closed = true; closing.delete(this); resolve();
    }));
  }
  retire() {
    if (this.closed) return;
    closing.set(this, { runtime: this.runtime, done: this.done });
    terminateProcessTree(this.child, true);
  }
}

export async function waitForCliRetirements(env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const runtime = runtimeKey(env);
  const pending = [...closing.values()].filter(p => p.runtime === runtime);
  if (!pending.length) return;
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    await Promise.race([
      Promise.all(pending.map(p => p.done)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('이전 구독 세션이 종료 중입니다. 잠시 후 다시 요청하세요.')), 5000);
        abort = () => reject(new Error('구독 세션 재연결이 중지되었습니다.'));
        signal?.addEventListener('abort', abort, { once: true });
      }),
    ]);
    signal?.throwIfAborted();
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}
