import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants, lstatSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { resolveWorkspacePath } from './path-security.js';

export const HARNESS_VERIFIER_LIMITS = Object.freeze({ fileBytes: 2 * 1024 * 1024, sourceFiles: 32,
  sourceBytes: 16 * 1024 * 1024, outputBytes: 16 * 1024, timeoutMs: 120_000, schemaBytes: 32 * 1024 });
export type VerificationPermission = 'full' | 'workspace' | 'read-only';
export interface VerificationCommand { executable: string; args: string[] }
/** Deliberately small JSON Schema subset. Unsupported keywords fail closed. */
export interface ArtifactSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, ArtifactSchema>; required?: string[]; additionalProperties?: boolean;
  items?: ArtifactSchema; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number;
  minimum?: number; maximum?: number; enum?: unknown[]; const?: unknown;
}
export interface VerificationExecution {
  exitCode: number | null; stdout: string; stderr: string;
  /** True after owned execution/abort cleanup settles. Adapters must include their child tree. */
  settled: boolean; timedOut?: boolean; aborted?: boolean; stdoutTruncated?: boolean; stderrTruncated?: boolean;
}
export interface SandboxVerificationExecutor {
  /** Host-owned adapter to an existing approved workspace sandbox; never model input. */
  kind: 'workspace-sandbox';
  execute(request: { workspacePath: string; command: VerificationCommand; timeoutMs: number; maxOutputBytes: number; signal: AbortSignal }): Promise<VerificationExecution>;
}
export interface CommandVerificationRequest {
  id: string; command: VerificationCommand; sourcePaths: string[]; permission: VerificationPermission;
  /** Supplied by the trusted admission layer AFTER approval, never accepted from model arguments. */
  approved: boolean; timeoutMs?: number;
}
export interface ArtifactVerificationRequest { id: string; path: string; schema: ArtifactSchema }
export interface VerificationReceipt {
  version: 1; receiptId: string; id: string; kind: 'command' | 'json-artifact';
  status: 'passed' | 'failed' | 'cancelled' | 'timed-out' | 'rejected';
  scope: 'declared-sources-only'; workspaceHash: string; commandHash?: string; schemaHash?: string;
  sourceRevision?: string; afterRevision?: string; sourceCount?: number; artifactHash?: string;
  execution: 'none' | 'local-full-not-isolated' | 'workspace-sandbox'; exitCode: number | null;
  durationMs: number; failure?: string; stdout: string; stderr: string;
  stdoutTruncated: boolean; stderrTruncated: boolean;
}

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
class VerificationFailure extends Error { constructor(readonly code: string) { super(code); } }
function active(signal: AbortSignal) { if (signal.aborted) throw new VerificationFailure('cancelled'); }
function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(k => typeof k !== 'string' || !keys.includes(k))) throw new VerificationFailure('invalid_request');
  return value as Record<string, any>;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(value)) throw new VerificationFailure('invalid_id');
  return value;
}
function boundedOutput(value: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8'), max = HARNESS_VERIFIER_LIMITS.outputBytes;
  return { text: bytes.subarray(0, max).toString('utf8').replace(/\uFFFD$/u, ''), truncated: bytes.length > max };
}
function canonical(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
function validateSchema(value: unknown): ArtifactSchema {
  // Clone once so callers cannot mutate a schema while an asynchronous read is in progress.
  let text: string;
  try { text = JSON.stringify(value, (_key, item) => {
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'number' && !Number.isFinite(item)) throw new Error('Non-JSON schema');
    return item;
  }); } catch { throw new VerificationFailure('invalid_schema'); }
  if (!text || Buffer.byteLength(text) > HARNESS_VERIFIER_LIMITS.schemaBytes) throw new VerificationFailure('invalid_schema');
  const root = JSON.parse(text);
  let nodes = 0;
  const walk = (raw: unknown, depth: number) => {
    if (++nodes > 256 || depth > 12) throw new VerificationFailure('schema_limit');
    const s = object(raw, ['type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'const']);
    if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(s.type)) throw new VerificationFailure('invalid_schema');
    const only = (keys: string[], types: string[]) => { if (keys.some(k => Object.hasOwn(s, k)) && !types.includes(s.type)) throw new VerificationFailure('invalid_schema'); };
    only(['properties', 'required', 'additionalProperties'], ['object']); only(['items', 'minItems', 'maxItems'], ['array']);
    only(['minLength', 'maxLength'], ['string']); only(['minimum', 'maximum'], ['number', 'integer']);
    for (const k of ['minItems', 'maxItems', 'minLength', 'maxLength']) if (s[k] !== undefined && (!Number.isSafeInteger(s[k]) || s[k] < 0 || s[k] > 2_000_000)) throw new VerificationFailure('invalid_schema');
    for (const k of ['minimum', 'maximum']) if (s[k] !== undefined && (typeof s[k] !== 'number' || !Number.isFinite(s[k]))) throw new VerificationFailure('invalid_schema');
    for (const [min, max] of [['minimum', 'maximum'], ['minItems', 'maxItems'], ['minLength', 'maxLength']]) if (s[min] !== undefined && s[max] !== undefined && s[min] > s[max]) throw new VerificationFailure('invalid_schema');
    if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean') throw new VerificationFailure('invalid_schema');
    if (s.required !== undefined && (!Array.isArray(s.required) || s.required.length > 64 || s.required.some((k: unknown) => typeof k !== 'string' || k.length > 200) || new Set(s.required).size !== s.required.length)) throw new VerificationFailure('invalid_schema');
    if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length || s.enum.length > 32)) throw new VerificationFailure('invalid_schema');
    if (s.properties !== undefined) {
      if (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties) || Object.keys(s.properties).length > 64) throw new VerificationFailure('invalid_schema');
      for (const [key, child] of Object.entries(s.properties)) { if (key.length > 200) throw new VerificationFailure('invalid_schema'); walk(child, depth + 1); }
    }
    if (s.items !== undefined) walk(s.items, depth + 1);
  };
  walk(root, 0); return root;
}
/** Validate a registration contract without reading files or executing commands. */
export function validateArtifactSchema(value: unknown): ArtifactSchema { return validateSchema(value); }
function matchesSchema(value: any, schema: ArtifactSchema, budget = { nodes: 0 }, depth = 0): boolean {
  if (++budget.nodes > 100_000 || depth > 64) throw new VerificationFailure('artifact_complexity');
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type === 'integer' ? actual !== 'number' || !Number.isSafeInteger(value) : actual !== schema.type) return false;
  if (Object.hasOwn(schema, 'const') && canonical(value) !== canonical(schema.const)) return false;
  if (schema.enum && !schema.enum.some(v => canonical(v) === canonical(value))) return false;
  if (actual === 'number' && (!Number.isFinite(value) || schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) return false;
  if (actual === 'string') { const length = [...value].length; if (schema.minLength !== undefined && length < schema.minLength || schema.maxLength !== undefined && length > schema.maxLength) return false; }
  if (actual === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every((v: unknown) => matchesSchema(v, schema.items!, budget, depth + 1))) return false;
  }
  if (actual === 'object') {
    if (schema.required?.some(k => !Object.hasOwn(value, k))) return false;
    for (const key of Object.keys(value)) {
      const property = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (property ? !matchesSchema(value[key], property, budget, depth + 1) : schema.additionalProperties === false) return false;
    }
  }
  return true;
}

/** No discovery, package-script selection, model calls, persistence or automatic retries.
 * An exit-zero receipt proves this approved command on the declared source revision,
 * not that a test suite is meaningful, complete, or authorized for later runs. */
export class HarnessVerifier {
  private readonly workspace: string;
  private readonly root: BigIntStats;
  private readonly workspaceHash: string;
  private busy = false;
  private poisoned = false;
  constructor(private readonly options: { workspacePath: string; sandboxExecutor?: SandboxVerificationExecutor }) {
    this.workspace = resolve(options.workspacePath);
    this.root = lstatSync(this.workspace, { bigint: true });
    if (!this.root.isDirectory() || this.root.isSymbolicLink() || pathKey(realpathSync(this.workspace)) !== pathKey(this.workspace)) throw new Error('Invalid verification workspace');
    this.workspaceHash = hash(canonical([pathKey(this.workspace), String(this.root.dev), String(this.root.ino)]));
    if (options.sandboxExecutor && options.sandboxExecutor.kind !== 'workspace-sandbox') throw new Error('Invalid sandbox adapter');
  }
  private receipt(id: string, kind: VerificationReceipt['kind']): VerificationReceipt {
    return { version: 1, receiptId: randomUUID(), id, kind, status: 'failed', scope: 'declared-sources-only', workspaceHash: this.workspaceHash,
      execution: 'none', exitCode: null, durationMs: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false };
  }
  private path(value: string): string {
    const root = lstatSync(this.workspace, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== this.root.dev || root.ino !== this.root.ino || pathKey(realpathSync(this.workspace)) !== pathKey(this.workspace)) throw new VerificationFailure('workspace_changed');
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f]/.test(value) || value.replace(/^[A-Za-z]:[\\/]/, '').includes(':')) throw new VerificationFailure('invalid_path');
    try { return resolveWorkspacePath(this.workspace, value); } catch { throw new VerificationFailure('path_denied'); }
  }
  private async read(value: string, signal: AbortSignal): Promise<{ bytes: Buffer; path: string; identity: string[] }> {
    active(signal); const path = this.path(value), before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new VerificationFailure('not_regular_file');
    if (before.size > BigInt(HARNESS_VERIFIER_LIMITS.fileBytes)) throw new VerificationFailure('file_limit');
    const file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    try {
      const opened = await file.stat({ bigint: true });
      if (!same(before, opened) || this.path(value) !== path) throw new VerificationFailure('source_changed');
      const buffer = Buffer.alloc(Number(before.size) + 1); let length = 0;
      while (length < buffer.length) { active(signal); const chunk = await file.read(buffer, length, Math.min(65536, buffer.length - length), length); length += chunk.bytesRead; if (!chunk.bytesRead) break; }
      active(signal);
      if (!same(opened, await file.stat({ bigint: true })) || !same(opened, lstatSync(this.path(value), { bigint: true })) || length !== Number(before.size)) throw new VerificationFailure('source_changed');
      return { bytes: buffer.subarray(0, length), path, identity: [opened.dev, opened.ino, opened.size, opened.mtimeNs, opened.ctimeNs].map(String) };
    } finally { await file.close(); }
  }
  private async revision(paths: string[], signal: AbortSignal): Promise<string> {
    let bytes = 0; const records: Array<[string, string, string[]]> = [];
    for (const value of paths) {
      const file = await this.read(value, signal); bytes += file.bytes.length;
      if (bytes > HARNESS_VERIFIER_LIMITS.sourceBytes) throw new VerificationFailure('source_limit');
      records.push([pathKey(relative(this.workspace, file.path)).replaceAll('\\', '/'), hash(file.bytes), file.identity]);
    }
    if (new Set(records.map(r => r[0])).size !== records.length) throw new VerificationFailure('duplicate_source');
    return hash(canonical(records.sort((a, b) => a[0].localeCompare(b[0]))));
  }
  async verifyArtifact(input: ArtifactVerificationRequest, signal: AbortSignal): Promise<VerificationReceipt> {
    const started = performance.now(), request = object(input, ['id', 'path', 'schema']);
    const receipt = this.receipt(identifier(request.id), 'json-artifact');
    try {
      active(signal); const schema = validateSchema(request.schema); receipt.schemaHash = hash(canonical(schema));
      const { bytes } = await this.read(request.path, signal); receipt.artifactHash = hash(bytes);
      let data: unknown; try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new VerificationFailure('invalid_json'); }
      if (!matchesSchema(data, schema)) throw new VerificationFailure('schema_mismatch');
      active(signal); receipt.status = 'passed';
    } catch (error) {
      receipt.failure = signal.aborted ? 'cancelled' : error instanceof VerificationFailure ? error.code : 'artifact_unavailable';
      receipt.status = signal.aborted ? 'cancelled' : 'failed';
    }
    receipt.durationMs = performance.now() - started; return receipt;
  }
  async runCommand(input: CommandVerificationRequest, signal: AbortSignal): Promise<VerificationReceipt> {
    const started = performance.now(), request = object(input, ['id', 'command', 'sourcePaths', 'permission', 'approved', 'timeoutMs']);
    const receipt = this.receipt(identifier(request.id), 'command');
    if (this.busy || this.poisoned) return { ...receipt, status: 'rejected', failure: this.poisoned ? 'retirement_unconfirmed' : 'verification_busy' };
    this.busy = true;
    try {
      active(signal);
      if (request.approved !== true) throw new VerificationFailure('approval_required');
      if (!['full', 'workspace', 'read-only'].includes(request.permission)) throw new VerificationFailure('invalid_permission');
      const permission: VerificationPermission = request.permission;
      if (permission === 'read-only') throw new VerificationFailure('execution_denied');
      if (permission === 'workspace' && !this.options.sandboxExecutor) throw new VerificationFailure('sandbox_required');
      const raw = object(request.command, ['executable', 'args']);
      if (typeof raw.executable !== 'string' || !isAbsolute(raw.executable) || raw.executable.length > 4096 || /[\x00-\x1f]/.test(raw.executable)
        || !Array.isArray(raw.args) || raw.args.length > 64 || raw.args.some((v: unknown) => typeof v !== 'string' || v.includes('\0'))
        || Buffer.byteLength(JSON.stringify(raw.args)) > 16384) throw new VerificationFailure('invalid_command');
      const command: VerificationCommand = { executable: raw.executable, args: [...raw.args] };
      const timeoutMs = request.timeoutMs ?? 30_000;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > HARNESS_VERIFIER_LIMITS.timeoutMs) throw new VerificationFailure('invalid_timeout');
      if (!Array.isArray(request.sourcePaths) || !request.sourcePaths.length || request.sourcePaths.length > HARNESS_VERIFIER_LIMITS.sourceFiles || request.sourcePaths.some((p: unknown) => typeof p !== 'string')) throw new VerificationFailure('invalid_sources');
      const paths = [...request.sourcePaths];
      receipt.commandHash = hash(canonical(command)); receipt.sourceCount = paths.length;
      receipt.sourceRevision = await this.revision(paths, signal);
      active(signal); receipt.execution = permission === 'full' ? 'local-full-not-isolated' : 'workspace-sandbox';
      const controller = new AbortController(); let timedOut = false;
      const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) controller.abort();
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      let result: VerificationExecution;
      try {
        // Adapter ownership is a trusted host contract. A non-settling adapter
        // poisons this verifier; it must never allow another execution to overlap.
        const execution = permission === 'full' ? executeLocal(command, this.workspace, controller.signal)
          : this.options.sandboxExecutor!.execute({ workspacePath: this.workspace, command, timeoutMs, maxOutputBytes: HARNESS_VERIFIER_LIMITS.outputBytes, signal: controller.signal });
        let deadline: NodeJS.Timeout | undefined;
        let retirementTimeout: (() => void) | undefined;
        try { result = await Promise.race([execution, new Promise<VerificationExecution>(resolveResult => {
          retirementTimeout = () => { deadline = setTimeout(() => resolveResult({ exitCode: null, stdout: '', stderr: '', settled: false }), 5500); };
          controller.signal.addEventListener('abort', retirementTimeout, { once: true });
          if (controller.signal.aborted) retirementTimeout();
        })]); } finally { clearTimeout(deadline); if (retirementTimeout) controller.signal.removeEventListener('abort', retirementTimeout); }
      } catch { controller.abort(); this.poisoned = true; throw new VerificationFailure('executor_unconfirmed'); }
      finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
      if (!result || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || (result.exitCode !== null && !Number.isInteger(result.exitCode))) { this.poisoned = true; throw new VerificationFailure('invalid_executor_result'); }
      const stdout = boundedOutput(result.stdout), stderr = boundedOutput(result.stderr);
      receipt.stdout = stdout.text; receipt.stderr = stderr.text; receipt.stdoutTruncated = stdout.truncated || result.stdoutTruncated === true; receipt.stderrTruncated = stderr.truncated || result.stderrTruncated === true;
      receipt.exitCode = result.exitCode;
      if (result.settled !== true) { this.poisoned = true; throw new VerificationFailure('retirement_unconfirmed'); }
      if (signal.aborted || result.aborted && !timedOut) throw new VerificationFailure('cancelled');
      if (timedOut || result.timedOut) throw new VerificationFailure('timeout');
      receipt.afterRevision = await this.revision(paths, signal);
      if (receipt.afterRevision !== receipt.sourceRevision) throw new VerificationFailure('source_changed');
      if (result.exitCode !== 0) throw new VerificationFailure('exit_nonzero');
      receipt.status = 'passed';
    } catch (error) {
      receipt.failure = error instanceof VerificationFailure ? error.code : 'verification_unavailable';
      receipt.status = receipt.failure === 'cancelled' ? 'cancelled' : receipt.failure === 'timeout' ? 'timed-out'
        : receipt.execution === 'none' ? 'rejected' : 'failed';
    } finally { this.busy = false; }
    receipt.durationMs = performance.now() - started; return receipt;
  }
}

/** Full permission only. No shell interpolation, package discovery, or implicit environment secrets. */
function executeLocal(command: VerificationCommand, workspace: string, signal: AbortSignal): Promise<VerificationExecution> {
  if (signal.aborted) return Promise.resolve({ exitCode: null, stdout: '', stderr: '', settled: true, aborted: true });
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'LANG', 'LC_ALL', 'TZ']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
  return new Promise(resolveResult => {
    const child = spawn(command.executable, command.args, { cwd: workspace, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let outBytes = 0, errBytes = 0, outTruncated = false, errTruncated = false;
    let done = false, aborted = false, deadline: NodeJS.Timeout | undefined;
    let closed = false, closedCode: number | null = null, cleanup: Promise<boolean> | undefined;
    const finish = (exitCode: number | null, settled: boolean) => {
      if (done) return; done = true; clearTimeout(deadline); signal.removeEventListener('abort', abort);
      if (!settled) { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); }
      resolveResult({ exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
        settled, aborted, stdoutTruncated: outTruncated, stderrTruncated: errTruncated });
    };
    const finishClosed = () => {
      if (!closed || done) return;
      if (cleanup) void cleanup.then(ok => finish(closedCode, ok)); else finish(closedCode, true);
    };
    const abort = () => {
      if (aborted || done) return; aborted = true;
      // Begin scoped tree retirement while the root PID still exists. Await
      // taskkill itself as well as close; root close alone is not tree cleanup.
      cleanup = retireOwnedProcess(child);
      deadline = setTimeout(() => finish(null, false), 5000);
      finishClosed();
    };
    const append = (target: Buffer[], which: 'out' | 'err', data: Buffer) => {
      if (done) return; const current = which === 'out' ? outBytes : errBytes, size = Math.min(data.length, Math.max(0, HARNESS_VERIFIER_LIMITS.outputBytes - current));
      if (size) target.push(Buffer.from(data.subarray(0, size)));
      if (which === 'out') { outBytes += size; outTruncated ||= size < data.length; } else { errBytes += size; errTruncated ||= size < data.length; }
    };
    child.stdout.on('data', (data: Buffer) => append(stdout, 'out', data)); child.stderr.on('data', (data: Buffer) => append(stderr, 'err', data));
    child.once('error', () => { if (!child.pid) finish(null, true); else abort(); });
    child.once('close', code => { closed = true; closedCode = code; finishClosed(); });
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}

/** No process-name scans/global killing. Only this call's PID/process group. */
function retireOwnedProcess(child: ChildProcess): Promise<boolean> {
  if (!child.pid) return Promise.resolve(true);
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); return Promise.resolve(true); }
    catch (error) { return Promise.resolve((error as NodeJS.ErrnoException).code === 'ESRCH'); }
  }
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(false);
  return new Promise(resolveRetired => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    let finished = false;
    const finish = (ok: boolean) => { if (finished) return; finished = true; clearTimeout(timer); resolveRetired(ok); };
    const timer = setTimeout(() => { try { killer.kill(); } catch { /* owned helper only */ } finish(false); }, 4500);
    killer.once('error', () => finish(false)); killer.once('close', code => finish(code === 0));
  });
}
