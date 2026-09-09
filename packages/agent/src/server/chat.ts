import { randomUUID } from 'node:crypto';
import type { ChatConfirmRequest } from '@mr-robot/shared';
import type { Turn } from '../ai/provider.js';

interface PendingConfirm {
  requestId: string;
  conversationId: string;
  conversationTitle: string;
  tool: string;
  input: unknown;
  summary: string;
  resolve: (ok: boolean) => void;
  timer: NodeJS.Timeout;
}

const CONFIRM_TIMEOUT_MS = 120_000;
const CANCEL_MESSAGES = {
  user: '작업이 중지되었습니다.',
  shutdown: 'PC 에이전트가 종료되어 작업이 중단되었습니다. 다시 연결한 후 요청하세요.',
  revoked: '연결된 기기의 권한이 변경되거나 해제되어 작업을 중단했습니다.',
  'discord-disconnected': 'Discord 연결이 끊겨 작업을 안전하게 중단했습니다. 재연결 후 다시 요청하세요.',
  'discord-authority': 'Discord 역할·권한 확인에 실패하거나 권한이 변경되어 작업을 중단했습니다. 연결과 역할을 확인한 후 다시 요청하세요.',
  'discord-transport': 'Discord와 PC 사이의 작업 연결 오류로 중단했습니다. 다시 연결한 후 요청하세요.',
} as const;
export type ChatCancelReason = keyof typeof CANCEL_MESSAGES;

/**
 * Per-connection chat state: the conversation turns plus the
 * approval-in-flight bookkeeping. One confirmation at a time (tool calls
 * execute sequentially), resolved by the owning device or by timeout.
 * A transient socket disconnect does not own or cancel this state.
 */
export class ChatSession {
  turns: Turn[] = [];
  /** Backward-compatible per-client selection; actual turns live in ConversationStore. */
  conversationId: string | null = null;
  busy = false;
  private abort: AbortController | null = null;
  private pending: PendingConfirm | null = null;
  private steering: string[] = [];
  private cancelReason?: ChatCancelReason;

  begin(): AbortController {
    this.cancelReason = undefined;
    this.abort = new AbortController();
    this.busy = true;
    return this.abort;
  }

  signal(): AbortSignal | undefined {
    return this.abort?.signal;
  }

  cancel(reason: ChatCancelReason = 'user'): void {
    if (this.abort && !this.abort.signal.aborted) {
      this.cancelReason = reason;
      this.abort.abort(new Error(CANCEL_MESSAGES[reason]));
    }
    this.settlePending(false);
    this.steering.length = 0;
  }

  cancellationMessage(): string | undefined {
    return this.abort?.signal.aborted && this.cancelReason ? CANCEL_MESSAGES[this.cancelReason] : undefined;
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

  /** Host-only snapshot. Callers must verify run ownership before returning it. */
  pendingConfirmForOwner(): ChatConfirmRequest | undefined {
    if (this.pending === null) return undefined;
    const { requestId, conversationId, conversationTitle, tool, summary } = this.pending;
    // Raw tool input is deliberately not replayed after reconnect. The
    // human-readable summary is enough to approve or reject the paused call.
    return { requestId, conversationId, conversationTitle, tool, input: undefined, summary };
  }

  end(): void {
    this.settlePending(false);
    this.steering.length = 0;
    this.abort = null;
    this.busy = false;
  }

  askConfirm(send: (event: string, data: unknown) => void, req: Omit<ChatConfirmRequest, 'requestId'>): Promise<boolean> {
    this.settlePending(false);
    return new Promise<boolean>((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => this.settlePending(false), CONFIRM_TIMEOUT_MS);
      timer.unref?.();
      this.pending = { requestId, ...req, resolve, timer };
      send('chat.confirm', { requestId, ...req });
    });
  }

  respondConfirm(requestId: string, conversationId: string, approve: boolean): boolean {
    if (!this.pending || this.pending.requestId !== requestId || this.pending.conversationId !== conversationId) return false;
    this.settlePending(approve);
    return true;
  }

  /** Settle everything during explicit cancellation or server shutdown. */
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
