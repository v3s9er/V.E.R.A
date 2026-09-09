/** Correlates RPC responses before consuming asynchronous lifecycle events.
 * IDs are adopted ONLY from matching thread/start/resume and turn/start replies.
 * Notifications cannot select a thread or authorize a tool call.
 */
export class CliSessionEvents {
  private thread = '';
  private opening = false;
  private startupIds: string[] = [];
  private pending: any[] = [];
  private pendingBytes = 0;
  private finished = new Set<string>();
  turnRequest?: number;
  turn = '';
  beginThread() { this.opening = true; this.thread = ''; this.startupIds = []; this.finished.clear(); }
  bindThread(id: unknown, priorTurns?: unknown) {
    if (typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id) || this.startupIds.some(early => early !== id)) throw new Error('구독 대화 식별자가 일치하지 않습니다.');
    this.thread = id; this.opening = false; this.startupIds = [];
    // A resumed thread may publish its last usage event after the RPC reply.
    // Seed known finished turns from that verified reply, not from notifications.
    if (Array.isArray(priorTurns)) for (const turn of priorTurns.slice(-32)) {
      if (['completed', 'interrupted', 'failed'].includes(turn?.status)
        && typeof turn.id === 'string' && /^[\w-]{1,128}$/.test(turn.id)) this.finished.add(turn.id);
    }
  }
  beginTurn(request: number) { this.turnRequest = request; this.turn = ''; this.pending = []; this.pendingBytes = 0; }
  bindTurn(id: unknown): any[] {
    if (typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id) || this.finished.has(id)) throw new Error('구독 실행 식별자가 일치하지 않습니다.');
    // Validate the entire queue BEFORE exposing even one text delta/tool event.
    for (const m of this.pending) {
      const turn = m.params?.turnId ?? m.params?.turn?.id;
      if (turn != null && turn !== id) throw new Error('구독 실행 식별자가 일치하지 않습니다.');
    }
    this.turn = id; this.turnRequest = undefined;
    const events = this.pending; this.pending = []; this.pendingBytes = 0;
    return events;
  }
  complete() {
    if (this.turn) this.finished.add(this.turn);
    if (this.finished.size > 32) this.finished.delete(this.finished.values().next().value!);
    this.turn = ''; this.turnRequest = undefined; this.pending = []; this.pendingBytes = 0;
  }
  deferToolRequest(m: any): boolean {
    if (this.turnRequest === undefined) return false;
    if (!this.thread || m.params?.threadId !== this.thread || typeof m.params?.turnId !== 'string' || this.finished.has(m.params.turnId)) throw new Error('격리 도구 요청 검증에 실패했습니다.');
    this.enqueue(m);
    return true;
  }
  private enqueue(m: any) {
    this.pendingBytes += Buffer.byteLength(JSON.stringify(m));
    if (this.pending.length >= 128 || this.pendingBytes > 512 * 1024) throw new Error('구독 초기 응답 대기 한도를 초과했습니다.');
    this.pending.push(m);
  }
  /** False means ignored/queued; true means safe for the caller's event handler. */
  accept(m: any): boolean {
    if (typeof m.method !== 'string' || m.id !== undefined) return false;
    // Account notices and warnings can carry a threadId before thread/resume
    // finishes. They are not conversation output: ignore their payload entirely.
    if (!/^(?:thread\/|item\/|turn\/)/.test(m.method)) return false;
    const thread = m.params?.threadId ?? m.params?.thread?.id;
    if (thread != null) {
      if (!this.thread) {
        // Resume can also emit tokenUsage/updated and goal/cleared before its
        // reply. Retain only their identity hint; never consume startup payloads.
        if (!this.opening || !m.method.startsWith('thread/')
          || typeof thread !== 'string' || !/^[\w-]{1,128}$/.test(thread) || this.startupIds.length >= 32) throw new Error('구독 대화 초기화 순서가 올바르지 않습니다.');
        this.startupIds.push(thread);
        return false;
      }
      if (thread !== this.thread) throw new Error('구독 대화 식별자가 일치하지 않습니다.');
    }
    const turn = m.params?.turnId ?? m.params?.turn?.id;
    if (turn != null && this.finished.has(turn)) return false;
    if (!/^(?:item\/|turn\/|thread\/tokenUsage\/)/.test(m.method)) return false;
    if (this.turnRequest !== undefined) {
      this.enqueue(m);
      return false;
    }
    if (!this.turn) return false;
    if (turn != null && turn !== this.turn) throw new Error('구독 실행 식별자가 일치하지 않습니다.');
    return true;
  }
}
