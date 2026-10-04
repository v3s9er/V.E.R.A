import type { MemoryItem } from '@mr-robot/shared';

// Literal values such as status=ready must not become graph join keys.
export const entityEdges: ReadonlySet<string> = new Set(['is_a', 'subclass_of', 'part_of', 'depends_on', 'requires', 'disjoint_with', 'owner', 'located_in']);
const ascii = (value: string) => /^[a-z0-9_-]+$/.test(value);
const normalized = (value: string) => value.normalize('NFKC').toLowerCase();
type Entry = { item: MemoryItem; entity: string; rest: string };
export type KnowledgeMatch = { item: MemoryItem; score: number; entityScore: number };

/** Immutable, host-owned snapshot of already scoped saved claims. Exact entity
 * identity is separate from normalized recall. Unicode substring search retains
 * the original scorer's semantics; only ASCII whole tokens use postings. */
export class KnowledgeIndex {
  private readonly entries: Entry[] = [];
  private readonly entityTokens = new Map<string, Set<number>>();
  private readonly restTokens = new Map<string, Set<number>>();
  private readonly adjacent = new Map<string, MemoryItem[]>();
  private readonly ids = new Set<string>();
  private base?: KnowledgeIndex;
  /** Conservative cache-admission accounting, not a V8 heap measurement. */
  private readonly ownRetainedBytes: number;

  constructor(items: readonly MemoryItem[]) {
    let bytes = 256;
    const link = (entity: string, item: MemoryItem) => {
      const existing = this.adjacent.get(entity);
      if (existing) existing.push(item);
      else { this.adjacent.set(entity, [item]); bytes += 128 + entity.length * 2; }
      bytes += 16;
    };
    const tokenize = (value: string, postings: Map<string, Set<number>>, index: number) => {
      for (const token of new Set(value.split(/[^\p{L}\p{N}_-]+/u).filter(ascii))) {
        let members = postings.get(token);
        if (!members) { members = new Set(); postings.set(token, members); bytes += 192 + token.length * 2; }
        members.add(index); bytes += 48;
      }
    };
    for (const original of items) {
      if (!original.relation || original.supersededBy) continue;
      const relation = Object.freeze({ ...original.relation });
      const item: MemoryItem = { id: original.id, text: original.text, tags: [...original.tags],
        createdAt: original.createdAt, updatedAt: original.updatedAt, source: original.source,
        workspaceId: original.workspaceId, conversationId: original.conversationId,
        relationMode: original.relationMode, relation };
      Object.freeze(item.tags); Object.freeze(item);
      const entity = normalized(`${relation.subject} ${entityEdges.has(relation.predicate) ? relation.object : ''}`);
      const rest = normalized(`${relation.predicate} ${item.text} ${item.tags.join(' ')}`);
      const index = this.entries.length;
      this.entries.push({ item, entity, rest });
      if (!this.ids.has(item.id)) { this.ids.add(item.id); bytes += 64 + item.id.length * 2; }
      // Count both snapshot strings and normalized material. Per-record/member
      // overhead also bounds caches of many tiny records with distinct terms.
      bytes += 768 + 2 * (JSON.stringify(item).length + entity.length + rest.length);
      tokenize(entity, this.entityTokens, index); tokenize(rest, this.restTokens, index);
      link(relation.subject, item);
      if (entityEdges.has(relation.predicate) && relation.object !== relation.subject) link(relation.object, item);
    }
    for (const neighbors of this.adjacent.values()) Object.freeze(neighbors);
    this.ownRetainedBytes = bytes;
  }

  get retainedBytes(): number { return this.ownRetainedBytes + (this.base?.retainedBytes ?? 0); }
  get size(): number { return this.entries.length + (this.base?.size ?? 0); }

  /** An uncached, at-most-two-layer view. Saved snapshots are never modified.
   * Duplicate IDs retain the existing full-index ordering semantics; they are
   * not implicit overrides or separate independent claims. */
  withObservations(observed: readonly MemoryItem[]): KnowledgeIndex {
    // Flatten only the small fresh layer if another observation is appended.
    if (this.base) return this.base.withObservations([...this.entries.map(entry => entry.item), ...observed]);
    const fresh = new KnowledgeIndex(observed);
    if (!fresh.size) return this;
    if ([...fresh.ids].some(id => this.ids.has(id))) {
      return new KnowledgeIndex([...this.entries.map(entry => entry.item), ...fresh.entries.map(entry => entry.item)]);
    }
    fresh.base = this;
    return fresh;
  }

  neighbors(entity: string): readonly MemoryItem[] {
    const own = this.adjacent.get(entity) ?? [];
    return this.base ? Object.freeze([...this.base.neighbors(entity), ...own]) : own;
  }

  matches(queryTerms: readonly string[]): KnowledgeMatch[] {
    if (!this.base) return this.ownMatches(queryTerms);
    const entities = [...this.base.ownMatches(queryTerms, true), ...this.ownMatches(queryTerms, true)];
    // Entity priority is global across both layers, not decided independently
    // for saved and observed claims. Do not expand generic saved text postings
    // when the named entity exists only in the tiny fresh observation layer.
    return entities.length ? entities : [...this.base.ownMatches(queryTerms), ...this.ownMatches(queryTerms)];
  }

  private ownMatches(queryTerms: readonly string[], entityOnly = false): KnowledgeMatch[] {
    const entityScores = new Map<number, number>();
    const add = (scores: Map<number, number>, index: number, value: number) => scores.set(index, (scores.get(index) ?? 0) + value);
    for (const term of queryTerms) {
      if (ascii(term)) {
        for (const index of this.entityTokens.get(term) ?? []) add(entityScores, index, 4);
      } else {
        // Substring recall, including Korean particles, cannot be replaced by
        // whole-token lookup without dropping previously matching facts.
        for (let index = 0; index < this.entries.length; index++) {
          const entry = this.entries[index];
          if (entry.entity.includes(term)) add(entityScores, index, 4);
        }
      }
    }
    // Named-entity matches already suppress unrelated text-only seeds in the
    // retrieval policy. Do not enumerate a generic "status" posting for every
    // saved record when only a few named entities can be admitted.
    if (entityScores.size) return [...entityScores].map(([index, entityScore]) => {
      const entry = this.entries[index];
      let score = entityScore;
      for (const term of queryTerms) {
        if (ascii(term) ? !this.entityTokens.get(term)?.has(index) && this.restTokens.get(term)?.has(index)
          : !entry.entity.includes(term) && entry.rest.includes(term)) score++;
      }
      return { item: entry.item, score, entityScore };
    });
    if (entityOnly) return [];
    const textScores = new Map<number, number>();
    for (const term of queryTerms) {
      if (ascii(term)) for (const index of this.restTokens.get(term) ?? []) add(textScores, index, 1);
      else for (let index = 0; index < this.entries.length; index++) if (this.entries[index].rest.includes(term)) add(textScores, index, 1);
    }
    return [...textScores].map(([index, score]) => ({ item: this.entries[index].item, score, entityScore: 0 }));
  }
}

/** One cache per MemoryStore revision, with exact scope keys supplied by the
 * host. It never contains query results or fresh project observations. */
export class KnowledgeIndexCache {
  private readonly entries = new Map<string, KnowledgeIndex>();
  private bytes = 0;
  private records = 0;
  constructor(private readonly limits = { scopes: 8, records: 40_000, bytes: 32 * 1024 * 1024 }) {
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 0)) throw new RangeError('Invalid knowledge index cache limits');
  }
  get(scopeKey: string, load: () => readonly MemoryItem[]): KnowledgeIndex {
    const cached = this.entries.get(scopeKey);
    if (cached) { this.entries.delete(scopeKey); this.entries.set(scopeKey, cached); return cached; }
    const index = new KnowledgeIndex(load());
    if (!this.limits.scopes || index.size > this.limits.records || index.retainedBytes > this.limits.bytes) return index;
    while (this.entries.size >= this.limits.scopes || this.records + index.size > this.limits.records || this.bytes + index.retainedBytes > this.limits.bytes) {
      const first = this.entries.entries().next().value!;
      this.entries.delete(first[0]); this.records -= first[1].size; this.bytes -= first[1].retainedBytes;
    }
    this.entries.set(scopeKey, index); this.records += index.size; this.bytes += index.retainedBytes;
    return index;
  }
  clear(): void { this.entries.clear(); this.bytes = 0; this.records = 0; }
  stats(): { scopes: number; records: number; retainedBytes: number } { return { scopes: this.entries.size, records: this.records, retainedBytes: this.bytes }; }
}
