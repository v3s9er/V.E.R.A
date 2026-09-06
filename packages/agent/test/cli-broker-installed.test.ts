// Real installed CLI, synthetic local Responses endpoint. No provider credentials/tokens used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextWorker } from '../src/ai/cli-text-pool.js';
import { resolveCliInvocation, cliSubscriptionEnvironment } from '../src/ai/cli.js';
import type { BrokerAgentRequest } from '../src/ai/provider.js';
const home = mkdtempSync(join(tmpdir(), 'mrrobot-installed-broker-'));
mkdirSync(join(home, 'skills', 'private-fixture'), { recursive: true });
writeFileSync(join(home, 'skills', 'private-fixture', 'SKILL.md'), '---\nname: private-fixture\ndescription: PRIVATE_SKILL_SENTINEL\n---\nPRIVATE_SKILL_SENTINEL');
const controller = new AbortController();
const bodies: any[] = [], streamed: string[] = [];
let calls = 0, streamedBeforeComplete = false;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    const body = JSON.parse(raw); bodies.push(body);
    const n = bodies.length;
    const code = n === 1 ? 'text(await tools.public_search({query: "synthetic fixture"}));' : 'text([typeof process, typeof require, typeof fetch, typeof tools.exec_command, typeof tools.skills__read, typeof tools.skills__list].join(","));';
    const item = n === 1 || n === 4
      ? { id: 'fc_' + n, type: 'custom_tool_call', name: 'exec', call_id: 'call_fixture_' + n, input: code, status: 'completed' }
      : { id: 'msg_' + n, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture answer ' + n, annotations: [] }] };
    const response = { id: 'resp_' + n, object: 'response', created_at: 1, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 40 } } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event: any) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
    send({ type: 'response.output_item.added', output_index: 0, item: item.type === 'custom_tool_call' ? { ...item, input: '' } : { ...item, content: [] } });
    if (item.type === 'custom_tool_call') send({ type: 'response.custom_tool_call_input.delta', item_id: item.id, output_index: 0, delta: item.input });
    else send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'fixture answer ' + n });
    setTimeout(() => {
      if (n === 2) streamedBeforeComplete = streamed.includes('fixture answer 2');
      send({ type: 'response.output_item.done', output_index: 0, item });
      send({ type: 'response.completed', response }); res.end();
    }, 100);
  });
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const invocation = resolveCliInvocation('codex-cli', 'codex');
const req: BrokerAgentRequest = {
  system: 'Synthetic isolated broker test', turns: [{ role: 'user', content: 'synthetic input' }], signal: controller.signal,
  tools: [{ name: 'public_search', description: 'Fixture search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }],
  onEvent: e => { if (e.type === 'text') streamed.push(e.text); },
  executeTool: async (name, input) => { calls++; assert.equal(name, 'public_search'); assert.deepEqual(input, { query: 'synthetic fixture' }); return 'synthetic evidence'; },
};
const worker = new TextWorker({ command: process.execPath, prefixArgs: [fileURLToPath(new URL('./fixtures/codex-fixture-proxy.mjs', import.meta.url))], env: { ...cliSubscriptionEnvironment('codex-cli'), CODEX_HOME: home, MRROBOT_FIXTURE_PORT: String((server.address() as any).port), MRROBOT_FIXTURE_COMMAND: invocation.command, MRROBOT_FIXTURE_PREFIX: JSON.stringify(invocation.prefixArgs) }, model: 'gpt-5.6-terra', providerId: 'fixture', req });
const timeout = setTimeout(() => controller.abort(), 30_000);
try {
  const a = await worker.run(req);
  assert.equal(a.text, 'fixture answer 2'); assert.equal(calls, 1);
  assert.equal(a.usage.promptTokens, 200, 'sum both internal calls in this native turn');
  assert.ok(streamedBeforeComplete, 'answer streamed before model turn completion');
  const next: BrokerAgentRequest = { ...req, turns: [...req.turns, { role: 'assistant', content: a.text }, { role: 'user', content: 'follow up' }] };
  assert.ok(worker.accepts(next));
  const b = await worker.run(next);
  assert.equal(b.text, 'fixture answer 3');
  assert.equal(b.usage.promptTokens, 100, 'do not count previous native turns again');
  assert.equal(bodies.length, 3);
  const c = await worker.run({ ...req, turns: [...next.turns, { role: 'assistant', content: b.text }, { role: 'user', content: 'boundary probe' }] });
  assert.equal(c.text, 'fixture answer 5'); assert.equal(calls, 1);
  assert.ok(JSON.stringify(bodies[4].input).includes('undefined,undefined,undefined,undefined,undefined,undefined'), 'code-mode cannot access Node, network, host tools or skills');
  assert.ok(!JSON.stringify(bodies).includes('PRIVATE_SKILL_SENTINEL'), 'host skills must not enter isolated context');
  for (const body of bodies) {
    const specs = [...(body.tools ?? []), ...body.input.filter((x: any) => x.type === 'additional_tools').flatMap((x: any) => x.tools ?? [])];
    assert.ok(specs.length > 0);
    const serialized = JSON.stringify(specs);
    assert.ok(serialized.includes('public_search'));
    assert.ok(!serialized.includes('skills__read') && !serialized.includes('skills__list'), 'no host skill readers');
    assert.ok(!/tools: \{ (exec_command|read_file|apply_patch|view_image|shell_exec)\(/.test(serialized), 'no native PC tool exposed through nested code mode');
  }
  assert.ok(JSON.stringify(bodies[1].input).includes('synthetic evidence'));
  console.log('Installed CLI: native broker loop, only registered tool, early text streaming, session reuse, whole-turn usage passed (local fixture, no subscription use).');
} finally {
  clearTimeout(timeout); worker.close(); controller.abort(); server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
  for (let i = 0; i < 15; i++) { try { rmSync(home, { recursive: true, force: true }); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
}
