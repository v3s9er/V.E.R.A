import { randomUUID } from 'node:crypto';
import { isObservationLimitedStatus } from '@mr-robot/shared';
import type { ChatRunActivity, ChatRunPhase, ChatRunState, CoordinationAgent } from '@mr-robot/shared';

const TERMINAL = new Set<ChatRunPhase>(['completed', 'failed', 'cancelled']);
/** Run-local, bounded, host-owned state. No raw tool inputs or hidden reasoning.
 * Snapshots must only be served after the existing run-owner authorization. */
export class RunProgress {
  readonly runId = randomUUID();
  readonly startedAt: number;
  private updatedAt: number;
  private phase: ChatRunPhase = 'starting';
  private activity: ChatRunActivity[] = [];
  private activityTruncated = false;
  private activityHadErrors = false;
  private observationLimited = false;
  private partialText = '';
  private partialTextTruncated = false;
  private firstTextAt?: number;
  private serial = 0;
  private agents = new Map<string, CoordinationAgent>();
  constructor(private now = Date.now) { this.startedAt = this.updatedAt = now(); }
  transition(phase: ChatRunPhase) {
    if (TERMINAL.has(this.phase) || (this.phase === 'cancelling' && !TERMINAL.has(phase))) return;
    this.phase = phase;
    this.updatedAt = this.now();
    if (TERMINAL.has(phase)) for (const item of this.activity) if (item.state === 'running') {
      // Model completion is not proof that an unacknowledged tool succeeded.
      item.state = 'error'; item.finishedAt = this.updatedAt;
      this.activityHadErrors = true;
    }
    if (TERMINAL.has(phase)) for (const agent of this.agents.values()) if (agent.state === 'queued' || agent.state === 'running') {
      agent.state = phase === 'cancelled' ? 'cancelled' : 'failed';
      agent.status = '보조 작업의 완료 확인 없이 응답이 종료되었습니다.';
    }
  }
  text(delta: string) {
    if (!delta || TERMINAL.has(this.phase) || this.phase === 'cancelling') return false;
    this.firstTextAt ??= this.now();
    const changed = this.phase !== 'answering';
    const combined = this.partialText + delta;
    this.partialTextTruncated ||= combined.length > 64000;
    this.partialText = combined.slice(-64000);
    this.transition('answering');
    return changed;
  }
  /** First visible answer text, not a status/thinking event. Missing is not zero. */
  firstTextLatencyMs(): number | undefined {
    return this.firstTextAt === undefined ? undefined : Math.max(0, this.firstTextAt - this.startedAt);
  }
  status(status: string): void {
    if (TERMINAL.has(this.phase) || this.observationLimited || !isObservationLimitedStatus(status)) return;
    this.observationLimited = true;
    this.updatedAt = this.now();
  }
  tool(info: { name: string; status: 'start' | 'done' | 'error'; callId?: string }) {
    if (TERMINAL.has(this.phase) || this.phase === 'cancelling') return;
    this.transition('working');
    // Retain evidence even when its start row was already evicted. A boolean
    // stays bounded and replay-safe without inventing an exact error total.
    this.activityHadErrors ||= info.status === 'error';
    const id = info.callId || info.name;
    if (info.status === 'start') {
      if (info.callId && this.activity.some(item => item.id.slice(0, item.id.lastIndexOf(':')) === id)) return;
      this.activity.push({ id: `${id}:${++this.serial}`, label: info.name.slice(0, 100), state: 'running', startedAt: this.now() });
      this.activityTruncated ||= this.activity.length > 32;
      this.activity = this.activity.slice(-32);
    } else {
      const item = this.activity.find(item => item.id.slice(0, item.id.lastIndexOf(':')) === id
        && (item.state === 'running' || !!info.callId && info.status === 'error' && item.state === 'done'));
      if (item) { item.state = info.status; item.finishedAt = this.now(); }
    }
  }
  agent(snapshot: CoordinationAgent): void {
    if (TERMINAL.has(this.phase) || (!this.agents.has(snapshot.agentId) && this.agents.size >= 8)) return;
    // Explicit projection: results, assignments and tool inputs never reach
    // progress even if a caller passes an internal worker snapshot.
    this.agents.set(snapshot.agentId, {
      agentId: snapshot.agentId, label: snapshot.label.slice(0, 80), model: snapshot.model,
      providerId: snapshot.providerId, state: snapshot.state, sequence: snapshot.sequence,
      turns: snapshot.turns, status: snapshot.status.slice(0, 200), usage: { ...snapshot.usage },
    });
    this.updatedAt = this.now();
  }
  snapshot(): Pick<ChatRunState, 'runId' | 'phase' | 'updatedAt' | 'activity' | 'activityTruncated' | 'activityHadErrors' | 'observationLimited' | 'partialText' | 'partialTextTruncated' | 'agents'> {
    return { runId: this.runId, phase: this.phase, updatedAt: this.updatedAt,
      activity: this.activity.map(item => ({ ...item })), activityTruncated: this.activityTruncated, activityHadErrors: this.activityHadErrors,
      observationLimited: this.observationLimited,
      partialText: this.partialText, partialTextTruncated: this.partialTextTruncated,
      agents: [...this.agents.values()].map(agent => ({ ...agent, usage: { ...agent.usage } })) };
  }
}
