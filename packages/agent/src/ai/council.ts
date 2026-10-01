import type { RoutingMode } from '@mr-robot/shared';

export interface CouncilLimits {
  /** Total deliberation budget; final verification gets its own turn afterwards. */
  deliberationMs: number;
  nodeMs: number;
  /** Brief opportunity for more evidence once enough proposals have arrived. */
  graceMs: number;
}

export function councilLimits(mode: RoutingMode): CouncilLimits {
  if (mode === 'economy') return { deliberationMs: 45_000, nodeMs: 30_000, graceMs: 5_000 };
  if (mode === 'balanced') return { deliberationMs: 75_000, nodeMs: 60_000, graceMs: 10_000 };
  return { deliberationMs: 90_000, nodeMs: 75_000, graceMs: 15_000 };
}

export type CouncilState = 'running' | 'completed' | 'failed' | 'timed_out' | 'superseded' | 'cancelled' | 'skipped';
export interface CouncilEvent {
  id: string;
  state: CouncilState;
  elapsedMs: number;
}
export interface CouncilOutcome<T> extends CouncilEvent {
  value?: T;
}

class CouncilStop extends Error {
  constructor(readonly state: 'timed_out' | 'superseded') { super(state); }
}

/** Stop awaiting even a broken adapter that ignores abort. Late results are discarded. */
export function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    operation.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

/** Analysis only: never grants tools, authority, retries, or a different model. */
export class Council {
  private readonly deadline: number;
  private emit(event: CouncilEvent): void {
    // A disconnected progress consumer cannot change the execution outcome.
    try { this.options.onEvent?.(event); } catch { /* best-effort progress */ }
  }
  constructor(private readonly options: {
    limits: CouncilLimits;
    signal: AbortSignal;
    isFatal(error: unknown): boolean;
    onEvent?(event: CouncilEvent): void;
  }) {
    for (const value of Object.values(options.limits)) {
      if (!Number.isFinite(value) || value < 1 || value > 600_000) throw new Error('Invalid council time budget');
    }
    this.deadline = performance.now() + options.limits.deliberationMs;
  }

  async collect<T>(jobs: Array<{ id: string; run(signal: AbortSignal): Promise<T> }>): Promise<CouncilOutcome<T>[]> {
    const { signal: parent, limits } = this.options;
    parent.throwIfAborted();
    const remaining = this.deadline - performance.now();
    if (remaining <= 0) return jobs.map(job => {
      const event = { id: job.id, state: 'skipped' as const, elapsedMs: 0 };
      this.emit(event);
      return event;
    });
    if (!jobs.length) return [];
    const batch = new AbortController();
    const batchSignal = AbortSignal.any([parent, batch.signal]);
    const budgetTimer = setTimeout(() => batch.abort(new CouncilStop('timed_out')), Math.ceil(remaining));
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let completed = 0;
    // This is an evidence threshold, NOT a correctness/consensus vote.
    const threshold = Math.ceil(jobs.length / 2);
    let fatal: unknown;
    try {
      const outcomes = await Promise.all(jobs.map(async job => {
        const start = performance.now();
        const local = new AbortController();
        const signal = AbortSignal.any([batchSignal, local.signal]);
        const timer = setTimeout(() => local.abort(new CouncilStop('timed_out')), limits.nodeMs);
        const event = (state: CouncilState): CouncilEvent => ({ id: job.id, state, elapsedMs: Math.round(performance.now() - start) });
        try {
          signal.throwIfAborted();
          this.emit(event('running'));
          const value = await untilAborted(Promise.resolve().then(() => {
            signal.throwIfAborted();
            return job.run(signal);
          }), signal);
          completed++;
          if (completed >= threshold && !graceTimer && !batchSignal.aborted) {
            graceTimer = setTimeout(() => batch.abort(new CouncilStop('superseded')), limits.graceMs);
          }
          const outcome = { ...event('completed'), value };
          this.emit(event('completed'));
          return outcome;
        } catch (error) {
          if (this.options.isFatal(error)) { fatal ??= error; batch.abort(error); }
          const state: CouncilState = parent.aborted || fatal ? 'cancelled'
            : signal.aborted && signal.reason instanceof CouncilStop ? signal.reason.state : 'failed';
          const outcome = event(state);
          // No provider errors, prompts, model output or credentials in telemetry.
          this.emit(outcome);
          return outcome;
        } finally { clearTimeout(timer); }
      }));
      if (fatal) throw fatal;
      parent.throwIfAborted();
      return outcomes;
    } finally {
      clearTimeout(budgetTimer);
      clearTimeout(graceTimer);
      if (!batch.signal.aborted) batch.abort(new CouncilStop('superseded'));
    }
  }
}
