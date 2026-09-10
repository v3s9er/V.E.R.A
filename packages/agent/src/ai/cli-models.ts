import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { terminateProcessTree } from '../computer/shell.js';
import type { ProviderModelCatalog } from '@mr-robot/shared';

const DISCOVERY_ERRORS = {
  launch: 'Codex CLI를 실행하지 못했습니다. 설치 상태와 Mr.Robot의 CLI 경로를 확인하세요.',
  unsupported: '설치된 Codex CLI가 모델 조회 기능이나 실행 옵션을 지원하지 않습니다. 해당 CLI를 업데이트한 뒤 모델 목록을 새로고침하세요.',
  timeout: 'Codex 모델 조회 시간이 초과되었습니다. 로그인과 네트워크를 확인한 뒤 다시 시도하세요.',
  empty: 'Codex가 표시 가능한 모델을 반환하지 않았습니다. 로그인 계정과 모델 사용 권한을 확인하세요.',
  protocol: 'Codex 모델 목록을 갱신하지 못했습니다. CLI 업데이트·로그인·네트워크를 확인하고 다시 시도하세요.',
} as const;

/** Only these fixed messages may cross the CLI boundary. Never forward stderr. */
export class ModelDiscoveryError extends Error {
  constructor(readonly reason: keyof typeof DISCOVERY_ERRORS) { super(DISCOVERY_ERRORS[reason]); }
}

type DiscoveryOptions = { command: string; prefixArgs: string[]; env: NodeJS.ProcessEnv; timeoutMs?: number };

/** Same executable as model/list. Optional diagnostics must not block discovery. */
export function discoverCodexVersion(options: DiscoveryOptions): Promise<string | undefined> {
  return new Promise(resolve => {
    const child = spawn(options.command, [...options.prefixArgs, '--version'],
      { env: options.env, cwd: tmpdir(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let done = false, output = '', bytes = 0;
    const decoder = new StringDecoder('utf8');
    const finish = (version?: string) => {
      if (done) return;
      done = true; clearTimeout(timer); terminateProcessTree(child); resolve(version);
    };
    const timer = setTimeout(() => finish(), options.timeoutMs ?? 1500);
    child.on('error', () => finish());
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > 8192) { finish(); return; }
      output += decoder.write(data);
    });
    child.on('close', code => finish(code === 0 ? output.trim().match(/^codex-cli (\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,48})?)$/)?.[1] : undefined));
  });
}

/** Discovery only: never opens a thread, runs inference, or approves tools. */
export function discoverCodexModels(options: DiscoveryOptions): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const config: Record<string, unknown> = {
      mcp_servers: {}, 'apps._default.enabled': false,
      'features.plugins': false, 'features.remote_plugin': false,
      'features.hooks': false, 'features.memories': false, 'features.apps': false,
      'features.remote_control': false, 'features.shell_snapshot': false,
      'features.skip_host_skill_discovery': true, project_doc_max_bytes: 0,
    };
    const child = spawn(options.command, [...options.prefixArgs, 'app-server', '--listen', 'stdio://', '--strict-config',
      ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${typeof value === 'object' ? '{}' : JSON.stringify(value)}`])],
    { env: options.env, cwd: tmpdir(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let done = false, buffer = '', bytes = 0, requestId = 1, pages = 0;
    const decoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stderrTail = '', unsupported = false;
    const models = new Set<string>(), cursors = new Set<string>();
    const failure = () => new ModelDiscoveryError(unsupported ? 'unsupported' : 'protocol');
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      terminateProcessTree(child);
      if (error) reject(error); else resolve([...models]);
    };
    const timer = setTimeout(() => finish(new ModelDiscoveryError('timeout')), options.timeoutMs ?? 12_000);
    const send = (message: unknown) => { if (!done) child.stdin.write(JSON.stringify(message) + '\n'); };
    const count = (length: number) => { bytes += length; if (bytes > 4 * 1024 * 1024) finish(failure()); return !done; };
    child.on('error', () => finish(new ModelDiscoveryError('launch')));
    child.on('close', () => { if (!done) finish(failure()); });
    child.stdin.on('error', () => finish(failure()));
    child.stderr.on('data', (data: Buffer) => {
      if (!count(data.length)) return;
      stderrTail = (stderrTail + stderrDecoder.write(data)).slice(-2048);
      unsupported ||= /(?:unexpected argument|unrecognized subcommand|unknown (?:option|argument|subcommand))/i.test(stderrTail);
    });
    child.stdout.on('data', (data: Buffer) => {
      if (!count(data.length)) return;
      buffer += decoder.write(data);
      let end: number;
      while (!done && (end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.method) {
            if (message.id !== undefined) finish(failure()); // Unexpected server request: never approve it.
            continue;
          }
          if (message.id !== requestId) continue;
          if (message.error || !message.result) {
            if (message.error?.code === -32601) unsupported = true;
            finish(failure()); continue;
          }
          if (requestId === 1) {
            send({ method: 'initialized', params: {} });
            send({ id: ++requestId, method: 'model/list', params: { limit: 100, includeHidden: false } });
            continue;
          }
          if (!Array.isArray(message.result.data) || ++pages > 20) { finish(failure()); continue; }
          for (const entry of message.result.data) {
            if (!entry || entry.hidden === true) continue;
            const id = entry.model ?? entry.id;
            if (typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(id)) models.add(id);
          }
          if (models.size > 2000) { finish(failure()); continue; }
          const cursor = message.result.nextCursor;
          if (cursor == null) { finish(models.size ? undefined : new ModelDiscoveryError('empty')); continue; }
          if (typeof cursor !== 'string' || cursor.length > 2048 || cursors.has(cursor) || pages >= 20) { finish(failure()); continue; }
          cursors.add(cursor);
          send({ id: ++requestId, method: 'model/list', params: { limit: 100, includeHidden: false, cursor } });
        } catch { finish(failure()); }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'mrrobot_models', version: '1.0.0' } } });
  });
}

/** Bounded lazy refresh; concurrent callers share one discovery, including failures. */
export class ModelListCache {
  private values?: string[];
  private expiresAt = 0;
  private attemptedAt = -Infinity;
  private pending?: Promise<string[]>;
  private error?: Error;
  private updatedAt: number | null = null;
  constructor(private load: () => Promise<string[]>, private fallback: () => string[], private now = Date.now) {}
  status(): Pick<ProviderModelCatalog, 'state' | 'lastUpdatedAt' | 'lastAttemptAt' | 'warning'> {
    return {
      state: !this.values ? 'fallback' : this.error || this.now() >= this.expiresAt ? 'stale' : 'fresh',
      lastUpdatedAt: this.updatedAt,
      lastAttemptAt: Number.isFinite(this.attemptedAt) ? this.attemptedAt : null,
      ...(this.error ? { warning: this.error.message } : {}),
    };
  }
  async get(force = false): Promise<string[]> {
    if (this.pending) {
      const values = await this.pending;
      if (force && this.error) throw this.error;
      return [...values];
    }
    if ((!force && this.now() < this.expiresAt) || (force && this.now() - this.attemptedAt < 5000)) {
      if (force && this.error) throw this.error;
      return [...(this.values ?? this.fallback())];
    }
    this.attemptedAt = this.now();
    this.pending = (async () => {
      try {
        const values = await this.load();
        if (!values.length) throw new Error('모델 목록이 비어 있습니다.');
        this.values = [...new Set(values)]; this.error = undefined;
        this.updatedAt = this.now();
        this.expiresAt = this.now() + 5 * 60_000;
      } catch (error) {
        this.error = new Error(`모델 목록 갱신에 실패했습니다. 기존 목록은 유지됩니다. ${error instanceof ModelDiscoveryError ? DISCOVERY_ERRORS[error.reason] : '공급자 CLI·로그인·네트워크를 확인하세요.'}`);
        this.expiresAt = this.now() + 30_000;
      }
      return [...(this.values ?? this.fallback())];
    })();
    try {
      const values = await this.pending;
      if (force && this.error) throw this.error;
      return values;
    } finally { this.pending = undefined; }
  }
}
