import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemoryItem } from '@mr-robot/shared';

export class MemoryStore {
  private readonly file: string;
  private items: MemoryItem[] = [];

  constructor(home: string) {
    this.file = join(home, 'memory.json');
    try {
      if (existsSync(this.file)) this.items = JSON.parse(readFileSync(this.file, 'utf8')) as MemoryItem[];
    } catch {
      this.items = [];
    }
  }

  list(): MemoryItem[] {
    return [...this.items].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  add(text: string, tags: string[] = []): MemoryItem {
    const now = Date.now();
    const item: MemoryItem = { id: randomUUID(), text: text.trim().slice(0, 4000), tags: tags.map(String).slice(0, 12), createdAt: now, updatedAt: now };
    if (!item.text) throw new Error('memory text is required');
    this.items.push(item);
    this.save();
    return item;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((m) => m.id !== id);
    if (before === this.items.length) return false;
    this.save();
    return true;
  }

  context(query: string, limit = 12): string {
    const terms = query.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((x) => x.length > 1);
    return this.items
      .map((item) => ({ item, score: terms.reduce((n, term) => n + (item.text.toLocaleLowerCase().includes(term) || item.tags.some((t) => t.toLocaleLowerCase().includes(term)) ? 1 : 0), 0) }))
      .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt)
      .slice(0, limit)
      .map(({ item }) => `- ${item.text}`)
      .join('\n');
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }
}
