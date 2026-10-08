import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(run: (state: any) => Promise<void>) {
  const previous = process.env.MR_ROBOT_HOME, home = mkdtempSync(join(tmpdir(), 'vera-harness-rpc-')); process.env.MR_ROBOT_HOME = home;
  const { AgentServer } = await import('../src/server/server.js'), { ChatSession } = await import('../src/server/chat.js');
  const server: any = new AgentServer(), path = join(home, 'workspace'); mkdirSync(path); writeFileSync(join(path, 'guide.md'), '@fixture/api owner team-a');
  writeFileSync(join(path, 'result.json'), '{"ok":true}'); const project = server.config.addWorkspace(path, 'Harness fixture');
  const client = { id: 'admin-test', directLoopback: true, state: { authed: true, auth: { isAdmin: true, permissionCap: 'full' }, chat: new ChatSession() }, sendEvent() {} };
  server.hub = { clients: [client], close() {}, disconnectLink() {} }; server.plugins.aiTools = () => [];
  server.config.updateSettings({ safety: { ...server.config.settings.safety, mode: 'workspace' } });
  try { await run({ server, handlers: server.handlers(), client, project, home, path }); }
  finally { server.cancelAllRuns(); await server.stop(); if (previous === undefined) delete process.env.MR_ROBOT_HOME; else process.env.MR_ROBOT_HOME = previous;
    assert.ok(home.startsWith(join(tmpdir(), 'vera-harness-rpc-'))); rmSync(home, { recursive: true, force: true }); }
}
const profile = { id: 'result', name: 'Result', kind: 'json-artifact', path: 'result.json', schema: { type: 'object', properties: { ok: { type: 'boolean', const: true } }, required: ['ok'], additionalProperties: false } };

test('legacy presets remain stored but never hide the chosen model or block a single-agent run', () => fixture(async ({ handlers, client, server, project }: any) => {
  const conversation = server.conversations.create({ workspaceId: project.id, routingPresetId: 'missing-legacy-scenario', providerId: 'saved-provider', providerModel: 'saved-model' });
  let seen = false;
  server.loop.run = async (history: any[], text: string, _callbacks: any, _tools: any, options: any) => {
    seen = true; assert.equal(options.routing, null); assert.equal(options.providerId, 'chosen-provider'); assert.equal(options.providerModel, 'chosen-model');
    return { text: 'fixture', turns: [...history, { role: 'user', content: text }, { role: 'assistant', content: 'fixture' }], usage: { promptTokens: 1, completionTokens: 1 } };
  };
  const result = await handlers.get('chat.start')({ conversationId: conversation.id, text: 'Inspect the selected project documentation', providerId: 'chosen-provider', providerModel: 'chosen-model' }, client);
  assert.equal(result.ok, true); assert.equal(seen, true);
  assert.equal(server.conversations.get(conversation.id).routingPresetId, 'missing-legacy-scenario');
  assert.throws(() => handlers.get('conversations.create')({ routingPresetId: null }, client), /프리셋 ID/);
}));

test('all harness read and write RPCs require admin, reject Discord and never trust request authority fields', () => fixture(async ({ handlers, client, home, project }: any) => {
  for (const method of ['get', 'update', 'search', 'candidates', 'approve', 'retract', 'verify']) {
    const handler = handlers.get(`harness.${method}`); assert.ok(handler);
    for (const auth of [undefined, { isAdmin: false, permissionCap: 'full' }, { isAdmin: true, trustedDiscord: true, permissionCap: 'full' }]) {
      assert.throws(() => handler({ workspaceId: project.id, isAdmin: true, confirmation: 'user-confirmed' }, { ...client, state: { ...client.state, auth } }), /관리자/);
    }
  }
  assert.equal(existsSync(join(home, 'harness')), false);
  assert.throws(() => handlers.get('harness.get')({ workspaceId: project.id, isAdmin: true }, client), /request_invalid/);
  assert.throws(() => handlers.get('harness.get')({ workspaceId: 'missing' }, client), /workspace_missing/);
}));

test('RPC configuration, scoped search, verification, user approval and retraction operate on private state', () => fixture(async ({ handlers, client, server, project }: any) => {
  const updated = await handlers.get('harness.update')({ workspaceId: project.id, documents: ['guide.md'], verifiers: [profile] }, client);
  assert.equal(updated.capabilities.workspaceCommand, false);
  const search = await handlers.get('harness.search')({ workspaceId: project.id, query: '@fixture/api' }, client); assert.equal(search.matches.length, 1);
  const broker = await server.harness.capabilities(project.id, { allowed: () => true, permission: () => 'workspace' });
  const proposed = JSON.parse(await broker.execute('harness_propose', { claim: { subject: '@fixture/api', predicate: 'owner', object: 'team-a' }, evidence: [{ path: 'guide.md', sha256: search.matches[0].sha256, quote: '@fixture/api owner team-a' }] }, new AbortController().signal));
  assert.equal((await handlers.get('harness.verify')({ workspaceId: project.id, verifierId: 'result' }, client)).status, 'passed');
  assert.equal((await handlers.get('harness.candidates')({ workspaceId: project.id }, client))[0].status, 'candidate');
  await assert.rejects(handlers.get('harness.approve')({ workspaceId: project.id, candidateId: proposed.id, confirmation: true }, client), /confirmation_required/);
  assert.equal((await handlers.get('harness.approve')({ workspaceId: project.id, candidateId: proposed.id, confirmation: 'user-confirmed' }, client)).status, 'promoted');
  assert.equal((await handlers.get('harness.retract')({ workspaceId: project.id, candidateId: proposed.id, reason: 'user-correction' }, client)).status, 'retracted');
  assert.deepEqual(server.memory.list(), []);
}));

test('read-only authority cannot alter documents or approval and active work blocks out-of-band configuration', () => fixture(async ({ handlers, client, server, project }: any) => {
  const readonly = { ...client, state: { ...client.state, auth: { isAdmin: true, permissionCap: 'read-only' } } };
  for (const method of ['update', 'approve', 'retract']) assert.throws(() => handlers.get(`harness.${method}`)({ workspaceId: project.id }, readonly), /읽기 전용/);
  server.activeRuns.set('fixture', { workspaceId: project.id });
  try { assert.throws(() => handlers.get('harness.update')({ workspaceId: project.id, documents: [] }, client), /작업이 끝난/); assert.throws(() => handlers.get('harness.verify')({ workspaceId: project.id, verifierId: 'result' }, client), /작업이 끝난/); }
  finally { server.activeRuns.delete('fixture'); }
}));

test('actual chat.start hands scoped executable callbacks to the runtime and checks permission again before tools', () => fixture(async ({ handlers, client, server, project }: any) => {
  await handlers.get('harness.update')({ workspaceId: project.id, documents: ['guide.md'], verifiers: [profile] }, client);
  let seen = false;
  server.loop.run = async (history: any[], text: string, callbacks: any, _tools: any, options: any) => {
    seen = true; assert.ok(options.harnessCapabilities); callbacks.beforeToolCall('harness_recall');
    const result = JSON.parse(await options.harnessCapabilities.execute('harness_recall', { query: '@fixture/api' }, callbacks.signal)); assert.equal(result.documents.matches.length, 1);
    client.state.auth.permissionCap = 'read-only'; assert.throws(() => callbacks.beforeToolCall('harness_verify'), /권한/);
    await assert.rejects(options.harnessCapabilities.execute('harness_verify', { verifierId: 'result' }, callbacks.signal), /permission_changed/); client.state.auth.permissionCap = 'full';
    return { text: 'fixture', turns: [...history, { role: 'user', content: text }, { role: 'assistant', content: 'fixture' }], usage: { promptTokens: 1, completionTokens: 1 } };
  };
  const conversation = server.conversations.create({ workspaceId: project.id, permissionMode: 'workspace' });
  const result = await handlers.get('chat.start')({ conversationId: conversation.id, text: 'Inspect the selected project documentation and verify evidence', permissionMode: 'workspace' }, client);
  assert.equal(result.ok, true); assert.equal(seen, true);
}));

test('non-admin and Discord chat runtimes never receive harness capabilities', () => fixture(async ({ handlers, client, server, project }: any) => {
  await handlers.get('harness.update')({ workspaceId: project.id, documents: ['guide.md'] }, client);
  let count = 0; server.loop.run = async (history: any[], text: string, _callbacks: any, _tools: any, options: any) => {
    count++; assert.equal(options.harnessCapabilities, undefined);
    return { text: 'fixture', turns: [...history, { role: 'user', content: text }, { role: 'assistant', content: 'fixture' }], usage: { promptTokens: 1, completionTokens: 1 } };
  };
  for (const auth of [{ isAdmin: false, permissionCap: 'workspace' }, { isAdmin: false, trustedDiscord: true, permissionCap: 'workspace' }]) {
    const grant = server.config.createDeviceLink(`fixture-${count}`, 'workspace', []);
    const other = { ...client, id: `other-${count}`, state: { ...client.state, auth: { ...auth, linkId: grant.link.id } } }, conversation = server.conversations.create({ workspaceId: project.id, permissionMode: 'workspace' });
    const result = await handlers.get('chat.start')({ conversationId: conversation.id, text: 'Inspect the project documentation carefully', permissionMode: 'workspace' }, other);
    assert.equal(result.ok, true);
  }
  assert.equal(count, 2);
}));

test('global permission reduction cancels native runs immediately while preserving the Discord ceiling', () => fixture(async ({ handlers, client, server, project }: any) => {
  server.updateSettings({ safety: { ...server.config.settings.safety, mode: 'full' } });
  const local: string[] = [], discord: string[] = [];
  server.activeRuns.set('local', { workspaceId: project.id, permissionMode: 'full', session: { cancel: (reason: string) => local.push(reason) } });
  server.activeRuns.set('discord', { trustedDiscord: true, permissionMode: 'full', session: { cancel: (reason: string) => discord.push(reason) } });
  try {
    handlers.get('settings.set')({ safety: { ...server.config.settings.safety, mode: 'workspace' } }, client);
    assert.deepEqual(local, ['revoked']); assert.deepEqual(discord, []);
    handlers.get('settings.set')({ safety: { ...server.config.settings.safety, mode: 'read-only' } }, client);
    assert.deepEqual(discord, ['revoked']);
  } finally { server.activeRuns.clear(); }
}));

test('independent checks block profile edits and cancel on permission reduction, revocation and stop', () => fixture(async ({ handlers, client, server, project }: any) => {
  let signal: AbortSignal | undefined;
  server.harness.verify = async (_workspace: string, _id: string, _mode: string, runSignal: AbortSignal) => {
    signal = runSignal;
    return new Promise(resolve => runSignal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }));
  };
  for (const change of ['permission', 'revocation', 'stop']) {
    server.updateSettings({ safety: { ...server.config.settings.safety, mode: 'full' } });
    const grant = server.config.createDeviceLink('fixture-check', 'full', []);
    const owner = { ...client, state: { ...client.state, auth: { ...client.state.auth, linkId: grant.link.id } } };
    const pending = handlers.get('harness.verify')({ workspaceId: project.id, verifierId: 'fixture' }, owner);
    assert.equal(signal!.aborted, false);
    assert.throws(() => handlers.get('harness.update')({ workspaceId: project.id, documents: [] }, client), /작업이 끝난/);
    assert.throws(() => handlers.get('projects.delete')({ id: project.id }, client), /실행 중/);
    if (change === 'permission') handlers.get('settings.set')({ safety: { ...server.config.settings.safety, mode: 'read-only' } }, client);
    else if (change === 'revocation') handlers.get('pairing.link.revoke')({ id: grant.link.id }, client);
    else assert.equal(server.cancelAllRuns(), 1);
    assert.equal((await pending).status, 'cancelled'); assert.equal(server.activeHarnessChecks.size, 0);
  }
}));
