import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

interface CacheEntry {
  path: string;
  mtimeMs: number;
  size: number;
  digest: string;
  text: string;
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
  private readonly statsFile: string;

  constructor(home: string, private readonly maxEntries = 256) {
    const dir = join(home, 'context-cache');
    mkdirSync(dir, { recursive: true });
    this.statsFile = join(dir, 'stats.json');
  }

  read(path: string, maxBytes = 20_000): { content: string; digest: string; cached: boolean; truncated: boolean } {
    const target = resolve(path);
    const stat = statSync(target);
    if (!stat.isFile()) throw new Error('파일이 아닙니다.');
    const cached = this.entries.get(target);
    let entry: CacheEntry;
    let hit = false;
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      entry = cached;
      entry.touchedAt = Date.now();
      this.hits++;
      hit = true;
    } else {
      const buffer = readFileSync(target);
      const text = buffer.toString('utf8');
      entry = {
        path: target,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        digest: createHash('sha256').update(buffer).digest('hex'),
        text,
        touchedAt: Date.now(),
      };
      this.entries.set(target, entry);
      this.misses++;
      this.evict();
    }
    this.persistStats();
    return {
      content: entry.text.slice(0, Math.max(1, maxBytes)),
      digest: entry.digest,
      cached: hit,
      truncated: entry.text.length > maxBytes,
    };
  }

  evidence(paths: string[], budget = 24_000): ContextEvidence[] {
    const unique = [...new Set(paths.map((value) => resolve(value)))].filter((path) => existsSync(path));
    if (!unique.length) return [];
    const perFile = Math.max(1_500, Math.floor(budget / Math.min(unique.length, 12)));
    return unique.slice(0, 12).map((path) => {
      const value = this.read(path, perFile);
      return { path, digest: value.digest, excerpt: value.content, truncated: value.truncated };
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

  stats(): { entries: number; hits: number; misses: number; savedReads: number } {
    return { entries: this.entries.size, hits: this.hits, misses: this.misses, savedReads: this.hits };
  }

  invalidate(path?: string): void {
    if (path) this.entries.delete(resolve(path));
    else this.entries.clear();
  }

  private compact(text: string, max: number): string {
    if (text.length <= max) return text;
    const head = Math.floor(max * 0.65);
    const tail = max - head;
    return `${text.slice(0, head)}\n…[context compacted]…\n${text.slice(-tail)}`;
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return;
    const oldest = [...this.entries.values()].sort((a, b) => a.touchedAt - b.touchedAt)[0];
    if (oldest) this.entries.delete(oldest.path);
  }

  private persistStats(): void {
    try {
      writeFileSync(this.statsFile, JSON.stringify({ ...this.stats(), updatedAt: Date.now(), cache: basename(this.statsFile) }), 'utf8');
    } catch {
      // Cache metrics must never break a user task.
    }
  }
}
