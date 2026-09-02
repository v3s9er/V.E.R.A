import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginContext } from './context.js';
import { isPluginCategory, type PluginCategory, type PluginDependency, type PluginKind, type PluginPermission } from '@mr-robot/shared';

const require = createRequire(import.meta.url);

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  kind?: PluginKind;
  /** Catalog section. Older plugins may omit this and receive a host default. */
  category?: PluginCategory;
  capabilities?: string[];
  permissions?: PluginPermission[];
  dependencies?: PluginDependency[];
  /** Built-ins may stay loaded but disable their active behavior through plugin settings. */
  enabledByDefault?: boolean;
}

export interface MrRobotPlugin {
  manifest: PluginManifest;
  activate?(ctx: PluginContext): void | Promise<void>;
  deactivate?(ctx: PluginContext): void | Promise<void>;
}

export interface LoadedModule {
  mod: unknown;
  kind: 'esm' | 'cjs';
  file: string;
  /** require() cache key (CJS only) — deleted on unload. */
  cacheKey?: string;
}

/** Resolve a plugin path (file, or directory containing an index). */
export function resolvePluginPath(source: string): string {
  let file = resolve(source);
  if (existsSync(file) && statSync(file).isDirectory()) {
    for (const candidate of ['index.js', 'index.mjs', 'index.cjs', 'plugin.js', 'main.js']) {
      const p = resolve(file, candidate);
      if (existsSync(p)) {
        file = p;
        break;
      }
    }
  }
  if (!existsSync(file)) throw new Error(`plugin not found: ${file}`);
  return file;
}

/**
 * Load a plugin module.
 *
 * ESM plugins are imported through a URL keyed by the file's mtime. An
 * UNCHANGED file always resolves to the same URL, so Node reuses the cached
 * module — repeated load/unload cycles add nothing to the ESM module map
 * (verified by the leak test). Editing the file bumps the mtime and yields a
 * fresh module. Because the module is reused, module-scope variables survive
 * a reload: per-load state belongs in the plugin context (ctx), which is
 * rebuilt — and torn down — on every load/unload.
 *
 * CJS plugins go through `require` and their cache entry is deleted on
 * unload (see {@link unloadPluginModule}).
 */
export async function loadPluginModule(source: string): Promise<LoadedModule> {
  const file = resolvePluginPath(source);
  if (file.endsWith('.cjs')) {
    const key = require.resolve(file);
    return { mod: require(key), kind: 'cjs', file, cacheKey: key };
  }
  const mtime = Math.round(statSync(file).mtimeMs);
  const url = `${pathToFileURL(file).href}?v=${mtime}`;
  const mod = await import(url);
  return { mod, kind: 'esm', file };
}

/** Drop the module-cache entry so nothing retains the plugin's code. */
export function unloadPluginModule(m: LoadedModule): void {
  if (m.kind === 'cjs' && m.cacheKey) {
    delete require.cache[m.cacheKey];
  }
  // ESM has no public cache-eviction API. The busted import URL guarantees a
  // fresh instance on the next load; dropping our reference lets GC reclaim it.
}

/** Extract the plugin object from whatever shape the module exports. */
export function extractPlugin(mod: unknown): MrRobotPlugin {
  if (!mod || typeof mod !== 'object') throw new Error('plugin module must export an object');
  const m = mod as Record<string, unknown>;
  const candidate = m.plugin ?? m.default;
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('plugin must export a `plugin` (or default) object');
  }
  const p = candidate as Record<string, unknown>;
  const manifest = p.manifest as PluginManifest | undefined;
  if (!manifest || typeof manifest.id !== 'string' || typeof manifest.name !== 'string') {
    throw new Error('plugin is missing a manifest { id, name, version }');
  }
  return {
    manifest: {
      id: manifest.id,
      name: manifest.name,
      version: String(manifest.version ?? '0.0.0'),
      description: typeof manifest.description === 'string' ? manifest.description : undefined,
      kind: manifest.kind,
      category: isPluginCategory(manifest.category) ? manifest.category : undefined,
      capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities.map(String) : undefined,
      permissions: Array.isArray(manifest.permissions) ? manifest.permissions : undefined,
      dependencies: Array.isArray(manifest.dependencies) ? manifest.dependencies : undefined,
      enabledByDefault: manifest.enabledByDefault,
    },
    activate: typeof p.activate === 'function' ? (p.activate as MrRobotPlugin['activate']) : undefined,
    deactivate: typeof p.deactivate === 'function' ? (p.deactivate as MrRobotPlugin['deactivate']) : undefined,
  };
}

/** Bound a possibly-hanging teardown so unload never blocks forever. */
export async function withTimeout<T>(p: Promise<T> | T | undefined, ms: number, label: string): Promise<T | undefined> {
  if (p === undefined) return undefined;
  const wrapped = Promise.resolve(p);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([wrapped, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
