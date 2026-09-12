import { randomUUID } from 'node:crypto';
import type { ChatRunActivity, ChatRunPhase, ChatRunState } from '@mr-robot/shared';

const TERMINAL = new Set<ChatRunPhase>(['completed', 'failed', 'cancelled']);
/** Run-local, bounded, host-owned state. No raw tool inputs or hidden reasoning.
 * Snapshots must only be served after the existing run-owner authorization. */
export class RunProgress {
  readonly runId = randomUUID();
  readonly startedAt: number;
  private updatedAt: number;
  private phase: ChatRunPhase = 'starting';
  private activity: ChatRunActivity[] = [];
  private partialText = '';
  private partialTextTruncated = false;
  private serial = 0;
  constructor(private now = Date.now) { this.startedAt = this.updatedAt = now(); }
  transition(phase: ChatRunPhase) {
    if (TERMINAL.has(this.phase) || (this.phase === 'cancelling' && !TERMINAL.has(phase))) return;
    this.phase = phase;
    this.updatedAt = this.now();
    if (TERMINAL.has(phase)) for (const item of this.activity) if (item.state === 'running') {
      item.state = phase === 'completed' ? 'done' : 'error'; item.finishedAt = this.updatedAt;
    }
  }
  text(delta: string) {
    if (TERMINAL.has(this.phase) || this.phase === 'cancelling') return false;
    const changed = this.phase !== 'answering';
    const combined = this.partialText + delta;
    this.partialTextTruncated ||= combined.length > 64000;
    this.partialText = combined.slice(-64000);
    this.transition('answering');
    return changed;
  }
  tool(info: { name: string; status: 'start' | 'done' | 'error'; callId?: string }) {
    if (TERMINAL.has(this.phase) || this.phase === 'cancelling') return;
    this.transition('working');
    const id = info.callId || info.name;
    if (info.status === 'start') {
      this.activity.push({ id: `${id}:${++this.serial}`, label: info.name.slice(0, 100), state: 'running', startedAt: this.now() });
      this.activity = this.activity.slice(-32);
    } else {
      const item = this.activity.find(item => item.id.startsWith(`${id}:`) && item.state === 'running');
      if (item) { item.state = info.status; item.finishedAt = this.now(); }
    }
  }
  snapshot(): Pick<ChatRunState, 'runId' | 'phase' | 'updatedAt' | 'activity' | 'partialText' | 'partialTextTruncated'> {
    return { runId: this.runId, phase: this.phase, updatedAt: this.updatedAt,
      activity: this.activity.map(item => ({ ...item })), partialText: this.partialText, partialTextTruncated: this.partialTextTruncated };
  }
}
