import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ENTROPY = 'Mr.Robot/work-calendar/private-state/v1';
const PREFIX = 'dpapi:work-calendar:v1:';
/** Maximum UTF-8 JSON payload accepted by the protected private store. */
export const MAX_WORK_CALENDAR_STATE_BYTES = 4 * 1024 * 1024;
// DPAPI adds a small envelope and Base64 expands bytes by roughly 4/3. This
// leaves ample bounded headroom for a maximum-size accepted payload.
const POWERSHELL_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
// Only ASCII Base64 crosses the Node <-> Windows PowerShell stdio boundary.
// Windows PowerShell 5.1 can otherwise decode redirected UTF-8 input with a
// legacy console code page, silently corrupting Korean labels and addresses.
const PROTECT_SCRIPT = `Add-Type -AssemblyName System.Security;$data=[Console]::In.ReadToEnd();$bytes=[Convert]::FromBase64String($data);$entropy=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}');$out=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($out))`;
const UNPROTECT_SCRIPT = `Add-Type -AssemblyName System.Security;$data=[Console]::In.ReadToEnd();$bytes=[Convert]::FromBase64String($data);$entropy=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}');$out=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($out))`;

export interface WorkCalendarSaveOptions {
  /** Replace both recovery copies so a superseded private value is not retained. */
  purgePrevious?: boolean;
}

/** The only on-disk location for sensitive work-calendar state. */
export function workCalendarStatePath(root = process.env.MR_ROBOT_HOME?.trim() || join(homedir(), '.mr-robot')): string {
  return join(root, 'private', 'work-calendar', 'state.bin');
}

/**
 * Small DPAPI-backed JSON store. It deliberately has no plaintext or portable
 * fallback: inability to use the current Windows account is an error.
 */
export class WorkCalendarPrivateStore<T> {
  constructor(readonly file = workCalendarStatePath()) {}

  load(): T | undefined {
    if (process.platform !== 'win32') throw new Error('Work-calendar private storage requires Windows DPAPI');
    try {
      return decryptJson<T>(requireTextFile(this.file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(previousFile(this.file))) return undefined;
      // A corrupt primary is intentionally never overwritten during recovery.
      // The preceding encrypted snapshot remains usable until a successful save.
      try {
        return decryptJson<T>(requireTextFile(previousFile(this.file)));
      } catch {
        throw new Error('Unable to decrypt protected work-calendar state');
      }
    }
  }

  save(value: T, options: WorkCalendarSaveOptions = {}): void {
    if (process.platform !== 'win32') throw new Error('Work-calendar private storage requires Windows DPAPI');
    let plaintext: string;
    try {
      plaintext = JSON.stringify(value);
    } catch {
      throw new Error('Work-calendar state cannot be serialized');
    }
    if (plaintext === undefined) throw new Error('Work-calendar state cannot be serialized');
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_WORK_CALENDAR_STATE_BYTES) {
      throw new Error('Work-calendar state exceeds protected storage limit');
    }

    let ciphertext: string;
    try {
      const bytes = Buffer.from(plaintext, 'utf8');
      try {
        ciphertext = PREFIX + runPowerShell(PROTECT_SCRIPT, bytes.toString('base64'));
      } finally {
        bytes.fill(0);
      }
    } catch {
      throw new Error('Unable to encrypt protected work-calendar state');
    }

    const directory = dirname(this.file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    setPrivateDirectoryPermissions(directory);
    const temporary = join(directory, `.state-${randomUUID()}.tmp`);
    const previous = previousFile(this.file);
    const previousTemporary = options.purgePrevious === true
      ? join(directory, `.state-${randomUUID()}.tmp`)
      : undefined;
    try {
      writeProtectedTemporary(temporary, ciphertext);
      if (previousTemporary) {
        // Prepare both durable copies before publishing either one. The recovery
        // copy is replaced first, so a valid protected copy exists throughout a
        // primary replacement even on Windows, where rename cannot overwrite.
        writeProtectedTemporary(previousTemporary, ciphertext);
        publishSanitizedCopies(this.file, temporary, previous, previousTemporary);
      } else {
        // Ordinary saves retain the preceding encrypted snapshot for recovery.
        if (existsSync(previous)) unlinkSync(previous);
        if (existsSync(this.file)) renameSync(this.file, previous);
        renameSync(temporary, this.file);
        setOwnerOnlyPermissions(this.file);
        flushFile(this.file);
      }
    } catch {
      // If publishing the new ciphertext failed after rotation, restore the last
      // known-good primary. No encrypted bytes are logged or decoded here.
      if (!previousTemporary) {
        try {
          if (!existsSync(this.file) && existsSync(previous)) renameSync(previous, this.file);
        } catch { /* best effort */ }
      }
      try { unlinkSync(temporary); } catch { /* best effort */ }
      if (previousTemporary) try { unlinkSync(previousTemporary); } catch { /* best effort */ }
      throw new Error('Unable to persist protected work-calendar state');
    }
  }
}

function writeProtectedTemporary(file: string, ciphertext: string | Buffer): void {
  const descriptor = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(descriptor, ciphertext, typeof ciphertext === 'string' ? { encoding: 'utf8' } : undefined);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  setOwnerOnlyPermissions(file);
}

/**
 * Publishes the same sanitized state as both primary and recovery copy. The
 * encrypted snapshots are used only to roll back a caught filesystem failure;
 * successful calls leave no named recovery path containing the old value.
 */
function publishSanitizedCopies(primary: string, primaryTemporary: string, previous: string, previousTemporary: string): void {
  let oldPrimary: Buffer | undefined;
  let oldPrevious: Buffer | undefined;
  let previousReplacementStarted = false;
  let primaryReplacementStarted = false;
  try {
    oldPrimary = readOptionalCiphertext(primary);
    oldPrevious = readOptionalCiphertext(previous);
    if (oldPrimary) {
      previousReplacementStarted = true;
      replaceWithPrepared(previous, previousTemporary);
      primaryReplacementStarted = true;
      replaceWithPrepared(primary, primaryTemporary);
    } else {
      // A recovery-only state can exist after external deletion or an interrupted
      // older save. Publish the missing primary first so the previous copy stays
      // usable until another durable copy exists.
      primaryReplacementStarted = true;
      replaceWithPrepared(primary, primaryTemporary);
      previousReplacementStarted = true;
      replaceWithPrepared(previous, previousTemporary);
    }
  } catch {
    // Restore the primary first and byte-for-byte. Callers do not commit their
    // in-memory revision when save throws, so the primary must match that state.
    if (primaryReplacementStarted) try { restoreCiphertext(primary, oldPrimary); } catch { /* best effort */ }
    if (previousReplacementStarted) try { restoreCiphertext(previous, oldPrevious); } catch { /* best effort */ }
    throw new Error('Unable to publish sanitized work-calendar state');
  } finally {
    oldPrimary?.fill(0);
    oldPrevious?.fill(0);
  }
}

function readOptionalCiphertext(file: string): Buffer | undefined {
  try {
    return readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function replaceWithPrepared(target: string, prepared: string): void {
  if (existsSync(target)) unlinkSync(target);
  renameSync(prepared, target);
  setOwnerOnlyPermissions(target);
  flushFile(target);
}

function restoreCiphertext(target: string, ciphertext: Buffer | undefined): void {
  if (existsSync(target)) unlinkSync(target);
  if (!ciphertext) return;
  const temporary = join(dirname(target), `.state-${randomUUID()}.restore`);
  try {
    writeProtectedTemporary(temporary, ciphertext);
    renameSync(temporary, target);
    setOwnerOnlyPermissions(target);
    flushFile(target);
  } finally {
    try { unlinkSync(temporary); } catch { /* best effort */ }
  }
}

function requireTextFile(file: string): string {
  // Keeping this import out of the public API prevents callers from reading a
  // decrypted representation accidentally; this is ciphertext only.
  return readFileSync(file, 'utf8').trim();
}

function previousFile(file: string): string { return `${file}.previous`; }

function decryptJson<T>(encoded: string): T {
  if (!encoded.startsWith(PREFIX)) throw new Error('Unsupported protected work-calendar state format');
  let plain: string;
  try {
    const decoded = Buffer.from(runPowerShell(UNPROTECT_SCRIPT, encoded.slice(PREFIX.length)), 'base64');
    try {
      plain = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
    } finally {
      decoded.fill(0);
    }
  } catch {
    throw new Error('Protected work-calendar state is not valid UTF-8');
  }
  try {
    return JSON.parse(plain) as T;
  } catch {
    throw new Error('Protected work-calendar state is not valid JSON');
  }
}

function setOwnerOnlyPermissions(path: string): void {
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs are authoritative; chmod is best effort. */ }
}

function setPrivateDirectoryPermissions(path: string): void {
  try { chmodSync(path, 0o700); } catch { /* Windows ACLs are authoritative; chmod is best effort. */ }
}

function flushFile(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } catch { /* Encryption and atomic replacement still fail closed; flush is best effort on Windows filesystems. */ }
  finally { if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* already closed */ } }
}

function runPowerShell(script: string, input: string): string {
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: POWERSHELL_MAX_BUFFER_BYTES,
  });
  if (result.status !== 0) throw new Error('Windows DPAPI operation failed');
  return result.stdout.trim();
}
