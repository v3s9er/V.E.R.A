import { join } from 'node:path';
import { isPluginCategory, type PluginCategory, type PluginInfo } from '@mr-robot/shared';
import type { EventBus } from '../eventbus.js';
import type { Logger } from '../logger.js';
import type { Computer } from '../computer/index.js';
import type { ProviderRegistry } from '../ai/registry.js';
import type { ConfigStore } from '../config.js';
import type { NeutralTool } from '../ai/provider.js';
import { PluginCommandRegistry, type PluginExecutionContext } from './commands.js';
import { PluginContextImpl } from './context.js';
import { extractPlugin, loadPluginModule, unloadPluginModule, withTimeout, type MrRobotPlugin, type LoadedModule } from './loader.js';
import { PluginStorage } from './storage.js';

interface LoadedPlugin {
  info: PluginInfo;
  plugin: MrRobotPlugin;
  module?: LoadedModule;
  ctx: PluginContextImpl;
}

const BUILTIN_CATEGORY_DEFAULTS: Readonly<Record<string, PluginCategory>> = {
  calendar: 'productivity',
  'voice-wake': 'productivity',
  orca: 'development',
  'mcp-host': 'development',
  'docker-sandbox': 'pentest',
  'ctf-toolpack': 'pentest',
};

function defaultCategory(plugin: MrRobotPlugin, builtin: boolean): PluginCategory {
  if (isPluginCategory(plugin.manifest.category)) return plugin.manifest.category;
  if (!builtin) return 'other';
  return BUILTIN_CATEGORY_DEFAULTS[plugin.manifest.id] ?? 'system';
}

/**
 * Owns every live plugin and guarantees clean attach/detach:
 *
 *   load  -> fresh module (cache-busted import / require) -> activate(ctx)
 *   unload-> deactivate(ctx) -> ctx.dispose() (listeners, timers, commands)
 *            -> module-cache eviction -> reference dropped -> GC can reclaim.
 *
 * Nothing survives an unload: no event listeners, no timers, no command
 * handlers, no module-cache entries. This is verified by the test suite
 * (load/unload cycles must leave listener/timer counts unchanged).
 */
export class PluginManager {
  readonly commands = new PluginCommandRegistry();
  private readonly storage: PluginStorage;
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly hostState: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void };

  constructor(
    private readonly bus: EventBus,
    private readonly computer: Computer,
    private readonly registry: ProviderRegistry,
    config: ConfigStore,
    private readonly logger: Logger,
  ) {
    this.storage = new PluginStorage(join(config.dir, 'plugins'));
    this.hostState = this.storage.for('_host');
  }

  list(): PluginInfo[] {
    return [...this.plugins.values()].map((p) => ({
      ...p.info,
      commands: this.commands.list(p.info.id).map((c) => c.name),
      subscriptions: p.ctx.subscriptionCount,
      timers: p.ctx.timerCount,
    }));
  }

  get(id: string): LoadedPlugin | undefined {
    return this.plugins.get(id);
  }

  async load(source: string): Promise<PluginInfo> {
    const module = await loadPluginModule(source);
    const plugin = extractPlugin(module.mod);
    const { id } = plugin.manifest;
    if (this.plugins.has(id)) throw new Error(`plugin "${id}" is already loaded`);

    const logger = this.logger.child(`plugin:${id}`);
    const ctx = new PluginContextImpl(id, logger, this.bus, this.computer, this.registry, this.storage, this.commands);

    try {
      await withTimeout(plugin.activate?.(ctx), 10000, `plugin ${id} activate`);
    } catch (err) {
      ctx.dispose();
      unloadPluginModule(module);
      throw new Error(`plugin "${id}" activate failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const info: PluginInfo = {
      id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      description: plugin.manifest.description ?? '',
      status: 'loaded',
      kind: plugin.manifest.kind ?? 'integration',
      category: this.savedCategory(id) ?? defaultCategory(plugin, false),
      builtin: false,
      enabled: this.hostState.get<boolean>(`enabled:${id}`) ?? plugin.manifest.enabledByDefault !== false,
      capabilities: plugin.manifest.capabilities ?? [],
      permissions: plugin.manifest.permissions ?? [],
      dependencies: plugin.manifest.dependencies ?? [],
      source: module.file,
      commands: this.commands.list(id).map((c) => c.name),
      subscriptions: ctx.subscriptionCount,
      timers: ctx.timerCount,
    };
    this.plugins.set(id, { info, plugin, module, ctx });
    this.logger.info(`plugin loaded: ${id} v${plugin.manifest.version}`);
    this.bus.emit('plugins.changed', this.list());
    return info;
  }

  /** Load a first-party plugin that is bundled into the agent executable. */
  async loadBuiltin(plugin: MrRobotPlugin): Promise<PluginInfo> {
    const { id } = plugin.manifest;
    if (this.plugins.has(id)) return this.plugins.get(id)!.info;
    const logger = this.logger.child(`plugin:${id}`);
    const ctx = new PluginContextImpl(id, logger, this.bus, this.computer, this.registry, this.storage, this.commands);
    try {
      await withTimeout(plugin.activate?.(ctx), 10000, `plugin ${id} activate`);
    } catch (err) {
      ctx.dispose();
      throw new Error(`plugin "${id}" activate failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const info: PluginInfo = {
      id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      description: plugin.manifest.description ?? '',
      status: 'loaded',
      kind: plugin.manifest.kind ?? 'integration',
      category: this.savedCategory(id) ?? defaultCategory(plugin, true),
      builtin: true,
      enabled: this.hostState.get<boolean>(`enabled:${id}`) ?? plugin.manifest.enabledByDefault !== false,
      capabilities: plugin.manifest.capabilities ?? [],
      permissions: plugin.manifest.permissions ?? [],
      dependencies: plugin.manifest.dependencies ?? [],
      source: `builtin:${id}`,
      commands: this.commands.list(id).map((c) => c.name),
      subscriptions: ctx.subscriptionCount,
      timers: ctx.timerCount,
    };
    this.plugins.set(id, { info, plugin, ctx });
    this.logger.info(`built-in plugin loaded: ${id} v${plugin.manifest.version}`);
    this.bus.emit('plugins.changed', this.list());
    return info;
  }

  async unload(id: string): Promise<boolean> {
    const p = this.plugins.get(id);
    if (!p) return false;

    // 1. Let the plugin clean up after itself (bounded).
    try {
      await withTimeout(p.plugin.deactivate?.(p.ctx), 3000, `plugin ${id} deactivate`);
    } catch (err) {
      this.logger.warn(`plugin ${id} deactivate error: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 2. Deterministic teardown of everything the context tracked.
    p.ctx.dispose();
    // 3. Evict the module from the (CJS) cache / drop the ESM reference.
    if (p.module) unloadPluginModule(p.module);
    // 4. Drop the last reference so the module + closures are collectable.
    this.plugins.delete(id);

    this.logger.info(`plugin unloaded: ${id}`);
    this.bus.emit('plugins.changed', this.list());
    return true;
  }

  async unloadAll(): Promise<void> {
    for (const id of [...this.plugins.keys()]) await this.unload(id);
  }

  /** Commands plugins declared as AI tools. */
  aiTools(userMessage = ''): NeutralTool[] {
    return this.commands.aiTools(userMessage).filter((tool) => {
      const owner = this.commands.get(tool.name)?.pluginId;
      return owner ? this.plugins.get(owner)?.info.enabled !== false : false;
    });
  }

  setEnabled(id: string, enabled: boolean): PluginInfo {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error('플러그인을 찾을 수 없습니다.');
    plugin.info.enabled = enabled;
    this.hostState.set(`enabled:${id}`, enabled);
    this.bus.emit('plugins.changed', this.list());
    return { ...plugin.info };
  }

  /** Persist an administrator catalog override independently of plugin code. */
  setCategory(id: string, category: PluginCategory): PluginInfo {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error('플러그인을 찾을 수 없습니다.');
    if (!isPluginCategory(category)) throw new Error('지원하지 않는 플러그인 카테고리입니다.');
    plugin.info.category = category;
    this.hostState.set(`category:${id}`, category);
    this.bus.emit('plugins.changed', this.list());
    return { ...plugin.info };
  }

  private savedCategory(id: string): PluginCategory | undefined {
    const value = this.hostState.get<unknown>(`category:${id}`);
    return isPluginCategory(value) ? value : undefined;
  }

  isDestructive(name: string): boolean {
    return this.commands.get(name)?.destructive ?? true;
  }

  isAdminOnly(name: string): boolean {
    return this.commands.get(name)?.adminOnly ?? false;
  }

  requiredCapability(name: string): string | undefined {
    return this.commands.get(name)?.requiredCapability;
  }

  /** Invoke a plugin-registered command (RPC entry point). */
  async call(name: string, params: unknown, execution?: PluginExecutionContext): Promise<unknown> {
    const cmd = this.commands.get(name);
    if (!cmd) throw new Error(`unknown plugin command: ${name}`);
    const plugin = this.plugins.get(cmd.pluginId);
    const isControl = /(?:\.status|\.config\.(?:get|set)|\.servers\.(?:list|add|remove))$/.test(name);
    if (plugin?.info.enabled === false && !isControl) throw new Error(`${plugin.info.name} 플러그인이 꺼져 있습니다.`);
    execution?.signal?.throwIfAborted();
    const result = await cmd.handler(params, execution);
    execution?.signal?.throwIfAborted();
    return result;
  }
}
