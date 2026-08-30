import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  ChatUsage,
  ConversationCreateInput,
  ConversationDetail,
  ConversationStatus,
  ConversationSummary,
  ConversationSyncMergeResult,
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
  /** Content revision and bounded ancestry used to distinguish descendants from concurrent edits. */
  syncRevision?: string;
  syncAncestors?: string[];
}

export interface ConversationRecoveryDiagnostic {
  code: 'conversations-corrupt-quarantined' | 'conversations-backup-recovered' | 'conversations-fresh-recovery' | 'conversations-persistence-blocked';
  message: string;
  at: number;
  path?: string;
}

export interface ConversationRecoveryState {
  degraded: boolean;
  writesBlocked: boolean;
  diagnostics: ConversationRecoveryDiagnostic[];
}

const emptyUsage = (): ChatUsage => ({ promptTokens: 0, completionTokens: 0 });

const conversationStatuses = new Set<ConversationStatus>(['active', 'archived']);
const reasoningEfforts = new Set<ReasoningEffort>(['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max']);
const permissionModes: PermissionMode[] = ['read-only', 'ask', 'workspace', 'full'];
const turnRoles = new Set<Turn['role']>(['system', 'user', 'assistant', 'tool']);
const MAX_SYNC_CONVERSATIONS = 5_000;
const MAX_SYNC_CONVERSATION_BYTES = 32 * 1024 * 1024;
const MAX_SYNC_ANCESTORS = 64;
const MAX_SUMMARY_BYTES = 64 * 1024;
const MAX_CONVERSATION_TURNS = 512;
const MAX_CONVERSATION_TURNS_BYTES = 4 * 1024 * 1024;
const SYNC_REVISION = /^[a-f0-9]{64}$/;

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  // Do not begin inside a multi-byte UTF-8 code point.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

function conversationRevision(item: StoredConversation): string {
  // Access policy and workspace binding are destination-local security state.
  // The id and wall-clock updatedAt are also excluded so a deterministic
  // conflict copy keeps the ancestry of the branch it protects.
  const content = {
    title: item.title,
    status: item.status,
    pinned: item.pinned === true,
    createdAt: item.createdAt,
    reasoningEffort: item.reasoningEffort,
    providerId: item.providerId,
    providerModel: item.providerModel,
    routingPresetId: item.routingPresetId,
    summary: item.summary,
    compactedMessages: item.compactedMessages,
    turns: item.turns,
    usage: {
      promptTokens: item.usage.promptTokens,
      completionTokens: item.usage.completionTokens,
      cachedPromptTokens: item.usage.cachedPromptTokens ?? 0,
      cacheWritePromptTokens: item.usage.cacheWritePromptTokens ?? 0,
      reasoningTokens: item.usage.reasoningTokens ?? 0,
    },
  };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

function ensureSyncMetadata(item: StoredConversation): void {
  const revision = conversationRevision(item);
  if (item.syncRevision !== revision) {
    item.syncRevision = revision;
    item.syncAncestors = [];
    return;
  }
  item.syncAncestors = [...new Set((item.syncAncestors ?? []).filter((value) => SYNC_REVISION.test(value) && value !== revision))].slice(0, MAX_SYNC_ANCESTORS);
}

function advanceSyncRevision(item: StoredConversation, previousRevision: string, previousAncestors: string[]): void {
  const revision = conversationRevision(item);
  item.syncRevision = revision;
  item.syncAncestors = [...new Set([previousRevision, ...previousAncestors])]
    .filter((value) => SYNC_REVISION.test(value) && value !== revision)
    .slice(0, MAX_SYNC_ANCESTORS);
}

function conflictConversationId(originalId: string, revision: string): string {
  return `conflict:${createHash('sha256').update(`${originalId}:${revision}`).digest('hex').slice(0, 32)}`;
}

function boundedString(value: unknown, label: string, max: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} 문자열이 올바르지 않습니다.`);
  if (Buffer.byteLength(value, 'utf8') > max) throw new Error(`${label} 크기가 제한을 초과했습니다.`);
  return value;
}

function safeNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} 숫자가 올바르지 않습니다.`);
  }
  return value;
}

function narrowPermission(requested: PermissionMode, ceiling: PermissionMode): PermissionMode {
  return permissionModes[Math.min(permissionModes.indexOf(requested), permissionModes.indexOf(ceiling))] ?? 'read-only';
}

function normalizeTurn(raw: unknown, conversationIndex: number, turnIndex: number): Turn {
  if (!raw || typeof raw !== 'object') throw new Error(`대화 ${conversationIndex + 1}의 메시지 ${turnIndex + 1}이 올바르지 않습니다.`);
  const source = raw as Partial<Turn>;
  if (!turnRoles.has(source.role as Turn['role'])) throw new Error(`대화 ${conversationIndex + 1}의 메시지 역할이 올바르지 않습니다.`);
  const content = boundedString(source.content, '메시지 본문', 512 * 1024) as string;
  const toolCalls = source.toolCalls === undefined ? undefined : (() => {
    if (!Array.isArray(source.toolCalls) || source.toolCalls.length > 64) throw new Error('도구 호출 목록이 올바르지 않습니다.');
    return source.toolCalls.map((call) => ({
      id: boundedString(call?.id, '도구 호출 ID', 256) as string,
      name: boundedString(call?.name, '도구 이름', 256) as string,
      args: boundedString(call?.args, '도구 인자', 256 * 1024) as string,
    }));
  })();
  const toolResults = source.toolResults === undefined ? undefined : (() => {
    if (!Array.isArray(source.toolResults) || source.toolResults.length > 64) throw new Error('도구 결과 목록이 올바르지 않습니다.');
    return source.toolResults.map((result) => ({
      id: boundedString(result?.id, '도구 결과 ID', 256) as string,
      name: boundedString(result?.name, '도구 결과 이름', 256) as string,
      content: boundedString(result?.content, '도구 결과 본문', 512 * 1024) as string,
    }));
  })();
  return { role: source.role as Turn['role'], content, ...(toolCalls ? { toolCalls } : {}), ...(toolResults ? { toolResults } : {}) };
}

function normalizeLocalTurns(turns: Turn[], enforceTotalBudget = true): Turn[] {
  if (!Array.isArray(turns) || turns.length > MAX_CONVERSATION_TURNS) {
    throw new Error('대화 메시지 수가 저장 제한을 초과했습니다. 큰 텍스트는 파일 첨부나 작업 폴더 파일로 전달하세요.');
  }
  let normalized: Turn[];
  try {
    normalized = turns.map((turn, turnIndex) => normalizeTurn(turn, 0, turnIndex));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`대화 기록을 저장할 수 없습니다: ${detail} 큰 텍스트는 파일 첨부나 작업 폴더 파일로 전달하세요.`);
  }
  if (enforceTotalBudget && Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_CONVERSATION_TURNS_BYTES) {
    throw new Error('대화 기록이 4MB 저장 제한을 초과했습니다. 큰 텍스트는 파일 첨부나 작업 폴더 파일로 전달하세요.');
  }
  return normalized;
}

function normalizeStoredConversation(raw: unknown, index: number): StoredConversation {
  if (!raw || typeof raw !== 'object') throw new Error(`대화 ${index + 1} 데이터가 올바르지 않습니다.`);
  const source = raw as Partial<StoredConversation>;
  const id = boundedString(source.id, '대화 ID', 160) as string;
  if (!/^[A-Za-z0-9:_-]+$/.test(id)) throw new Error('대화 ID 형식이 올바르지 않습니다.');
  const title = (boundedString(source.title, '대화 제목', 512) as string).trim().slice(0, 120) || '새 대화';
  if (!conversationStatuses.has(source.status as ConversationStatus)) throw new Error('대화 상태가 올바르지 않습니다.');
  const nowLimit = Date.now() + 5 * 60_000;
  const updatedAt = Math.min(safeNumber(source.updatedAt, '대화 수정 시각', 0, 9_007_199_254_740_991), nowLimit);
  const createdAt = Math.min(safeNumber(source.createdAt, '대화 생성 시각', 0, 9_007_199_254_740_991), updatedAt);
  if (!reasoningEfforts.has(source.reasoningEffort as ReasoningEffort)) throw new Error('대화 추론 단계가 올바르지 않습니다.');
  const permissionMode = permissionModes.includes(source.permissionMode as PermissionMode) ? source.permissionMode as PermissionMode : 'ask';
  if (!Array.isArray(source.turns) || source.turns.length > MAX_CONVERSATION_TURNS) throw new Error('대화 메시지 수가 제한을 초과했습니다.');
  const turns = source.turns.map((turn, turnIndex) => normalizeTurn(turn, index, turnIndex));
  if (Buffer.byteLength(JSON.stringify(turns), 'utf8') > MAX_CONVERSATION_TURNS_BYTES) throw new Error('한 대화의 동기화 크기가 4MB를 초과했습니다.');
  const usageSource = source.usage && typeof source.usage === 'object' ? source.usage : emptyUsage();
  const usage: ChatUsage = {
    promptTokens: safeNumber(usageSource.promptTokens ?? 0, '입력 토큰', 0, 1_000_000_000_000),
    completionTokens: safeNumber(usageSource.completionTokens ?? 0, '출력 토큰', 0, 1_000_000_000_000),
    cachedPromptTokens: safeNumber(usageSource.cachedPromptTokens ?? 0, '캐시 적중 토큰', 0, 1_000_000_000_000),
    cacheWritePromptTokens: safeNumber(usageSource.cacheWritePromptTokens ?? 0, '캐시 기록 토큰', 0, 1_000_000_000_000),
    reasoningTokens: safeNumber(usageSource.reasoningTokens ?? 0, '추론 토큰', 0, 1_000_000_000_000),
  };
  const normalized: StoredConversation = {
    id,
    title,
    status: source.status as ConversationStatus,
    pinned: source.pinned === true,
    createdAt,
    updatedAt,
    reasoningEffort: source.reasoningEffort as ReasoningEffort,
    providerId: boundedString(source.providerId, '공급자 ID', 256, true),
    providerModel: boundedString(source.providerModel, '모델 ID', 512, true),
    routingPresetId: boundedString(source.routingPresetId, '프리셋 ID', 256, true),
    workspaceId: boundedString(source.workspaceId, '작업 폴더 ID', 256, true),
    permissionMode,
    summary: boundedString(source.summary, '대화 요약', MAX_SUMMARY_BYTES, true),
    compactedMessages: Math.floor(safeNumber(source.compactedMessages ?? 0, '압축 메시지 수', 0, 10_000_000)),
    turns,
    usage,
  };
  const suppliedRevision = source.syncRevision === undefined ? undefined : boundedString(source.syncRevision, '대화 동기화 revision', 64);
  if (suppliedRevision !== undefined && !SYNC_REVISION.test(suppliedRevision)) throw new Error('대화 동기화 revision 형식이 올바르지 않습니다.');
  if (source.syncAncestors !== undefined && (!Array.isArray(source.syncAncestors) || source.syncAncestors.length > MAX_SYNC_ANCESTORS)) {
    throw new Error('대화 동기화 ancestry가 올바르지 않습니다.');
  }
  const ancestors = (source.syncAncestors ?? []).map((value) => boundedString(value, '대화 동기화 ancestor', 64) as string);
  if (ancestors.some((value) => !SYNC_REVISION.test(value))) throw new Error('대화 동기화 ancestor 형식이 올바르지 않습니다.');
  const computedRevision = conversationRevision(normalized);
  normalized.syncRevision = computedRevision;
  // Ignore provenance metadata if the claimed head does not describe the
  // normalized payload. This prevents a peer from suppressing conflict copies.
  normalized.syncAncestors = suppliedRevision === computedRevision
    ? [...new Set(ancestors.filter((value) => value !== computedRevision))].slice(0, MAX_SYNC_ANCESTORS)
    : [];
  return normalized;
}

function normalizeConversationSnapshot(value: unknown): StoredConversation[] {
  if (!Array.isArray(value)) throw new Error('대화 동기화 데이터가 올바르지 않습니다.');
  assertConversationSnapshotBudget(value);
  const normalized = value.map(normalizeStoredConversation);
  if (new Set(normalized.map((item) => item.id)).size !== normalized.length) throw new Error('중복된 대화 ID가 있습니다.');
  return normalized;
}

function assertConversationSnapshotBudget(value: unknown[]): void {
  if (value.length > MAX_SYNC_CONVERSATIONS) throw new Error('동기화할 대화 수가 5,000개를 초과했습니다.');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_SYNC_CONVERSATION_BYTES) throw new Error('대화 동기화 데이터가 32MB를 초과했습니다.');
}

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

function conversationRecoveryTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function atomicWriteConversationUtf8(file: string, value: string): void {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tmp, 'wx', 0o600);
    writeFileSync(descriptor, value, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tmp, file);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

function decodeConversationFile(raw: string): StoredConversation[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('conversation store root must be an array');
  const normalized = parsed.map(normalizeStoredConversation);
  if (new Set(normalized.map((item) => item.id)).size !== normalized.length) throw new Error('conversation store contains duplicate ids');
  return normalized;
}

/** Atomic JSON conversation store. One server owns it, so no database is required. */
export class ConversationStore {
  private readonly file: string;
  readonly backupFile: string;
  private items: StoredConversation[] = [];
  private recoveryDiagnostics: ConversationRecoveryDiagnostic[] = [];
  private writesBlocked = false;

  constructor(home: string) {
    this.file = join(home, 'conversations.json');
    this.backupFile = `${this.file}.bak`;
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.file)) {
        this.items = decodeConversationFile(readFileSync(this.file, 'utf8'));
        for (const item of this.items) ensureSyncMetadata(item);
        return;
      }
      return;
    } catch (error) {
      console.error('[conversations] store is unreadable; preserving it for recovery:', error);
    }

    const quarantine = this.quarantine(this.file);
    if (quarantine) {
      this.recordDiagnostic({
        code: 'conversations-corrupt-quarantined',
        message: '손상되거나 읽을 수 없는 대화 원본을 격리했습니다.',
        path: quarantine,
      });
    }

    if (existsSync(this.backupFile)) {
      let backupRaw: string | undefined;
      let backupItems: StoredConversation[] | undefined;
      try {
        backupRaw = readFileSync(this.backupFile, 'utf8');
        backupItems = decodeConversationFile(backupRaw);
        for (const item of backupItems) ensureSyncMetadata(item);
      } catch (error) {
        console.error('[conversations] last-known-good backup is also unreadable:', error);
        const backupQuarantine = this.quarantine(this.backupFile);
        if (backupQuarantine) {
          this.recordDiagnostic({
            code: 'conversations-corrupt-quarantined',
            message: '읽을 수 없는 대화 백업을 별도로 격리했습니다.',
            path: backupQuarantine,
          });
        }
      }
      if (backupRaw !== undefined && backupItems !== undefined) {
        this.items = backupItems;
        if (!this.writesBlocked) {
          try {
            atomicWriteConversationUtf8(this.file, backupRaw);
          } catch (error) {
            this.writesBlocked = true;
            this.recordDiagnostic({
              code: 'conversations-persistence-blocked',
              message: '정상 대화 백업은 읽었지만 복구본을 저장하지 못해 추가 저장을 차단했습니다.',
              path: this.backupFile,
            });
            console.error('[conversations] backup loaded but could not be restored atomically:', error);
          }
        }
        this.recordDiagnostic({
          code: 'conversations-backup-recovered',
          message: '마지막 정상 대화 백업으로 복구했습니다.',
          path: this.backupFile,
        });
        return;
      }
    }

    this.items = [];
    this.recordDiagnostic({
      code: 'conversations-fresh-recovery',
      message: '정상 백업이 없어 빈 대화 저장소로 시작했습니다. 격리된 원본은 수동 복구할 수 있습니다.',
      path: quarantine,
    });
    if (!this.writesBlocked) this.save();
  }

  private recordDiagnostic(diagnostic: Omit<ConversationRecoveryDiagnostic, 'at'>): void {
    this.recoveryDiagnostics.push({ ...diagnostic, at: Date.now() });
  }

  private quarantine(file: string): string | undefined {
    if (!existsSync(file)) return undefined;
    const target = `${file}.corrupt-${conversationRecoveryTimestamp()}-${randomUUID().slice(0, 8)}`;
    try {
      renameSync(file, target);
      return target;
    } catch {
      this.writesBlocked = true;
      this.recordDiagnostic({
        code: 'conversations-persistence-blocked',
        message: '손상된 대화 원본을 안전하게 격리하지 못해 추가 저장을 차단했습니다.',
        path: file,
      });
      return undefined;
    }
  }

  private save(): void {
    if (this.writesBlocked) throw new Error('대화 복구 원본을 보존하기 위해 저장이 차단되었습니다.');
    for (const item of this.items) ensureSyncMetadata(item);
    mkdirSync(dirname(this.file), { recursive: true });
    const serialized = JSON.stringify(this.items, null, 2);
    let backupRaw = serialized;
    if (existsSync(this.file)) {
      const currentRaw = readFileSync(this.file, 'utf8');
      try {
        decodeConversationFile(currentRaw);
        backupRaw = currentRaw;
      } catch {
        const quarantined = this.quarantine(this.file);
        if (!quarantined) throw new Error('손상된 현재 대화 저장소를 격리하지 못했습니다.');
        this.recordDiagnostic({
          code: 'conversations-corrupt-quarantined',
          message: '저장 직전 감지한 손상 대화 원본을 격리했습니다.',
          path: quarantined,
        });
      }
    }
    if (existsSync(this.backupFile)) {
      try {
        decodeConversationFile(readFileSync(this.backupFile, 'utf8'));
      } catch {
        const quarantined = this.quarantine(this.backupFile);
        if (!quarantined) throw new Error('손상된 대화 백업을 격리하지 못했습니다.');
      }
    }
    atomicWriteConversationUtf8(this.backupFile, backupRaw);
    atomicWriteConversationUtf8(this.file, serialized);
  }

  get recovery(): ConversationRecoveryState {
    return {
      degraded: this.recoveryDiagnostics.length > 0,
      writesBlocked: this.writesBlocked,
      diagnostics: structuredClone(this.recoveryDiagnostics),
    };
  }

  list(status?: ConversationStatus): ConversationSummary[] {
    return this.items
      .filter((c) => !status || c.status === status)
      .sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.updatedAt - a.updatedAt)
      .map(summarize);
  }

  exportSnapshot(): unknown[] {
    for (const item of this.items) ensureSyncMetadata(item);
    return structuredClone(this.items);
  }

  validateSnapshot(value: unknown): void {
    normalizeConversationSnapshot(value);
  }

  restoreSnapshot(value: unknown): void {
    if (!Array.isArray(value)) throw new Error('복구할 대화 snapshot이 올바르지 않습니다.');
    // Rollback receives a snapshot produced by exportSnapshot() from this
    // process. Do not apply remote-import ceilings here: a pre-existing local
    // store may legitimately exceed them and still has to be recoverable.
    const previous = this.items;
    this.items = structuredClone(value as StoredConversation[]);
    for (const item of this.items) ensureSyncMetadata(item);
    try {
      this.save();
    } catch (error) {
      this.items = previous;
      throw error;
    }
  }

  mergeSnapshot(value: unknown, permissionCeiling: PermissionMode = 'ask'): ConversationSyncMergeResult {
    const candidates = normalizeConversationSnapshot(value);
    const next = structuredClone(this.items);
    for (const item of next) ensureSyncMetadata(item);
    let added = 0; let updated = 0; let unchanged = 0; let conflicts = 0;
    const conflictIds: string[] = [];
    for (const candidate of candidates) {
      const existingIndex = next.findIndex((item) => item.id === candidate.id);
      if (existingIndex < 0) {
        next.push({ ...structuredClone(candidate), permissionMode: narrowPermission(candidate.permissionMode ?? 'ask', permissionCeiling), workspaceId: undefined });
        added++;
        continue;
      }
      const existing = next[existingIndex];
      ensureSyncMetadata(existing);
      ensureSyncMetadata(candidate);
      const existingRevision = existing.syncRevision as string;
      const candidateRevision = candidate.syncRevision as string;
      if (candidateRevision === existingRevision) {
        unchanged++;
        continue;
      }
      const candidateDescendsFromExisting = candidate.syncAncestors?.includes(existingRevision) === true;
      const existingDescendsFromCandidate = existing.syncAncestors?.includes(candidateRevision) === true;
      if (candidateDescendsFromExisting) {
        next[existingIndex] = {
          ...structuredClone(candidate),
          // Destination-local access decisions are never overwritten by sync.
          permissionMode: existing.permissionMode ?? 'ask',
          workspaceId: existing.workspaceId,
        };
        updated++;
        continue;
      }
      if (existingDescendsFromCandidate) {
        unchanged++;
        continue;
      }

      // Neither head descends from the other: both devices edited the same
      // conversation independently. Keep a deterministic visible copy of the
      // losing branch before applying LWW to the canonical id.
      const candidateWins = candidate.updatedAt > existing.updatedAt
        || (candidate.updatedAt === existing.updatedAt && candidateRevision > existingRevision);
      const loser = candidateWins ? existing : candidate;
      const loserRevision = candidateWins ? existingRevision : candidateRevision;
      const conflictId = conflictConversationId(candidate.id, loserRevision);
      if (!next.some((item) => item.id === conflictId)) {
        const importedLoser = !candidateWins;
        const title = `${loser.title} (동기화 충돌 복사본)`.slice(0, 120);
        const conflictCopy: StoredConversation = {
          ...structuredClone(loser),
          id: conflictId,
          title,
          pinned: false,
          permissionMode: importedLoser ? narrowPermission(loser.permissionMode ?? 'ask', permissionCeiling) : existing.permissionMode ?? 'ask',
          workspaceId: importedLoser ? undefined : existing.workspaceId,
        };
        advanceSyncRevision(conflictCopy, loserRevision, loser.syncAncestors ?? []);
        next.push(conflictCopy);
        added++;
        conflicts++;
        conflictIds.push(conflictId);
      }
      if (candidateWins) {
        next[existingIndex] = {
          ...structuredClone(candidate),
          permissionMode: existing.permissionMode ?? 'ask',
          workspaceId: existing.workspaceId,
        };
        updated++;
      } else unchanged++;
    }
    if (added || updated) {
      // Import limits are invariants of the resulting local store, not merely
      // of each peer payload. Two individually-valid disjoint snapshots must
      // not combine into a store that can no longer be exported or rolled back.
      assertConversationSnapshotBudget(next);
      const previous = this.items;
      this.items = next;
      try {
        this.save();
      } catch (error) {
        this.items = previous;
        throw error;
      }
    }
    return { added, updated, unchanged, conflicts, conflictIds };
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
    ensureSyncMetadata(item);
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
    ensureSyncMetadata(item);
    const previousRevision = item.syncRevision as string;
    const previousAncestors = [...(item.syncAncestors ?? [])];
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
    advanceSyncRevision(item, previousRevision, previousAncestors);
    this.save();
    return this.detail(item);
  }

  appendResult(id: string, turns: Turn[], usage: ChatUsage): ConversationDetail {
    // Build and compact a detached candidate first. This preserves the live
    // conversation when validation or the atomic disk write fails, while also
    // allowing a long but valid history to compact below the reload budget.
    const index = this.items.findIndex((conversation) => conversation.id === id);
    if (index < 0) throw new Error('conversation not found');
    const previous = this.items[index];
    ensureSyncMetadata(previous);
    const previousRevision = previous.syncRevision as string;
    const previousAncestors = [...(previous.syncAncestors ?? [])];
    const candidate = structuredClone(previous);
    candidate.turns = normalizeLocalTurns(turns, false);
    candidate.usage.promptTokens += usage.promptTokens;
    candidate.usage.completionTokens += usage.completionTokens;
    candidate.usage.cachedPromptTokens = (candidate.usage.cachedPromptTokens ?? 0) + (usage.cachedPromptTokens ?? 0);
    candidate.usage.cacheWritePromptTokens = (candidate.usage.cacheWritePromptTokens ?? 0) + (usage.cacheWritePromptTokens ?? 0);
    candidate.usage.reasoningTokens = (candidate.usage.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
    candidate.updatedAt = Date.now();
    const firstUser = candidate.turns.find((turn) => turn.role === 'user')?.content.trim();
    if (candidate.title === '새 대화' && firstUser) candidate.title = firstUser.replace(/\s+/g, ' ').slice(0, 48);
    this.compact(candidate);
    candidate.turns = normalizeLocalTurns(candidate.turns);
    advanceSyncRevision(candidate, previousRevision, previousAncestors);
    this.items[index] = candidate;
    try {
      this.save();
    } catch (error) {
      this.items[index] = previous;
      throw error;
    }
    return this.detail(candidate);
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
    let cut = Math.max(2, item.turns.length - 12);
    // A provider tool result is valid only when the preceding assistant
    // tool_call remains in history. Expand the retained window by one turn
    // when the raw size cut would orphan that result.
    if (item.turns[cut]?.role === 'tool') {
      const previous = item.turns[cut - 1];
      const resultIds = new Set(item.turns[cut].toolResults?.map((result) => result.id) ?? []);
      const callIds = new Set(previous?.toolCalls?.map((call) => call.id) ?? []);
      const paired = previous?.role === 'assistant'
        && resultIds.size > 0
        && [...resultIds].every((id) => callIds.has(id));
      if (paired) cut -= 1;
      else {
        while (cut < item.turns.length && item.turns[cut]?.role === 'tool') cut += 1;
      }
    }
    const old = item.turns.slice(0, cut);
    const digest = old
      .filter((t) => t.role !== 'tool')
      .map((t) => `- ${t.role}: ${t.content.replace(/\s+/g, ' ').slice(0, 700)}`)
      .join('\n');
    item.summary = utf8Tail([item.summary, digest].filter(Boolean).join('\n'), MAX_SUMMARY_BYTES);
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
