import { randomUUID } from 'node:crypto';
import type { ChatConfirmRequest } from '@mr-robot/shared';
import type { Turn } from '../ai/provider.js';

interface PendingConfirm {
  requestId: string;
  resolve: (ok: boolean) => void;
  timer: NodeJS.Timeout;
}

const CONFIRM_TIMEOUT_MS = 120_000;

/**
 * Per-connection chat state: the conversation turns plus the
 * approval-in-flight bookkeeping. One confirmation at a time (tool calls
 * execute sequentially), resolved by the client or by timeout, and always
 * settled on disconnect — nothing is left dangling.
 */
export class ChatSession {
  turns: Turn[] = [];
  /** Backward-compatible per-client selection; actual turns live in ConversationStore. */
  conversationId: string | null = null;
  busy = false;
  private abort: AbortController | null = null;
  private pending: PendingConfirm | null = null;
  private steering: string[] = [];

  begin(): AbortController {
    this.abort = new AbortController();
    this.busy = true;
    return this.abort;
  }

  signal(): AbortSignal | undefined {
    return this.abort?.signal;
  }

  cancel(): void {
    this.abort?.abort();
  }

  steer(text: string): number {
    const clean = text.trim().slice(0, 8_000);
    if (!clean) return this.steering.length;
    this.steering.push(clean);
    if (this.steering.length > 20) this.steering.splice(0, this.steering.length - 20);
    return this.steering.length;
  }

  takeSteering(): string[] {
    return this.steering.splice(0);
  }

  get steeringQueued(): number {
    return this.steering.length;
  }

  end(): void {
    this.abort = null;
    this.busy = false;
  }

  askConfirm(send: (event: string, data: unknown) => void, req: Omit<ChatConfirmRequest, 'requestId'>): Promise<boolean> {
    this.settlePending(false);
    this.steering.length = 0;
    return new Promise<boolean>((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => this.settlePending(false), CONFIRM_TIMEOUT_MS);
      timer.unref?.();
      this.pending = { requestId, resolve, timer };
      send('chat.confirm', { requestId, ...req });
    });
  }

  respondConfirm(requestId: string, approve: boolean): boolean {
    if (!this.pending || this.pending.requestId !== requestId) return false;
    this.settlePending(approve);
    return true;
  }

  /** Settle everything — called on disconnect so no promise ever hangs. */
  reset(): void {
    this.cancel();
    this.end();
    this.settlePending(false);
  }

  private settlePending(ok: boolean): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const { resolve } = this.pending;
    this.pending = null;
    resolve(ok);
  }
}
