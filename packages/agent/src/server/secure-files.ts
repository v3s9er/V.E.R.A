import { createCipheriv, createDecipheriv, randomBytes, randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, statfsSync, openSync, closeSync, readSync, writeFileSync, appendFileSync, unlinkSync, renameSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { SecretVault } from '../secrets.js';
import { atomicWriteUtf8 } from '../config.js';
import type { HttpApiHost } from './http.js';

const CHUNK = 128 * 1024;
const MAX_FILE = 96 * 1024 * 1024;
type Key = { key: string; principal?: string; expiresAt: number };
type Packet = { id: string; nonce: string; data: string };
const hex = (v: unknown, n: number) => typeof v === 'string' && v.length === n && /^[a-f0-9]+$/.test(v);
export function sealFilePacket(id: string, key: string, value: unknown, direction: 'request' | 'response'): Packet {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), nonce);
  cipher.setAAD(Buffer.from(`Mr.Robot/files/v1/${direction}/${id}`));
  return { id, nonce: nonce.toString('hex'), data: Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('hex') };
}
export function openFilePacket(packet: Packet, key: string, direction: 'request' | 'response'): any {
  if (!hex(packet.nonce, 24) || typeof packet.data !== 'string' || packet.data.length > 900_000 || packet.data.length < 32 || packet.data.length % 2 || !/^[a-f0-9]+$/.test(packet.data)) throw new Error('암호문 형식 오류');
  const data = Buffer.from(packet.data, 'hex');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(packet.nonce, 'hex'));
  cipher.setAAD(Buffer.from(`Mr.Robot/files/v1/${direction}/${packet.id}`));
  cipher.setAuthTag(data.subarray(-16));
  return JSON.parse(Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]).toString('utf8'));
}

/** File-only PSK channel. Keys are transferred optically, never through the relay. */
export class SecureFiles {
  private epoch = randomUUID();
  private keys: Record<string, Key> = {};
  private replay = new Map<string, number>();
  private uploads = new Map<string, { principal: string; file: string; size: number; offset: number; name: string; expiresAt: number; hash: ReturnType<typeof createHash> }>();
  private vault = new SecretVault('remote-link');
  private file: string;
  private staging: string;
  constructor(private home: string, private host: HttpApiHost, private confined: (root: string, path: unknown) => string, vault?: Pick<SecretVault, 'protect' | 'unprotect'>) {
    if (vault) this.vault = vault as SecretVault;
    this.file = join(home, 'file-channel.dpapi');
    this.staging = join(home, 'secure-file-staging');
    mkdirSync(this.staging, { recursive: true });
    if (existsSync(this.file)) this.keys = JSON.parse(this.vault.unprotect(readFileSync(this.file, 'utf8')));
    // Only owned partial transfer files; never user's shared files.
    for (const name of readdirSync(this.staging)) if (/^[a-f0-9-]{36}\.part$/.test(name)) unlinkSync(join(this.staging, name));
  }
  private save() { atomicWriteUtf8(this.file, this.vault.protect(JSON.stringify(Object.fromEntries(Object.entries(this.keys).filter(([, k]) => k.principal))))); }
  invite() {
    this.sweep();
    if (Object.keys(this.keys).length >= 64) throw new Error('보안 파일 기기 등록 한도입니다. 기존 등록을 초기화하세요.');
    const id = randomUUID(), key = randomBytes(32).toString('hex'), expiresAt = Date.now() + 5 * 60_000;
    // Unclaimed keys stay memory-only and vanish on restart.
    this.keys[id] = { key, expiresAt };
    return { app: 'mr-robot-file-key', version: 1, id, key, expiresAt };
  }
  reset() { this.keys = {}; this.replay.clear(); this.save(); }
  protected(principal: string) { return Object.values(this.keys).some(k => k.principal === principal); }
  private sweep() {
    for (const [id, key] of Object.entries(this.keys)) if (!key.principal && key.expiresAt <= Date.now()) delete this.keys[id];
    for (const [id, expiry] of this.replay) if (expiry < Date.now()) this.replay.delete(id);
    for (const [id, upload] of this.uploads) if (upload.expiresAt < Date.now()) { try { unlinkSync(upload.file); } catch {} this.uploads.delete(id); }
  }
  handle(packet: Packet) {
    this.sweep();
    const key = this.keys[packet?.id];
    if (!key || key.expiresAt <= Date.now()) throw new Error('보안 파일 QR을 다시 등록하세요.');
    const body = openFilePacket(packet, key.key, 'request');
    if (!body || typeof body !== 'object' || !hex(body.requestId, 32) || !Number.isSafeInteger(body.time) || Math.abs(Date.now() - body.time) > 120_000) throw new Error('만료된 보안 요청');
    const auth = this.host.authenticate(String(body.secret ?? ''));
    if (!auth || auth.isAdmin || !auth.linkId) throw new Error('페어링된 모바일 기기만 등록할 수 있습니다.');
    const principal = auth.linkId;
    if (key.principal && key.principal !== principal) throw new Error('다른 기기의 암호화 키입니다.');
    const replayId = `${packet.id}:${packet.nonce}`;
    if (this.replay.has(replayId) || this.replay.size >= 8192) throw new Error('중복 요청 또는 요청 과다');
    this.replay.set(replayId, Date.now() + 120_000);
    if (!key.principal) {
      if (body.op !== 'enroll' || !this.host.sharedFileAccess(body.secret, false)) throw new Error('파일 전송 기기 등록이 필요합니다.');
      key.principal = principal; key.expiresAt = Date.now() + 90 * 86400_000;
      try { this.save(); } catch (error) { delete this.keys[packet.id]; throw error; }
    }
    let result: unknown;
    try { result = this.operation(body, principal); }
    catch (error) { result = { error: error instanceof Error ? error.message : '보안 파일 작업 실패' }; }
    return sealFilePacket(packet.id, key.key, { requestId: body.requestId, result }, 'response');
  }
  private operation(body: any, principal: string): unknown {
    const canRead = this.host.sharedFileAccess(body.secret, false);
    if (!canRead) throw new Error('PC에서 이 기기의 파일 전송 권한을 허용하세요.');
    if (body.op === 'enroll' || body.op === 'hello') return { ok: true, expiresInDays: 90, session: this.epoch };
    if (body.session !== this.epoch) return { error: '파일 연결 세션이 갱신됐습니다.', code: 'SESSION_EXPIRED' };
    const root = body.workspaceId ? this.host.workspacesList().find(w => w.id === body.workspaceId)?.path : join(this.home, 'shared');
    if (!root) throw new Error('작업 폴더를 찾을 수 없습니다.');
    if (body.workspaceId && !this.host.fileAccess(body.secret, false)) throw new Error('작업 폴더 읽기 권한이 없습니다.');
    if (body.op === 'list' || body.op === 'read') {
      const file = this.confined(root, body.path || '');
      if (body.op === 'list') {
        return { items: readdirSync(file, { withFileTypes: true }).filter(d => !d.isSymbolicLink()).slice(0, 1500).map(d => { const path = this.confined(root, join(String(body.path || ''), d.name)); const stat = statSync(path); return { name: d.name, path: relative(root, path).replaceAll('\\', '/'), size: stat.size, isDirectory: stat.isDirectory(), modifiedAt: stat.mtimeMs }; }) };
      }
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('보안 전송은 일반 파일 하나당 최대 96MB입니다.');
      const offset = Number(body.offset);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size) throw new Error('파일 위치 오류');
      const version = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
      if (body.version && body.version !== version) throw new Error('전송 중 파일이 변경됐습니다. 다시 받으세요.');
      const fd = openSync(file, 'r'), bytes = Buffer.alloc(Math.min(CHUNK, stat.size - offset));
      let size: number;
      try { size = readSync(fd, bytes, 0, bytes.length, offset); } finally { closeSync(fd); }
      return { size: stat.size, version, offset, data: bytes.subarray(0, size).toString('hex'), done: offset + size === stat.size };
    }
    // Phone attachments go only into a unique shared inbox, not arbitrary project writes.
    if (!this.host.sharedFileAccess(body.secret, true)) throw new Error('현재 읽기 전용입니다. PC에서 파일 전송 쓰기 권한을 허용하세요.');
    if (body.op === 'upload.begin') {
      if (this.uploads.size >= 4 || !Number.isSafeInteger(body.size) || body.size < 0 || body.size > MAX_FILE) throw new Error('전송 한도 초과 (동시 4개, 파일당 96MB)');
      const disk = statfsSync(this.staging);
      if (disk.bavail * disk.bsize < body.size + 128 * 1024 * 1024) throw new Error('PC 저장 공간이 부족합니다.');
      const id = randomUUID(), file = join(this.staging, `${id}.part`);
      writeFileSync(file, '', { flag: 'wx' });
      this.uploads.set(id, { principal, file, size: body.size, offset: 0, name: basename(String(body.name || 'attachment')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120), expiresAt: Date.now() + 120_000, hash: createHash('sha256') });
      return { id };
    }
    const upload = this.uploads.get(body.uploadId);
    if (!upload || upload.principal !== principal) throw new Error('업로드가 만료됐거나 다른 기기의 작업입니다.');
    if (body.op === 'upload.cancel') { unlinkSync(upload.file); this.uploads.delete(body.uploadId); return { ok: true }; }
    if (body.op === 'upload.chunk') {
      if (body.offset !== upload.offset || typeof body.data !== 'string' || body.data.length > CHUNK * 2 || body.data.length % 2 || !/^[a-f0-9]+$/.test(body.data)) throw new Error('업로드 조각 순서 오류');
      const bytes = Buffer.from(body.data, 'hex');
      if (upload.offset + bytes.length > upload.size) throw new Error('업로드 크기 초과');
      appendFileSync(upload.file, bytes); upload.hash.update(bytes); upload.offset += bytes.length; upload.expiresAt = Date.now() + 120_000;
      return { offset: upload.offset };
    }
    if (body.op === 'upload.end') {
      if (upload.offset !== upload.size) throw new Error('미완료 업로드');
      const path = `.mobile-inbox/${body.uploadId}-${upload.name}`;
      const shared = join(this.home, 'shared'); mkdirSync(join(shared, '.mobile-inbox'), { recursive: true });
      const target = this.confined(shared, path);
      if (existsSync(target)) throw new Error('기존 파일을 덮어쓸 수 없습니다.');
      renameSync(upload.file, target); this.uploads.delete(body.uploadId);
      return { path, absolutePath: target, size: upload.size, sha256: upload.hash.digest('hex') };
    }
    throw new Error('지원하지 않는 파일 작업');
  }
}
