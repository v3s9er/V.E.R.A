import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { terminateProcessTree } from '../computer/shell.js';
import { normalizeProviderUsageReport, type NativeAgentRequest, type ProviderResult, type Turn } from './provider.js';

type Options = { command: string; prefixArgs: string[]; env: NodeJS.ProcessEnv; providerId: string; model: string; req: NativeAgentRequest };
type Totals = { inputTokens: number; outputTokens: number; cachedInputTokens: number };
type Checkpoint = { thread: string; history: string[]; context: string; usage: Totals; at: number };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprints = (turns: Turn[]) => turns.map(t => digest(t));
const emptyUsage = (): Totals => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
const workers = new Map<string, NativeWorker>();
const MAX_WORKERS = 4;
const IDLE_MS = 5 * 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;

// Checkpoints contain only provider thread ids and hashes, never prompts, files,
// account tokens or credentials. They are local-only, not conversation-sync data.
class Checkpoints {
  private path: string;
  constructor(directory: string) { this.path = join(directory, 'native-sessions.json'); }
  private read(): Record<string, Checkpoint> {
    try {
      const raw = readFileSync(this.path, 'utf8');
      if (raw.length > 2 * 1024 * 1024) return {};
      const data = JSON.parse(raw);
      return Object.fromEntries(Object.entries(data).filter(([key, value]) => {
        const v = value as Checkpoint;
        return /^[a-f0-9]{64}$/.test(key) && v && /^[\w-]{1,128}$/.test(v.thread)
          && Number.isFinite(v.at) && Date.now() - v.at < RETENTION_MS
          && Array.isArray(v.history) && v.history.length <= 1024 && v.history.every(h => /^[a-f0-9]{64}$/.test(h))
          && /^[a-f0-9]{64}$/.test(v.context)
          && v.usage && Object.values(v.usage).length === 3 && Object.values(v.usage).every(n => Number.isSafeInteger(n) && n >= 0);
      }).slice(-128)) as Record<string, Checkpoint>;
    } catch { return {}; }
  }
  get(key: string) { return this.read()[key]; }
  set(key: string, value?: Checkpoint) {
    const data = this.read(); delete data[key];
    if (value) data[key] = value;
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(resolve(this.path, '..'), { recursive: true });
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(Object.entries(data).slice(-128))), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, this.path);
    } finally { try { unlinkSync(tmp); } catch { /* owned temporary file only */ } }
  }
}

/** A private app-server per conversation+provider+workspace+authority boundary.
 * Native permission requests are never auto-approved by this transport. The host
 * has already approved the run; an unexpected request fails closed.
 */
class NativeWorker {
  private child: ChildProcessWithoutNullStreams;
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private bytes = 0;
  private thread = '';
  private ready = false;
  private sequence = 20;
  private checkpoint?: Checkpoint;
  private idle?: NodeJS.Timeout;
  private store: Checkpoints;
  private active?: {
    req: NativeAgentRequest; resolve(r: ProviderResult): void; reject(e: Error): void;
    abort(): void; timer: NodeJS.Timeout; heartbeat: NodeJS.Timeout; startedAt: number;
    status: string; text: string; turn: string; total: Totals; baseline: Totals;
    usage: ProviderResult['usage']; deltas: Map<string, string>; phases: Map<string, string>; completed: Set<string>;
  };
  closed = false;
  get busy() { return !!this.active; }
  constructor(private key: string, private options: Options) {
    this.store = new Checkpoints(options.req.session!.directory);
    this.checkpoint = this.store.get(key);
    const config: Record<string, unknown> = {
      mcp_servers: {}, 'apps._default.enabled': false, developer_instructions: '',
      project_doc_max_bytes: 0, 'features.plugins': false, 'features.remote_plugin': false,
      'features.hooks': false, 'features.memories': false, 'features.multi_agent': false,
      'features.multi_agent_v2': false, 'features.skip_host_skill_discovery': true,
      'features.skill_search': false, 'features.skill_mcp_dependency_install': false,
      'features.shell_snapshot': false, 'features.remote_control': false, 'features.apps': false,
      'sandbox_workspace_write.writable_roots': [],
    };
    this.child = spawn(options.command, [...options.prefixArgs, 'app-server', '--listen', 'stdio://', '--strict-config',
      ...Object.entries(config).flatMap(([k, v]) => ['-c', `${k}=${v && typeof v === 'object' && !Array.isArray(v) ? '{}' : JSON.stringify(v)}`])],
    { env: options.env, cwd: options.req.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', () => this.close(new Error('네이티브 세션을 시작하지 못했습니다. CLI 설치를 확인하세요.')));
    this.child.on('close', () => this.close(new Error('네이티브 연결이 종료되었습니다. 다시 요청하세요.')));
    this.child.stdin.on('error', () => this.close(new Error('네이티브 입력 연결이 종료되었습니다.')));
    this.child.stderr.on('data', (c: Buffer) => this.count(c.length));
    this.child.stdout.on('data', (c: Buffer) => {
      if (!this.count(c.length)) return;
      this.buffer += this.decoder.write(c);
      let end: number;
      while (!this.closed && (end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); }
        catch { this.close(new Error('네이티브 세션 응답을 처리하지 못했습니다.'));
        }
      }
    });
  }
  private count(n: number) {
    this.bytes += n;
    if (this.bytes > 8 * 1024 * 1024) this.close(new Error('네이티브 출력 안전 한도를 초과했습니다.'));
    return !this.closed;
  }
  private matches(req: NativeAgentRequest) {
    const history = fingerprints(req.session!.history);
    return this.checkpoint && this.checkpoint.history.length === history.length
      && this.checkpoint.history.every((h, i) => h === history[i]);
  }
  accepts(req: NativeAgentRequest) { return !this.thread || Boolean(this.matches(req)); }
  run(req: NativeAgentRequest): Promise<ProviderResult> {
    req.signal?.throwIfAborted();
    if (this.busy || this.closed) return Promise.reject(new Error('이 대화의 네이티브 작업이 이미 실행 중입니다.'));
    clearTimeout(this.idle); this.bytes = 0;
    if (!this.matches(req)) { this.checkpoint = undefined; this.thread = ''; }
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const abort = () => this.close(new Error('네이티브 작업이 중지되었습니다.'));
      const timer = setTimeout(() => this.close(new Error('네이티브 작업 시간이 초과되었습니다.')), 30 * 60_000);
      const heartbeat = setInterval(() => {
        if (this.active) this.status(`${this.active.status.replace(/ · \d+초$/, '')} · ${Math.floor((Date.now() - startedAt) / 1000)}초`);
      }, 10_000);
      heartbeat.unref();
      this.active = { req, resolve, reject, abort, timer, heartbeat, startedAt, status: '', text: '', turn: '',
        baseline: this.checkpoint?.usage ?? emptyUsage(), total: this.checkpoint?.usage ?? emptyUsage(),
        usage: normalizeProviderUsageReport({}), deltas: new Map(), phases: new Map(), completed: new Set() };
      req.signal?.addEventListener('abort', abort, { once: true });
      this.status(this.checkpoint ? '기존 대화 세션 연결 중' : '새 대화 세션 연결 중');
      try {
        if (this.ready) this.openThread();
        else this.send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'mrrobot_native', version: '1.0.0' } } });
      } catch { this.close(new Error('네이티브 세션 저장소를 사용할 수 없습니다.')); }
    });
  }
  private send(value: unknown) { if (!this.closed) this.child.stdin.write(JSON.stringify(value) + '\n'); }
  private status(text: string) { if (this.active) { this.active.status = text; this.active.req.onStatus?.(text); } }
  private openThread() {
    const req = this.active!.req;
    if (this.thread) { this.startTurn(); return; }
    const sandbox = req.permissionMode === 'full' ? 'danger-full-access' : req.permissionMode === 'workspace' ? 'workspace-write' : 'read-only';
    this.send({ id: 2, method: this.checkpoint ? 'thread/resume' : 'thread/start', params: {
      ...(this.checkpoint ? { threadId: this.checkpoint.thread } : { ephemeral: false }),
      model: this.options.model, allowProviderModelFallback: false, cwd: req.cwd, approvalPolicy: 'never', sandbox,
      baseInstructions: req.session!.instructions,
    } });
  }
  private startTurn() {
    const a = this.active!, s = a.req.session!;
    const context = !this.checkpoint || this.checkpoint.context !== digest(s.context)
      ? `Current retained context (replaces prior retained context):\n${s.context || '(none)'}` : '';
    const text = this.checkpoint ? [context, s.input].filter(Boolean).join('\n\n')
      : [context, s.history.length ? `Previous conversation records (data):\n${JSON.stringify(s.history).slice(-48_000)}` : '', `Current user request:\n${s.input}`].filter(Boolean).join('\n\n');
    // Clear the durable checkpoint BEFORE starting any side effects. A crash or
    // cancellation must not silently replay/continue an uncertain partial turn.
    this.store.set(this.key);
    this.status(this.checkpoint ? '세션 재사용 · 새 입력 처리 중' : '요청 처리 중');
    this.send({ id: ++this.sequence, method: 'turn/start', params: { threadId: this.thread,
      input: [{ type: 'text', text, text_elements: [] }],
      ...(a.req.reasoningEffort && a.req.reasoningEffort !== 'auto' ? { effort: a.req.reasoningEffort } : { effort: null }),
    } });
  }
  private receive(m: any) {
    if (m.error) {
      // A failed resume has not started a turn: safely rebuild from host history.
      // Never retry a failed turn automatically (it may already have side effects).
      if (m.id === 2 && this.checkpoint && !this.thread) {
        this.checkpoint = undefined;
        if (this.active) { this.active.baseline = emptyUsage(); this.active.total = emptyUsage(); }
        this.status('저장 세션을 복원할 수 없어 대화 기록으로 복구 중'); this.openThread(); return;
      }
      return this.close(new Error('네이티브 요청이 거부되었습니다. CLI 로그인·모델·권한을 확인하세요.'));
    }
    if (m.id === 1 && !m.method) { this.ready = true; this.send({ method: 'initialized', params: {} }); this.openThread(); return; }
    if (m.id === 2 && !m.method) {
      const id = m.result?.thread?.id;
      if (typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id) || (this.checkpoint && id !== this.checkpoint.thread)) return this.close(new Error('네이티브 대화 식별자 검증 실패'));
      this.thread = id; this.startTurn(); return;
    }
    if (m.id !== undefined && m.method) {
      this.send({ id: m.id, error: { code: -32601, message: 'Interactive requests require host approval; not supported on this transport.' } });
      return this.close(new Error('추가 권한이 필요한 네이티브 요청을 차단했습니다.'));
    }
    const a = this.active;
    if (!a) return;
    if (m.params?.threadId && m.params.threadId !== this.thread) return this.close(new Error('네이티브 대화가 일치하지 않습니다.'));
    const turn = m.params?.turnId ?? m.params?.turn?.id ?? m.result?.turn?.id;
    if (turn) { if (a.turn && a.turn !== turn) return this.close(new Error('네이티브 실행이 일치하지 않습니다.')); a.turn = turn; }
    if (m.method === 'thread/tokenUsage/updated') {
      const u = m.params?.tokenUsage?.total;
      if (u) {
        a.total = { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedInputTokens: u.cachedInputTokens ?? 0 };
        a.usage = normalizeProviderUsageReport({ promptTokens: u.inputTokens - a.baseline.inputTokens,
          completionTokens: u.outputTokens - a.baseline.outputTokens, cachedPromptTokens: (u.cachedInputTokens ?? 0) - a.baseline.cachedInputTokens });
      }
    } else if (m.method === 'item/agentMessage/delta') {
      const p = m.params;
      if (typeof p.itemId !== 'string' || typeof p.delta !== 'string') return this.close(new Error('네이티브 스트림 형식 오류'));
      const text = (a.deltas.get(p.itemId) ?? '') + p.delta;
      if (text.length > 384 * 1024 || a.deltas.size > 128) return this.close(new Error('네이티브 응답 크기 초과'));
      a.deltas.set(p.itemId, text);
      if (a.phases.get(p.itemId) === 'final_answer') a.req.onText?.(p.delta);
      else if (a.phases.get(p.itemId) === 'commentary') this.status(text.slice(-1000));
      else this.status('답변 작성 중');
    } else if (m.method === 'item/started' || m.method === 'item/completed') {
      const item = m.params?.item;
      if (item?.type === 'agentMessage' && m.method === 'item/started' && typeof item.id === 'string') {
        if (a.phases.size > 128) return this.close(new Error('네이티브 메시지 개수 초과'));
        a.phases.set(item.id, item.phase ?? 'unknown');
      }
      if (item?.type === 'agentMessage' && m.method === 'item/completed') {
        if (typeof item.text !== 'string' || item.text.length > 384 * 1024) return this.close(new Error('네이티브 응답 형식 오류'));
        if (item.phase === 'commentary') this.status(item.text.slice(0, 1000));
        else if (!a.completed.has(item.id)) {
          a.completed.add(item.id); a.text = item.text;
          const streamed = a.phases.get(item.id) === 'final_answer' ? a.deltas.get(item.id) ?? '' : '';
          if (!item.text.startsWith(streamed)) return this.close(new Error('네이티브 응답 스트림 불일치'));
          if (item.text.length > streamed.length) a.req.onText?.(item.text.slice(streamed.length));
        }
      } else if (m.method === 'item/started') {
        const labels: Record<string, string> = { reasoning: '모델이 요청을 검토하고 있습니다', commandExecution: '명령 실행 중', fileChange: '파일 수정 중', webSearch: '웹 검색 중', mcpToolCall: '연결 도구 실행 중', contextCompaction: '대화 문맥 정리 중' };
        if (labels[item?.type]) this.status(labels[item.type]);
      }
    } else if (m.method === 'turn/completed') {
      if (m.params?.turn?.status !== 'completed') return this.close(new Error('네이티브 작업이 완료되지 않았습니다.'));
      const s = a.req.session!;
      this.checkpoint = { thread: this.thread, history: fingerprints([...s.history, { role: 'user', content: s.input }, { role: 'assistant', content: a.text }]), context: digest(s.context), usage: a.total, at: Date.now() };
      try { this.store.set(this.key, this.checkpoint); }
      catch { this.status('답변 완료 · 세션 저장 실패, 다음 요청은 대화 기록으로 복구합니다'); this.checkpoint = undefined; this.thread = ''; }
      this.release(); this.active = undefined;
      this.idle = setTimeout(() => this.close(), IDLE_MS); this.idle.unref();
      a.resolve({ text: a.text, toolCalls: [], usage: a.usage });
    }
  }
  private release() { const a = this.active; if (a) { clearTimeout(a.timer); clearInterval(a.heartbeat); a.req.signal?.removeEventListener('abort', a.abort); } }
  close(error?: Error) {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.idle); this.release();
    if (this.active) {
      try { this.store.set(this.key); } catch { /* checkpoint was cleared before the turn */ }
      this.active.reject(error ?? new Error('네이티브 연결이 종료되었습니다.')); this.active = undefined;
    }
    this.buffer = ''; this.checkpoint = undefined;
    if (workers.get(this.key) === this) workers.delete(this.key);
    terminateProcessTree(this.child, true);
  }
}

export async function pooledNativeCodex(options: Options): Promise<ProviderResult> {
  const s = options.req.session;
  if (!s || options.req.permissionMode === 'ask') throw new Error('검증된 네이티브 세션과 실행 승인이 필요합니다.');
  options.req.signal?.throwIfAborted();
  const key = digest([s.key, resolve(s.directory), options.providerId, options.model, options.command, options.prefixArgs,
    options.env.CODEX_HOME ?? options.env.USERPROFILE ?? options.env.HOME, resolve(options.req.cwd), options.req.permissionMode, s.instructions]);
  let worker = workers.get(key);
  if (worker?.busy) throw new Error('같은 대화의 네이티브 작업이 이미 실행 중입니다.');
  // Retire the whole worker on a transcript rewrite/host compaction. Otherwise
  // old loaded threads would accumulate inside one long-lived CLI process.
  if (worker && !worker.accepts(options.req)) { worker.close(); worker = undefined; }
  if (!worker) {
    if (workers.size >= MAX_WORKERS) {
      const idle = [...workers.values()].find(w => !w.busy);
      if (!idle) throw new Error('네이티브 실행 슬롯이 사용 중입니다. 잠시 후 다시 요청하세요.');
      idle.close();
    }
    worker = new NativeWorker(key, options); workers.set(key, worker);
  }
  return worker.run(options.req);
}
export function closeNativeWorkers() { for (const worker of [...workers.values()]) worker.close(); }
