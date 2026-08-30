import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

interface CacheEntry {
  path: string;
  mtimeMs: number;
  size: number;
  digest: string;
  buffer: Buffer;
  touchedAt: number;
}

export interface ContextEvidence {
  path: string;
  digest: string;
  excerpt: string;
  truncated: boolean;
}

/**
 * Content-addressed local context cache shared by every provider.
 *
 * It avoids repeated disk reads/parsing and gives each role a small evidence
 * pack. Providers still charge for the text they actually receive; no system
 * can share paid input tokens across unrelated model vendors.
 */
export class ContextBroker {
  private readonly entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private cachedBytes = 0;
  private lastPersistAt = 0;
  private readonly statsFile: string;

  constructor(
    home: string,
    private readonly maxEntries = 256,
    private readonly maxCacheBytes = 32 * 1024 * 1024,
    private readonly maxEntryBytes = 2 * 1024 * 1024,
  ) {
    const dir = join(home, 'context-cache');
    mkdirSync(dir, { recursive: true });
    this.statsFile = join(dir, 'stats.json');
  }

  read(path: string, maxBytes = 20_000): { content: string; digest: string; cached: boolean; truncated: boolean } {
    const target = resolve(path);
    const stat = statSync(target);
    if (!stat.isFile()) throw new Error('파일이 아닙니다.');
    const requestedBytes = Math.max(1, Math.min(
      Number.isFinite(maxBytes) ? Math.floor(maxBytes) : 20_000,
      this.maxEntryBytes,
      this.maxCacheBytes,
    ));
    const cached = this.entries.get(target);
    let entry: CacheEntry;
    let hit = false;
    if (
      cached
      && cached.mtimeMs === stat.mtimeMs
      && cached.size === stat.size
      && (cached.buffer.length >= requestedBytes || cached.buffer.length >= stat.size)
    ) {
      entry = cached;
      entry.touchedAt = Date.now();
      this.hits++;
      hit = true;
    } else {
      const bytesToRead = Math.min(stat.size, requestedBytes);
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const fd = openSync(target, 'r');
      let offset = 0;
      try {
        while (offset < bytesToRead) {
          const count = readSync(fd, buffer, offset, bytesToRead - offset, offset);
          if (count === 0) break;
          offset += count;
        }
      } finally {
        closeSync(fd);
      }
      const bounded = offset === buffer.length ? buffer : buffer.subarray(0, offset);
      if (cached) this.cachedBytes -= cached.buffer.length;
      entry = {
        path: target,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        digest: createHash('sha256')
          .update(bounded)
          .update(`:${stat.size}:${stat.mtimeMs}`)
          .digest('hex'),
        buffer: bounded,
        touchedAt: Date.now(),
      };
      this.entries.set(target, entry);
      this.cachedBytes += bounded.length;
      this.misses++;
      this.evict();
    }
    this.persistStats();
    return {
      content: entry.buffer.subarray(0, requestedBytes).toString('utf8'),
      digest: entry.digest,
      cached: hit,
      truncated: entry.size > requestedBytes,
    };
  }

  evidence(paths: string[], budget = 24_000): ContextEvidence[] {
    const unique = [...new Set(paths.map((value) => resolve(value)))].filter((path) => existsSync(path));
    const totalBudget = Math.max(0, Number.isFinite(budget) ? Math.floor(budget) : 24_000);
    if (!unique.length || totalBudget === 0) return [];
    // Never exceed the caller's context allowance. With a tiny budget prefer
    // one useful character from fewer files over silently expanding the pack.
    const selected = unique.slice(0, Math.min(12, totalBudget));
    let remaining = totalBudget;
    return selected.map((path, index) => {
      const filesLeft = selected.length - index;
      const allowance = Math.max(1, Math.floor(remaining / filesLeft));
      const value = this.read(path, allowance);
      const excerpt = value.content.slice(0, allowance);
      remaining -= excerpt.length;
      return {
        path,
        digest: value.digest,
        excerpt,
        truncated: value.truncated || value.content.length > excerpt.length,
      };
    });
  }

  rolePack(role: string, original: string, handoffs: Array<{ label: string; text: string }>, budget = 18_000): string {
    const relevant = handoffs.map((item) => ({
      label: item.label,
      text: this.compact(item.text, Math.max(1_200, Math.floor((budget - original.length) / Math.max(1, handoffs.length)))),
    }));
    return [
      `Original request:\n${this.compact(original, Math.min(8_000, budget))}`,
      relevant.length ? `Role-specific handoff for ${role}:\n${relevant.map((item) => `[${item.label}]\n${item.text}`).join('\n\n')}` : '',
    ].filter(Boolean).join('\n\n').slice(-budget);
  }

  stats(): { entries: number; hits: number; misses: number; savedReads: number; bytes: number; maxBytes: number } {
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      savedReads: this.hits,
      bytes: this.cachedBytes,
      maxBytes: this.maxCacheBytes,
    };
  }

  invalidate(path?: string): void {
    if (path) {
      const target = resolve(path);
      const entry = this.entries.get(target);
      if (entry) this.cachedBytes -= entry.buffer.length;
      this.entries.delete(target);
    } else {
      this.entries.clear();
      this.cachedBytes = 0;
    }
  }

  private compact(text: string, max: number): string {
    if (text.length <= max) return text;
    const head = Math.floor(max * 0.65);
    const tail = max - head;
    return `${text.slice(0, head)}\n…[context compacted]…\n${text.slice(-tail)}`;
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.cachedBytes > this.maxCacheBytes) {
      let oldest: CacheEntry | undefined;
      for (const entry of this.entries.values()) {
        if (!oldest || entry.touchedAt < oldest.touchedAt) oldest = entry;
      }
      if (!oldest) break;
      this.entries.delete(oldest.path);
      this.cachedBytes -= oldest.buffer.length;
    }
  }

  private persistStats(): void {
    const now = Date.now();
    if (now - this.lastPersistAt < 5_000) return;
    this.lastPersistAt = now;
    try {
      writeFileSync(this.statsFile, JSON.stringify({ ...this.stats(), updatedAt: now, cache: basename(this.statsFile) }), 'utf8');
    } catch {
      // Cache metrics must never break a user task.
    }
  }
}
