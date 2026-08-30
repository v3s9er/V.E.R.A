import type { EventHandler } from '../eventbus.js';
import type { Computer } from '../computer/index.js';
import type { Logger } from '../logger.js';
import type { ProviderRegistry } from '../ai/registry.js';
import type { PluginStorage } from './storage.js';
import { PluginCommandRegistry, type PluginExecutionContext, type RegisterCommandOptions } from './commands.js';

/**
 * Everything a plugin can hold on to, given out through this context.
 *
 * LEAK-FREE CONTRACT: plugins must use `ctx.on/once/setInterval/setTimeout`
 * (not raw globals) for anything they want to outlive a single call. The
 * context records every such resource and `dispose()` deterministically
 * removes them on unload — event subscriptions are unsubscribed, timers are
 * cleared, registered commands are dropped, and the context then releases
 * every reference so the plugin module can be garbage-collected.
 */
export interface PluginContext {
  readonly pluginId: string;
  readonly logger: Logger;

  /** Persistent per-plugin key-value storage (survives reloads). */
  readonly storage: {
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): void;
  };

  /** Register a command callable from any client via `plugin.call`. */
  registerCommand(
    name: string,
    handler: (params: unknown, execution?: PluginExecutionContext) => unknown | Promise<unknown>,
    opts?: RegisterCommandOptions,
  ): void;

  /** Subscribe to a server event. Auto-removed on unload. */
  on(event: string, handler: EventHandler): void;
  once(event: string, handler: EventHandler): void;
  /** Publish a namespaced event to clients or other plugins. */
  emit(event: string, data: unknown): void;

  /** Tracked timers — cleared on unload. */
  setInterval(fn: () => void, ms: number): NodeJS.Timeout;
  setTimeout(fn: () => void, ms: number): NodeJS.Timeout;
  clearInterval(t: NodeJS.Timeout): void;
  clearTimeout(t: NodeJS.Timeout): void;

  /** Direct (read-mostly) access to machine + AI capabilities. */
  readonly computer: Computer;
  readonly ai: { providerCount(): number };
}

export class PluginContextImpl implements PluginContext {
  readonly pluginId: string;
  readonly logger: Logger;
  private readonly subscriptions: Array<() => void> = [];
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    pluginId: string,
    logger: Logger,
    private readonly bus: { on: (e: string, h: EventHandler) => () => void; once: (e: string, h: EventHandler) => () => void; emit: (e: string, data: unknown) => void },
    readonly computer: Computer,
    private readonly registry: ProviderRegistry,
    private readonly pluginStorage: PluginStorage,
    private readonly commands: PluginCommandRegistry,
  ) {
    this.pluginId = pluginId;
    this.logger = logger;
  }

  get ai(): { providerCount(): number } {
    return { providerCount: () => this.registry.list().length };
  }

  get storage(): { get<T>(key: string): T | undefined; set(key: string, value: unknown): void } {
    return this.pluginStorage.for(this.pluginId);
  }

  on(event: string, handler: EventHandler): void {
    this.subscriptions.push(this.bus.on(event, handler));
  }

  once(event: string, handler: EventHandler): void {
    this.subscriptions.push(this.bus.once(event, handler));
  }

  emit(event: string, data: unknown): void {
    if (!event.startsWith(`${this.pluginId}.`) && !event.startsWith('voice.') && !event.startsWith('calendar.')) {
      throw new Error(`plugin events must be namespaced: ${this.pluginId}.*`);
    }
    this.bus.emit(event, data);
  }

  setInterval(fn: () => void, ms: number): NodeJS.Timeout {
    const t = setInterval(fn, ms);
    this.timers.add(t);
    return t;
  }

  setTimeout(fn: () => void, ms: number): NodeJS.Timeout {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  clearInterval(t: NodeJS.Timeout): void {
    clearInterval(t);
    this.timers.delete(t);
  }

  clearTimeout(t: NodeJS.Timeout): void {
    clearTimeout(t);
    this.timers.delete(t);
  }

  registerCommand(name: string, handler: (params: unknown, execution?: PluginExecutionContext) => unknown | Promise<unknown>, opts?: RegisterCommandOptions): void {
    this.commands.register(this.pluginId, name, handler, opts);
  }

  get subscriptionCount(): number {
    return this.subscriptions.length;
  }

  get timerCount(): number {
    return this.timers.size;
  }

  /**
   * Deterministic teardown. Order matters:
   * 1. unsubscribe every event listener,
   * 2. clear every timer,
   * 3. drop registered commands,
   * 4. release all references (arrays/sets emptied) so nothing retains the
   *    plugin's closures.
   */
  dispose(): void {
    for (const off of this.subscriptions) {
      try {
        off();
      } catch {
        /* ignore listener teardown errors */
      }
    }
    this.subscriptions.length = 0;
    for (const t of this.timers) clearInterval(t);
    this.timers.clear();
    this.commands.unregisterAll(this.pluginId);
  }
}
