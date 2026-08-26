export type EventHandler = (...args: unknown[]) => void;

/**
 * Minimal typed event bus. Used both by the agent internals and by plugin
 * subscriptions (the plugin context tracks listeners created through it so
 * they can be removed deterministically on unload — no leaks).
 */
export class EventBus {
  private listeners = new Map<string, Set<EventHandler>>();

  on(event: string, handler: EventHandler): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  once(event: string, handler: EventHandler): () => void {
    const wrapper: EventHandler = (...args) => {
      this.off(event, wrapper);
      handler(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: string, handler: EventHandler): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.listeners.delete(event);
  }

  emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Snapshot so handlers that unsubscribe during emit do not break iteration.
    for (const handler of [...set]) {
      try {
        handler(...args);
      } catch (err) {
        // A misbehaving listener must never take down the bus.
        console.error(`[eventbus] handler error for "${event}":`, err);
      }
    }
  }

  removeAll(event?: string): void {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
