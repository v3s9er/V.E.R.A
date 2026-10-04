import { projectRunConflicts } from './project-runs.js';

type Scope = { workspaceId?: string; permissionMode: string };
type Waiting = { scope: Scope; signal?: AbortSignal; grant: () => void; cancel: () => void };

/** FIFO per project, with concurrent readers. This is scheduling, not a filesystem sandbox. */
export class ProjectRunQueue {
  private active = new Set<Scope>();
  private waiting: Waiting[] = [];

  acquire(scope: Scope, signal?: AbortSignal, onQueued?: () => void): Promise<() => void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const item: Waiting = {
        scope, signal,
        grant: () => {
          signal?.removeEventListener('abort', item.cancel);
          this.active.add(scope);
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.active.delete(scope);
            this.drain();
          });
        },
        cancel: () => {
          this.waiting = this.waiting.filter(candidate => candidate !== item);
          signal?.removeEventListener('abort', item.cancel);
          reject(signal?.reason ?? new Error('작업이 중지되었습니다.'));
          this.drain();
        },
      };
      const blocked = projectRunConflicts(this.active, scope)
        || projectRunConflicts(this.waiting.map(value => value.scope), scope);
      if (!blocked) { item.grant(); return; }
      this.waiting.push(item);
      signal?.addEventListener('abort', item.cancel, { once: true });
      try { onQueued?.(); } catch (error) { item.cancel(); }
    });
  }

  private drain(): void {
    for (const item of [...this.waiting]) {
      if (!this.waiting.includes(item)) continue;
      if (item.signal?.aborted) { item.cancel(); continue; }
      const earlier = this.waiting.slice(0, this.waiting.indexOf(item));
      if (projectRunConflicts(this.active, item.scope)
        || projectRunConflicts(earlier.map(value => value.scope), item.scope)) continue;
      this.waiting = this.waiting.filter(candidate => candidate !== item);
      item.grant();
    }
  }
}
