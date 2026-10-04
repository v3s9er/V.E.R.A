/** A cancellation acknowledgement is not proof that execution has stopped. */
export async function watchChatSettlement(options: {
  conversationId: string;
  runId?: string;
  signal: { readonly aborted: boolean };
  wait(): Promise<void>;
  loadRuns(): Promise<unknown>;
  onRunning(): void;
  onSettled(): void;
  onUnavailable(): void;
}): Promise<void> {
  const { signal } = options;
  while (!signal.aborted) {
    await options.wait();
    if (signal.aborted) return;
    try {
      const value = await options.loadRuns();
      if (signal.aborted) return;
      // A failed/invalid snapshot is unknown, never an empty list of jobs.
      if (!Array.isArray(value) || value.some(run => !run || typeof run.conversationId !== 'string' || typeof run.running !== 'boolean')) throw new Error('Invalid run snapshot');
      const active = value.find(run => run.conversationId === options.conversationId && run.running);
      if (!active) { options.onSettled(); return; }
      // A newer request owns the conversation now. Never mutate its UI.
      if (options.runId && active.runId && options.runId !== active.runId) return;
      options.onRunning();
    } catch {
      if (!signal.aborted) options.onUnavailable();
    }
  }
}

/** Late RPC replies cannot finish a later request in the same conversation. */
export class ChatRequestOwnership {
  private readonly pending = new Map<string, object>();
  begin(conversationId: string): object {
    const token = {};
    this.pending.set(conversationId, token);
    return token;
  }
  owns(conversationId: string, token: object): boolean { return this.pending.get(conversationId) === token; }
  has(conversationId: string): boolean { return this.pending.has(conversationId); }
  finish(conversationId: string): void { this.pending.delete(conversationId); }
  clear(): void { this.pending.clear(); }
}

/** A reopened conversation must read settings after its own pending save settles. */
export class ConversationSaveBarrier {
  private readonly pending = new Map<string, { settled: Promise<void>; resolve(): void }>();
  has(conversationId: string): boolean { return this.pending.has(conversationId); }
  add(conversationId: string): void {
    if (this.pending.has(conversationId)) return;
    let resolve!: () => void;
    const settled = new Promise<void>(done => { resolve = done; });
    this.pending.set(conversationId, { settled, resolve });
  }
  delete(conversationId: string): void {
    const entry = this.pending.get(conversationId);
    this.pending.delete(conversationId);
    entry?.resolve();
  }
  async wait(conversationId: string): Promise<void> {
    while (this.pending.has(conversationId)) await this.pending.get(conversationId)!.settled;
  }
}
