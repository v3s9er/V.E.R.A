import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { daybreakProgram } from '@mr-robot/shared';
import { classifyCliFailure } from './cli-failure.js';
import { CliSessionEvents, NativeRawToolEvents, sanitizeNativeRawNotification } from './cli-session-events.js';
import { NativeToolEvents } from './native-tool-events.js';
import { NativeRunScheduler } from './native-run-scheduler.js';
import { NativeDelegationEvents, nativeDelegationConfig, nativeDelegationLimit, sanitizeNativeDelegationRequest } from './native-delegation.js';
import { CliProcessRetirement, waitForCliRetirements } from './cli-process-retirement.js';
import { nativeHistory } from './native-history.js';
import { normalizeProviderUsageReport, type NativeAgentRequest, type ProviderResult, type ProviderTiming, type Turn } from './provider.js';

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
    usage: ProviderResult['usage']; deltas: Map<string, string>; phases: Map<string, string>; completed: Map<string, string>;
    streamed: Map<string, string>; applied: string[]; unsubscribe?: () => void;
    timingStart: number; reused: boolean; timings: Set<ProviderTiming['stage']>; output: string; outputItem?: string;
    steering?: { id: number; inputs: string[]; timer: NodeJS.Timeout };
    steeringDisabled?: boolean; turnCompleted?: boolean; cancelling?: boolean; interruptTimer?: NodeJS.Timeout;
    toolAbort: AbortController; toolCalls: Set<string>; pendingTool?: string; toolTimer?: NodeJS.Timeout;
    toolEvents: NativeToolEvents;
    rawToolEvents: NativeRawToolEvents;
    delegation?: NativeDelegationEvents;
  };
  private rawEventsSupported = true;
  private rawEventsActive = false;
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
      'features.hooks': false, 'features.memories': false, 'features.skip_host_skill_discovery': true,
      'features.skill_search': false, 'features.skill_mcp_dependency_install': false,
      'features.shell_snapshot': false, 'features.remote_control': false, 'features.apps': false,
      'sandbox_workspace_write.writable_roots': [],
      agents: {}, ...nativeDelegationConfig(options.req, options.model),
    };
    this.child = spawn(options.command, [...options.prefixArgs, 'app-server', '--listen', 'stdio://', '--strict-config',
      ...Object.entries(config).flatMap(([k, v]) => ['-c', `${k}=${v && typeof v === 'object' && !Array.isArray(v) ? '{}' : JSON.stringify(v)}`])],
    { env: options.env, cwd: options.req.cwd, windowsHide: true, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
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
        try {
          const decoded = JSON.parse(line);
          const message = sanitizeNativeDelegationRequest(decoded) ?? sanitizeNativeRawNotification(decoded);
          if (message) this.receive(message);
        }
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
    return this.checkpoint && this.checkpoint.history.length <= history.length
      && this.checkpoint.history.every((h, i) => h === history[i]);
  }
  accepts(req: NativeAgentRequest) { return !this.thread || Boolean(this.matches(req)); }
  run(req: NativeAgentRequest, timingStart: number): Promise<ProviderResult> {
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
      const toolEvents = new NativeToolEvents(req.onTool, Date.now, req.hostTools?.tools.map(tool => tool.name));
      this.active = { req, resolve, reject, abort, timer, heartbeat, startedAt, status: '', text: '', turn: '',
        baseline: this.checkpoint?.usage ?? emptyUsage(), total: this.checkpoint?.usage ?? emptyUsage(),
        usage: normalizeProviderUsageReport({}), deltas: new Map(), phases: new Map(), completed: new Map(), streamed: new Map(), applied: [],
        timingStart, reused: !!this.checkpoint, timings: new Set(), output: '',
        toolAbort: new AbortController(), toolCalls: new Set(), toolEvents,
        rawToolEvents: new NativeRawToolEvents((method, item) => toolEvents.accept(method, item)),
        ...(req.nativeDelegation ? { delegation: new NativeDelegationEvents(nativeDelegationLimit(req), this.model, req.reasoningEffort, req.onTool) } : {}) };
      this.mark('worker');
      this.active.unsubscribe = req.steering?.subscribe(() => this.steer());
      req.signal?.addEventListener('abort', abort, { once: true });
      this.status(this.checkpoint ? '기존 대화 세션 연결 중' : '새 대화 세션 연결 중');
      try {
        if (this.ready) this.openThread();
        else this.send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'mrrobot_native', version: '1.0.0' },
          // turn/start always sends cyberAccessProgram (including "standard").
          // That field needs protocol opt-in even without dynamic host tools;
          // this does not change sandbox or tool authorization.
          capabilities: { experimentalApi: true },
        } });
      } catch { this.close(new Error('네이티브 세션 저장소를 사용할 수 없습니다.')); }
    });
  }
  private send(value: unknown) { if (!this.closed) this.child.stdin.write(JSON.stringify(value) + '\n'); }
  private mark(stage: ProviderTiming['stage']) {
    const a = this.active;
    if (!a || a.timings.has(stage)) return;
    a.timings.add(stage);
    try { a.req.onTiming?.({ transport: 'codex-native', stage, elapsedMs: Math.round((performance.now() - a.timingStart) * 1000) / 1000, reused: a.reused }); } catch { /* diagnostics must not affect execution */ }
  }
  private emitText(id: string, text: string) {
    const a = this.active!;
    if (a.outputItem && a.outputItem !== id && !a.completed.has(a.outputItem)) throw new Error('네이티브 메시지 순서가 일치하지 않습니다.');
    const separator = a.outputItem && a.outputItem !== id && a.output ? '\n\n' : '';
    if (a.output.length + separator.length + text.length > 384 * 1024) throw new Error('네이티브 응답 크기 초과');
    a.outputItem = id;
    if (!text) return;
    this.mark('firstText'); a.output += separator + text; a.req.onText?.(separator + text);
  }
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
    try { a.delegation?.assertSettled(); }
    catch (error) { this.close(error instanceof Error ? error : new Error('네이티브 보조 작업 완료 검증 실패')); return; }
    const delegationEnabled = !!a.delegation;
    // App-server parent usage is not documented as including all descendants.
    // Keep reported parent counters, but never claim complete child accounting.
    if (delegationEnabled && a.usage.reportStatus === 'reported') a.usage = { ...a.usage, reportStatus: 'missing' };
    const s = a.req.session!;
    this.checkpoint = { thread: this.thread, history: fingerprints([...s.history, { role: 'user', content: s.input },
      ...a.applied.map(content => ({ role: 'user' as const, content })), { role: 'assistant', content: a.text }]), context: digest(s.context), usage: a.total, at: Date.now() };
    try { this.store.set(this.key, this.checkpoint); }
    catch { this.status('답변 완료 · 세션 저장 실패, 다음 요청은 대화 기록으로 복구합니다'); this.checkpoint = undefined; this.thread = ''; }
    this.mark('completed'); this.events.complete();
    this.release(); this.active = undefined; this.lastUsed = Date.now();
    const result: ProviderResult = { text: a.text, toolCalls: [], usage: a.usage };
    if (delegationEnabled) {
      // Retire the entire owned process tree, including any unobserved nested
      // native work, before reporting success. Resume the saved main thread on
      // the next call instead of leaving auxiliary sessions warm indefinitely.
      this.close();
      void this.retirement.waitUntilClosed().then(() => {
        if (a.req.signal?.aborted) a.reject(new Error('네이티브 작업이 중지되었습니다.'));
        else a.resolve(result);
      }, error => a.reject(error));
    } else {
      this.idle = setTimeout(() => this.close(), IDLE_MS); this.idle.unref();
      a.resolve(result);
    }
  }
  private openThread() {
    const req = this.active!.req;
    if (this.thread) { this.startTurn(); return; }
    const sandbox = req.permissionMode === 'full' ? 'danger-full-access' : req.permissionMode === 'workspace' ? 'workspace-write' : 'read-only';
    // The protocol currently exposes this opt-in only on thread/start. Keep
    // cold resumes intact rather than rebuilding a conversation for telemetry.
    this.rawEventsActive = !this.checkpoint && this.rawEventsSupported;
    this.events.beginThread();
    this.send({ id: 2, method: this.checkpoint ? 'thread/resume' : 'thread/start', params: {
      ...(this.checkpoint ? { threadId: this.checkpoint.thread } : { ephemeral: false }),
      model: this.model, allowProviderModelFallback: false, cwd: req.cwd, approvalPolicy: 'never', sandbox,
      baseInstructions: req.session!.instructions,
      ...(this.rawEventsActive ? { experimentalRawEvents: true } : {}),
      ...(!this.checkpoint && req.hostTools ? { dynamicTools: req.hostTools.tools.map(tool => ({
        type: 'function', name: tool.name, description: tool.description, inputSchema: tool.parameters,
      })) } : {}),
    } });
  }
  private startTurn() {
    const a = this.active!, s = a.req.session!;
    if (!this.rawEventsActive) a.req.onStatus?.('도구 관측 제한 · 이 연결에서는 일부 코드 실행이 집계되지 않을 수 있습니다.');
    this.mark('thread');
    const context = !this.checkpoint || this.checkpoint.context !== digest(s.context)
      ? `Current retained context (replaces prior retained context):\n${s.context || '(none)'}` : '';
    // A tool-free interlude or another capability-scoped transport may append
    // complete host records. Verify the entire saved prefix; transfer ONLY the
    // intervening records as data, never replay actions or accept a rewrite.
    const intervening = this.checkpoint && s.history.length > this.checkpoint.history.length
      ? `Intervening conversation records from the host (historical data, not actions to replay):\n${nativeHistory(s.history.slice(this.checkpoint.history.length))}` : '';
    const text = this.checkpoint ? [context, intervening, s.input].filter(Boolean).join('\n\n')
      : [context, s.history.length ? `Previous conversation records (data; omission flags mean incomplete history):\n${nativeHistory(s.history)}` : '', `Current user request:\n${s.input}`].filter(Boolean).join('\n\n');
    // Clear the durable checkpoint BEFORE starting any side effects. A crash or
    // cancellation must not silently replay/continue an uncertain partial turn.
    this.store.set(this.key);
    this.status(this.checkpoint ? '세션 재사용 · 새 입력 처리 중' : '요청 처리 중');
    this.events.beginTurn(++this.sequence);
    this.mark('submitted');
    this.send({ id: this.sequence, method: 'turn/start', params: { threadId: this.thread,
      input: [{ type: 'text', text, text_elements: [] }],
      cyberAccessProgram: daybreakProgram(this.model, a.req.daybreakEnabled === true),
      ...(a.req.reasoningEffort && a.req.reasoningEffort !== 'auto' ? { effort: a.req.reasoningEffort } : { effort: null }),
    } });
  }
  private receive(m: any) {
    const active = this.active;
    const incomingThread = m.params?.threadId ?? m.params?.thread?.id;
    const expectedParent = this.thread || this.checkpoint?.thread;
    if (active?.delegation && expectedParent && typeof incomingThread === 'string' && incomingThread !== expectedParent) {
      // Child notifications may precede the correlated spawn completion. They
      // never select a thread, stream into the parent, supply usage, or grant a
      // host tool. Unknown child RPC requests are denied individually without
      // aborting a valid main-thread operation.
      if (m.id !== undefined && m.method) this.send({ id: m.id, error: { code: -32601,
        message: 'Host capabilities and interactive approvals belong only to the parent thread.' } });
      else if (m.method === 'thread/started') active.delegation.observeChildThread(m.params?.thread, expectedParent);
      return;
    }
    if (active?.delegation && !expectedParent && m.method === 'thread/started' && m.params?.thread?.parentThreadId != null) {
      // A child notification cannot select the primary thread while its RPC
      // response is still pending. Its parent metadata is checked on adoption.
      active.delegation.observeChildThread(m.params.thread, '');
      return;
    }
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
      // Negotiate only this optional field, once per worker and strictly before
      // a thread/turn exists. Never retry a failed model invocation or another
      // invalid parameter, and do not add schema/catalog probes to the hot path.
      if (m.id === 2 && !this.checkpoint && !this.thread && this.rawEventsActive
        && m.error.code === -32602 && typeof m.error.message === 'string'
        && /experimentalRawEvents/.test(m.error.message)
        && /unknown|unrecognized|unsupported|not supported|unexpected/i.test(m.error.message)) {
        this.rawEventsSupported = false; this.openThread(); return;
      }
      // A failed resume has not started a turn: safely rebuild from host history.
      // Never retry a failed turn automatically (it may already have side effects).
      if (m.id === 2 && this.checkpoint && !this.thread) {
        this.checkpoint = undefined;
        if (this.active) { this.active.baseline = emptyUsage(); this.active.total = emptyUsage(); }
        this.status('저장 세션을 복원할 수 없어 대화 기록으로 복구 중'); this.openThread(); return;
      }
      return this.close(classifyCliFailure(m.error, 'request_rejected'));
    }
    if (m.id === 1 && !m.method) { this.ready = true; this.mark('initialized'); this.send({ method: 'initialized', params: {} }); this.openThread(); return; }
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
      this.mark('accepted');
      for (const event of queued) { if (!this.closed && this.active === a) this.receive(event); }
      this.steer();
      return;
    }
    if (!this.events.accept(m)) return;
    if (m.method === 'item/nativeDelegation/requested') {
      if (!a.delegation || m.params?.threadId !== this.thread || m.params?.turnId !== a.turn) throw new Error('네이티브 보조 작업 요청의 부모 실행 검증에 실패했습니다.');
      a.delegation.requested(m.params);
    } else if (m.method === 'rawResponseItem/completed') {
      a.rawToolEvents.accept(m.params.item);
    } else if (m.method === 'thread/tokenUsage/updated') {
      const u = m.params?.tokenUsage?.total;
      if (u) {
        a.total = { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedInputTokens: u.cachedInputTokens ?? 0 };
        a.usage = normalizeProviderUsageReport({ promptTokens: u.inputTokens - a.baseline.inputTokens,
          completionTokens: u.outputTokens - a.baseline.outputTokens, cachedPromptTokens: (u.cachedInputTokens ?? 0) - a.baseline.cachedInputTokens });
      }
    } else if (m.method === 'item/agentMessage/delta') {
      const p = m.params;
      if (typeof p.itemId !== 'string' || !p.itemId || p.itemId.length > 200 || typeof p.delta !== 'string' || a.completed.has(p.itemId)) return this.close(new Error('네이티브 스트림 형식 오류'));
      this.mark('firstDelta');
      const text = (a.deltas.get(p.itemId) ?? '') + p.delta;
      if (text.length > 384 * 1024 || a.deltas.size > 128) return this.close(new Error('네이티브 응답 크기 초과'));
      a.deltas.set(p.itemId, text);
      if (a.phases.get(p.itemId) === 'commentary') this.status(text.slice(-1000));
      else {
        // agentMessage is public output, unlike reasoning payloads. Older CLIs
        // omit phase; do not hold their text until item/completed.
        a.streamed.set(p.itemId, (a.streamed.get(p.itemId) ?? '') + p.delta);
        this.emitText(p.itemId, p.delta);
      }
    } else if (m.method === 'item/started' || m.method === 'item/completed') {
      const item = m.params?.item;
      if (item?.type === 'collabAgentToolCall' || item?.type === 'subAgentActivity') {
        if (!a.delegation) throw new Error('허용되지 않은 네이티브 보조 작업을 차단했습니다.');
        if (m.params?.threadId !== this.thread || m.params?.turnId !== a.turn) throw new Error('네이티브 보조 작업의 부모 실행 식별자가 누락되었습니다.');
        if (item.type === 'subAgentActivity') a.delegation.activity(m.method, item, this.thread);
        else a.delegation.accept(m.method, item, this.thread);
      }
      a.toolEvents.accept(m.method, item);
      if (item?.type === 'agentMessage' && m.method === 'item/started' && typeof item.id === 'string') {
        if (a.phases.size > 128) return this.close(new Error('네이티브 메시지 개수 초과'));
        if (a.completed.has(item.id) || (a.streamed.has(item.id) && item.phase === 'commentary')) return this.close(new Error('네이티브 메시지 단계 불일치'));
        a.phases.set(item.id, item.phase ?? 'unknown');
      }
      if (item?.type === 'agentMessage' && m.method === 'item/completed') {
        if (typeof item.id !== 'string' || !item.id || item.id.length > 200 || typeof item.text !== 'string' || item.text.length > 384 * 1024) return this.close(new Error('네이티브 응답 형식 오류'));
        if (a.completed.has(item.id)) {
          if (a.completed.get(item.id) !== item.text) this.close(new Error('네이티브 중복 응답 불일치'));
          return;
        }
        if (a.completed.size >= 128 || ((item.phase ?? a.phases.get(item.id)) === 'commentary' && a.streamed.has(item.id))) return this.close(new Error('네이티브 메시지 단계 또는 개수 오류'));
        if ((item.phase ?? a.phases.get(item.id)) === 'commentary') this.status(item.text.slice(0, 1000));
        else {
          const streamed = a.streamed.get(item.id) ?? '';
          if (!item.text.startsWith(streamed)) return this.close(new Error('네이티브 응답 스트림 불일치'));
          this.emitText(item.id, item.text.slice(streamed.length));
          a.text = a.output;
        }
        a.completed.set(item.id, item.text);
      } else if (m.method === 'item/started') {
        const labels: Record<string, string> = { reasoning: '모델이 요청을 검토하고 있습니다', commandExecution: '명령 실행 중', fileChange: '파일 수정 중', webSearch: '웹 검색 중', imageView: '원본 이미지 확인 중', mcpToolCall: '연결 도구 실행 중', dynamicToolCall: '연결 도구 실행 중', contextCompaction: '대화 문맥 정리 중' };
        if (labels[item?.type]) this.status(labels[item.type]);
      }
    } else if (m.method === 'turn/completed') {
      if (m.params?.turn?.status !== 'completed') return this.close(new Error('네이티브 작업이 완료되지 않았습니다.'));
      if ([...a.deltas.keys()].some(id => !a.completed.has(id))) return this.close(new Error('네이티브 응답이 완성되기 전에 종료되었습니다.'));
      a.turnCompleted = true;
      this.finish();
    }
  }
  private hostTool(m: any) {
    const a = this.active, p = m.params;
    if (!a?.req.hostTools || !(a.req.hostTools.authorize?.(p?.tool, a.req.permissionMode) ?? a.req.permissionMode === 'full') || !a.turn || a.turnCompleted
      || p?.threadId !== this.thread || p?.turnId !== a.turn || p.namespace != null
      || typeof p.callId !== 'string' || p.callId.length > 200 || !p.callId
      || !a.req.hostTools.tools.some(tool => tool.name === p.tool)
      || a.pendingTool || a.toolCalls.has(p.callId) || a.toolCalls.size >= 512
      || Buffer.byteLength(JSON.stringify(p.arguments ?? {})) > 32_768) {
      this.send({ id: m.id, error: { code: -32602, message: 'Host capability correlation failed.' } });
      this.close(new Error('연결 도구의 대화·권한·중복 요청 검증에 실패했습니다.')); return;
    }
    a.toolCalls.add(p.callId); a.pendingTool = p.callId;
    this.status(p.tool === 'evidence_image' ? '원본 이미지 확인 중' : p.tool === 'evidence_text' ? '원본 문서 확인 중' : p.tool === 'evidence_python_syntax' ? '코드 문법 검사 중' : p.tool === 'evidence_python_values' ? '값·연산 검산 중' : p.tool === 'knowledge_lookup' ? '프로젝트 지식 조회 중' : p.tool.startsWith('agent_') ? '보조 작업 조율 중' : p.tool.startsWith('mcp_') ? '연결 도구 실행 중' : p.tool === 'desktop_act' ? 'PC 조작 중 · 결과 확인 대기' : 'PC 화면 확인 중');
    const timeoutMs = a.req.hostTools.timeoutMs?.(p.tool) ?? 25_000;
    const timer = setTimeout(() => this.close(new Error('연결 도구가 응답하지 않아 중단했습니다.')), Number.isFinite(timeoutMs) ? Math.max(1000, Math.min(90_000, timeoutMs)) : 25_000);
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
    a.toolEvents.finish();
    a.rawToolEvents.clear();
    a.delegation?.finish();
    clearTimeout(a.timer); clearInterval(a.heartbeat); clearTimeout(a.interruptTimer); clearTimeout(a.steering?.timer);
    a.unsubscribe?.(); a.req.signal?.removeEventListener('abort', a.abort);
    clearTimeout(a.toolTimer); a.toolAbort.abort(); a.req.hostTools?.dispose();
  } }
  close(error?: Error) {
    if (this.closed) return;
    if (this.active) this.mark('failed');
    this.closed = true; clearTimeout(this.idle); this.release();
    const interrupted = this.active;
    if (interrupted) {
      try { this.store.set(this.key); } catch { /* checkpoint was cleared before the turn */ }
      this.active = undefined;
    }
    this.buffer = ''; this.checkpoint = undefined;
    if (workers.get(this.key) === this) workers.delete(this.key);
    this.retirement.retire();
    if (interrupted) {
      const failure = error ?? new Error('네이티브 연결이 종료되었습니다.');
      // Do not release the caller's execution/admission lock while native
      // helpers can still have side effects. This also covers cancellation
      // before their spawn event has arrived; opt-in alone requires draining.
      if (interrupted.delegation) void this.retirement.waitUntilClosed().then(() => interrupted.reject(failure), () => {
        interrupted.reject(new Error(`${failure.message} 이전 네이티브 실행 종료를 확인하지 못했습니다.`));
      });
      else interrupted.reject(failure);
    }
  }
}

export async function pooledNativeCodex(options: Options): Promise<ProviderResult> {
  const startedAt = performance.now();
  const marked = new Set<ProviderTiming['stage']>();
  const mark = (stage: ProviderTiming['stage']) => {
    if (marked.has(stage)) return;
    marked.add(stage);
    try { options.req.onTiming?.({ transport: 'codex-native', stage, elapsedMs: Math.round((performance.now() - startedAt) * 1000) / 1000, reused: false }); } catch { /* metadata only */ }
  };
  const epoch = runtimeEpoch;
  const s = options.req.session;
  if (!s || options.req.permissionMode === 'ask') throw new Error('검증된 네이티브 세션과 실행 승인이 필요합니다.');
  const delegationLimit = nativeDelegationLimit(options.req);
  if (options.req.hostTools?.tools.some(t => !(options.req.hostTools!.authorize?.(t.name, options.req.permissionMode) ?? options.req.permissionMode === 'full'))) throw new Error('현재 권한에서 허용되지 않은 연결 도구입니다.');
  options.req.signal?.throwIfAborted();
  const key = digest([s.key, resolve(s.directory), options.providerId, options.model, options.command, options.prefixArgs,
    digest(options.env), resolve(options.req.cwd), options.req.permissionMode, s.instructions, options.req.hostTools?.tools ?? null,
    options.req.daybreakEnabled === true, delegationLimit, delegationLimit ? options.req.reasoningEffort ?? 'auto' : null]);
  const release = await scheduler.acquire(key, options.req.signal, position => options.req.onStatus?.(`네이티브 실행 대기 · ${position}번째 · 앞선 작업 완료 시 자동 시작`));
  mark('queue');
  try { while (true) {
    await waitForCliRetirements(options.env, options.req.signal);
    mark('retirement');
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
    return await worker.run(options.req, startedAt);
  } } finally { release(); }
}
export function closeNativeWorkers() { runtimeEpoch++; scheduler.cancelPending(); for (const worker of [...workers.values()]) worker.close(); }
