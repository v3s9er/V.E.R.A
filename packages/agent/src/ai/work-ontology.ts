import { createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveWorkspacePath } from '../path-security.js';
import { WORK_ONTOLOGY_TOOLS, isWorkOntologyTool } from './work-ontology-tools.js';

export interface WorkOntologySummary {
  total: number;
  reported: number;
  verified: number;
  blocked: number;
  checksPassed: number;
  checksFailed: number;
  stale?: boolean;
}

type ReportedStatus = 'planned' | 'running' | 'completed' | 'blocked';
type Acceptance = 'unverified' | 'reported' | 'verified' | 'blocked';
type CheckKind = 'exists' | 'contains' | 'sha256';
type Failure = 'unavailable' | 'scope' | 'not_regular' | 'too_large' | 'changed' | 'mismatch';
interface Check { id: string; kind: CheckKind; path: string; expected?: string }
interface Receipt { id: string; status: 'unchecked' | 'passed' | 'failed'; sha256?: string; reason?: Failure }
interface Task { id: string; title: string; dependsOn: string[]; checks: Check[]; status: ReportedStatus; receipts: Receipt[] }

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
const STATUSES: ReportedStatus[] = ['planned', 'running', 'completed', 'blocked'];
class CheckFailure extends Error { constructor(readonly code: Failure) { super('Workspace check failed'); } }

function assertActive(signal: AbortSignal): void {
  // Abort reasons can contain caller data; never reflect them into a receipt.
  if (signal.aborted) throw new DOMException('Work checks cancelled', 'AbortError');
}
function record(value: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid work tool arguments');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid work identifier');
  return value;
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw new Error('Work text size or format bound exceeded');
  return value;
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function pathKey(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path; }

/** A bounded, run-owned ledger. No model calls, shell, automatic persistence or global state. */
export class WorkOntology {
  readonly tools = WORK_ONTOLOGY_TOOLS;
  private readonly workspace: string;
  private readonly rootReal: string;
  private readonly rootIdentity: BigIntStats;
  private readonly onChange?: (summary: WorkOntologySummary) => void;
  private tasks = new Map<string, Task>();
  private checkedRoots = new Set<string>();
  private staleTasks = new Set<string>();
  private revision = 0;

  constructor(options: { workspacePath: string; onChange?: (summary: WorkOntologySummary) => void }) {
    this.workspace = resolve(options.workspacePath);
    try {
      this.rootIdentity = lstatSync(this.workspace, { bigint: true });
      if (!this.rootIdentity.isDirectory() || this.rootIdentity.isSymbolicLink()) throw new Error();
      this.rootReal = realpathSync(this.workspace);
    } catch { throw new Error('Work checks require an available workspace directory'); }
    this.onChange = options.onChange;
  }

  async execute(name: string, input: unknown, signal: AbortSignal): Promise<string> {
    assertActive(signal);
    if (!isWorkOntologyTool(name)) throw new Error('Unknown work capability');
    switch (name) {
      case 'work_plan': this.setPlan(input); break;
      case 'work_update': {
        const args = record(input, ['id', 'status'], ['id', 'status']);
        const task = this.task(identifier(args.id));
        if (!STATUSES.includes(args.status as ReportedStatus)) throw new Error('Invalid reported work status');
        task.status = args.status as ReportedStatus;
        this.revision++;
        this.changed();
        break;
      }
      case 'work_check': {
        const args = record(input, ['id'], ['id']);
        const id = identifier(args.id);
        this.task(id);
        await this.check([id], signal);
        this.checkedRoots.add(id);
        break;
      }
      case 'work_status': record(input, []); break;
    }
    assertActive(signal);
    return JSON.stringify(this.packet());
  }

  /** Host calls this before a tool that may change files, including native tools. */
  invalidate(): void {
    this.revision++;
    let changed = false;
    for (const task of this.tasks.values()) {
      if (task.receipts.some(receipt => receipt.status !== 'unchecked')) {
        this.staleTasks.add(task.id);
        task.receipts = this.unchecked(task);
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  /** Refresh only checks explicitly requested earlier in this run, including their prerequisites. */
  async recheck(signal: AbortSignal): Promise<void> {
    assertActive(signal);
    if (this.checkedRoots.size) await this.check([...this.checkedRoots], signal);
  }

  summary(): WorkOntologySummary {
    const result: WorkOntologySummary = { total: this.tasks.size, reported: 0, verified: 0, blocked: 0, checksPassed: 0, checksFailed: 0 };
    for (const task of this.tasks.values()) {
      if (task.status === 'completed') result.reported++;
      const acceptance = this.acceptance(task);
      if (acceptance === 'verified') result.verified++;
      if (acceptance === 'blocked') result.blocked++;
      for (const receipt of task.receipts) {
        if (receipt.status === 'passed') result.checksPassed++;
        if (receipt.status === 'failed') result.checksFailed++;
      }
    }
    if (this.staleTasks.size) result.stale = true;
    return result;
  }

  context(): string {
    if (!this.tasks.size) return '';
    return `Work acceptance (declared file conditions only; completed is a claim): ${JSON.stringify({ summary: this.summary(), tasks: [...this.tasks.values()].map(task => ({ id: task.id, status: task.status, acceptance: this.acceptance(task) })) })}`;
  }

  private changed(): void {
    try { this.onChange?.(this.summary()); } catch { /* UI disconnects cannot alter acceptance. */ }
  }
  private task(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Unknown work task');
    return task;
  }
  private unchecked(task: Task): Receipt[] { return task.checks.map(check => ({ id: check.id, status: 'unchecked' })); }
  private acceptance(task: Task): Acceptance {
    const parents = task.dependsOn.map(id => this.acceptance(this.task(id)));
    if (task.status === 'blocked' || task.receipts.some(receipt => receipt.status === 'failed') || parents.includes('blocked')) return 'blocked';
    if (task.status !== 'completed') return 'unverified';
    return task.checks.length > 0 && !this.staleTasks.has(task.id)
      && task.receipts.every(receipt => receipt.status === 'passed') && parents.every(parent => parent === 'verified') ? 'verified' : 'reported';
  }
  private packet() {
    return { scope: 'declared-file-checks', summary: this.summary(), tasks: [...this.tasks.values()].map(task => ({
      id: task.id, status: task.status, acceptance: this.acceptance(task), dependsOn: [...task.dependsOn], checks: task.receipts.map(receipt => ({ ...receipt })),
    })) };
  }

  private setPlan(input: unknown): void {
    const args = record(input, ['tasks'], ['tasks']);
    if (!Array.isArray(args.tasks) || !args.tasks.length || args.tasks.length > 12) throw new Error('Work plan requires 1 to 12 tasks');
    const next = new Map<string, Task>();
    let checkCount = 0, expectedBytes = 0;
    for (const rawTask of args.tasks) {
      const item = record(rawTask, ['id', 'title', 'dependsOn', 'checks'], ['id', 'title']);
      const id = identifier(item.id), title = text(item.title, 160);
      if (next.has(id)) throw new Error('Duplicate work task identifier');
      const deps = item.dependsOn ?? [], checks = item.checks ?? [];
      if (!Array.isArray(deps) || deps.length > 11 || !Array.isArray(checks) || checks.length > 4) throw new Error('Work dependency or check bound exceeded');
      const dependsOn = deps.map(identifier);
      if (new Set(dependsOn).size !== dependsOn.length || dependsOn.includes(id)) throw new Error('Invalid work dependencies');
      const parsed: Check[] = checks.map(rawCheck => {
        const c = record(rawCheck, ['id', 'kind', 'path', 'expected'], ['id', 'kind', 'path']);
        const checkId = identifier(c.id), path = text(c.path, 2048);
        if (!['exists', 'contains', 'sha256'].includes(c.kind as string)) throw new Error('Invalid work check kind');
        const kind = c.kind as CheckKind;
        if (kind === 'exists') {
          if (Object.hasOwn(c, 'expected')) throw new Error('Existence checks do not accept expected data');
          return { id: checkId, kind, path };
        }
        let expected = text(c.expected, 2048);
        expectedBytes += Buffer.byteLength(expected);
        if (kind === 'sha256') {
          if (!/^[a-fA-F0-9]{64}$/.test(expected)) throw new Error('Invalid expected SHA-256');
          expected = expected.toLowerCase();
        }
        return { id: checkId, kind, path, expected };
      });
      checkCount += parsed.length;
      if (checkCount > 32 || expectedBytes > 16384) throw new Error('Work plan evidence size bound exceeded');
      if (new Set(parsed.map(check => check.id)).size !== parsed.length) throw new Error('Duplicate work check identifier');
      next.set(id, { id, title, dependsOn, checks: parsed, status: 'planned', receipts: parsed.map(check => ({ id: check.id, status: 'unchecked' })) });
    }
    const active = new Set<string>(), visited = new Set<string>();
    const visit = (id: string) => {
      const task = next.get(id);
      if (!task) throw new Error('Unknown work prerequisite');
      if (active.has(id)) throw new Error('Work dependencies contain a cycle');
      if (visited.has(id)) return;
      active.add(id);
      task.dependsOn.forEach(visit);
      active.delete(id);
      visited.add(id);
    };
    next.forEach(task => visit(task.id));
    // No existing state changes until every node and edge has been validated.
    this.tasks = next;
    this.checkedRoots.clear();
    this.staleTasks.clear();
    this.revision++;
    this.changed();
  }

  private async check(roots: string[], signal: AbortSignal): Promise<void> {
    assertActive(signal);
    const ordered = new Set<string>();
    const visit = (id: string) => { if (!ordered.has(id)) { this.task(id).dependsOn.forEach(visit); ordered.add(id); } };
    roots.forEach(visit);
    for (const id of ordered) {
      const task = this.task(id);
      task.receipts = this.unchecked(task);
      if (task.checks.length) this.staleTasks.add(id);
    }
    const revision = ++this.revision;
    this.changed();
    const pending = new Map<string, Receipt[]>();
    for (const id of ordered) {
      const task = this.task(id), receipts: Receipt[] = [];
      for (const check of task.checks) {
        assertActive(signal);
        try {
          const bytes = await this.read(check.path, signal);
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          const passed = check.kind === 'exists' || (check.kind === 'sha256' ? sha256 === check.expected : bytes.includes(Buffer.from(check.expected!, 'utf8')));
          receipts.push({ id: check.id, status: passed ? 'passed' : 'failed', sha256, ...(!passed ? { reason: 'mismatch' as const } : {}) });
        } catch (error) {
          assertActive(signal);
          receipts.push({ id: check.id, status: 'failed', reason: error instanceof CheckFailure ? error.code : 'unavailable' });
        }
        assertActive(signal);
        if (revision !== this.revision) throw new Error('Work state changed during verification; check again');
      }
      pending.set(id, receipts);
    }
    assertActive(signal);
    if (revision !== this.revision) throw new Error('Work state changed during verification; check again');
    for (const [id, receipts] of pending) {
      this.task(id).receipts = receipts;
      this.staleTasks.delete(id);
    }
    this.changed();
  }

  private scopedPath(path: string): string {
    // Disallow Windows alternate data streams and device path syntax on every OS.
    if (/[\x00-\x1f]/.test(path) || path.replace(/^[A-Za-z]:[\\/]/, '').includes(':')) throw new CheckFailure('scope');
    try {
      const root = lstatSync(this.workspace, { bigint: true });
      if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== this.rootIdentity.dev || root.ino !== this.rootIdentity.ino
        || pathKey(realpathSync(this.workspace)) !== pathKey(this.rootReal)) throw new CheckFailure('scope');
      return resolveWorkspacePath(this.workspace, path, { mustExist: false });
    } catch { throw new CheckFailure('scope'); }
  }

  private async read(path: string, signal: AbortSignal): Promise<Buffer> {
    assertActive(signal);
    const selected = this.scopedPath(path);
    let before: BigIntStats;
    try { before = statSync(selected, { bigint: true }); }
    catch { throw new CheckFailure('unavailable'); }
    if (!before.isFile()) throw new CheckFailure('not_regular');
    if (before.size > BigInt(MAX_FILE_BYTES)) throw new CheckFailure('too_large');
    const handle = await open(selected, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    try {
      assertActive(signal);
      const opened = await handle.stat({ bigint: true });
      if (pathKey(this.scopedPath(path)) !== pathKey(selected) || !opened.isFile() || !sameFile(before, opened)) throw new CheckFailure('changed');
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let size = 0;
      while (size < bytes.length) {
        assertActive(signal);
        const { bytesRead } = await handle.read(bytes, size, Math.min(65536, bytes.length - size), size);
        size += bytesRead;
        if (!bytesRead) break;
      }
      assertActive(signal);
      const afterHandle = await handle.stat({ bigint: true });
      const after = statSync(this.scopedPath(path), { bigint: true });
      if (size !== Number(before.size) || !sameFile(before, afterHandle) || !sameFile(before, after)) throw new CheckFailure('changed');
      return bytes.subarray(0, size);
    } finally { await handle.close(); }
  }
}
