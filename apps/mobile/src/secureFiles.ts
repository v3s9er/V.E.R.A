import { gcm } from '@noble/ciphers/aes.js';
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils.js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { File } from 'expo-file-system';
import type { SavedPc } from './types';
import { httpBaseForPc, pcAuthenticatedHeaders } from './pcs';

type FileKey = { id: string; key: string; expiresAt: number };
const storageKey = (pc: SavedPc) => `mr-robot.file-key.${pc.id}`;
const aad = (id: string, direction: string) => utf8ToBytes(`Mr.Robot/files/v1/${direction}/${id}`);
const CHUNK = 128 * 1024, LIMIT = 96 * 1024 * 1024;
const sessions = new Map<string, string>();

export async function secureFileCall(pc: SavedPc, operation: Record<string, unknown>, signal?: AbortSignal, supplied?: FileKey, retry = true): Promise<any> {
  const stored = supplied ?? JSON.parse(await SecureStore.getItemAsync(storageKey(pc)) || 'null') as FileKey | null;
  if (!stored || stored.expiresAt <= Date.now()) throw new Error('파일 화면에서 PC의 파일 암호화 QR을 먼저 등록하세요.');
  if (operation.op !== 'hello' && operation.op !== 'enroll' && !sessions.has(stored.id)) await secureFileCall(pc, { op: 'hello' }, signal, stored);
  const requestId = bytesToHex(Crypto.getRandomBytes(16));
  const nonce = Crypto.getRandomBytes(12), key = hexToBytes(stored.key);
  const body = { ...operation, session: sessions.get(stored.id), secret: pc.secret, time: Date.now(), requestId };
  const data = gcm(key, nonce, aad(stored.id, 'request')).encrypt(utf8ToBytes(JSON.stringify(body)));
  const url = `${httpBaseForPc(pc)}/api/secure-files/channel`;
  const headers = pcAuthenticatedHeaders(pc, url, { 'content-type': 'application/json' });
  // PC bearer is inside the encrypted packet, not exposed to the relay in a header.
  delete headers['x-mr-robot-token'];
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(cancel, 25_000);
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: controller.signal, headers,
      body: JSON.stringify({ id: stored.id, nonce: bytesToHex(nonce), data: bytesToHex(data) }) });
    if (!response.ok) throw new Error(`보안 파일 연결 실패 (${response.status}). PC의 새 파일 암호화 QR을 등록하세요. Access가 만료됐다면 PC 연결부터 갱신하세요.`);
    const packet = await response.json();
    if (packet.id !== stored.id || typeof packet.data !== 'string' || packet.data.length > 1_500_000 || !/^[a-f0-9]{24}$/.test(packet.nonce)) throw new Error('잘못된 암호화 응답');
    const opened = JSON.parse(bytesToUtf8(gcm(key, hexToBytes(packet.nonce), aad(stored.id, 'response')).decrypt(hexToBytes(packet.data))));
    if (opened.requestId !== requestId) throw new Error('다른 요청의 응답입니다.');
    if (opened.result?.code === 'SESSION_EXPIRED' && retry) { sessions.delete(stored.id); return await secureFileCall(pc, operation, signal, supplied, false); }
    if (opened.result?.session) { if (sessions.size >= 64) sessions.clear(); sessions.set(stored.id, opened.result.session); }
    if (opened.result?.error) throw new Error(opened.result.error);
    return opened.result;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); key.fill(0); }
}

export async function enrollFileKey(pc: SavedPc, raw: string): Promise<void> {
  const value = JSON.parse(raw);
  if (value.app !== 'mr-robot-file-key' || value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.id)
    || !/^[a-f0-9]{64}$/.test(value.key) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 300_000) throw new Error('PC 파일 화면에서 만든 유효한 암호화 QR을 스캔하세요.');
  await secureFileCall(pc, { op: 'enroll' }, undefined, value);
  await SecureStore.setItemAsync(storageKey(pc), JSON.stringify({ id: value.id, key: value.key, expiresAt: Date.now() + 89 * 86400_000 }), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}

export async function uploadSecureFile(pc: SavedPc, uri: string, name: string, signal?: AbortSignal): Promise<{ path: string; absolutePath: string }> {
  const file = new File(uri);
  if (file.size > LIMIT) throw new Error('보안 파일 전송은 최대 96MB입니다.');
  const start = await secureFileCall(pc, { op: 'upload.begin', size: file.size, name }, signal);
  const handle = file.open();
  try {
    let offset = 0;
    while (offset < file.size) {
      if (signal?.aborted) throw new Error('전송 취소');
      const bytes = handle.readBytes(Math.min(CHUNK, file.size - offset));
      if (!bytes.length) throw new Error('파일이 변경됐습니다.');
      const result = await secureFileCall(pc, { op: 'upload.chunk', uploadId: start.id, offset, data: bytesToHex(bytes) }, signal);
      offset += bytes.length;
      if (result.offset !== offset) throw new Error('전송 순서 오류');
    }
    return await secureFileCall(pc, { op: 'upload.end', uploadId: start.id }, signal);
  } catch (error) {
    void secureFileCall(pc, { op: 'upload.cancel', uploadId: start.id }).catch(() => {});
    throw error;
  } finally { handle.close(); }
}

export async function downloadSecureFile(pc: SavedPc, path: string, uri: string, workspaceId?: string, signal?: AbortSignal): Promise<void> {
  const file = new File(uri); file.create({ overwrite: false });
  const handle = file.open();
  try {
    let offset = 0, version: string | undefined;
    for (;;) {
      const part = await secureFileCall(pc, { op: 'read', path, workspaceId, offset, version }, signal);
      if (!Number.isSafeInteger(part.size) || part.size > LIMIT || part.offset !== offset || (version && part.version !== version)) throw new Error('파일 전송 무결성 오류');
      version = part.version;
      const bytes = hexToBytes(part.data);
      if (bytes.length > CHUNK || offset + bytes.length > part.size || (!bytes.length && !part.done)) throw new Error('파일 조각 크기 오류');
      handle.writeBytes(bytes); offset += bytes.length;
      if (part.done) { if (offset !== part.size) throw new Error('불완전한 파일'); break; }
    }
  } catch (error) { handle.close(); file.delete(); throw error; }
  finally { try { handle.close(); } catch {} }
}
