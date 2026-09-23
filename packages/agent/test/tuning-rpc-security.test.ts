import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('local training RPCs require authenticated direct-local admin, not linked mobile or Discord authority', async () => {
  const previousHome = process.env.MR_ROBOT_HOME;
  const testHome = mkdtempSync(join(tmpdir(), 'mrrobot-tuning-rpc-test-'));
  process.env.MR_ROBOT_HOME = testHome;
  const { AgentServer } = await import('../src/server/server.js');
  const { webSocketTicketBinding } = await import('../src/server/ws.js');
  const server = new AgentServer();
  try {
    const handlers = (server as any).handlers() as Map<string, (params: unknown, client: any) => any>;
    const client = (auth: unknown, directLoopback: boolean) => ({ id: 'synthetic-client', directLoopback, state: { auth } });
    const jsonl = Array.from({ length: 10 }, (_, n) => JSON.stringify({ messages: [{ role: 'user', content: `Synthetic task ${n}` }, { role: 'assistant', content: 'Synthetic answer.' }] })).join('\n');
    const params = { name: 'safe fixture', jsonl, id: 'not-a-dataset', isAdmin: true, directLoopback: true, trustedDiscord: false };
    const methods = ['tuning.datasets.validate', 'tuning.datasets.import', 'tuning.datasets.list', 'tuning.datasets.export'];
    for (const method of methods) {
      const handler = handlers.get(method);
      assert.ok(handler, method);
      for (const denied of [client(undefined, true), client({ isAdmin: false, permissionCap: 'full', linkId: 'mobile' }, true), client({ isAdmin: true, permissionCap: 'full' }, false), client({ isAdmin: true, trustedDiscord: true }, true), client({ isAdmin: false, trustedDiscord: true, permissionCap: 'full' }, true)]) {
        assert.throws(() => handler(params, denied), /관리자|로컬/);
      }
    }
    assert.equal(existsSync(join(testHome, 'private', 'tuning')), false, 'Denied requests must not write data or list private folders.');
    assert.equal([...handlers.keys()].some(method => /^tuning\..*(?:train|run|execute|upload)/.test(method)), false, 'There is no remote training or upload RPC.');
    const admin = client({ isAdmin: true, permissionCap: 'full' }, true);
    const checked = handlers.get('tuning.datasets.validate')!(params, admin);
    assert.equal(checked.valid, true);
    const saved = handlers.get('tuning.datasets.import')!(params, admin);
    assert.equal(handlers.get('tuning.datasets.list')!({}, admin).length, 1);
    const exported = handlers.get('tuning.datasets.export')!({ id: saved.id }, admin);
    assert.equal(JSON.parse(readFileSync(exported.manifestPath, 'utf8')).trainingStarted, false);
    const publicFrames = JSON.stringify([checked, saved, handlers.get('tuning.datasets.list')!({}, admin), exported]);
    assert.equal(publicFrames.includes('Synthetic task'), false, 'Results never echo raw training examples.');

    const local = webSocketTicketBinding({ directRemote: '127.0.0.1', directLocal: '127.0.0.1', hostHeader: '127.0.0.1:8787' });
    assert.equal(local.directLoopback, true);
    for (const binding of [
      webSocketTicketBinding({ directRemote: '192.0.2.10', directLocal: '192.0.2.1', hostHeader: '127.0.0.1:8787' }),
      webSocketTicketBinding({ directRemote: '127.0.0.1', directLocal: '127.0.0.1', hostHeader: 'agent.example.invalid' }),
      webSocketTicketBinding({ directRemote: '127.0.0.1', directLocal: '127.0.0.1', hostHeader: '127.0.0.1:8787', cloudflareConnectingIp: '192.0.2.10', cloudflareRay: '1234567890abcdef-ICN' }),
    ]) assert.equal(binding.directLoopback, false, 'Public/proxied transport cannot acquire local training authority.');
  } finally {
    await server.stop();
    if (previousHome === undefined) delete process.env.MR_ROBOT_HOME; else process.env.MR_ROBOT_HOME = previousHome;
    rmSync(testHome, { recursive: true, force: true });
  }
});
