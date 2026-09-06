import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SecureFiles, sealFilePacket, openFilePacket } from '../src/server/secure-files.js';
import { resolveConfinedPath } from '../src/server/http.js';
import { gcm } from '../../../apps/mobile/node_modules/@noble/ciphers/aes.js';

const dir = mkdtempSync(join(tmpdir(), 'mr-robot-encrypted-files-test-'));
const vault = { protect: (value: string) => Buffer.from(value).toString('base64'), unprotect: (value: string) => Buffer.from(value, 'base64').toString() };
let revoked = false, write = true;
const host: any = {
 authenticate: (secret: string) => !revoked && ['fixture-device', 'other-device'].includes(secret) ? { isAdmin: false, linkId: secret } : null,
 sharedFileAccess: (_: string, isWrite: boolean) => !revoked && (!isWrite || write),
 fileAccess: (_: string, isWrite: boolean) => !isWrite,
 workspacesList: () => [{ id: 'workspace', path: join(dir, 'workspace') }],
};
try {
 mkdirSync(join(dir, 'shared')); mkdirSync(join(dir, 'workspace'));
 writeFileSync(join(dir, 'workspace', '한국어.pdf'), Buffer.from('fixture pdf contents'));
 const channel = new SecureFiles(dir, host, resolveConfinedPath, vault);
 const invite = channel.invite();
 let session: string | undefined;
 function request(op: Record<string, unknown>, secret = 'fixture-device') {
  return sealFilePacket(invite.id, invite.key, { ...op, session, secret, time: Date.now(), requestId: randomBytes(16).toString('hex') }, 'request');
 }
 function call(op: Record<string, unknown>, secret?: string) {
  return openFilePacket(channel.handle(request(op, secret)), invite.key, 'response').result;
 }
 assert.throws(() => channel.handle(request({ op: 'list' })), /등록/);
 const enrolled = call({ op: 'enroll' }); session = enrolled.session;
 assert.equal(enrolled.ok, true);
 assert.equal(channel.protected('fixture-device'), true);
 const stored = readFileSync(join(dir, 'file-channel.dpapi'), 'utf8');
 assert.equal(stored.includes(invite.key), false);
 const req = request({ op: 'list', workspaceId: 'workspace' });
 // Mobile noble AES-GCM and Node OpenSSL interoperate in both directions.
 const decoded = JSON.parse(Buffer.from(gcm(Buffer.from(invite.key, 'hex'), Buffer.from(req.nonce, 'hex'), Buffer.from(`Mr.Robot/files/v1/request/${invite.id}`)).decrypt(Buffer.from(req.data, 'hex'))).toString());
 assert.equal(decoded.op, 'list');
 const response = channel.handle(req);
 const mobile = JSON.parse(Buffer.from(gcm(Buffer.from(invite.key, 'hex'), Buffer.from(response.nonce, 'hex'), Buffer.from(`Mr.Robot/files/v1/response/${invite.id}`)).decrypt(Buffer.from(response.data, 'hex'))).toString());
 assert.equal(mobile.result.items[0].name, '한국어.pdf');
 assert.throws(() => channel.handle(req), /중복/);
 assert.throws(() => channel.handle({ ...request({ op: 'list' }), data: '00'.repeat(32) }));
 assert.throws(() => openFilePacket(response, invite.key, 'request'));
 assert.throws(() => channel.handle(request({ op: 'enroll' }, 'other-device')), /다른 기기/);
 assert.ok(call({ op: 'read', path: '../outside', offset: 0 }).error);
 const part = call({ op: 'read', path: '한국어.pdf', workspaceId: 'workspace', offset: 0 });
 assert.equal(Buffer.from(part.data, 'hex').toString(), 'fixture pdf contents');
 assert.equal(part.done, true);
 writeFileSync(join(dir, 'workspace', '한국어.pdf'), 'changed');
 assert.ok(call({ op: 'read', path: '한국어.pdf', workspaceId: 'workspace', offset: 0, version: part.version }).error);
 const upload = call({ op: 'upload.begin', size: 3, name: 'phone.txt' });
 assert.ok(call({ op: 'upload.chunk', uploadId: upload.id, offset: 1, data: '616263' }).error);
 assert.ok(call({ op: 'upload.end', uploadId: upload.id }).error);
 assert.equal(call({ op: 'upload.chunk', uploadId: upload.id, offset: 0, data: '616263' }).offset, 3);
 const uploaded = call({ op: 'upload.end', uploadId: upload.id });
 assert.equal(readFileSync(uploaded.absolutePath, 'utf8'), 'abc');
 write = false; assert.ok(call({ op: 'upload.begin', size: 0, name: 'blocked' }).error);
 const reopened = new SecureFiles(dir, host, resolveConfinedPath, vault);
 assert.equal(reopened.protected('fixture-device'), true);
 assert.equal(openFilePacket(reopened.handle(request({ op: 'list' })), invite.key, 'response').result.code, 'SESSION_EXPIRED', 'old captured operations cannot be replayed after a PC restart');
 revoked = true; assert.throws(() => reopened.handle(request({ op: 'list' })));
 channel.reset(); assert.throws(() => channel.handle(request({ op: 'list' })));
 console.log('Secure files passed: optical enrollment, AES-GCM interoperability, tamper/replay/reflection rejection, ownership/revocation, confinement, ordered upload, read-only, restart');
} finally { rmSync(dir, { recursive: true, force: true }); }
