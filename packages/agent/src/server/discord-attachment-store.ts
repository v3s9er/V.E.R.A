import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mrRobotHome } from '../config.js';
import { SecretVault } from '../secrets.js';
import { resolveConfinedPath } from './http.js';
import { fetchPublicResource, SafeFetchError, type SharedByteBudget } from '../plugins/resource-archiver/security.js';

const MiB = 1024 * 1024, TTL = 7 * 24 * 3600_000;
export type AttachmentSource = { id: string; url: string; name: string; size: number };
export type StoredAttachment = { id: string; name: string; size: number; sha256: string; expiresAt: number };
/** Only fixed, non-sensitive diagnostics may cross the Discord bridge. */
export class DiscordAttachmentError extends Error {
  constructor(readonly code: string, message: string, readonly attempts = 0) {
    super(`${message} [${code}]`);
    this.name = 'DiscordAttachmentError';
  }
}
function downloadFailure(error: unknown, attempts: number): DiscordAttachmentError {
  if (error instanceof SafeFetchError) {
    if (error.kind === 'http' && error.status && error.status >= 400 && error.status <= 599) {
      const message = [401, 403, 404, 410].includes(error.status)
        ? 'Discord에서 첨부 접근을 거부했거나 파일이 만료·삭제되었습니다. 원본을 다시 첨부해 주세요.'
        : 'Discord 첨부 서버가 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
      return new DiscordAttachmentError(`HTTP_${error.status}`, message, attempts);
    }
    const messages = {
      dns: 'Discord 첨부 서버 주소를 찾지 못했습니다. PC의 인터넷 연결과 DNS를 확인해 주세요.',
      network: 'Discord 첨부 다운로드 연결이 끊겼습니다. PC의 인터넷 연결을 확인하고 다시 시도해 주세요.',
      timeout: 'Discord 첨부 다운로드 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.',
      body: '첨부 다운로드가 끝까지 완료되지 않았습니다. 다시 첨부해 주세요.',
      size: '실제 첨부 용량이 한도를 초과했습니다. 파일당 25MiB, 한 요청 합계 50MiB까지 받을 수 있습니다.',
      policy: '허용되지 않는 첨부 주소 또는 리디렉션을 차단했습니다. 이 티켓에 원본을 직접 첨부해 주세요.',
      http: 'Discord 첨부 서버 응답이 올바르지 않습니다. 다시 시도해 주세요.',
    };
    return new DiscordAttachmentError(`DOWNLOAD_${error.kind.toUpperCase()}`, messages[error.kind], attempts);
  }
  return new DiscordAttachmentError('DOWNLOAD_FAILED', 'Discord 첨부를 내려받지 못했습니다. 다시 시도해 주세요.', attempts);
}
export function validateAttachmentSources(value: unknown, channel: string): AttachmentSource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10 || !/^\d{1,22}$/.test(channel)) throw new Error('첨부 목록이 올바르지 않습니다.');
  let size = 0;
  return value.map(f => {
    if (!f || !/^\d{1,22}$/.test(f.id) || typeof f.name !== 'string' || f.name.length > 200 || typeof f.url !== 'string' || f.url.length > 8192
      || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > 25 * MiB || (size += f.size) > 50 * MiB) throw new Error('첨부 크기 또는 식별자가 올바르지 않습니다.');
    const url = new URL(f.url);
    const parts = url.pathname.split('/');
    if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
      || url.username || url.password || url.port || parts.length !== 5 || parts[1] !== 'attachments' || parts[2] !== channel || parts[3] !== f.id)
      throw new Error('이 메시지에 직접 첨부한 Discord 파일만 받을 수 있습니다.');
    return { id: f.id, name: f.name.replace(/[\x00-\x1f]/g, '_'), size: f.size, url: url.href };
  });
}

/** Encrypted originals survive app/container restarts; ticket identity is AEAD-bound.
 * No model-supplied path or URL is ever accepted by this store. */
export class DiscordAttachmentStore {
  private key?: Buffer;
  constructor(private root = join(mrRobotHome(), 'discord-attachments'), private vault = new SecretVault('discord-attachments'),
    private now = Date.now, private fetcher = fetchPublicResource, private receiveTimeoutMs = 60_000) {}
  private path(name: string) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) throw new Error('첨부 저장소 경로가 안전하지 않습니다.');
    return resolveConfinedPath(this.root, name);
  }
  private getKey() {
    if (!this.key) {
      try {
        const path = this.path('key.dpapi');
        let key: Buffer;
        if (existsSync(path)) key = Buffer.from(this.vault.unprotect(readFileSync(path, 'utf8')), 'base64');
        else {
          key = randomBytes(32);
          writeFileSync(path, this.vault.protect(key.toString('base64')), { flag: 'wx', mode: 0o600 });
        }
        if (key.length !== 32) throw new Error('key');
        // A failed key write must never leave a transient key cached in memory.
        this.key = key;
      } catch {
        throw new DiscordAttachmentError('STORAGE_KEY', 'PC의 첨부 암호화 키를 열거나 저장하지 못했습니다. 기존 키는 삭제하지 말고 PC 저장소 권한을 확인해 주세요.');
      }
    }
    return this.key;
  }
  private scope(ticket: string) {
    if (!ticket || ticket.length > 200) throw new Error('첨부 티켓이 올바르지 않습니다.');
    return createHash('sha256').update(ticket).digest('hex');
  }
  private filename(ticket: string, id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('첨부 ID가 올바르지 않습니다.');
    return `${this.scope(ticket)}-${id}.bin`;
  }
  prune() {
    this.path('key.dpapi');
    let used = 0;
    for (const name of readdirSync(this.root)) {
      if (!/^[a-f0-9]{64}-[a-f0-9]{64}\.bin$/.test(name)) continue;
      const path = this.path(name), stat = lstatSync(path);
      if (!stat.isFile()) throw new Error('첨부 저장소 파일이 안전하지 않습니다.');
      if (this.now() - stat.mtimeMs > TTL) unlinkSync(path); else used += stat.size;
    }
    return used;
  }
  put(ticket: string, name: string, data: Buffer): StoredAttachment {
    if (data.length > 25 * MiB) throw new Error('첨부 하나는 25MB 이하로 보내주세요.');
    const id = createHash('sha256').update(data).digest('hex'), filename = this.filename(ticket, id);
    const used = this.prune();
    if (!existsSync(this.path(filename)) && used + data.length > 512 * MiB) throw new DiscordAttachmentError('STORAGE_QUOTA', '첨부 보관 공간이 가득 찼습니다. 기존 첨부는 보존했습니다. PC에서 보관 공간을 정리해 주세요.');
    const meta = { id, sha256: id, name: name.slice(0, 200), size: data.length, expiresAt: this.now() + TTL };
    const header = Buffer.from(JSON.stringify(meta)), length = Buffer.alloc(4); length.writeUInt32BE(header.length);
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.getKey(), nonce);
    cipher.setAAD(Buffer.from(filename));
    const encrypted = Buffer.concat([cipher.update(Buffer.concat([length, header, data])), cipher.final()]);
    writeFileSync(this.path(filename), Buffer.concat([nonce, cipher.getAuthTag(), encrypted]), { mode: 0o600 });
    return meta;
  }
  get(ticket: string, id: string): { meta: StoredAttachment; data: Buffer } {
    const name = this.filename(ticket, id), path = this.path(name);
    if (!existsSync(path)) throw new Error('이 티켓에 보관된 첨부가 아닙니다. 원본 보관 기간은 7일입니다.');
    if (lstatSync(path).size > 26 * MiB) throw new Error('첨부 저장 형식이 올바르지 않습니다.');
    const raw = readFileSync(path), decipher = createDecipheriv('aes-256-gcm', this.getKey(), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(name)); decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    const length = plain.readUInt32BE(0);
    if (length > 4096) throw new Error('첨부 메타데이터가 올바르지 않습니다.');
    const meta = JSON.parse(plain.subarray(4, 4 + length).toString('utf8')) as StoredAttachment, data = plain.subarray(4 + length);
    if (meta.expiresAt < this.now() || meta.id !== id || meta.size !== data.length || createHash('sha256').update(data).digest('hex') !== id) throw new Error('첨부가 만료되었거나 무결성 검증에 실패했습니다.');
    return { meta, data };
  }
  list(ticket: string): StoredAttachment[] {
    this.prune();
    const prefix = this.scope(ticket) + '-';
    return readdirSync(this.root).filter(n => n.startsWith(prefix) && /^[a-f0-9]{64}-[a-f0-9]{64}\.bin$/.test(n)).map(n => this.get(ticket, n.slice(65, 129)).meta);
  }
  async receive(ticket: string, source: AttachmentSource, signal?: AbortSignal, budget: SharedByteBudget = { remaining: 50 * MiB }) {
    const url = new URL(source.url);
    validateAttachmentSources([source], url.pathname.split('/')[2] ?? '');
    if (!Number.isSafeInteger(budget.remaining) || budget.remaining < 0 || budget.remaining > 50 * MiB) throw new Error('첨부 용량 예산이 올바르지 않습니다.');
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.receiveTimeoutMs);
    timer.unref();
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    let body: Buffer | undefined;
    let attempts = 0;
    try {
      const maxBytes = Math.min(25 * MiB, budget.remaining);
      for (attempts = 1; attempts <= 3; attempts++) {
        try {
          combined.throwIfAborted();
          const result = await this.fetcher(url.href, { pageHost: url.hostname, allowedCrossOriginHosts: new Set() }, {
            maxResources: 1, maxNetworkRequests: 1, maxResourceBytes: maxBytes, maxTotalBytes: maxBytes, maxDepth: 0,
            concurrency: 1, timeoutMs: 45_000, retries: 0, maxRedirects: 0, minRequestIntervalMs: 0, overallTimeoutMs: this.receiveTimeoutMs,
          }, combined, { remaining: maxBytes });
          combined.throwIfAborted();
          if (result.status !== 200) throw new SafeFetchError('status', false, 'http', result.status);
          if (result.body.length > maxBytes) throw new SafeFetchError('size', false, 'size');
          if (!result.body.length && source.size > 0) throw new SafeFetchError('empty body', true, 'body');
          // Discord metadata can describe a different image representation than
          // the CDN serves. Its size is a hint, NOT a checksum. The secure HTTP
          // reader enforces transport completion and decoded-byte limits; bind
          // the hash, encrypted record and request budget to the bytes received.
          body = Buffer.from(result.body);
          break;
        } catch (error) {
          combined.throwIfAborted();
          if (!(error instanceof SafeFetchError) || !error.retryable || attempts === 3) throw error;
          await delay(attempts * 250, undefined, { signal: combined });
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      throw downloadFailure(timeout.signal.aborted ? new SafeFetchError('timeout', false, 'timeout') : error, attempts);
    } finally { clearTimeout(timer); }
    signal?.throwIfAborted();
    if (!body) throw downloadFailure(new Error('missing body'), attempts);
    // Sequential ticket intake shares an actual-byte budget across all files.
    budget.remaining -= body.length;
    try { return this.put(ticket, source.name, body); }
    catch (error) {
      if (error instanceof DiscordAttachmentError) throw error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOSPC' || code === 'EDQUOT') throw new DiscordAttachmentError('STORAGE_SPACE', '첨부는 내려받았지만 PC 디스크 공간이 부족해 저장하지 못했습니다.');
      if (code === 'EACCES' || code === 'EPERM') throw new DiscordAttachmentError('STORAGE_PERMISSION', '첨부는 내려받았지만 PC 저장소 접근이 거부되었습니다. 폴더 권한이나 보안 프로그램을 확인해 주세요.');
      throw new DiscordAttachmentError('STORAGE_WRITE', '첨부는 내려받았지만 PC의 암호화 보관소에 저장하지 못했습니다. 저장소 상태를 확인해 주세요.');
    }
  }
}
let store: DiscordAttachmentStore | undefined;
export function discordAttachmentStore() { return store ??= new DiscordAttachmentStore(); }
