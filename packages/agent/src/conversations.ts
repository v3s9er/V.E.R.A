import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  ChatUsage,
  ConversationCreateInput,
  ConversationDetail,
  ConversationStatus,
  ConversationSummary,
  PermissionMode,
  ReasoningEffort,
} from '@mr-robot/shared';
import type { Turn } from './ai/provider.js';

interface StoredConversation {
  id: string;
  title: string;
  status: ConversationStatus;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  reasoningEffort: ReasoningEffort;
  providerId?: string;
  providerModel?: string;
  routingPresetId?: string;
  workspaceId?: string;
  permissionMode?: PermissionMode;
  summary?: string;
  compactedMessages: number;
  turns: Turn[];
  usage: ChatUsage;
}

const emptyUsage = (): ChatUsage => ({ promptTokens: 0, completionTokens: 0 });

function publicMessages(turns: Turn[]): ChatMessage[] {
  return turns.map((turn) => ({
    role: turn.role,
    content: turn.role === 'tool'
      ? (turn.toolResults ?? []).map((r) => `${r.name}: ${r.content}`).join('\n')
      : turn.content,
    toolCalls: turn.toolCalls?.map((call) => ({ id: call.id, name: call.name, input: call.args })),
  }));
}

function summarize(c: StoredConversation): ConversationSummary {
  return {
    id: c.id,
    title: c.title,
    status: c.status,
    pinned: c.pinned === true,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: c.turns.filter((t) => t.role === 'user' || t.role === 'assistant').length + c.compactedMessages,
    reasoningEffort: c.reasoningEffort,
    providerId: c.providerId,
    providerModel: c.providerModel,
    routingPresetId: c.routingPresetId,
    workspaceId: c.workspaceId,
    permissionMode: c.permissionMode ?? 'ask',
    compactedMessages: c.compactedMessages,
  };
}

/** Atomic JSON conversation store. One server owns it, so no database is required. */
export class ConversationStore {
  private readonly file: string;
  private items: StoredConversation[] = [];

  constructor(home: string) {
    this.file = join(home, 'conversations.json');
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as StoredConversation[];
        this.items = Array.isArray(parsed) ? parsed : [];
      }
    } catch {
      this.items = [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  list(status?: ConversationStatus): ConversationSummary[] {
    return this.items
      .filter((c) => !status || c.status === status)
      .sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.updatedAt - a.updatedAt)
      .map(summarize);
  }

  exportSnapshot(): unknown[] {
    return structuredClone(this.items);
  }

  mergeSnapshot(value: unknown): { added: number; updated: number; unchanged: number } {
    if (!Array.isArray(value)) throw new Error('대화 동기화 데이터가 올바르지 않습니다.');
    let added = 0; let updated = 0; let unchanged = 0;
    for (const raw of value.slice(0, 10_000)) {
      const candidate = raw as Partial<StoredConversation>;
      if (!candidate || typeof candidate.id !== 'string' || typeof candidate.title !== 'string' || !Array.isArray(candidate.turns) || typeof candidate.updatedAt !== 'number') continue;
      const existingIndex = this.items.findIndex((item) => item.id === candidate.id);
      if (existingIndex < 0) {
        this.items.push(structuredClone(candidate as StoredConversation));
        added++;
      } else if (candidate.updatedAt > this.items[existingIndex].updatedAt) {
        this.items[existingIndex] = structuredClone(candidate as StoredConversation);
        updated++;
      } else unchanged++;
    }
    if (added || updated) this.save();
    return { added, updated, unchanged };
  }

  create(input: ConversationCreateInput = {}): ConversationDetail {
    const now = Date.now();
    const item: StoredConversation = {
      id: randomUUID(),
      title: input.title?.trim() || '새 대화',
      status: 'active',
      pinned: input.pinned === true,
      createdAt: now,
      updatedAt: now,
      reasoningEffort: input.reasoningEffort ?? 'auto',
      providerId: input.providerId,
      providerModel: input.providerModel,
      routingPresetId: input.routingPresetId,
      workspaceId: input.workspaceId,
      permissionMode: input.permissionMode ?? 'ask',
      compactedMessages: 0,
      turns: [],
      usage: emptyUsage(),
    };
    this.items.push(item);
    this.save();
    return this.detail(item);
  }

  get(id: string): ConversationDetail | undefined {
    const item = this.items.find((c) => c.id === id);
    return item ? this.detail(item) : undefined;
  }

  turns(id: string): Turn[] {
    const item = this.require(id);
    return structuredClone(item.turns);
  }

  contextSummary(id: string): string | undefined {
    return this.require(id).summary;
  }

  update(id: string, patch: { title?: string; status?: ConversationStatus; pinned?: boolean; reasoningEffort?: ReasoningEffort; providerId?: string | null; providerModel?: string | null; routingPresetId?: string | null; workspaceId?: string | null; permissionMode?: PermissionMode }): ConversationDetail {
    const item = this.require(id);
    if (patch.title !== undefined) item.title = patch.title.trim().slice(0, 120) || item.title;
    if (patch.status) item.status = patch.status;
    if (patch.pinned !== undefined) item.pinned = patch.pinned;
    if (patch.reasoningEffort) item.reasoningEffort = patch.reasoningEffort;
    if (patch.providerId !== undefined) {
      item.providerId = patch.providerId || undefined;
      if (!item.providerId) item.providerModel = undefined;
    }
    if (patch.providerModel !== undefined) item.providerModel = patch.providerModel?.trim() || undefined;
    if (patch.routingPresetId !== undefined) item.routingPresetId = patch.routingPresetId?.trim() || undefined;
    if (patch.workspaceId !== undefined) item.workspaceId = patch.workspaceId?.trim() || undefined;
    if (patch.permissionMode) item.permissionMode = patch.permissionMode;
    item.updatedAt = Date.now();
    this.save();
    return this.detail(item);
  }

  appendResult(id: string, turns: Turn[], usage: ChatUsage): ConversationDetail {
    const item = this.require(id);
    item.turns = structuredClone(turns);
    item.usage.promptTokens += usage.promptTokens;
    item.usage.completionTokens += usage.completionTokens;
    item.updatedAt = Date.now();
    const firstUser = item.turns.find((t) => t.role === 'user')?.content.trim();
    if (item.title === '새 대화' && firstUser) item.title = firstUser.replace(/\s+/g, ' ').slice(0, 48);
    this.compact(item);
    this.save();
    return this.detail(item);
  }

  delete(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((c) => c.id !== id);
    if (this.items.length === before) return false;
    this.save();
    return true;
  }

  private compact(item: StoredConversation): void {
    const approxChars = item.turns.reduce((n, t) => n + t.content.length + (t.toolResults ?? []).reduce((m, r) => m + r.content.length, 0), 0);
    if (approxChars < 96_000 || item.turns.length <= 16) return;
    const cut = Math.max(2, item.turns.length - 12);
    const old = item.turns.slice(0, cut);
    const digest = old
      .filter((t) => t.role !== 'tool')
      .map((t) => `- ${t.role}: ${t.content.replace(/\s+/g, ' ').slice(0, 700)}`)
      .join('\n');
    item.summary = [item.summary, digest].filter(Boolean).join('\n').slice(-30_000);
    item.compactedMessages += old.filter((t) => t.role === 'user' || t.role === 'assistant').length;
    item.turns = item.turns.slice(cut);
  }

  private require(id: string): StoredConversation {
    const item = this.items.find((c) => c.id === id);
    if (!item) throw new Error('conversation not found');
    return item;
  }

  private detail(item: StoredConversation): ConversationDetail {
    return { ...summarize(item), messages: publicMessages(item.turns), summary: item.summary, usage: { ...item.usage } };
  }
}
