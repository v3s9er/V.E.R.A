import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { CliSessionEvents } from './cli-session-events.js';
import { NativeRunScheduler } from './native-run-scheduler.js';
import { CliProcessRetirement, waitForCliRetirements } from './cli-process-retirement.js';
import { normalizeProviderUsageReport, type NativeAgentRequest, type ProviderResult, type Turn } from './provider.js';

type Options = { command: string; prefixArgs: string[]; env: NodeJS.ProcessEnv; providerId: string; model: string; req: NativeAgentRequest };
type Totals = { inputTokens: number; outputTokens: number; cachedInputTokens: number };
type Checkpoint = { thread: string; history: string[]; context: string; usage: Totals; at: number };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprints = (turns: Turn[]) => turns.map(t => digest(t));
const emptyUsage = (): Totals => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
const workers = new Map<string, NativeWorker>();
const MAX_WORKERS = 4;
const scheduler = new NativeRunScheduler(MAX_WORKERS);
let runtimeEpoch = 0;
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
  private retirement: CliProcessRetirement;
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private bytes = 0;
  private thread = '';
  private ready = false;
  private sequence = 20;
  private events = new CliSessionEvents();
  private checkpoint?: Checkpoint;
  private idle?: NodeJS.Timeout;
  private store: Checkpoints;
  private readonly model: string;
  private active?: {
    req: NativeAgentRequest; resolve(r: ProviderResult): void; reject(e: Error): void;
    abort(): void; timer: NodeJS.Timeout; heartbeat: NodeJS.Timeout; startedAt: number;
    status: string; text: string; turn: string; total: Totals; baseline: Totals;
    usage: ProviderResult['usage']; deltas: Map<string, string>; phases: Map<string, string>; completed: Set<string>;
    streamed: Map<string, string>; applied: string[]; unsubscribe?: () => void;
    steering?: { id: number; inputs: string[]; timer: NodeJS.Timeout };
    steeringDisabled?: boolean; turnCompleted?: boolean; cancelling?: boolean; interruptTimer?: NodeJS.Timeout;
    toolAbort: AbortController; toolCalls: Set<string>; pendingTool?: string; toolTimer?: NodeJS.Timeout;
  };
  closed = false;
  lastUsed = Date.now();
  get busy() { return !!this.active; }
  constructor(private key: string, options: Options) {
    // Warm workers must not retain the first request's transcript, callbacks,
    // abort signal or server admission closures while idle.
    this.model = options.model;
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
    this.retirement = new CliProcessRetirement(this.child, options.env);
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
        catch (error) { this.close(error instanceof SyntaxError ? new Error('네이티브 세션 응답을 처리하지 못했습니다.') : error instanceof Error ? error : new Error('네이티브 연결 검증 오류'));
        }
      }
    });
  }
  private count(n: number) {
    this.bytes += n;
    // Image tool results are echoed in completed events, not retained in memory.
    // Keep the text-only ceiling while allowing a bounded visual workflow.
    if (this.bytes > (this.active?.req.hostTools ? 64 : 8) * 1024 * 1024) this.close(new Error('네이티브 출력 안전 한도를 초과했습니다.'));
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
      const abort = () => this.interrupt();
      const timer = setTimeout(() => this.close(new Error('네이티브 작업 시간이 초과되었습니다.')), 30 * 60_000);
      const heartbeat = setInterval(() => {
        if (this.active) this.status(`${this.active.status.replace(/ · \d+초$/, '')} · ${Math.floor((Date.now() - startedAt) / 1000)}초`);
      }, 10_000);
      heartbeat.unref();
      this.active = { req, resolve, reject, abort, timer, heartbeat, startedAt, status: '', text: '', turn: '',
        baseline: this.checkpoint?.usage ?? emptyUsage(), total: this.checkpoint?.usage ?? emptyUsage(),
        usage: normalizeProviderUsageReport({}), deltas: new Map(), phases: new Map(), completed: new Set(), streamed: new Map(), applied: [],
        toolAbort: new AbortController(), toolCalls: new Set() };
      this.active.unsubscribe = req.steering?.subscribe(() => this.steer());
      req.signal?.addEventListener('abort', abort, { once: true });
      this.status(this.checkpoint ? '기존 대화 세션 연결 중' : '새 대화 세션 연결 중');
      try {
        if (this.ready) this.openThread();
        else this.send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'mrrobot_native', version: '1.0.0' },
          ...(req.hostTools ? { capabilities: { experimentalApi: true } } : {}),
        } });
      } catch { this.close(new Error('네이티브 세션 저장소를 사용할 수 없습니다.')); }
    });
  }
  private send(value: unknown) { if (!this.closed) this.child.stdin.write(JSON.stringify(value) + '\n'); }
  private status(text: string) { if (this.active) { this.active.status = text; this.active.req.onStatus?.(text); } }
  private interrupt() {
    const a = this.active;
    if (!a || a.cancelling) return;
    a.cancelling = true;
    a.toolAbort.abort(new Error('네이티브 작업이 중지되었습니다.'));
    if (!a.turn) { this.close(new Error('네이티브 작업이 중지되었습니다.')); return; }
    this.status('중지 요청 전달 · 실행 종료 확인 중');
    this.send({ id: ++this.sequence, method: 'turn/interrupt', params: { threadId: this.thread, turnId: a.turn } });
    // A stuck/old CLI must not keep tools alive indefinitely after cancellation.
    a.interruptTimer = setTimeout(() => this.close(new Error('네이티브 작업이 중지되었습니다.')), 1500);
  }
  private steer() {
    const a = this.active;
    if (!a?.turn || a.cancelling || a.turnCompleted || a.steering || a.steeringDisabled) return;
    const inputs = a.req.steering?.peek() ?? [];
    if (!inputs.length) return;
    const id = ++this.sequence;
    const timer = setTimeout(() => this.close(new Error('추가 지시 수신 확인이 지연되어 실행을 중단했습니다. 중복 실행을 막기 위해 자동 재전송하지 않습니다.')), 10_000);
    a.steering = { id, inputs, timer };
    this.send({ id, method: 'turn/steer', params: { threadId: this.thread, expectedTurnId: a.turn,
      input: inputs.map(text => ({ type: 'text', text, text_elements: [] })),
    } });
    this.status(`추가 지시 ${inputs.length}개 전달 중 · 현재 작업 유지`);
  }
  private finish() {
    const a = this.active;
    if (!a?.turnCompleted || a.steering || a.cancelling || a.pendingTool) return;
    const s = a.req.session!;
    this.checkpoint = { thread: this.thread, history: fingerprints([...s.history, { role: 'user', content: s.input },
      ...a.applied.map(content => ({ role: 'user' as const, content })), { role: 'assistant', content: a.text }]), context: digest(s.context), usage: a.total, at: Date.now() };
    try { this.store.set(this.key, this.checkpoint); }
    catch { this.status('답변 완료 · 세션 저장 실패, 다음 요청은 대화 기록으로 복구합니다'); this.checkpoint = undefined; this.thread = ''; }
    this.events.complete();
    this.release(); this.active = undefined; this.lastUsed = Date.now();
    this.idle = setTimeout(() => this.close(), IDLE_MS); this.idle.unref();
    a.resolve({ text: a.text, toolCalls: [], usage: a.usage });
  }
  private openThread() {
    const req = this.active!.req;
    if (this.thread) { this.startTurn(); return; }
    const sandbox = req.permissionMode === 'full' ? 'danger-full-access' : req.permissionMode === 'workspace' ? 'workspace-write' : 'read-only';
    this.events.beginThread();
    this.send({ id: 2, method: this.checkpoint ? 'thread/resume' : 'thread/start', params: {
      ...(this.checkpoint ? { threadId: this.checkpoint.thread } : { ephemeral: false }),
      model: this.model, allowProviderModelFallback: false, cwd: req.cwd, approvalPolicy: 'never', sandbox,
      baseInstructions: req.session!.instructions,
      ...(!this.checkpoint && req.hostTools ? { dynamicTools: req.hostTools.tools.map(tool => ({
        type: 'function', name: tool.name, description: tool.description, inputSchema: tool.parameters,
      })) } : {}),
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
    this.events.beginTurn(++this.sequence);
    this.send({ id: this.sequence, method: 'turn/start', params: { threadId: this.thread,
      input: [{ type: 'text', text, text_elements: [] }],
      ...(a.req.reasoningEffort && a.req.reasoningEffort !== 'auto' ? { effort: a.req.reasoningEffort } : { effort: null }),
    } });
  }
  private receive(m: any) {
    const active = this.active;
    if (active?.cancelling) {
      if (m.method === 'turn/completed' && this.events.accept(m)) this.close(new Error('네이티브 작업이 중지되었습니다.'));
      return; // No stale output or steering acknowledgements after cancellation.
    }
    if (active?.steering && m.id === active.steering.id && !m.method) {
      const pending = active.steering;
      clearTimeout(pending.timer); active.steering = undefined;
      if (m.error) {
        // Definitive rejection: retain host inputs for the continuation fallback.
        active.steeringDisabled = true;
        this.status('추가 지시는 현재 응답 뒤에 이어서 반영합니다');
      } else {
        if (m.result?.turnId !== active.turn || !active.req.steering?.commit(pending.inputs)) return this.close(new Error('추가 지시 실행 식별자 또는 대기열 검증에 실패했습니다.'));
        active.applied.push(...pending.inputs);
        active.req.onSteeringApplied?.(pending.inputs);
        this.status(`추가 지시 ${pending.inputs.length}개 반영 · 같은 실행에서 계속`);
      }
      this.finish(); this.steer(); return;
    }
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
      this.events.bindThread(id, m.result?.thread?.turns);
      this.thread = id; this.startTurn(); return;
    }
    if (m.id !== undefined && m.method) {
      if (m.method === 'item/tool/call' && active?.req.hostTools) {
        if (this.events.deferToolRequest(m)) return;
        this.hostTool(m); return;
      }
      this.send({ id: m.id, error: { code: -32601, message: 'Interactive requests require host approval; not supported on this transport.' } });
      return this.close(new Error('추가 권한이 필요한 네이티브 요청을 차단했습니다.'));
    }
    const a = this.active;
    if (!a) return;
    if (!m.method && m.id === this.events.turnRequest) {
      const queued = this.events.bindTurn(m.result?.turn?.id);
      a.turn = this.events.turn;
      for (const event of queued) { if (!this.closed && this.active === a) this.receive(event); }
      this.steer();
      return;
    }
    if (!this.events.accept(m)) return;
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
      if (a.phases.get(p.itemId) === 'commentary') this.status(text.slice(-1000));
      else {
        // agentMessage is public output, unlike reasoning payloads. Older CLIs
        // omit phase; do not hold their text until item/completed.
        a.streamed.set(p.itemId, (a.streamed.get(p.itemId) ?? '') + p.delta);
        a.req.onText?.(p.delta);
      }
    } else if (m.method === 'item/started' || m.method === 'item/completed') {
      const item = m.params?.item;
      if (item?.type === 'agentMessage' && m.method === 'item/started' && typeof item.id === 'string') {
        if (a.phases.size > 128) return this.close(new Error('네이티브 메시지 개수 초과'));
        a.phases.set(item.id, item.phase ?? 'unknown');
      }
      if (item?.type === 'agentMessage' && m.method === 'item/completed') {
        if (typeof item.text !== 'string' || item.text.length > 384 * 1024) return this.close(new Error('네이티브 응답 형식 오류'));
        if ((item.phase ?? a.phases.get(item.id)) === 'commentary') this.status(item.text.slice(0, 1000));
        else if (!a.completed.has(item.id)) {
          a.completed.add(item.id); a.text = item.text;
          const streamed = a.streamed.get(item.id) ?? '';
          if (!item.text.startsWith(streamed)) return this.close(new Error('네이티브 응답 스트림 불일치'));
          if (item.text.length > streamed.length) a.req.onText?.(item.text.slice(streamed.length));
        }
      } else if (m.method === 'item/started') {
        const labels: Record<string, string> = { reasoning: '모델이 요청을 검토하고 있습니다', commandExecution: '명령 실행 중', fileChange: '파일 수정 중', webSearch: '웹 검색 중', mcpToolCall: '연결 도구 실행 중', dynamicToolCall: 'PC 화면 도구 실행 중', contextCompaction: '대화 문맥 정리 중' };
        if (labels[item?.type]) this.status(labels[item.type]);
      }
    } else if (m.method === 'turn/completed') {
      if (m.params?.turn?.status !== 'completed') return this.close(new Error('네이티브 작업이 완료되지 않았습니다.'));
      a.turnCompleted = true;
      this.finish();
    }
  }
  private hostTool(m: any) {
    const a = this.active, p = m.params;
    if (!a?.req.hostTools || a.req.permissionMode !== 'full' || !a.turn || a.turnCompleted
      || p?.threadId !== this.thread || p?.turnId !== a.turn || p.namespace != null
      || typeof p.callId !== 'string' || p.callId.length > 200 || !p.callId
      || !a.req.hostTools.tools.some(tool => tool.name === p.tool)
      || a.pendingTool || a.toolCalls.has(p.callId) || a.toolCalls.size >= 512
      || Buffer.byteLength(JSON.stringify(p.arguments ?? {})) > 32_768) {
      this.send({ id: m.id, error: { code: -32602, message: 'Host desktop capability correlation failed.' } });
      this.close(new Error('PC 화면 도구의 대화·권한·중복 요청 검증에 실패했습니다.')); return;
    }
    a.toolCalls.add(p.callId); a.pendingTool = p.callId;
    this.status(p.tool === 'desktop_act' ? 'PC 조작 중 · 결과 확인 대기' : 'PC 화면 확인 중');
    const timer = setTimeout(() => this.close(new Error('PC 화면 도구가 응답하지 않아 중단했습니다.')), 25_000);
    a.toolTimer = timer;
    void Promise.resolve().then(() => a.req.hostTools!.execute(p.tool, p.arguments, a.toolAbort.signal)).then(result => {
      if (this.active === a && !a.cancelling && !this.closed) this.send({ id: m.id, result });
    }, error => {
      if (this.active === a && !a.cancelling && !this.closed) this.send({ id: m.id, result: { success: false,
        contentItems: [{ type: 'inputText', text: JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 500) : '화면 작업 실패', retry: 'Observe current state before retrying; never repeat an uncertain action blindly.' }) }],
      } });
    }).finally(() => {
      clearTimeout(timer);
      if (this.active === a) { a.pendingTool = undefined; a.toolTimer = undefined; this.finish(); }
    });
  }
  private release() { const a = this.active; if (a) {
    clearTimeout(a.timer); clearInterval(a.heartbeat); clearTimeout(a.interruptTimer); clearTimeout(a.steering?.timer);
    a.unsubscribe?.(); a.req.signal?.removeEventListener('abort', a.abort);
    clearTimeout(a.toolTimer); a.toolAbort.abort(); a.req.hostTools?.dispose();
  } }
  close(error?: Error) {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.idle); this.release();
    if (this.active) {
      try { this.store.set(this.key); } catch { /* checkpoint was cleared before the turn */ }
      this.active.reject(error ?? new Error('네이티브 연결이 종료되었습니다.')); this.active = undefined;
    }
    this.buffer = ''; this.checkpoint = undefined;
    if (workers.get(this.key) === this) workers.delete(this.key);
    this.retirement.retire();
  }
}

export async function pooledNativeCodex(options: Options): Promise<ProviderResult> {
  const epoch = runtimeEpoch;
  const s = options.req.session;
  if (!s || options.req.permissionMode === 'ask') throw new Error('검증된 네이티브 세션과 실행 승인이 필요합니다.');
  if (options.req.hostTools && options.req.permissionMode !== 'full') throw new Error('PC 화면 도구는 전체 접근 권한에서만 사용할 수 있습니다.');
  options.req.signal?.throwIfAborted();
  const key = digest([s.key, resolve(s.directory), options.providerId, options.model, options.command, options.prefixArgs,
    options.env.CODEX_HOME ?? options.env.USERPROFILE ?? options.env.HOME, resolve(options.req.cwd), options.req.permissionMode, s.instructions, options.req.hostTools?.tools ?? null]);
  const release = await scheduler.acquire(key, options.req.signal, position => options.req.onStatus?.(`네이티브 실행 대기 · ${position}번째 · 앞선 작업 완료 시 자동 시작`));
  try { while (true) {
    await waitForCliRetirements(options.env, options.req.signal);
    if (epoch !== runtimeEpoch) throw new Error('네이티브 실행이 종료되었습니다.');
    options.req.signal?.throwIfAborted();
    let worker = workers.get(key);
    if (worker?.busy) throw new Error('같은 대화의 네이티브 작업이 이미 실행 중입니다.');
    // Retire the whole worker on a transcript rewrite/host compaction. Otherwise
    // old loaded threads would accumulate inside one long-lived CLI process.
    if (worker && !worker.accepts(options.req)) { worker.close(); continue; }
    if (!worker) {
      if (workers.size >= MAX_WORKERS) {
        const idle = [...workers.values()].filter(w => !w.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!idle) throw new Error('네이티브 실행 슬롯이 사용 중입니다. 잠시 후 다시 요청하세요.');
        idle.close(); continue;
      }
      worker = new NativeWorker(key, options); workers.set(key, worker);
    }
    return await worker.run(options.req);
  } } finally { release(); }
}
export function closeNativeWorkers() { runtimeEpoch++; scheduler.cancelPending(); for (const worker of [...workers.values()]) worker.close(); }
