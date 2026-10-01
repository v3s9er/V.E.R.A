import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemoryItem } from '@mr-robot/shared';
import { retrieveKnowledge, type KnowledgeResult } from './ontology.js';

export class MemoryStore {
  private readonly file: string;
  private items: MemoryItem[] = [];
  private readonly knowledgeCache = new Map<string, KnowledgeResult>();

  constructor(home: string) {
    this.file = join(home, 'memory.json');
    try {
      if (existsSync(this.file)) {
        const data: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        if (Array.isArray(data)) this.items = data.filter((item): item is MemoryItem => !!item && typeof item.id === 'string'
          && typeof item.text === 'string' && Array.isArray(item.tags) && item.tags.every((tag: unknown) => typeof tag === 'string')
          && Number.isFinite(item.createdAt) && Number.isFinite(item.updatedAt) && !Number.isNaN(new Date(item.updatedAt).valueOf())
          && [item.workspaceId, item.conversationId, item.source, item.supersededBy].every(value => value === undefined || typeof value === 'string')
          && (item.relationMode === undefined || item.relationMode === 'fact')
          && (item.relation === undefined || item.relation && ['subject', 'predicate', 'object'].every(key => typeof item.relation[key] === 'string' && item.relation[key].trim().length > 0 && item.relation[key].length <= 200)));
      }
    } catch {
      this.items = [];
    }
  }

  list(): MemoryItem[] {
    return structuredClone(this.items).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  add(text: string, tags: string[] = [], scope: Pick<MemoryItem, 'workspaceId' | 'conversationId' | 'source' | 'relation' | 'relationMode'> & { replacesId?: string } = {}): MemoryItem {
    const relation = scope.relation;
    if (relation && ![relation.subject, relation.predicate, relation.object].every(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200)) throw new Error('관계의 대상·속성·값은 각각 1~200자여야 합니다.');
    const now = Date.now();
    const item: MemoryItem = { id: randomUUID(), text: text.trim().slice(0, 4000), tags: tags.map(String).slice(0, 12), createdAt: now, updatedAt: now,
      ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
      ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
      ...(scope.source ? { source: scope.source.slice(0, 500) } : {}),
      ...(relation ? { relation: { subject: relation.subject.trim(), predicate: relation.predicate.trim(), object: relation.object.trim() } } : {}),
      ...(scope.relationMode === 'fact' ? { relationMode: 'fact' as const } : {}),
    };
    if (!item.text) throw new Error('memory text is required');
    const replacing = scope.replacesId ? this.items.find(i => i.id === scope.replacesId) : undefined;
    if (scope.replacesId && (!replacing || replacing.supersededBy || replacing.workspaceId !== item.workspaceId || replacing.conversationId !== item.conversationId || !item.relation
      || replacing.relation?.subject !== item.relation.subject || replacing.relation?.predicate !== item.relation.predicate)) throw new Error('같은 범위·대상·관계의 현재 사실만 수정할 수 있습니다.');
    if (replacing) replacing.supersededBy = item.id;
    if (item.relation && !item.relationMode) for (const previous of this.items) {
      if (!previous.supersededBy && previous.workspaceId === item.workspaceId && previous.conversationId === item.conversationId
        && previous.relation?.subject === item.relation.subject && previous.relation?.predicate === item.relation.predicate) previous.supersededBy = item.id;
    }
    this.items.push(item);
    this.save();
    return structuredClone(item);
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((m) => m.id !== id);
    if (before === this.items.length) return false;
    this.save();
    return true;
  }

  inspect(query: string, scope: Pick<MemoryItem, 'workspaceId' | 'conversationId'> = {}): KnowledgeResult {
    const started = performance.now();
    const cacheKey = JSON.stringify([scope.workspaceId, scope.conversationId, query.slice(0, 16000)]);
    const cached = this.knowledgeCache.get(cacheKey);
    if (cached) {
      this.knowledgeCache.delete(cacheKey); this.knowledgeCache.set(cacheKey,cached);
      const result = structuredClone(cached);
      result.metrics.retrievalMs = Math.round((performance.now()-started)*1000)/1000;
      return result;
    }
    const scoped = this.items.filter(item => !item.supersededBy && (!item.workspaceId || item.workspaceId === scope.workspaceId)
      && (!item.conversationId || item.conversationId === scope.conversationId));
    const result = retrieveKnowledge(scoped, query);
    if (this.knowledgeCache.size >= 24) this.knowledgeCache.delete(this.knowledgeCache.keys().next().value!);
    this.knowledgeCache.set(cacheKey,result);
    return structuredClone(result);
  }

  retainedContext(query: string, scope: Pick<MemoryItem, 'workspaceId' | 'conversationId'> = {}): KnowledgeResult {
    const result = this.inspect(query,scope);
    // Relation facts already have a compact proof-carrying representation.
    const plain = this.context(query,12,scope,true);
    const plainLines: string[] = [];
    let bytes = 0;
    for (const line of plain.split('\n').filter(Boolean)) {
      if (bytes + Buffer.byteLength(line) + 1 > 4000) { result.metrics.truncated = true; continue; }
      plainLines.push(line); bytes += Buffer.byteLength(line) + 1;
    }
    if (plain && plainLines.join('\n') !== plain) plainLines.push('[일반 기억 일부 생략 · 저장된 원문은 유지됨]');
    result.context = [result.context,plainLines.join('\n')].filter(Boolean).join('\n');
    result.metrics.contextBytes = Buffer.byteLength(result.context);
    return result;
  }

  context(query: string, limit = 12, scope: Pick<MemoryItem, 'workspaceId' | 'conversationId'> = {}, plainOnly = false): string {
    const terms = [...new Set(query.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((x) => x.length > 1))].slice(0, 128);
    if (!terms.length) return '';
    return this.items
      .filter(item => (!plainOnly || !item.relation) && !item.supersededBy && (!item.workspaceId || item.workspaceId === scope.workspaceId)
        && (!item.conversationId || item.conversationId === scope.conversationId))
      .map((item) => ({ item, score: terms.reduce((n, term) => n + (item.text.toLocaleLowerCase().includes(term) || item.tags.some((t) => t.toLocaleLowerCase().includes(term)) ? 1 : 0), 0) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt)
      .slice(0, Number.isFinite(limit) ? Math.max(0, Math.min(12, Math.floor(limit))) : 12)
      .map(({ item }) => `- [memory:${item.id}; updated:${new Date(item.updatedAt).toISOString()}; source:${JSON.stringify(item.source ?? 'legacy-user-memory')}] ${JSON.stringify(item.relation ? { text: item.text, relation: item.relation } : item.text)}`)
      .join('\n');
  }

  private save(): void {
    this.knowledgeCache.clear();
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }
}
