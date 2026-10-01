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
      if (existsSync(this.file)) {
        const data: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        if (Array.isArray(data)) this.items = data.filter((item): item is MemoryItem => !!item && typeof item.id === 'string'
          && typeof item.text === 'string' && Array.isArray(item.tags) && item.tags.every((tag: unknown) => typeof tag === 'string')
          && Number.isFinite(item.createdAt) && Number.isFinite(item.updatedAt) && !Number.isNaN(new Date(item.updatedAt).valueOf())
          && [item.workspaceId, item.conversationId, item.source, item.supersededBy].every(value => value === undefined || typeof value === 'string')
          && (item.relation === undefined || item.relation && ['subject', 'predicate', 'object'].every(key => typeof item.relation[key] === 'string')));
      }
    } catch {
      this.items = [];
    }
  }

  list(): MemoryItem[] {
    return [...this.items].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  add(text: string, tags: string[] = [], scope: Pick<MemoryItem, 'workspaceId' | 'conversationId' | 'source' | 'relation'> = {}): MemoryItem {
    const relation = scope.relation;
    if (relation && ![relation.subject, relation.predicate, relation.object].every(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200)) throw new Error('관계의 대상·속성·값은 각각 1~200자여야 합니다.');
    const now = Date.now();
    const item: MemoryItem = { id: randomUUID(), text: text.trim().slice(0, 4000), tags: tags.map(String).slice(0, 12), createdAt: now, updatedAt: now,
      ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
      ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
      ...(scope.source ? { source: scope.source.slice(0, 500) } : {}),
      ...(relation ? { relation: { subject: relation.subject.trim(), predicate: relation.predicate.trim(), object: relation.object.trim() } } : {}),
    };
    if (!item.text) throw new Error('memory text is required');
    if (item.relation) for (const previous of this.items) {
      if (!previous.supersededBy && previous.workspaceId === item.workspaceId && previous.conversationId === item.conversationId
        && previous.relation?.subject === item.relation.subject && previous.relation?.predicate === item.relation.predicate) previous.supersededBy = item.id;
    }
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

  context(query: string, limit = 12, scope: Pick<MemoryItem, 'workspaceId' | 'conversationId'> = {}): string {
    const terms = [...new Set(query.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((x) => x.length > 1))].slice(0, 128);
    if (!terms.length) return '';
    return this.items
      .filter(item => !item.supersededBy && (!item.workspaceId || item.workspaceId === scope.workspaceId)
        && (!item.conversationId || item.conversationId === scope.conversationId))
      .map((item) => ({ item, score: terms.reduce((n, term) => n + (item.text.toLocaleLowerCase().includes(term) || item.tags.some((t) => t.toLocaleLowerCase().includes(term)) ? 1 : 0), 0) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt)
      .slice(0, Number.isFinite(limit) ? Math.max(0, Math.min(12, Math.floor(limit))) : 12)
      .map(({ item }) => `- [memory:${item.id}; updated:${new Date(item.updatedAt).toISOString()}; source:${JSON.stringify(item.source ?? 'legacy-user-memory')}] ${JSON.stringify(item.relation ? { text: item.text, relation: item.relation } : item.text)}`)
      .join('\n');
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }
}
