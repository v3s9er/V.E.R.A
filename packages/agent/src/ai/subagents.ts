import { randomUUID } from 'node:crypto';

export type SubagentState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface SubagentSnapshot {
  agentId: string;
  label: string;
  providerId: string;
  model: string;
  state: SubagentState;
  /** Monotonic within one parent, including updates to different children. */
  sequence: number;
  turns: number;
  status: string;
  result?: string;
  error?: string;
  usage: { promptTokens: number; completionTokens: number };
}
export interface SubagentHistoryTurn { role: 'user' | 'assistant'; content: string }
export interface SubagentExecutionInput {
  agentId: string;
  task: string;
  context: string;
  /** New follow-ups only. The first invocation always has an empty array. */
  messages: string[];
  /** Previous acknowledged worker turns, never the parent's conversation. */
  history: SubagentHistoryTurn[];
  signal: AbortSignal;
  onStatus(status: string): void;
}
export interface SubagentManagerOptions {
  providerId: string;
  model: string;
  signal?: AbortSignal;
  /** Host-owned tuning may reduce, never exceed the existing two-worker cap. */
  maxParallel?: 1 | 2;
  /** Must honor cancellation; admission remains held until this promise settles. */
  execute(input: SubagentExecutionInput): Promise<{
    text: string;
    usage?: { promptTokens: number; completionTokens: number };
  }>;
  onUpdate?(snapshot: SubagentSnapshot): void;
}

const TASK_BYTES = 8 * 1024;
const CONTEXT_BYTES = 16 * 1024;
const RESULT_BYTES = 16 * 1024;
const INVOCATION_MS = 120_000;
const MAX_TURNS = 4;
const MAX_MESSAGES = 4;
const MAX_CHILDREN = 6;
const MAX_PARALLEL = 2;
const MAX_WAITERS = 32;

type AdmissionWaiter = {
  signal: AbortSignal;
  abort(): void;
  resolve(release: () => void): void;
  reject(error: unknown): void;
};

/** Independent of the native parent pool: waiting parents cannot occupy these slots. */
class SubagentAdmission {
  private running = 0;
  private queue: AdmissionWaiter[] = [];

  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.running >= 3 && this.queue.length >= 32) return Promise.reject(new Error('하위 에이전트 실행 대기열이 가득 찼습니다.'));
    return new Promise((resolve, reject) => {
      const waiter: AdmissionWaiter = { signal, resolve, reject, abort: () => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1);
        signal.removeEventListener('abort', waiter.abort);
        reject(signal.reason ?? new Error('하위 에이전트 실행 대기가 취소되었습니다.'));
      } };
      this.queue.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < 3 && this.queue.length) {
      const waiter = this.queue.shift()!;
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) { waiter.reject(waiter.signal.reason); continue; }
      this.running++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.running--;
        this.pump();
      });
    }
  }
}
const admission = new SubagentAdmission();

type Worker = {
  snapshot: SubagentSnapshot;
  task: string;
  context: string;
  controller: AbortController;
  messages: string[];
  acceptedMessages: number;
  history: SubagentHistoryTurn[];
};

function boundedInput(value: unknown, label: string, maximum: number, optional = false): string {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || (!optional && !value.trim())) throw new Error(`${label} 내용을 입력하세요.`);
  if (Buffer.byteLength(value, 'utf8') > maximum) throw new Error(`${label} 크기는 ${maximum}바이트를 넘을 수 없습니다.`);
  return value.trim();
}
function clip(value: string, maximum: number): string {
  const bytes = Buffer.from(value, 'utf8');
  return bytes.length <= maximum ? value : bytes.subarray(0, maximum).toString('utf8').replace(/\uFFFD$/u, '');
}
const terminal = (state: SubagentState) => state === 'completed' || state === 'failed' || state === 'cancelled';

/** One host-owned manager per user run. IDs, model and authority are never client supplied. */
export class SubagentManager {
  private workers = new Map<string, Worker>();
  private pending: Worker[] = [];
  private running = new Set<Promise<void>>();
  private listeners = new Set<() => void>();
  private sequence = 0;
  private disposed = false;
  private readonly abortParent = () => this.dispose();

  constructor(private readonly options: SubagentManagerOptions) {
    if (options.signal?.aborted) this.disposed = true;
    else options.signal?.addEventListener('abort', this.abortParent, { once: true });
  }

  spawn(input: { task: string; context?: string; label?: string }): { agentId: string } {
    this.assertOpen();
    if (this.workers.size >= MAX_CHILDREN) throw new Error('한 작업에서 하위 에이전트는 최대 6개까지 만들 수 있습니다.');
    const task = boundedInput(input.task, '작업', TASK_BYTES);
    const context = boundedInput(input.context, '문맥', CONTEXT_BYTES, true);
    const label = boundedInput(input.label, '이름', 160, true) || `작업자 ${this.workers.size + 1}`;
    const agentId = randomUUID();
    const worker: Worker = {
      task, context, controller: new AbortController(), messages: [], acceptedMessages: 0, history: [],
      snapshot: { agentId, label, providerId: this.options.providerId, model: this.options.model,
        state: 'queued', sequence: 0, turns: 0, status: '실행 대기 중', usage: { promptTokens: 0, completionTokens: 0 } },
    };
    this.workers.set(agentId, worker);
    this.pending.push(worker);
    this.publish(worker);
    this.pump();
    return { agentId };
  }

  list(): SubagentSnapshot[] { return [...this.workers.values()].map(worker => this.snapshot(worker)); }

  /** Account each settled provider call, including calls that finish after cancellation. */
  recordUsage(agentId: string, usage: { promptTokens: number; completionTokens: number }): void {
    const worker = this.owned(agentId);
    if (!usage || ![usage.promptTokens, usage.completionTokens].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return;
    const promptTokens = Math.min(Number.MAX_SAFE_INTEGER, worker.snapshot.usage.promptTokens + usage.promptTokens);
    const completionTokens = Math.min(Number.MAX_SAFE_INTEGER, worker.snapshot.usage.completionTokens + usage.completionTokens);
    if (promptTokens === worker.snapshot.usage.promptTokens && completionTokens === worker.snapshot.usage.completionTokens) return;
    worker.snapshot.usage = { promptTokens, completionTokens };
    this.publish(worker);
  }

  async wait(input: { agentIds?: string[]; afterSequence?: number; timeoutMs?: number } = {}, signal?: AbortSignal): Promise<SubagentSnapshot[]> {
    signal?.throwIfAborted();
    if (input.agentIds && (!Array.isArray(input.agentIds) || input.agentIds.length > MAX_CHILDREN)) throw new Error('대기할 하위 에이전트 목록이 올바르지 않습니다.');
    if (input.afterSequence !== undefined && (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0)) throw new Error('대기 순서가 올바르지 않습니다.');
    const selected = input.agentIds ? [...new Set(input.agentIds)].map(id => this.owned(id)) : [...this.workers.values()];
    const current = () => selected.map(worker => this.snapshot(worker));
    const ready = () => this.disposed || !selected.length || selected.some(worker => input.afterSequence === undefined
      ? terminal(worker.snapshot.state) : worker.snapshot.sequence > input.afterSequence!);
    const timeout = input.timeoutMs === undefined ? 15_000 : Number.isFinite(input.timeoutMs) ? Math.max(0, Math.min(15_000, input.timeoutMs)) : 15_000;
    if (ready() || timeout === 0) return current();
    if (this.listeners.size >= MAX_WAITERS) throw new Error('하위 에이전트 결과 대기가 너무 많습니다.');
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(update); signal?.removeEventListener('abort', abort); };
      const finish = () => { cleanup(); resolve(current()); };
      const update = () => { if (ready()) finish(); };
      const abort = () => { cleanup(); reject(signal?.reason ?? new Error('하위 에이전트 결과 대기가 취소되었습니다.')); };
      const timer = setTimeout(finish, timeout);
      this.listeners.add(update);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  message(input: { agentId: string; message: string }): { sequence: number; state: SubagentState } {
    this.assertOpen();
    const worker = this.owned(input.agentId);
    const message = boundedInput(input.message, '추가 지시', TASK_BYTES);
    if (worker.controller.signal.aborted || worker.snapshot.state === 'failed') throw new Error('종료되거나 실패한 하위 에이전트에는 추가 지시를 보낼 수 없습니다.');
    if (worker.snapshot.turns >= MAX_TURNS || worker.acceptedMessages >= MAX_MESSAGES) throw new Error('하위 에이전트의 추가 지시 또는 실행 횟수 한도에 도달했습니다.');
    worker.messages.push(message);
    worker.acceptedMessages++;
    if (worker.snapshot.state === 'completed') {
      worker.snapshot.state = 'queued';
      this.pending.push(worker);
    }
    worker.snapshot.status = '추가 지시 수신 · 다음 실행에 반영';
    this.publish(worker);
    this.pump();
    return { sequence: worker.snapshot.sequence, state: worker.snapshot.state };
  }

  cancel(agentId: string): void {
    const worker = this.owned(agentId);
    if (worker.snapshot.state === 'cancelled' || worker.snapshot.state === 'failed') return;
    if (worker.snapshot.state === 'completed') {
      worker.controller.abort(new Error('하위 에이전트가 종료되었습니다.'));
      return;
    }
    worker.controller.abort(new Error('하위 에이전트가 취소되었습니다.'));
    worker.messages = [];
    worker.snapshot.state = 'cancelled';
    worker.snapshot.status = '취소됨';
    this.pending = this.pending.filter(candidate => candidate !== worker);
    this.publish(worker);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.signal?.removeEventListener('abort', this.abortParent);
    for (const worker of this.workers.values()) this.cancel(worker.snapshot.agentId);
    this.pending = [];
    for (const listener of [...this.listeners]) listener();
  }

  /** Waits for actual executor settlement, so cancellation cannot free live provider slots early. */
  async drained(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('종료된 작업에서는 하위 에이전트를 실행할 수 없습니다.');
    this.options.signal?.throwIfAborted();
  }
  private owned(agentId: string): Worker {
    const worker = this.workers.get(agentId);
    if (!worker) throw new Error('이 작업에 속한 하위 에이전트가 아닙니다.');
    return worker;
  }
  private snapshot(worker: Worker): SubagentSnapshot {
    return { ...worker.snapshot, usage: { ...worker.snapshot.usage } };
  }
  private publish(worker: Worker): void {
    worker.snapshot.sequence = ++this.sequence;
    try { this.options.onUpdate?.(this.snapshot(worker)); } catch { /* Detached UI cannot strand execution. */ }
    for (const listener of [...this.listeners]) listener();
  }
  private pump(): void {
    while (!this.disposed && this.running.size < (this.options.maxParallel === 1 ? 1 : MAX_PARALLEL) && this.pending.length) {
      const worker = this.pending.shift()!;
      if (worker.controller.signal.aborted) continue;
      const task = this.run(worker).finally(() => { this.running.delete(task); this.pump(); });
      this.running.add(task);
    }
  }
  private async run(worker: Worker): Promise<void> {
    let release: (() => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort(worker.controller.signal.reason);
    worker.controller.signal.addEventListener('abort', abort, { once: true });
    try {
      release = await admission.acquire(worker.controller.signal);
      worker.controller.signal.throwIfAborted();
      const messages = worker.snapshot.turns ? worker.messages.splice(0) : [];
      worker.snapshot.turns++;
      worker.snapshot.state = 'running';
      worker.snapshot.status = '작업 중';
      this.publish(worker);
      controller.signal.throwIfAborted();
      timer = setTimeout(() => {
        worker.snapshot.state = 'failed';
        worker.snapshot.status = '실행 시간 초과';
        worker.snapshot.error = '하위 에이전트 실행이 120초를 초과했습니다.';
        worker.messages = [];
        controller.abort(new Error(worker.snapshot.error));
        this.publish(worker);
      }, INVOCATION_MS);
      const result = await this.options.execute({
        agentId: worker.snapshot.agentId, task: worker.task, context: worker.context,
        messages, history: worker.history.map(turn => ({ ...turn })), signal: controller.signal,
        onStatus: status => {
          if (controller.signal.aborted || typeof status !== 'string') return;
          const bounded = clip(status, 512);
          if (worker.snapshot.status === bounded) return;
          worker.snapshot.status = bounded;
          this.publish(worker);
        },
      });
      if (result.usage) this.recordUsage(worker.snapshot.agentId, result.usage);
      controller.signal.throwIfAborted();
      if (typeof result.text !== 'string') throw new Error('하위 에이전트 응답 형식이 올바르지 않습니다.');
      const text = clip(result.text, RESULT_BYTES);
      worker.history.push({ role: 'user', content: messages.length ? messages.join('\n\n') : worker.task }, { role: 'assistant', content: text });
      worker.snapshot.result = text;
      if (worker.messages.length && worker.snapshot.turns < MAX_TURNS) {
        worker.snapshot.state = 'queued';
        worker.snapshot.status = '추가 지시 실행 대기 중';
        this.pending.push(worker);
      } else {
        worker.snapshot.state = 'completed';
        worker.snapshot.status = '완료';
      }
      this.publish(worker);
    } catch (error) {
      if (!terminal(worker.snapshot.state)) {
        worker.snapshot.state = worker.controller.signal.aborted ? 'cancelled' : 'failed';
        worker.snapshot.status = worker.snapshot.state === 'cancelled' ? '취소됨' : '실행 실패';
        worker.snapshot.error = clip(error instanceof Error ? error.message : '하위 에이전트 실행에 실패했습니다.', 512);
        worker.messages = [];
        this.publish(worker);
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      worker.controller.signal.removeEventListener('abort', abort);
      release?.();
    }
  }
}
