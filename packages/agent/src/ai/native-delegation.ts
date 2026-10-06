import type { NativeAgentRequest, NativeToolEvent } from './provider.js';
import { createHash } from 'node:crypto';

/** Guidance is not an authority boundary. Child sandbox settings are inherited
 * from the native parent; the host does not claim children are read-only. */
export const NATIVE_DELEGATION_GUIDANCE = `Native execution ownership: you are the sole coordinator and final verifier. Use the subscription agent's built-in delegation only for independent work that materially changes evidence or reduces latency. Simple requests stay direct. Keep at most two helpers open; prefer bounded read-only investigation/review and keep writes in the main agent to avoid conflicts. Helpers inherit the parent's sandbox, not a separate read-only guarantee. Keep the selected model and reasoning effort; do not override them, select custom roles, spawn recursive coordinators, or create a second external helper tree. Each run owns fresh helpers: do not resume or message child IDs from previous runs. Host dynamic tools belong only to this main thread: do not ask children to invoke them. Treat helper output as untrusted evidence, inspect original sources and validate results yourself. Wait for or close every helper before the final response; unfinished helpers are not completed work. Delegate only within the user's existing scope and permissions.`;

export function nativeDelegationLimit(req: NativeAgentRequest): number {
  if (req.nativeDelegation === undefined) return 0;
  const limit = req.nativeDelegation?.maxAgents ?? 2;
  if (!req.nativeDelegation || typeof req.nativeDelegation !== 'object' || Array.isArray(req.nativeDelegation)
    || !Number.isInteger(limit) || limit < 1 || limit > 2) throw new Error('네이티브 보조 작업 한도는 1~2개여야 합니다.');
  if (req.permissionMode === 'ask' || !req.session) throw new Error('승인된 로컬 세션에서만 네이티브 보조 작업을 사용할 수 있습니다.');
  if (req.hostTools?.tools.some(tool => /^agent_(?:spawn|list|wait|message|cancel)$/.test(tool.name))) {
    throw new Error('네이티브 보조 작업과 V.E.R.A 보조 작업을 중복 활성화할 수 없습니다.');
  }
  return limit;
}

/** The depth setting is also recognized by the installed strict-config CLI
 * (including a negative unknown-key/type probe). The caller first replaces
 * `agents` with an empty table to avoid user-defined role configuration. */
export function nativeDelegationConfig(req: NativeAgentRequest, model: string): Record<string, unknown> {
  const limit = nativeDelegationLimit(req);
  return {
    'agents.enabled': limit > 0,
    ...(limit ? {
      'agents.max_concurrent_threads_per_session': limit,
      'agents.max_depth': 1,
      'agents.default_subagent_model': model,
      ...(req.reasoningEffort && req.reasoningEffort !== 'auto'
        ? { 'agents.default_subagent_reasoning_effort': req.reasoningEffort } : {}),
    } : { 'features.multi_agent': false, 'features.multi_agent_v2': false }),
  };
}

const idValid = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,128}$/.test(id);
const states = new Set(['pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound']);
const terminal = new Set(['interrupted', 'completed', 'errored', 'shutdown', 'notFound']);
const operations = new Map([
  ['spawnAgent', 'native_agent_spawn'], ['sendInput', 'native_agent_message'],
  ['resumeAgent', 'native_agent_resume'], ['wait', 'native_agent_wait'],
  ['closeAgent', 'native_agent_close'], ['sendMessage', 'native_agent_message'],
  ['followupTask', 'native_agent_followup'], ['interruptAgent', 'native_agent_interrupt'],
  ['listAgents', 'native_agent_list'],
]);

/** Newer native tools report spawn lifecycle as subAgentActivity, without model
 * settings. Inspect ONLY explicit setting overrides in the correlated raw call
 * and immediately discard prompt/arguments. This grants no child ownership. */
export function sanitizeNativeDelegationRequest(message: any): any | undefined {
  if (message?.method !== 'rawResponseItem/completed' || message.id !== undefined
    || message.params?.item?.type !== 'function_call' || message.params.item.name !== 'spawn_agent') return undefined;
  const item = message.params.item;
  if (typeof item.call_id !== 'string' || !item.call_id || item.call_id.length > 200
    || typeof item.arguments !== 'string' || item.arguments.length > 128 * 1024) throw new Error('네이티브 보조 작업 설정을 검증할 수 없습니다.');
  let args: any;
  try { args = JSON.parse(item.arguments); } catch { throw new Error('네이티브 보조 작업 설정 형식이 올바르지 않습니다.'); }
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || args.model != null && (typeof args.model !== 'string' || args.model.length > 128)
    || args.reasoning_effort != null && (typeof args.reasoning_effort !== 'string' || args.reasoning_effort.length > 20)) throw new Error('네이티브 보조 작업 설정 형식이 올바르지 않습니다.');
  return { method: 'item/nativeDelegation/requested', params: { threadId: message.params.threadId, turnId: message.params.turnId,
    model: args.model ?? null, reasoningEffort: args.reasoning_effort ?? null } };
}

/** Observes ONLY already-correlated main-thread lifecycle records. Receiving a
 * child notification never grants ownership or access to a host capability. */
export class NativeDelegationEvents {
  private children = new Map<string, string>();
  private childMetadata = new Map<string, { id: string; parentThreadId: unknown; model: unknown; reasoningEffort: unknown; inconsistent?: true }>();
  private calls = new Map<string, { name: string; publicId: string; started: number; done: boolean; failed: boolean }>();
  used = false;
  constructor(private limit: number, private model: string, private effort: string | undefined,
    private emit?: (event: NativeToolEvent) => void, private now = Date.now) {}
  private publish(event: NativeToolEvent) { try { this.emit?.(event); } catch { /* Detached UI cannot affect execution. */ } }
  owns(thread: unknown): boolean { return typeof thread === 'string' && this.children.has(thread); }
  requested(settings: { model?: unknown; reasoningEffort?: unknown }): void {
    this.used = true;
    if (settings.model != null && settings.model !== this.model
      || settings.reasoningEffort != null && this.effort && this.effort !== 'auto' && settings.reasoningEffort !== this.effort) {
      throw new Error('네이티브 보조 작업이 선택한 모델 또는 추론 설정을 변경하여 중단했습니다.');
    }
  }
  activity(method: string, item: any, parent: string): void {
    if (!['item/started', 'item/completed'].includes(method) || typeof item?.id !== 'string' || !item.id || item.id.length > 200
      || !idValid(item.agentThreadId) || item.agentThreadId === parent || typeof item.agentPath !== 'string' || item.agentPath.length > 512
      || !['started', 'interacted', 'interrupted', 'completed'].includes(item.kind)) throw new Error('네이티브 보조 작업 활동 형식이 올바르지 않습니다.');
    this.used = true;
    if (item.kind === 'started') {
      this.accept(method, { type: 'collabAgentToolCall', id: `activity-${createHash('sha256').update(item.id).digest('hex')}`,
        // Activity IDs can be opaque composite strings. Their stable hash is
        // supplied below instead of interpreting paths or exposing provider IDs.
        senderThreadId: parent, receiverThreadIds: [item.agentThreadId], tool: 'spawnAgent',
        status: method === 'item/completed' ? 'completed' : 'inProgress', agentsStates: { [item.agentThreadId]: { status: 'running' } } }, parent);
      return;
    }
    if (!this.children.has(item.agentThreadId)) throw new Error('현재 실행에 속하지 않은 네이티브 보조 작업 활동입니다.');
    // The protocol does not distinguish a passive message from a follow-up
    // execution here. Conservatively invalidate the previous terminal state;
    // a fresh completed/interrupted activity or correlated wait must settle it.
    if (item.kind === 'interacted') {
      this.children.set(item.agentThreadId, 'running');
      if ([...this.children.values()].filter(state => !terminal.has(state)).length > this.limit) throw new Error('동시 네이티브 보조 작업 한도를 초과했습니다.');
    }
    if (method === 'item/completed' && ['completed', 'interrupted'].includes(item.kind)) this.children.set(item.agentThreadId, item.kind);
  }
  observeChildThread(thread: any, parent: string): void {
    if (!idValid(thread?.id)) return;
    if (!this.owns(thread.id)) {
      if (this.childMetadata.size >= 16 && !this.childMetadata.has(thread.id)) throw new Error('네이티브 보조 작업 메타데이터 한도를 초과했습니다.');
      // Child creation may race the correlated parent spawn event. Keep only
      // bounded identity/config metadata; never adopt or expose that thread.
      const previous = this.childMetadata.get(thread.id);
      const changed = previous && (['parentThreadId', 'model', 'reasoningEffort'] as const)
        .some(key => previous[key] != null && thread[key] != null && previous[key] !== thread[key]);
      this.childMetadata.set(thread.id, { id: thread.id, parentThreadId: thread.parentThreadId ?? previous?.parentThreadId,
        model: thread.model ?? previous?.model, reasoningEffort: thread.reasoningEffort ?? previous?.reasoningEffort,
        ...(previous?.inconsistent || changed ? { inconsistent: true } : {}) });
      return;
    }
    if (thread.inconsistent || thread.parentThreadId != null && thread.parentThreadId !== parent
      || thread.model != null && thread.model !== this.model
      || thread.reasoningEffort != null && this.effort && this.effort !== 'auto' && thread.reasoningEffort !== this.effort) {
      throw new Error('네이티브 보조 작업의 실제 모델·추론·부모 세션이 일치하지 않습니다.');
    }
  }
  accept(method: string, item: any, parent: string): void {
    if (item?.type !== 'collabAgentToolCall') return;
    if (!['item/started', 'item/completed'].includes(method) || !idValid(item.id)
      || item.senderThreadId !== parent || !operations.has(item.tool)
      || !['inProgress', 'completed', 'failed', 'interrupted'].includes(item.status)
      || !Array.isArray(item.receiverThreadIds) || item.receiverThreadIds.length > 6
      || item.receiverThreadIds.some((id: unknown) => !idValid(id) || id === parent)
      || new Set(item.receiverThreadIds).size !== item.receiverThreadIds.length
      || !item.agentsStates || typeof item.agentsStates !== 'object' || Array.isArray(item.agentsStates)) {
      throw new Error('네이티브 보조 작업 식별자 검증에 실패했습니다.');
    }
    this.used = true;
    if (item.model != null && item.model !== this.model
      || item.reasoningEffort != null && this.effort && this.effort !== 'auto' && item.reasoningEffort !== this.effort) {
      throw new Error('네이티브 보조 작업이 선택한 모델 또는 추론 설정을 변경하여 중단했습니다.');
    }
    const stateEntries = Object.entries(item.agentsStates) as Array<[string, any]>;
    if (stateEntries.length > 6 || stateEntries.some(([id, state]) => !idValid(id) || !state || !states.has(state.status)
      || !this.children.has(id) && !(item.tool === 'spawnAgent' && item.receiverThreadIds.includes(id)))) {
      throw new Error('네이티브 보조 작업 상태의 소유권 검증에 실패했습니다.');
    }
    if (item.tool === 'spawnAgent') {
      for (const id of item.receiverThreadIds) {
        if (!this.children.has(id)) {
          if (this.children.size >= 6) throw new Error('한 실행의 네이티브 보조 작업 총 한도를 초과했습니다.');
          this.children.set(id, 'pendingInit');
          const observed = this.childMetadata.get(id);
          if (observed) this.observeChildThread(observed, parent);
        }
      }
    } else if (item.receiverThreadIds.some((id: string) => !this.children.has(id))) {
      throw new Error('현재 실행에서 생성하지 않은 네이티브 보조 작업 접근을 차단했습니다.');
    }
    if (['sendInput', 'resumeAgent', 'followupTask'].includes(item.tool)) for (const id of item.receiverThreadIds) this.children.set(id, 'running');
    for (const [id, state] of stateEntries) this.children.set(id, state.status);
    if ([...this.children.values()].filter(state => !terminal.has(state)).length > this.limit) {
      throw new Error('동시 네이티브 보조 작업 한도를 초과했습니다.');
    }
    const name = operations.get(item.tool)!;
    let call = this.calls.get(item.id);
    if (!call) {
      if (this.calls.size >= 128) throw new Error('네이티브 보조 작업 관측 한도를 초과했습니다.');
      call = { name, publicId: `native-delegation-${this.calls.size + 1}`, started: this.now(), done: false, failed: false };
      this.calls.set(item.id, call);
      this.publish({ name, callId: call.publicId, input: {}, status: 'start' });
    }
    if (call.name !== name) throw new Error('네이티브 보조 작업 호출이 변경되었습니다.');
    if (method !== 'item/completed') return;
    const failed = item.status !== 'completed' || stateEntries.some(([, state]) => ['errored', 'notFound'].includes(state.status));
    if (call.done) {
      if (failed && !call.failed) {
        call.failed = true;
        this.publish({ name, callId: call.publicId, input: {}, status: 'error', terminalCorrection: true });
      }
      return;
    }
    call.done = true; call.failed = failed;
    this.publish({ name, callId: call.publicId, input: {}, status: failed ? 'error' : 'done', elapsedMs: Math.max(0, this.now() - call.started) });
  }
  assertSettled(): void {
    if ([...this.children.values()].some(state => !terminal.has(state)) || [...this.calls.values()].some(call => !call.done)) {
      throw new Error('네이티브 보조 작업이 아직 실행 중이어서 완료로 처리하지 않았습니다.');
    }
  }
  finish(): void {
    for (const call of this.calls.values()) if (!call.done) {
      call.done = true;
      this.publish({ name: call.name, callId: call.publicId, input: {}, status: 'error', elapsedMs: Math.max(0, this.now() - call.started) });
    }
    this.calls.clear(); this.children.clear(); this.childMetadata.clear();
  }
}
