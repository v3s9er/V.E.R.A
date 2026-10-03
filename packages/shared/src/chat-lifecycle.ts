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
  finish(conversationId: string): void { this.pending.delete(conversationId); }
  clear(): void { this.pending.clear(); }
}
