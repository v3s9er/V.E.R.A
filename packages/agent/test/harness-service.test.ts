import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessService } from '../src/harness-service.js';
import { AgentLoop } from '../src/ai/loop.js';
import type { AiProvider } from '../src/ai/provider.js';

const text = '@fixture/api owner team-a\n';
const sha256 = createHash('sha256').update(text).digest('hex');
const candidate = { claim: { subject: '@fixture/api', predicate: 'owner', object: 'team-a' }, evidence: [{ path: 'guide.md', sha256, quote: text.trim() }] };
const artifact = { id: 'result', name: 'Result check', kind: 'json-artifact', path: 'result.json', schema: { type: 'object', properties: { ok: { type: 'boolean', const: true } }, required: ['ok'], additionalProperties: false } };
const fullCommand = { id: 'node-test', name: 'Node test', kind: 'command', command: { executable: process.execPath, args: ['-e', 'process.stdout.write("fixture passed")'] }, sourcePaths: ['guide.md'], timeoutMs: 1000, allowFullHostExecution: true };
const authority = () => ({ allowed: () => true, permission: () => 'workspace' as const });
function fixture(t: any) {
  const base = mkdtempSync(join(tmpdir(), 'vera-harness-service-')), workspace = join(base, 'workspace'), directory = join(base, 'private', 'harness'); mkdirSync(workspace);
  t.after(() => { assert.ok(base.startsWith(join(tmpdir(), 'vera-harness-service-'))); rmSync(base, { recursive: true, force: true }); });
  writeFileSync(join(workspace, 'guide.md'), text); writeFileSync(join(workspace, 'result.json'), '{"ok":true}');
  const make = (sandboxExecutor?: any) => new HarnessService({ directory, resolveWorkspace: id => id === 'workspace-a' ? { id, path: workspace } : undefined, sandboxExecutor });
  return { base, workspace, directory, service: make(), make };
}

test('empty configuration is read-only and capability-free until explicit admin configuration', async t => {
  const { service, directory } = fixture(t);
  assert.deepEqual(service.get('workspace-a', 'workspace').documents, []); assert.equal(existsSync(directory), false);
  assert.equal(await service.capabilities('workspace-a', authority()), undefined);
  assert.equal(existsSync(directory), false); assert.throws(() => service.get('unknown', 'full'), /workspace_missing/);
});

test('explicit document/verifier configuration persists privately and schema/authority fields fail closed', async t => {
  const { service, directory, make } = fixture(t);
  const view = await service.update('workspace-a', { documents: ['guide.md'], verifiers: [artifact] }, 'workspace');
  assert.equal(view.capabilities.workspaceCommand, false); assert.equal(view.verifiers[0].id, 'result');
  assert.deepEqual(make().get('workspace-a', 'workspace'), view); assert.equal(readdirSync(directory).length, 1);
  await assert.rejects(service.update('workspace-a', { documents: ['../secret.txt'] }, 'full'), /path_invalid/);
  await assert.rejects(service.update('workspace-a', { documents: ['.env'] }, 'full'), /path_invalid/);
  await assert.rejects(service.update('workspace-a', { verifiers: [{ ...artifact, schema: { type: 'object', unsupported: true } }] }, 'full'), /invalid_request/);
  await assert.rejects(service.update('workspace-a', { verifiers: [{ ...fullCommand, approved: true }] }, 'full'), /request_invalid/);
  await assert.rejects(service.update('workspace-a', { documents: [] }, 'read-only'), /read_only/);
  assert.ok(!JSON.stringify(view).includes(directory));
});

test('private directory ancestors are validated before creating state directories', async t => {
  const { base, service } = fixture(t), outside = join(base, 'other-private'); mkdirSync(outside);
  symlinkSync(outside, join(base, 'private'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.update('workspace-a', { documents: ['guide.md'] }, 'workspace'), /private_directory_unsafe/);
  assert.equal(existsSync(join(outside, 'harness')), false);
});

test('model broker exposes recall/propose/selected verify only and never promotes on successful verification', async t => {
  const { service, directory } = fixture(t); await service.update('workspace-a', { documents: ['guide.md'], verifiers: [artifact] }, 'workspace');
  const broker = (await service.capabilities('workspace-a', authority()))!, signal = new AbortController().signal;
  assert.deepEqual(broker.tools.map(tool => tool.name), ['harness_recall', 'harness_propose', 'harness_verify']);
  assert.equal(broker.isReadOnly!('harness_recall'), true); assert.equal(broker.isReadOnly!('harness_verify'), false);
  const recall = JSON.parse(await broker.execute('harness_recall', { query: '@fixture/api' }, signal));
  assert.equal(recall.documents.matches[0].sha256, sha256); assert.deepEqual(recall.claims, []);
  const proposed = JSON.parse(await broker.execute('harness_propose', candidate, signal)); assert.equal(proposed.status, 'candidate');
  const receipt = JSON.parse(await broker.execute('harness_verify', { verifierId: 'result' }, signal)); assert.equal(receipt.status, 'passed');
  assert.equal((await service.candidates('workspace-a'))[0].status, 'candidate');
  await assert.rejects(broker.execute('harness_approve', { candidateId: proposed.id }, signal), /tool_denied/);
  await assert.rejects(broker.execute('harness_verify', { verifierId: 'result', approved: true }, signal), /request_invalid/);
  await assert.rejects(broker.execute('harness_verify', { verifierId: 'result', command: fullCommand.command }, signal), /request_invalid/);
  await assert.rejects(service.approve('workspace-a', proposed.id, true), /user_confirmation_required/);
  await service.approve('workspace-a', proposed.id, 'user-confirmed');
  assert.equal(JSON.parse(await broker.execute('harness_recall', { query: '@fixture/api' }, signal)).claims.length, 1);
  await service.retract('workspace-a', proposed.id, 'user-correction');
  assert.equal(JSON.parse(await broker.execute('harness_recall', { query: '@fixture/api' }, signal)).claims.length, 0);
  assert.ok(readdirSync(directory).some(name => name.endsWith('.knowledge.json'))); assert.equal(existsSync(join(directory, 'memory.json')), false);
});

test('configured command profiles reject workspace execution without a real sandbox and require explicit full approval', async t => {
  const { service } = fixture(t); await service.update('workspace-a', { verifiers: [fullCommand] }, 'full');
  const denied = await service.verify('workspace-a', 'node-test', 'workspace'); assert.equal(denied.status, 'rejected'); assert.equal(denied.failure, 'sandbox_required'); assert.equal(denied.execution, 'none');
  await assert.rejects(service.verify('workspace-a', 'node-test', 'ask'), /requires_permission/);
  assert.equal((await service.verify('workspace-a', 'node-test', 'read-only')).failure, 'execution_denied');
  await service.update('workspace-a', { verifiers: [{ ...fullCommand, allowFullHostExecution: false }] }, 'full');
  await assert.rejects(service.verify('workspace-a', 'node-test', 'full'), /not_approved/);
});

test('explicitly approved full-permission fixture command returns a real execution receipt without model inference', async t => {
  const { service } = fixture(t); await service.update('workspace-a', { verifiers: [fullCommand] }, 'full');
  const receipt = await service.verify('workspace-a', 'node-test', 'full');
  assert.equal(receipt.status, 'passed'); assert.equal(receipt.execution, 'local-full-not-isolated');
  assert.equal(receipt.stdout, 'fixture passed'); assert.equal(receipt.sourceRevision, receipt.afterRevision);
  assert.match(receipt.commandHash!, /^[a-f0-9]{64}$/);
});

test('host-injected real-sandbox contract receives only configured command and current workspace permission', async t => {
  const { make, workspace } = fixture(t); const calls: any[] = [];
  const service = make({ kind: 'workspace-sandbox', execute: async (request: any) => { calls.push(request); return { exitCode: 0, stdout: 'fixture', stderr: '', settled: true }; } });
  await service.update('workspace-a', { verifiers: [{ ...fullCommand, allowFullHostExecution: false }] }, 'workspace');
  const receipt = await service.verify('workspace-a', 'node-test', 'workspace');
  assert.equal(receipt.status, 'passed'); assert.equal(receipt.execution, 'workspace-sandbox'); assert.equal(calls.length, 1);
  assert.equal(calls[0].workspacePath, workspace); assert.deepEqual(calls[0].command, fullCommand.command);
});

test('permission downgrade, revoked authority and changed configuration invalidate active model capabilities', async t => {
  const { service } = fixture(t); await service.update('workspace-a', { documents: ['guide.md'] }, 'workspace');
  let allowed = true, permission: any = 'workspace'; const broker = (await service.capabilities('workspace-a', { allowed: () => allowed, permission: () => permission }))!, signal = new AbortController().signal;
  permission = 'read-only'; await assert.rejects(broker.execute('harness_recall', { query: 'owner' }, signal), /permission_changed/);
  permission = 'workspace'; allowed = false; await assert.rejects(broker.execute('harness_recall', { query: 'owner' }, signal), /permission_changed/);
  allowed = true; await service.update('workspace-a', { documents: [] }, 'workspace');
  await assert.rejects(broker.execute('harness_recall', { query: 'owner' }, signal), /configuration_changed/);
  assert.equal(await service.capabilities('workspace-a', { allowed: () => false, permission: () => 'full' }), undefined);
});

test('changing selected documents starts a separate review scope while preserving private audit files', async t => {
  const { service, directory } = fixture(t); await service.update('workspace-a', { documents: ['guide.md'] }, 'workspace');
  const broker = (await service.capabilities('workspace-a', authority()))!;
  const proposed = JSON.parse(await broker.execute('harness_propose', candidate, new AbortController().signal));
  await service.approve('workspace-a', proposed.id, 'user-confirmed'); const before = readdirSync(directory).filter(name => name.endsWith('.knowledge.json'));
  await service.update('workspace-a', { documents: [] }, 'workspace'); assert.deepEqual(await service.candidates('workspace-a'), []);
  assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.knowledge.json')), before);
});

test('real AgentLoop API dispatch reaches scoped deterministic service with a synthetic provider, no inference', async t => {
  const { service, workspace } = fixture(t); await service.update('workspace-a', { documents: ['guide.md'], verifiers: [artifact] }, 'workspace');
  const broker = await service.capabilities('workspace-a', authority()); let calls = 0;
  const provider: AiProvider = { id: 'fixture', model: 'fixture', type: 'openai-compatible', baseUrl: '', label: 'Fixture', supportsTools: true, supportedReasoning: ['auto', 'high'], ping: async () => ({ ok: true }), models: async () => [], chat: async request => {
    calls++;
    if (calls === 1) return { text: '', toolCalls: [{ id: 'recall', name: 'harness_recall', args: JSON.stringify({ query: '@fixture/api' }) }], usage: { promptTokens: 1, completionTokens: 1 } };
    const observed = JSON.parse(request.turns.at(-1)!.toolResults![0].content); assert.equal(observed.documents.matches[0].sha256, sha256);
    return { text: 'Verified fixture evidence only.', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } };
  } };
  const result = await new AgentLoop({ default: () => provider } as any, {} as any).run([], 'Inspect project documentation and explain ownership', {}, [], { workspacePath: workspace, permissionMode: 'workspace', harnessCapabilities: broker });
  assert.equal(calls, 2); assert.equal(result.text, 'Verified fixture evidence only.');
});
