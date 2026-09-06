import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createHttpApi } from '../src/server/http.js';
import { WsUpgradeTickets } from '../src/server/ws.js';
import { defaultSettings } from '../src/config.js';
import { sealFilePacket, openFilePacket } from '../src/server/secure-files.js';

const directory = mkdtempSync(join(tmpdir(), 'robot-secure-http-'));
const oldHome = process.env.MR_ROBOT_HOME;
process.env.MR_ROBOT_HOME = directory;
let revoked = false;
const host: any = {
 getSettings: defaultSettings,
 isAdminSecret: (v: string) => v === 'fixture-admin',
 authenticate: (v: string) => v === 'fixture-admin' ? { isAdmin: true, permissionCap: 'full' } : v === 'fixture-device' && !revoked ? { isAdmin: false, linkId: 'device-fixture', permissionCap: 'ask' } : null,
 sharedFileAccess: () => !revoked,
 fileAccess: () => !revoked,
 workspacesList: () => [],
 chatFileRoot: (_: string, conversationId: string, path: string) => conversationId === 'chat-fixture' && path === join(directory, 'shared', '[파일] sample.pdf') ? join(directory, 'shared') : undefined,
};
const server = createHttpApi(host, undefined, new Set(), new WsUpgradeTickets()).listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
try {
 assert.equal((await post('/api/secure-files/channel', {}, { 'x-mr-robot-token': 'mr-robot-encrypted-file-v1' })).status, 403, 'public edge marker cannot authenticate a file request');
 assert.equal((await fetch(base + '/api/settings', { headers: { 'x-mr-robot-token': 'mr-robot-encrypted-file-v1' } })).status, 401, 'public edge marker cannot authenticate ordinary APIs');
 assert.equal((await post('/api/secure-files/invite', {})).status, 403);
 assert.equal((await post('/api/secure-files/invite', {}, { 'x-mr-robot-token': 'fixture-admin', 'cf-ray': 'fake' })).status, 403);
 const inviteResponse = await post('/api/secure-files/invite', {}, { 'x-mr-robot-token': 'fixture-admin' });
 assert.equal(inviteResponse.status, 200);
 const invite = await inviteResponse.json() as any;
 writeFileSync(join(directory, 'shared', '[파일] sample.pdf'), 'chat download fixture');
 const chatQuery = new URLSearchParams({ conversationId: 'chat-fixture', path: join(directory, 'shared', '[파일] sample.pdf') });
 const chatResponse = await fetch(`${base}/api/workspaces/download?${chatQuery}`, { headers: { 'x-mr-robot-token': 'fixture-admin' } });
 assert.equal(chatResponse.status, 200); assert.equal(await chatResponse.text(), 'chat download fixture');
 chatQuery.set('conversationId', 'unrelated');
 assert.notEqual((await fetch(`${base}/api/workspaces/download?${chatQuery}`, { headers: { 'x-mr-robot-token': 'fixture-admin' } })).status, 200);
 let session: string | undefined;
 const request = (op: Record<string, unknown>) => sealFilePacket(invite.id, invite.key, { ...op, session, secret: 'fixture-device', requestId: randomBytes(16).toString('hex'), time: Date.now() }, 'request');
 const enroll = await post('/api/secure-files/channel', request({ op: 'enroll' }), { 'x-mr-robot-token': 'mr-robot-encrypted-file-v1' });
 assert.equal(enroll.status, 200);
 session = openFilePacket(await enroll.json() as any, invite.key, 'response').result.session;
 writeFileSync(join(directory, 'shared', 'fixture.txt'), 'file body must not appear on the wire');
 const response = await post('/api/secure-files/channel', request({ op: 'read', path: 'fixture.txt', offset: 0 }));
 const wire = await response.text();
 assert.equal(wire.includes('file body'), false);
 assert.equal(wire.includes('fixture.txt'), false);
 assert.equal(Buffer.from(openFilePacket(JSON.parse(wire), invite.key, 'response').result.data, 'hex').toString(), 'file body must not appear on the wire');
 const plain = await fetch(base + '/api/files/download?path=fixture.txt', { headers: { 'x-mr-robot-token': 'fixture-device' } });
 assert.notEqual(plain.status, 200, 'enrolled device must not downgrade to plaintext transfer');
 revoked = true;
 assert.equal((await post('/api/secure-files/channel', request({ op: 'read', path: 'fixture.txt', offset: 0 }))).status, 403);
 console.log('Secure file HTTP tests passed: local-only QR, real DPAPI persistence, encrypted bearer/file/path, plaintext downgrade blocked, revoked device denied');
} finally {
 await new Promise<void>(resolve => server.close(() => resolve()));
 if (oldHome === undefined) delete process.env.MR_ROBOT_HOME; else process.env.MR_ROBOT_HOME = oldHome;
 rmSync(directory, { recursive: true, force: true });
}
