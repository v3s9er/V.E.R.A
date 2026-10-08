/** Explicit-document retrieval and host-accepted reusable claims. Never writes MemoryStore facts. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const VERSION = 'harness-documents-v1';
export const HARNESS_KNOWLEDGE_LIMITS = Object.freeze({ documents: 24, documentBytes: 131072, totalBytes: 1048576,
  queryChars: 2000, results: 8, snippetChars: 480, resultBytes: 8192, candidates: 200, evidence: 4, quoteChars: 1000 });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fail(code: string): never { throw new Error(code); }
const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const inside = (root: string, path: string) => { const r = relative(root, path); return r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const copy = <T>(value: T): T => structuredClone(value);
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exactKeys = (value: unknown, keys: string[]) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const plain = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);

/** Conservative common-secret detector, not a guarantee that arbitrary secrets can be recognized. */
function sensitive(text: string): boolean {
  return /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{15,})\b/.test(text)
    || /\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|private[_ -]?key|authorization)["']?\s*[:=]\s*["']?\S+/i.test(text)
    || /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/i.test(text);
}
function documentPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 240 || !value || value.includes('\\') || isAbsolute(value) || /[:\u0000-\u001f]/.test(value)) fail('document_path_invalid');
  const parts = (value as string).split('/');
  if (parts.length > 10 || parts.some(part => !part || part === '..' || part.startsWith('.') || /[. ]$/.test(part) || /[<>"|?*]/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    || /(?:^|[._ -])(?:secrets?|credentials?|passwords?|tokens?|auth)(?:[._ -]|$)/i.test(part))) fail('document_path_sensitive_or_invalid');
  if (!/\.(?:txt|md|markdown|json)$/i.test(parts.at(-1)!)) fail('document_type_unsupported');
  return parts.join('/');
}

export interface HarnessKnowledgeScope { workspaceId: string; conversationId?: string }
export interface DocumentProvenance {
  path: string; sourceId: string; sha256: string; version: string; observedAt: string; modifiedAt: string;
}
export interface DocumentMatch extends DocumentProvenance { lineStart: number; lineEnd: number; snippet: string; score: number; trust: 'untrusted-document' }
export interface DocumentSearchResult {
  matches: DocumentMatch[]; issues: Array<{ path: string; code: string }>; partial: boolean;
  metrics: { selected: number; read: number; bytes: number; cacheHits: number };
}
export interface KnowledgeEvidence { path: string; sha256: string; quote: string }
export interface KnowledgeClaim { subject: string; predicate: string; object: string }
export type KnowledgeStatus = 'candidate' | 'verified' | 'promoted' | 'retracted';
export type RetractionReason = 'user-correction' | 'failed-check' | 'stale-source' | 'superseded';
export interface KnowledgeCandidate {
  id: string; claim: KnowledgeClaim; evidence: KnowledgeEvidence[]; status: KnowledgeStatus; createdAt: string; updatedAt: string;
  acceptance?: { verification: 'user-confirmed' | 'deterministic-check'; checkId: string; acceptedAt: string; evidenceHash: string };
  retraction?: { reason: RetractionReason; at: string };
}
export interface KnowledgeCandidateView extends KnowledgeCandidate { stale: boolean; conflictIds: string[] }
declare const receiptBrand: unique symbol;
export interface HostAcceptanceReceipt { readonly [receiptBrand]: true }
export interface HarnessKnowledgeOptions {
  workspaceRoot: string; scope: HarnessKnowledgeScope; documents: readonly string[];
  /** Explicit host-owned destination outside the model workspace. Existing parent required. */
  stateFile?: string;
  now?: () => Date;
}
export interface HarnessKnowledge {
  documents: { search(query: string, options?: { limit?: number }): Promise<DocumentSearchResult> };
  candidates: {
    propose(input: { claim: KnowledgeClaim; evidence: KnowledgeEvidence[] }): Promise<KnowledgeCandidateView>;
    list(): Promise<KnowledgeCandidateView[]>;
    getReusable(query?: string): Promise<KnowledgeCandidateView[]>;
  };
  /** HOST ONLY. Do not register these methods as model tools or accept model self-verdicts. */
  host: {
    /** Host must first obtain user confirmation or run checkId's actual deterministic check.
     * Fresh matching quotations prove provenance, not the semantic truth of an arbitrary claim. */
    accept(id: string, decision: { verification: 'user-confirmed' | 'deterministic-check'; checkId: string }): Promise<HostAcceptanceReceipt>;
    promote(receipt: HostAcceptanceReceipt): Promise<KnowledgeCandidateView>;
    retract(id: string, reason: RetractionReason): Promise<KnowledgeCandidateView>;
  };
}
type Chunk = { text: string; lineStart: number; lineEnd: number; terms: Set<string>; entities: Set<string> };
type Document = { provenance: DocumentProvenance; text: string; chunks: Chunk[]; bytes: number };
const entities = (value: string) => new Set((value.normalize('NFKC').toLowerCase().match(/@[a-z0-9._-]+\/[a-z0-9._-]+/g) ?? []));
const words = (value: string) => [...new Set(value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])];
function chunksOf(text: string): Chunk[] {
  const chunks: Chunk[] = []; let textPart = '', first = 1, last = 1;
  const flush = () => { if (textPart.trim()) chunks.push({ text: textPart, lineStart: first, lineEnd: last, terms: new Set(words(textPart)), entities: entities(textPart) }); textPart = ''; };
  text.split(/\r?\n/).forEach((line, index) => {
    for (let start = 0; start < Math.max(1, line.length); start += HARNESS_KNOWLEDGE_LIMITS.snippetChars) {
      const part = line.slice(start, start + HARNESS_KNOWLEDGE_LIMITS.snippetChars);
      if (textPart && textPart.length + 1 + part.length > HARNESS_KNOWLEDGE_LIMITS.snippetChars) flush();
      if (!textPart) first = index + 1;
      textPart += (textPart ? '\n' : '') + part; last = index + 1;
    }
  }); flush(); return chunks;
}
function queryOf(query: unknown) {
  if (typeof query !== 'string' || !query.trim() || query.length > HARNESS_KNOWLEDGE_LIMITS.queryChars || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(query)) fail('knowledge_query_invalid');
  return { words: words(query as string).slice(0, 32), entities: entities(query as string) };
}
function rank(text: { terms: Set<string>; entities: Set<string> }, query: ReturnType<typeof queryOf>): number {
  if ([...query.entities].some(entity => !text.entities.has(entity))) return 0;
  const matches = query.words.filter(word => text.terms.has(word)).length;
  return matches ? matches + query.entities.size * 12 : 0;
}

class Engine {
  readonly selected: string[];
  readonly scopeKey: string;
  readonly stateFile?: string;
  private readonly cache = new Map<string, { path: string; chunks: Chunk[] }>();
  private readonly receipts = new WeakMap<object, { id: string; digest: string }>();
  private records: KnowledgeCandidate[] = [];
  private stateHash: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string, readonly options: HarnessKnowledgeOptions) {
    this.selected = [...new Set(options.documents.map(documentPath))].sort();
    this.scopeKey = hash(JSON.stringify([VERSION, root, options.scope.workspaceId, options.scope.conversationId ?? null]));
    this.stateFile = options.stateFile && resolve(options.stateFile);
    if (this.stateFile && inside(root, this.stateFile)) fail('knowledge_state_in_workspace');
  }
  now(): string { const date = this.options.now?.() ?? new Date(); if (!(date instanceof Date) || !Number.isFinite(date.valueOf())) fail('knowledge_clock_invalid'); return date.toISOString(); }
  serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => { this.assertStateUnchanged(); return work(); });
    this.queue = next.catch(() => undefined); return next;
  }
  async safeRoot(): Promise<void> {
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(this.root), this.root)) fail('document_scope_changed');
  }
  async safePath(path: string): Promise<void> {
    await this.safeRoot(); let current = this.root;
    for (const part of path.split('/')) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) fail('document_link');
    }
    const actual = await realpath(current);
    if (!inside(this.root, actual) || !samePath(actual, current)) fail('document_scope');
  }
  async read(path: string, remaining: number, onRead: (bytes: number) => void): Promise<Document> {
    if (remaining <= 0) fail('document_total_limit');
    await this.safePath(path);
    const filePath = join(this.root, path), before = await lstat(filePath, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) fail('document_not_regular');
    if (before.size > HARNESS_KNOWLEDGE_LIMITS.documentBytes) fail('document_too_large');
    if (before.size > remaining) fail('document_total_limit');
    const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.ino !== before.ino || stat.dev !== before.dev) fail('document_changed');
      const buffer = Buffer.alloc(Math.min(HARNESS_KNOWLEDGE_LIMITS.documentBytes, remaining)); let length = 0;
      while (length < buffer.length) { const next = await handle.read(buffer, length, buffer.length - length, length); if (!next.bytesRead) break; length += next.bytesRead; onRead(next.bytesRead); }
      if (length > HARNESS_KNOWLEDGE_LIMITS.documentBytes) fail('document_too_large');
      if (length > remaining) fail('document_total_limit');
      const after = await handle.stat({ bigint: true }), current = await lstat(filePath, { bigint: true });
      await this.safePath(path);
      if (!current.isFile() || current.nlink !== 1n || current.ino !== stat.ino || current.dev !== stat.dev || after.mtimeNs !== stat.mtimeNs
        || after.ctimeNs !== stat.ctimeNs || after.size !== BigInt(length) || current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs) fail('document_changed');
      const bytes = buffer.subarray(0, length); let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('document_encoding'); }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) fail('document_binary');
      if (path.toLowerCase().endsWith('.json')) { try { JSON.parse(text); } catch { return fail('document_json_invalid'); } }
      if (sensitive(text)) fail('document_sensitive');
      const sha256 = hash(bytes), sourceId = hash(JSON.stringify([this.scopeKey, path]));
      return { text, chunks: [], bytes: length, provenance: { path, sourceId, sha256, version: `${VERSION}:${sha256}`, observedAt: this.now(), modifiedAt: new Date(Number(stat.mtimeMs)).toISOString() } };
    } finally { await handle.close(); }
  }
  async refresh() {
    const docs = new Map<string, Document>(), issues: DocumentSearchResult['issues'] = [];
    let bytes = 0, cacheHits = 0;
    for (const path of this.selected) {
      try {
        const doc = await this.read(path, HARNESS_KNOWLEDGE_LIMITS.totalBytes - bytes, length => { bytes += length; });
        const key = hash(JSON.stringify([this.root, this.scopeKey, path, doc.provenance.sha256, VERSION]));
        const cached = this.cache.get(key);
        if (cached) { doc.chunks = cached.chunks; cacheHits++; }
        else { doc.chunks = chunksOf(doc.text); for (const [oldKey, value] of this.cache) if (value.path === path) this.cache.delete(oldKey); this.cache.set(key, { path, chunks: doc.chunks }); }
        docs.set(path, doc);
      } catch (error) {
        const message = (error as Error).message, code = /^document_[a-z_]+$/.test(message) ? message : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'document_missing' : 'document_unavailable';
        issues.push({ path, code }); for (const [key, value] of this.cache) if (value.path === path) this.cache.delete(key);
      }
    }
    return { docs, issues, metrics: { selected: this.selected.length, read: docs.size, bytes, cacheHits } };
  }
  evidenceValid(record: KnowledgeCandidate, docs: Map<string, Document>): boolean {
    return record.evidence.every(evidence => { const document = docs.get(evidence.path); return document?.provenance.sha256 === evidence.sha256 && document.text.includes(evidence.quote); });
  }
  digest(record: KnowledgeCandidate): string { return hash(JSON.stringify([this.scopeKey, record.id, record.claim, record.evidence])); }
  view(record: KnowledgeCandidate, docs: Map<string, Document>): KnowledgeCandidateView {
    return { ...copy(record), stale: !this.evidenceValid(record, docs), conflictIds: this.records.filter(other => other.id !== record.id && other.status !== 'retracted'
      && other.claim.subject === record.claim.subject && other.claim.predicate === record.claim.predicate && other.claim.object !== record.claim.object).map(other => other.id).sort() };
  }
  validateInput(input: unknown): { claim: KnowledgeClaim; evidence: KnowledgeEvidence[] } {
    if (!exactKeys(input, ['claim', 'evidence'])) fail('knowledge_candidate_invalid');
    const value = input as any;
    if (!exactKeys(value.claim, ['subject', 'predicate', 'object']) || !['subject', 'predicate', 'object'].every(key => plain(value.claim[key], 200))) fail('knowledge_claim_invalid');
    const claim: KnowledgeClaim = { subject: value.claim.subject.normalize('NFKC').trim(), predicate: value.claim.predicate.normalize('NFKC').trim(), object: value.claim.object.normalize('NFKC').trim() };
    if (!Object.values(claim).every(value => plain(value, 200))) fail('knowledge_claim_invalid');
    if (sensitive(`${claim.subject} ${claim.predicate}: ${claim.object}`)) fail('knowledge_claim_sensitive');
    if (!Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > HARNESS_KNOWLEDGE_LIMITS.evidence) fail('knowledge_evidence_invalid');
    const evidence = value.evidence.map((entry: any) => {
      if (!exactKeys(entry, ['path', 'sha256', 'quote']) || !validHash(entry.sha256) || typeof entry.quote !== 'string' || !entry.quote.trim() || entry.quote.length > HARNESS_KNOWLEDGE_LIMITS.quoteChars || sensitive(entry.quote)) fail('knowledge_evidence_invalid');
      const path = documentPath(entry.path);
      if (!this.selected.includes(path)) fail('knowledge_evidence_scope');
      return { path, sha256: entry.sha256, quote: entry.quote };
    });
    return { claim, evidence };
  }
  async readState(): Promise<void> {
    if (!this.stateFile) return;
    const directory = dirname(this.stateFile), stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(directory), directory)) fail('knowledge_state_path');
    const raw = this.stateBytes(); if (!raw) return;
    let data: any; try { data = JSON.parse(raw.toString('utf8')); } catch { return fail('knowledge_state_invalid'); }
    if (!exactKeys(data, ['version', 'scopeKey', 'records']) || data.version !== 1 || data.scopeKey !== this.scopeKey || !Array.isArray(data.records) || data.records.length > HARNESS_KNOWLEDGE_LIMITS.candidates) fail('knowledge_state_invalid');
    const ids = new Set<string>(), promotedKeys = new Set<string>();
    for (const row of data.records) {
      if (!exactKeys(row, ['id', 'claim', 'evidence', 'status', 'createdAt', 'updatedAt', 'acceptance', 'retraction']) || !plain(row.id, 80) || ids.has(row.id)
        || !['candidate', 'verified', 'promoted', 'retracted'].includes(row.status) || ![row.createdAt, row.updatedAt].every(at => typeof at === 'string' && Number.isFinite(Date.parse(at)))) fail('knowledge_state_invalid');
      ids.add(row.id); const normalized = this.validateInput({ claim: row.claim, evidence: row.evidence });
      if (Object.keys(normalized.claim).some(key => normalized.claim[key as keyof KnowledgeClaim] !== row.claim[key])) fail('knowledge_state_invalid');
      if (row.acceptance && (!exactKeys(row.acceptance, ['verification', 'checkId', 'acceptedAt', 'evidenceHash']) || !['user-confirmed', 'deterministic-check'].includes(row.acceptance.verification)
        || !plain(row.acceptance.checkId, 120) || sensitive(row.acceptance.checkId) || !Number.isFinite(Date.parse(row.acceptance.acceptedAt)) || row.acceptance.evidenceHash !== this.digest(row))) fail('knowledge_state_invalid');
      if (['verified', 'promoted'].includes(row.status) && !row.acceptance) fail('knowledge_state_invalid');
      if (row.status === 'candidate' && row.acceptance) fail('knowledge_state_invalid');
      if (row.retraction && (!exactKeys(row.retraction, ['reason', 'at']) || !['user-correction', 'failed-check', 'stale-source', 'superseded'].includes(row.retraction.reason) || !Number.isFinite(Date.parse(row.retraction.at)))) fail('knowledge_state_invalid');
      if (row.status === 'retracted' && !row.retraction) fail('knowledge_state_invalid');
      if (row.status !== 'retracted' && row.retraction) fail('knowledge_state_invalid');
      if (row.status === 'promoted') { const key = JSON.stringify([row.claim.subject, row.claim.predicate]); if (promotedKeys.has(key)) fail('knowledge_state_invalid'); promotedKeys.add(key); }
    }
    this.records = copy(data.records); this.stateHash = hash(raw);
  }
  stateBytes(): Buffer | undefined {
    if (!this.stateFile) return;
    const parent = dirname(this.stateFile), parentStat = lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !samePath(realpathSync(parent), parent)) fail('knowledge_state_path');
    try { const stat = lstatSync(this.stateFile); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2_000_000) fail('knowledge_state_unsafe'); return readFileSync(this.stateFile); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; if (/^knowledge_/.test((error as Error).message)) throw error; fail('knowledge_state_unavailable'); }
  }
  assertStateUnchanged(): void {
    if (!this.stateFile) return;
    const existing = this.stateBytes(); if ((existing && hash(existing)) !== this.stateHash) fail('knowledge_state_changed');
  }
  save(next: KnowledgeCandidate[]): void {
    if (this.stateFile) {
      this.assertStateUnchanged();
      const bytes = Buffer.from(JSON.stringify({ version: 1, scopeKey: this.scopeKey, records: next }));
      if (bytes.length > 2_000_000) fail('knowledge_state_full');
      const temp = join(dirname(this.stateFile), `.${basename(this.stateFile)}.${randomUUID()}.tmp`);
      try { writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 }); renameSync(temp, this.stateFile); this.stateHash = hash(bytes); }
      catch { try { unlinkSync(temp); } catch { /* owned temporary file only */ } fail('knowledge_state_write_failed'); }
    }
    this.records = next;
  }
  api(): HarnessKnowledge {
    return {
      documents: { search: (query, options = {}) => this.serial(async () => {
        if (!exactKeys(options, ['limit'])) fail('knowledge_options_invalid');
        const parsed = queryOf(query), limit = options.limit ?? 6;
        if (!Number.isInteger(limit) || limit < 1 || limit > HARNESS_KNOWLEDGE_LIMITS.results) fail('knowledge_limit_invalid');
        const refreshed = await this.refresh(), matches: DocumentMatch[] = [];
        for (const doc of refreshed.docs.values()) for (const chunk of doc.chunks) {
          const score = rank(chunk, parsed); if (score) matches.push({ ...doc.provenance, lineStart: chunk.lineStart, lineEnd: chunk.lineEnd, snippet: chunk.text, score, trust: 'untrusted-document' });
        }
        matches.sort((a, b) => b.score - a.score || compareText(a.path, b.path) || a.lineStart - b.lineStart);
        let bytes = 0; const bounded = matches.filter(match => { const size = Buffer.byteLength(match.snippet); if (bytes + size > HARNESS_KNOWLEDGE_LIMITS.resultBytes) return false; bytes += size; return true; }).slice(0, limit);
        return { matches: bounded, issues: refreshed.issues, partial: refreshed.issues.length > 0 || matches.length > bounded.length, metrics: refreshed.metrics };
      }) },
      candidates: {
        propose: input => this.serial(async () => {
          const normalized = this.validateInput(input), refreshed = await this.refresh();
          if (this.records.length >= HARNESS_KNOWLEDGE_LIMITS.candidates) fail('knowledge_candidates_full');
          const at = this.now(), record: KnowledgeCandidate = { id: randomUUID(), ...normalized, status: 'candidate', createdAt: at, updatedAt: at };
          if (!this.evidenceValid(record, refreshed.docs)) fail('knowledge_evidence_stale_or_missing');
          this.save([...this.records, record]); return this.view(record, refreshed.docs);
        }),
        list: () => this.serial(async () => { const refreshed = await this.refresh(); return this.records.map(record => this.view(record, refreshed.docs)); }),
        getReusable: query => this.serial(async () => {
          const parsed = query === undefined ? undefined : queryOf(query), refreshed = await this.refresh();
          return this.records.filter(record => record.status === 'promoted' && this.evidenceValid(record, refreshed.docs))
            .map(record => ({ record, score: parsed ? rank({ terms: new Set(words(Object.values(record.claim).join(' '))), entities: entities(Object.values(record.claim).join(' ')) }, parsed) : 1 }))
            .filter(item => item.score > 0).sort((a, b) => b.score - a.score || compareText(b.record.updatedAt, a.record.updatedAt)
              || compareText(JSON.stringify(a.record.claim), JSON.stringify(b.record.claim)))
            .slice(0, HARNESS_KNOWLEDGE_LIMITS.results).map(({ record }) => this.view(record, refreshed.docs));
        }),
      },
      host: {
        accept: (id, decision) => this.serial(async () => {
          if (!exactKeys(decision, ['verification', 'checkId']) || !['user-confirmed', 'deterministic-check'].includes(decision.verification) || !plain(decision.checkId, 120) || sensitive(decision.checkId)) fail('knowledge_acceptance_invalid');
          const record = this.records.find(item => item.id === id); if (!record || !['candidate', 'verified'].includes(record.status)) fail('knowledge_candidate_state');
          const refreshed = await this.refresh(); if (!this.evidenceValid(record, refreshed.docs)) fail('knowledge_evidence_stale_or_missing');
          const digest = this.digest(record), at = this.now(), next: KnowledgeCandidate = { ...record, status: 'verified', updatedAt: at, acceptance: { ...decision, acceptedAt: at, evidenceHash: digest } };
          this.save(this.records.map(item => item.id === id ? next : item));
          const receipt = Object.freeze(Object.create(null)) as HostAcceptanceReceipt; this.receipts.set(receipt, { id, digest }); return receipt;
        }),
        promote: receipt => this.serial(async () => {
          const authority = receipt && typeof receipt === 'object' ? this.receipts.get(receipt) : undefined;
          if (!authority) fail('knowledge_receipt_invalid');
          const record = this.records.find(item => item.id === authority!.id);
          if (!record || record.status !== 'verified' || this.digest(record) !== authority!.digest) fail('knowledge_candidate_state');
          const refreshed = await this.refresh(); if (!this.evidenceValid(record!, refreshed.docs)) fail('knowledge_evidence_stale_or_missing');
          const existing = this.records.find(item => item.status === 'promoted' && item.claim.subject === record!.claim.subject && item.claim.predicate === record!.claim.predicate);
          if (existing) fail(existing.claim.object === record!.claim.object ? 'knowledge_duplicate' : 'knowledge_conflict');
          const next: KnowledgeCandidate = { ...record!, status: 'promoted', updatedAt: this.now() };
          this.save(this.records.map(item => item.id === next.id ? next : item)); this.receipts.delete(receipt); return this.view(next, refreshed.docs);
        }),
        retract: (id, reason) => this.serial(async () => {
          if (!['user-correction', 'failed-check', 'stale-source', 'superseded'].includes(reason)) fail('knowledge_retraction_invalid');
          const record = this.records.find(item => item.id === id); if (!record || record.status === 'retracted') fail('knowledge_candidate_state');
          const at = this.now(), next: KnowledgeCandidate = { ...record, status: 'retracted', updatedAt: at, retraction: { reason, at } };
          this.save(this.records.map(item => item.id === id ? next : item)); return this.view(next, (await this.refresh()).docs);
        }),
      },
    };
  }
}

/** The host chooses scope, documents and state path. Never forward arbitrary model-selected options. */
export async function createHarnessKnowledge(options: HarnessKnowledgeOptions): Promise<HarnessKnowledge> {
  if (!options || typeof options.workspaceRoot !== 'string' || !options.workspaceRoot.trim() || !exactKeys(options.scope, ['workspaceId', 'conversationId'])
    || !plain(options.scope.workspaceId, 120) || (options.scope.conversationId !== undefined && !plain(options.scope.conversationId, 120))
    || !Array.isArray(options.documents) || options.documents.length > HARNESS_KNOWLEDGE_LIMITS.documents || (options.stateFile !== undefined && !isAbsolute(options.stateFile))) fail('knowledge_options_invalid');
  const root = resolve(options.workspaceRoot), frozen = { ...options, scope: copy(options.scope), documents: [...options.documents] };
  try { const engine = new Engine(root, frozen); await engine.safeRoot(); await engine.readState(); return engine.api(); }
  catch (error) { if (/^(?:knowledge|document)_[a-z_]+$/.test((error as Error).message)) throw error; return fail('knowledge_unavailable'); }
}
