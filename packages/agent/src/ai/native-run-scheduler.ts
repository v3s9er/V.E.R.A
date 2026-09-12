type Waiter = {
  key: string; resolve(release: () => void): void; reject(error: Error): void;
  signal?: AbortSignal; abort(): void; onQueued?: (position: number) => void;
};

/** Bounded FIFO admission. Waiting jobs own no child process or polling timer. */
export class NativeRunScheduler {
  private running = 0;
  private keys = new Set<string>();
  private queue: Waiter[] = [];
  constructor(private capacity = 4, private maxPending = 32) {}

  acquire(key: string, signal?: AbortSignal, onQueued?: (position: number) => void): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.keys.has(key)) return Promise.reject(new Error('같은 대화의 네이티브 작업이 이미 실행 또는 대기 중입니다.'));
    if (this.running >= this.capacity && this.queue.length >= this.maxPending) return Promise.reject(new Error('네이티브 대기열이 가득 찼습니다. 잠시 후 다시 요청하세요.'));
    this.keys.add(key);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { key, signal, resolve, reject, onQueued, abort: () => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1); this.keys.delete(key);
        signal?.removeEventListener('abort', waiter.abort);
        reject(new Error('네이티브 실행 대기가 중지되었습니다.'));
        this.notify();
      } };
      this.queue.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.pump();
    });
  }

  cancelPending() {
    for (const waiter of this.queue.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.abort);
      this.keys.delete(waiter.key);
      waiter.reject(new Error('네이티브 실행 대기가 종료되었습니다.'));
    }
  }

  private notify() {
    this.queue.forEach((waiter, index) => {
      try { waiter.onQueued?.(index + 1); }
      catch { /* A detached progress consumer must not strand another job's slot. */ }
    });
  }
  private pump() {
    while (this.running < this.capacity && this.queue.length) {
      const waiter = this.queue.shift()!;
      waiter.signal?.removeEventListener('abort', waiter.abort);
      this.running++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true; this.running--; this.keys.delete(waiter.key); this.pump();
      });
    }
    this.notify();
  }
}
