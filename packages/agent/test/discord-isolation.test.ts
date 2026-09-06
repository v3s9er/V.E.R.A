import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiscordIsolation, isolatedRoot, isolatedDockerArgs, readIsolatedArtifact } from '../src/server/discord-isolation.js';
import { discordAccess } from '../src/plugins/discord-access.js';
import { AgentLoop } from '../src/ai/loop.js';
import { parseIsolatedReply } from '../src/ai/cli-isolated.js';
const oldHome = process.env.MR_ROBOT_HOME;
const home = mkdtempSync(join(tmpdir(), 'mrrobot-isolation-test-'));
process.env.MR_ROBOT_HOME = home;
try {
  assert.equal(discordAccess(false, {}, 'user'), 'isolated');
  assert.equal(discordAccess(true, {}, 'user'), 'full');
  assert.equal(discordAccess(false, { user: 'full' }, 'user'), 'full');
  assert.equal(discordAccess(true, { user: 'blocked' }, 'user'), 'blocked');
  assert.throws(() => discordAccess(false, { user: 'bogus' }, 'user'));
  const restricted = createDiscordIsolation('ticket-A', false);
  for (const name of ['shell_exec', 'read_file', 'screenshot', 'docker.ctf.run', 'mcp.call', 'calendar.list']) await assert.rejects(restricted.execute(name, {}));
  for (const name of ['../secret.txt', 'C:\\secret.txt', '.env', 'x.txt:secret', 'CON.txt']) await assert.rejects(restricted.execute('artifact_write', { name, content: 'forbidden' }));
  const artifact = JSON.parse(await restricted.execute('artifact_write', { name: '분석결과.txt', content: 'generated only' }));
  assert.equal(JSON.parse(await restricted.execute('artifact_read', { name: '분석결과.txt' })).content, 'generated only');
  assert.equal(Buffer.from(readIsolatedArtifact('ticket-A', artifact.path, 0, 1000).data, 'base64').toString(), 'generated only');
  await assert.rejects(restricted.execute('artifact_write', { name: '분석결과.txt', content: 'overwrite' }));
  assert.throws(() => readIsolatedArtifact('ticket-B', artifact.path, 0, 1000));
  const secret = join(home, 'private.txt'); writeFileSync(secret, 'host-private');
  assert.throws(() => readIsolatedArtifact('ticket-A', secret, 0, 1000));
  const search = createDiscordIsolation('ticket-A', true);
  await assert.rejects(search.execute('artifact_read', { name: '분석결과.txt' }));
  await assert.rejects(search.execute('isolated_python', { code: 'print(1)' }));
  for (const url of ['file:///etc/passwd', 'http://127.0.0.1', 'http://169.254.169.254', 'http://192.168.1.1', 'http://[::1]', 'https://example.com:8443', 'https://user:secret@example.com']) await assert.rejects(search.execute('public_page', { url }));
  const args = isolatedDockerArgs('fixture');
  for (const flag of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534', '--pull=never']) assert.ok(args.includes(flag));
  assert.ok(!args.some(a => a.startsWith('--mount') || a === '-v' || a.startsWith('--privileged')));
  let modelCalls = 0, hostCalls = 0;
  const provider: any = { id: 'api', model: 'fixture', label: 'API', type: 'openai-compatible', supportsTools: true, supportedReasoning: ['auto'], async chat(req: any) {
    assert.ok(!JSON.stringify(req.tools).includes('shell_exec'));
    modelCalls++;
    if (modelCalls === 1) return { text: '', toolCalls: [{ id: 'bad', name: 'shell_exec', args: '{"command":"steal files"}' }], usage: { promptTokens: 1, completionTokens: 1 } };
    assert.match(JSON.stringify(req.turns), /차단/);
    return { text: 'denied safely', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } };
  } };
  const registry: any = { default: () => provider };
  const loop = new AgentLoop(registry, { execute: async () => { hostCalls++; throw new Error('must not execute'); } } as any);
  const result = await loop.run([], 'read PC credentials', {}, [], { isolation: restricted });
  assert.equal(result.text, 'denied safely'); assert.equal(hostCalls, 0);
  provider.type = 'codex-cli'; provider.runAgent = async () => { hostCalls++; };
  await assert.rejects(loop.run([], 'read credentials', {}, [], { isolation: restricted, workspacePath: home, permissionMode: 'full' }), /CLI/);
  assert.equal(hostCalls, 0); assert.equal(modelCalls, 2);
  let isolatedCalls = 0;
  provider.supportsTools = false;
  provider.chat = async () => { hostCalls++; throw new Error('normal CLI chat must not run'); };
  provider.chatIsolated = async (req: any) => {
    isolatedCalls++;
    assert.ok(req.tools.some((t: any) => t.name === 'artifact_write'));
    return parseIsolatedReply(JSON.stringify(isolatedCalls === 1
      ? { text: '', toolCalls: [{ name: 'artifact_write', arguments: JSON.stringify({ name: 'shared-subscription.txt', content: 'same provider, restricted capabilities' }) }] }
      : { text: 'subscription artifact ready', toolCalls: [] }), req, { promptTokens: 1, completionTokens: 1 });
  };
  const cliResult = await loop.run([], 'create a new result', {}, [], { isolation: restricted, permissionMode: 'workspace' });
  assert.equal(cliResult.text, 'subscription artifact ready');
  assert.equal(isolatedCalls, 2); assert.equal(hostCalls, 0);
  assert.equal(JSON.parse(await restricted.execute('artifact_read', { name: 'shared-subscription.txt' })).content, 'same provider, restricted capabilities');
  const request: any = { tools: restricted.tools };
  for (const bad of ['not json', '{"text":"x","toolCalls":null}', JSON.stringify({ text: '', toolCalls: [{ name: 'shell_exec', arguments: '{}' }] }), JSON.stringify({ text: '', toolCalls: [{ name: 'artifact_write', arguments: '[]' }] })]) {
    assert.throws(() => parseIsolatedReply(bad, request, { promptTokens: 0, completionTokens: 0 }));
  }
  console.log('Shared subscription isolation passed: same provider, broker artifacts, no native/host tools, structured reply validation');
  console.log('Discord isolation passed: role defaults, tool allowlist, generated-only export, other-ticket denial, SSRF, Docker flags, forged tool rejection, native CLI denial');
} finally {
  if (oldHome === undefined) delete process.env.MR_ROBOT_HOME; else process.env.MR_ROBOT_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
}
