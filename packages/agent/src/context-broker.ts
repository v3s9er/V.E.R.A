import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const MAX_EVIDENCE_PATHS = 128;
const MAX_PATH_CHARS = 4_096;
const MAX_HANDOFFS = 24;
const COMPACT_MARKER = '\n…[context truncated]…\n';

/** String budgets use UTF-16 code units, matching JavaScript string.length. */
function textBudget(value: number, fallback: number): number {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : fallback));
}

function prefix(text: string, max: number): string {
  let end = Math.min(text.length, max);
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
  return text.slice(0, end);
}

function suffix(text: string, max: number): string {
  let start = Math.max(0, text.length - max);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!) && /[\uD800-\uDBFF]/.test(text[start - 1]!)) start++;
  return text.slice(start);
}

function compact(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max < COMPACT_MARKER.length + 16) return `${prefix(text, max - 1)}…`;
  const contentBudget = max - COMPACT_MARKER.length;
  const headBudget = Math.ceil(contentBudget * 0.65);
  return `${prefix(text, headBudget)}${COMPACT_MARKER}${suffix(text, contentBudget - headBudget)}`;
}

function shortLabel(text: string, max: number): string {
  // Bound work as well as output: labels can originate in model-generated data.
  return `${prefix(text, max - 1).replace(/[\r\n\t]+/g, ' ')}${text.length > max - 1 ? '…' : ''}`;
}

function fairShares(lengths: number[], budget: number): number[] {
  const shares = lengths.map(() => 0);
  let remaining = budget;
  let active = lengths.map((_, index) => index).filter(index => lengths[index]! > 0);
  while (remaining > 0 && active.length) {
    const share = Math.max(1, Math.floor(remaining / active.length));
    for (const index of active) {
      const amount = Math.min(share, lengths[index]! - shares[index]!, remaining);
      shares[index]! += amount;
      remaining -= amount;
    }
    active = active.filter(index => shares[index]! < lengths[index]!);
  }
  return shares;
}

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
    if ([maxEntries, maxCacheBytes, maxEntryBytes].some(value => !Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError('Context cache limits must be non-negative safe integers.');
    }
    const dir = join(home, 'context-cache');
    mkdirSync(dir, { recursive: true });
    this.statsFile = join(dir, 'stats.json');
  }

  read(path: string, maxBytes = 20_000): { content: string; digest: string; cached: boolean; truncated: boolean } {
    const target = resolve(path);
    const stat = statSync(target);
    if (!stat.isFile()) throw new Error('파일이 아닙니다.');
    const requestedBytes = Math.min(
      textBudget(maxBytes, 20_000),
      this.maxEntryBytes,
      this.maxCacheBytes,
    );
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
    const bytes = entry.buffer.subarray(0, requestedBytes);
    // write() intentionally leaves an incomplete trailing UTF-8 character in
    // the decoder, unlike Buffer.toString() which invents a replacement glyph.
    let content = new StringDecoder('utf8').write(bytes);
    // Invalid source bytes can expand into three-byte replacement characters.
    // Keep even that decoded representation inside the advertised byte limit.
    if (Buffer.byteLength(content, 'utf8') > requestedBytes) {
      content = new StringDecoder('utf8').write(Buffer.from(content, 'utf8').subarray(0, requestedBytes));
    }
    return {
      content,
      digest: entry.digest,
      cached: hit,
      truncated: entry.size > bytes.length || content !== bytes.toString('utf8'),
    };
  }

  /** Excerpts share a UTF-16 character budget; bounded path/digest metadata is separate. */
  evidence(paths: string[], budget = 24_000): ContextEvidence[] {
    const totalBudget = textBudget(budget, 24_000);
    if (totalBudget === 0) return [];
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const value of paths.slice(0, MAX_EVIDENCE_PATHS)) {
      if (typeof value !== 'string' || value.length > MAX_PATH_CHARS) continue;
      const path = resolve(value);
      if (path.length > MAX_PATH_CHARS || seen.has(path) || !existsSync(path)) continue;
      seen.add(path);
      if (statSync(path).isFile()) unique.push(path);
      if (unique.length === 12) break;
    }
    if (!unique.length || totalBudget === 0) return [];
    // Never exceed the caller's context allowance. With a tiny budget prefer
    // one useful character from fewer files over silently expanding the pack.
    const selected = unique.slice(0, Math.min(12, totalBudget));
    let remaining = totalBudget;
    return selected.map((path, index) => {
      const filesLeft = selected.length - index;
      const allowance = Math.max(1, Math.floor(remaining / filesLeft));
      // UTF-8 needs at most three bytes per UTF-16 code unit. A byte allowance
      // equal to a character allowance needlessly discards Korean evidence.
      const value = this.read(path, Math.min(Number.MAX_SAFE_INTEGER, allowance * 3));
      const excerpt = prefix(value.content, allowance);
      remaining -= excerpt.length;
      return {
        path,
        digest: value.digest,
        excerpt,
        truncated: value.truncated || value.content.length > excerpt.length,
      };
    });
  }

  /** The complete returned string, including labels and notices, fits the UTF-16 budget. */
  rolePack(role: string, original: string, handoffs: Array<{ label: string; text: string }>, budget = 18_000): string {
    const totalBudget = textBudget(budget, 18_000);
    if (!totalBudget || (!original && !handoffs.length)) return '';
    const requestHeader = 'Original request:\n';
    const roleHeader = `\n\nRole-specific handoff for ${shortLabel(role, 48)}:\n`;
    const candidates = handoffs.slice(0, MAX_HANDOFFS).map(item => ({
      header: `[${shortLabel(item.label, 64)}]\n`, text: item.text,
    }));
    // Protect the task first. Small handoff contributions are reserved before
    // assigning the remaining payload to the original request, then shared
    // fairly among the selected handoffs. Headers and markers count too.
    const requestMinimum = original.length <= totalBudget
      ? original.length
      : Math.min(original.length, Math.max(1, Math.floor((totalBudget - requestHeader.length) * 0.6)));
    let count = candidates.length;
    for (; count > 0; count--) {
      const omitted = handoffs.length - count;
      const notice = omitted ? `\n\n[${omitted} handoffs omitted]` : '';
      const headerCost = requestHeader.length + roleHeader.length + notice.length + candidates.slice(0, count).reduce((sum, item, index) => sum + item.header.length + (index ? 2 : 0), 0);
      const minimums = candidates.slice(0, count).reduce((sum, item) => sum + Math.min(64, item.text.length), 0);
      if (headerCost + requestMinimum + minimums <= totalBudget) {
        const requestAllowance = Math.min(original.length, totalBudget - headerCost - minimums);
        const shares = fairShares(candidates.slice(0, count).map(item => item.text.length), totalBudget - headerCost - requestAllowance);
        return `${requestHeader}${compact(original, requestAllowance)}${roleHeader}${candidates.slice(0, count).map((item, index) => `${item.header}${compact(item.text, shares[index]!)}`).join('\n\n')}${notice}`;
      }
    }
    const fullNotice = handoffs.length ? `\n\n[${handoffs.length} handoffs omitted]` : '';
    // Prefer a shorter notice/header over shortening a request that still fits.
    const notice = original.length <= totalBudget && original.length + fullNotice.length > totalBudget ? '…' : fullNotice;
    const preservedRequest = original.length <= totalBudget ? original.length : Math.min(16, original.length);
    const header = requestHeader.length + preservedRequest + notice.length <= totalBudget ? requestHeader : '';
    if (header.length + notice.length + Math.min(16, original.length) <= totalBudget) {
      return `${header}${compact(original, totalBudget - header.length - notice.length)}${notice}`;
    }
    // At very small budgets the task and a one-character omission signal take
    // precedence over section labels or a verbose notice.
    const task = compact(original, Math.max(0, totalBudget - 1));
    return task.endsWith('…') ? task : `${task}…`;
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
