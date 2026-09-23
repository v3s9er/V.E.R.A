import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Turn } from './ai/provider.js';

const HASH = /^[a-f0-9]{64}$/;
const TARGET_CHUNK_BYTES = 512 * 1024;
// normalizeTurn permits a single turn containing up to 64 large tool results.
// A read is always bounded to one validated chunk, never an entire transcript.
const MAX_CHUNK_BYTES = 40 * 1024 * 1024;
// Reserve space for conversation metadata, the prompt summary and RPC framing.
export const TRANSCRIPT_PAGE_BYTES = 2 * 1024 * 1024 - 128 * 1024;
export const MAX_DISPLAY_TURN_BYTES = 128 * 1024;
const DISPLAY_MARKER = '\n[표시 제한으로 일부 생략됨. 전체 원문은 로컬 대화 저장소에 보존됩니다.]';
export const DEFAULT_TRANSCRIPT_PAGE_SIZE = 100;
export const MAX_TRANSCRIPT_PAGE_SIZE = 200;

export interface TranscriptReference {
  archiveId: string;
  head?: string;
  turnCount: number;
  missingMessages: number;
  /** Local-only cursor authentication prevents reading orphan/uncommitted chunks. */
  cursorKey: string;
  /** Hot retry receipts; older receipts have a disk index, never enter prompts. */
  recentAppends?: { id: string; fingerprint: string }[];
}

export interface TranscriptPageOptions { before?: string; limit?: number }
export interface TranscriptPage {
  turns: Turn[];
  hasMore: boolean;
  nextCursor?: string;
  archivedTurns: number;
  missingMessages: number;
  displayTruncated?: boolean;
}

interface Chunk {
  version: 1;
  previous?: string;
  offset: number;
  turns: Turn[];
  receipt?: { operationHash: string; fingerprint: string };
}

interface AppendReceipt { conversationId: string; id: string; fingerprint: string }
interface ReceiptIndex { archiveId: string; head: string; turnCount: number; fingerprint: string }

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }

function displayPrefix(value: string, budget: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= budget) return value;
  let end = Math.min(bytes.length, budget);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8') + DISPLAY_MARKER;
}

/** Only a display copy is shortened. The immutable archive keeps every byte. */
export function displayTranscriptTurn(original: Turn): { turn: Turn; bytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(JSON.stringify(original), 'utf8');
  // Leave room for public-message field names and tool-result separators.
  if (bytes <= MAX_DISPLAY_TURN_BYTES - 8192) return { turn: original, bytes: bytes + 8192, truncated: false };
  let budget = 16 * 1024;
  while (budget >= 64) {
    const copy: Turn = {
      role: original.role,
      content: displayPrefix(original.content, budget),
      ...(original.toolCalls ? { toolCalls: original.toolCalls.map(call => ({
        id: displayPrefix(call.id, Math.min(256, budget)), name: displayPrefix(call.name, Math.min(256, budget)),
        args: displayPrefix(call.args, Math.max(64, Math.floor(budget / original.toolCalls!.length))),
      })) } : {}),
      ...(original.toolResults ? { toolResults: original.toolResults.map(result => ({
        id: displayPrefix(result.id, Math.min(256, budget)), name: displayPrefix(result.name, Math.min(256, budget)),
        content: displayPrefix(result.content, Math.max(64, Math.floor(budget / original.toolResults!.length))),
      })) } : {}),
    };
    const size = Buffer.byteLength(JSON.stringify(copy), 'utf8') + 8192;
    if (size <= MAX_DISPLAY_TURN_BYTES) return { turn: copy, bytes: size, truncated: true };
    budget = Math.floor(budget / 2);
  }
  // Pathological escaped metadata can dominate all body text. Keep the role and
  // a labelled excerpt instead of ever returning an oversized wire payload.
  const copy: Turn = { role: original.role, content: displayPrefix(original.content, 4096) + DISPLAY_MARKER };
  return { turn: copy, bytes: Buffer.byteLength(JSON.stringify(copy), 'utf8') + 8192, truncated: true };
}

export function displayTranscriptWindow(turns: Turn[], end: number, limit: number): { turns: Turn[]; start: number; displayTruncated?: boolean } {
  const reversed: Turn[] = [];
  let bytes = 0;
  let start = end;
  let displayTruncated = false;
  while (start > 0 && reversed.length < limit) {
    const display = displayTranscriptTurn(turns[start - 1]);
    if (reversed.length && bytes + display.bytes > TRANSCRIPT_PAGE_BYTES) break;
    reversed.push(display.turn);
    bytes += display.bytes;
    displayTruncated ||= display.truncated;
    start -= 1;
  }
  return { turns: reversed.reverse(), start, ...(displayTruncated ? { displayTruncated: true } : {}) };
}

export function normalizeTranscriptReference(value: unknown): TranscriptReference | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('대화 원문 보관 참조가 올바르지 않습니다.');
  const ref = value as TranscriptReference;
  if (!HASH.test(ref.archiveId) || !HASH.test(ref.cursorKey) || (ref.head !== undefined && !HASH.test(ref.head))
    || !integer(ref.turnCount) || !integer(ref.missingMessages)
    || (ref.turnCount > 0 && ref.head === undefined)) throw new Error('대화 원문 보관 참조가 올바르지 않습니다.');
  if (ref.recentAppends !== undefined && (!Array.isArray(ref.recentAppends) || ref.recentAppends.length > 64
    || ref.recentAppends.some(receipt => !receipt || typeof receipt.id !== 'string' || receipt.id.length > 256
      || !HASH.test(receipt.fingerprint)))) throw new Error('대화 원문 저장 확인 정보가 올바르지 않습니다.');
  return {
    archiveId: ref.archiveId, head: ref.head, turnCount: ref.turnCount, missingMessages: ref.missingMessages, cursorKey: ref.cursorKey,
    ...(ref.recentAppends ? { recentAppends: structuredClone(ref.recentAppends) } : {}),
  };
}

export function transcriptPageLimit(options: TranscriptPageOptions): number {
  const limit = options.limit ?? DEFAULT_TRANSCRIPT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRANSCRIPT_PAGE_SIZE) throw new Error('대화 기록 페이지 크기는 1~200이어야 합니다.');
  if (options.before !== undefined && (typeof options.before !== 'string' || options.before.length > 240)) throw new Error('대화 기록 커서가 올바르지 않습니다.');
  return limit;
}

function atomicPrivateWrite(file: string, value: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, value, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } catch (error) {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* best effort */ } }
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * Local, immutable transcript chunks. conversations.json is the commit pointer:
 * write chunks first, then publish its reference in the atomic conversation save.
 * A failed save/crash leaves unreachable chunks, never a partly visible append.
 * Content addressing makes retrying that transaction reuse the same files.
 */
export class TranscriptStore {
  readonly root: string;

  constructor(home: string, private readonly normalizeTurn: (value: unknown) => Turn) {
    // Both normal MR_ROBOT_HOME and the repository-root override ignore private/.
    this.root = join(home, 'private', 'conversation-transcripts');
  }

  empty(id: string, missingMessages = 0): TranscriptReference {
    return { archiveId: digest(id), turnCount: 0, missingMessages, cursorKey: randomBytes(32).toString('hex') };
  }

  private chunkFile(ref: TranscriptReference, hash: string): string {
    if (!HASH.test(ref.archiveId) || !HASH.test(hash)) throw new Error('대화 원문 파일 참조가 올바르지 않습니다.');
    return join(this.root, ref.archiveId, `${hash}.json`);
  }

  private readChunk(ref: TranscriptReference, hash: string): Chunk {
    const file = this.chunkFile(ref, hash);
    const size = statSync(file).size;
    if (size <= 0 || size > MAX_CHUNK_BYTES) throw new Error('대화 원문 파일 크기가 올바르지 않습니다.');
    const raw = readFileSync(file, 'utf8');
    if (digest(raw) !== hash) throw new Error('대화 원문 파일의 무결성 검사가 실패했습니다.');
    const chunk = JSON.parse(raw) as Chunk;
    if (chunk.version !== 1 || !integer(chunk.offset) || !Array.isArray(chunk.turns)
      || chunk.turns.length > 512 || (!chunk.turns.length && !chunk.receipt)
      || (chunk.previous !== undefined && !HASH.test(chunk.previous))
      || (chunk.offset > 0 && chunk.previous === undefined)
      || (chunk.receipt !== undefined && (!HASH.test(chunk.receipt.operationHash) || !HASH.test(chunk.receipt.fingerprint)))) throw new Error('대화 원문 파일 형식이 올바르지 않습니다.');
    return { ...chunk, turns: chunk.turns.map(this.normalizeTurn) };
  }

  assertHead(ref: TranscriptReference): void {
    normalizeTranscriptReference(ref);
    if (ref.head) {
      const chunk = this.readChunk(ref, ref.head);
      if (chunk.offset + chunk.turns.length !== ref.turnCount) throw new Error('대화 원문 개수가 일치하지 않습니다.');
    }
  }

  append(ref: TranscriptReference, turns: Turn[], receipt?: AppendReceipt): TranscriptReference {
    this.assertHead(ref);
    const next = structuredClone(ref);
    let pending: Turn[] = [];
    let bytes = 0;
    const flush = (final = false): void => {
      if (!pending.length && !(final && receipt)) return;
      const chunk: Chunk = {
        version: 1, previous: next.head, offset: next.turnCount, turns: pending,
        ...(final && receipt ? { receipt: { operationHash: digest(receipt.id), fingerprint: receipt.fingerprint } } : {}),
      };
      const raw = JSON.stringify(chunk);
      if (Buffer.byteLength(raw, 'utf8') > MAX_CHUNK_BYTES) throw new Error('대화 원문 묶음의 저장 크기를 초과했습니다.');
      const hash = digest(raw);
      const file = this.chunkFile(next, hash);
      if (existsSync(file)) this.readChunk(next, hash); // Never overwrite malformed archive bytes.
      else atomicPrivateWrite(file, raw);
      next.head = hash;
      next.turnCount += pending.length;
      pending = [];
      bytes = 0;
    };
    for (const turn of turns) {
      const size = Buffer.byteLength(JSON.stringify(turn), 'utf8');
      if (pending.length && (bytes + size > TARGET_CHUNK_BYTES || pending.length >= 64)) flush();
      pending.push(turn);
      bytes += size;
    }
    flush(true);
    if (receipt && next.head) {
      // The index is prepared before conversations.json commits. A retry checks
      // ancestry, so an index left by a failed save never counts as committed.
      const index: ReceiptIndex = { archiveId: next.archiveId, head: next.head, turnCount: next.turnCount, fingerprint: receipt.fingerprint };
      atomicPrivateWrite(this.receiptFile(receipt.conversationId, receipt.id), JSON.stringify(index));
    }
    return next;
  }

  private receiptFile(id: string, operationId: string): string { return join(this.root, 'operations', digest(id), `${digest(operationId)}.json`); }

  findReceipt(id: string, operationId: string, ref: TranscriptReference): { fingerprint: string } | undefined {
    const hot = ref.recentAppends?.find(receipt => receipt.id === operationId);
    if (hot) return hot;
    const file = this.receiptFile(id, operationId);
    if (!existsSync(file)) return undefined;
    if (statSync(file).size > 2048) throw new Error('대화 저장 확인 파일의 크기가 올바르지 않습니다.');
    const index = JSON.parse(readFileSync(file, 'utf8')) as ReceiptIndex;
    if (!HASH.test(index.archiveId) || !HASH.test(index.head) || !HASH.test(index.fingerprint) || !integer(index.turnCount)) throw new Error('대화 저장 확인 파일이 올바르지 않습니다.');
    if (index.archiveId !== ref.archiveId || index.turnCount > ref.turnCount) return undefined;
    let hash = ref.head;
    let remaining = ref.turnCount;
    while (hash && remaining >= index.turnCount) {
      const chunk = this.readChunk(ref, hash);
      if (chunk.offset + chunk.turns.length !== remaining) throw new Error('대화 원문 연결의 순서가 올바르지 않습니다.');
      if (hash === index.head) {
        if (chunk.receipt?.operationHash !== digest(operationId) || chunk.receipt.fingerprint !== index.fingerprint) throw new Error('대화 저장 확인 정보가 일치하지 않습니다.');
        return { fingerprint: index.fingerprint };
      }
      hash = chunk.previous;
      remaining = chunk.offset;
    }
    return undefined;
  }

  private cursor(ref: TranscriptReference, hash: string, position: number, remaining: number): string {
    const payload = `${ref.head}:${hash}:${position}:${remaining}`;
    return `${payload}:${createHmac('sha256', ref.cursorKey).update(payload).digest('hex')}`;
  }

  page(ref: TranscriptReference, options: TranscriptPageOptions = {}): TranscriptPage {
    const limit = transcriptPageLimit(options);
    normalizeTranscriptReference(ref);
    let hash = ref.head;
    let remaining = ref.turnCount;
    let position: number | undefined;
    if (options.before) {
      const match = /^([a-f0-9]{64}):([a-f0-9]{64}):(\d+):(\d+):([a-f0-9]{64})$/.exec(options.before);
      if (!match || match[1] !== ref.head) throw new Error('대화 기록이 변경되었습니다. 최신 기록을 다시 열어 주세요.');
      hash = match[2];
      position = Number(match[3]) || undefined;
      remaining = Number(match[4]);
      if ((position !== undefined && !integer(position)) || !integer(remaining) || remaining >= ref.turnCount
        || this.cursor(ref, hash, position ?? 0, remaining) !== options.before) throw new Error('대화 기록 커서가 올바르지 않습니다.');
    }
    const reversed: Turn[] = [];
    let bytes = 0;
    let displayTruncated = false;
    let nextCursor: string | undefined;
    while (hash) {
      const chunk = this.readChunk(ref, hash);
      let index = position ?? chunk.turns.length;
      if (index < 0 || index > chunk.turns.length || chunk.offset + index !== remaining) throw new Error('대화 기록 페이지의 순서가 올바르지 않습니다.');
      while (index > 0) {
        const display = displayTranscriptTurn(chunk.turns[index - 1]);
        if (reversed.length && (reversed.length >= limit || bytes + display.bytes > TRANSCRIPT_PAGE_BYTES)) {
          nextCursor = this.cursor(ref, hash, index, remaining);
          return { turns: reversed.reverse(), hasMore: true, nextCursor, archivedTurns: ref.turnCount, missingMessages: ref.missingMessages, ...(displayTruncated ? { displayTruncated: true } : {}) };
        }
        reversed.push(display.turn);
        bytes += display.bytes;
        displayTruncated ||= display.truncated;
        index -= 1;
        remaining -= 1;
      }
      hash = chunk.previous;
      position = undefined;
      if (hash && remaining > 0 && reversed.length >= limit) {
        return { turns: reversed.reverse(), hasMore: true, nextCursor: this.cursor(ref, hash, 0, remaining), archivedTurns: ref.turnCount, missingMessages: ref.missingMessages, ...(displayTruncated ? { displayTruncated: true } : {}) };
      }
    }
    if (remaining !== 0) throw new Error('대화 원문 연결이 끊어졌습니다.');
    return { turns: reversed.reverse(), hasMore: false, archivedTurns: ref.turnCount, missingMessages: ref.missingMessages, ...(displayTruncated ? { displayTruncated: true } : {}) };
  }

  private tombstoneFile(id: string): string { return join(this.root, 'deleted', `${digest(id)}.json`); }
  isDeleted(id: string): boolean { return existsSync(this.tombstoneFile(id)); }
  markDeleted(id: string): void { atomicPrivateWrite(this.tombstoneFile(id), JSON.stringify({ version: 1, deletedAt: Date.now() })); }
  undoDelete(id: string): void { unlinkSync(this.tombstoneFile(id)); }
}
