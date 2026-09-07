import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { mrRobotHome } from '../config.js';
import { SecretVault } from '../secrets.js';
import { resolveConfinedPath } from './http.js';
import { fetchPublicResource } from '../plugins/resource-archiver/security.js';

const MiB = 1024 * 1024, TTL = 7 * 24 * 3600_000;
export type AttachmentSource = { id: string; url: string; name: string; size: number };
export type StoredAttachment = { id: string; name: string; size: number; sha256: string; expiresAt: number };
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
  constructor(private root = join(mrRobotHome(), 'discord-attachments'), private vault = new SecretVault('discord-attachments'), private now = Date.now) {}
  private path(name: string) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) throw new Error('첨부 저장소 경로가 안전하지 않습니다.');
    return resolveConfinedPath(this.root, name);
  }
  private getKey() {
    if (!this.key) {
      const path = this.path('key.dpapi');
      if (existsSync(path)) this.key = Buffer.from(this.vault.unprotect(readFileSync(path, 'utf8')), 'base64');
      else { this.key = randomBytes(32); writeFileSync(path, this.vault.protect(this.key.toString('base64')), { flag: 'wx', mode: 0o600 }); }
      if (this.key.length !== 32) { this.key = undefined; throw new Error('첨부 암호화 키를 열 수 없습니다.'); }
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
    if (!existsSync(this.path(filename)) && used + data.length > 512 * MiB) throw new Error('첨부 보관 공간이 가득 찼습니다. 기존 첨부는 보존했습니다. PC에서 보관 공간을 정리해 주세요.');
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
  async receive(ticket: string, source: AttachmentSource, signal?: AbortSignal) {
    const url = new URL(source.url);
    try {
      const result = await fetchPublicResource(url.href, { pageHost: url.hostname, allowedCrossOriginHosts: new Set() }, {
        maxResources: 1, maxNetworkRequests: 1, maxResourceBytes: 25 * MiB, maxTotalBytes: 25 * MiB, maxDepth: 0,
        concurrency: 1, timeoutMs: 45_000, retries: 0, maxRedirects: 0, minRequestIntervalMs: 0, overallTimeoutMs: 45_000,
      }, signal, { remaining: 25 * MiB });
      signal?.throwIfAborted();
      if (result.status !== 200 || result.body.length !== source.size) throw new Error('download');
      return this.put(ticket, source.name, Buffer.from(result.body));
    } catch { signal?.throwIfAborted(); throw new Error('Discord 첨부 원본을 받지 못했습니다. 다운로드 만료·네트워크 또는 저장 공간을 확인하세요.'); }
  }
}
let store: DiscordAttachmentStore | undefined;
export function discordAttachmentStore() { return store ??= new DiscordAttachmentStore(); }
