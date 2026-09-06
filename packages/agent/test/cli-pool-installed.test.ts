import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextWorker } from '../src/ai/cli-text-pool.js';
import { resolveCliInvocation, cliSubscriptionEnvironment } from '../src/ai/cli.js';
import type { ChatRequest } from '../src/ai/provider.js';
const home = mkdtempSync(join(tmpdir(), 'mrrobot-installed-pool-'));
const controller = new AbortController();
const bodies: any[] = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    bodies.push(JSON.parse(raw));
    const text = JSON.stringify({ text: `fixture answer ${bodies.length}`, toolCalls: [] });
    const item = { id: 'msg_' + bodies.length, type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
    const response = { id: 'resp_' + bodies.length, object: 'response', created_at: 1, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 40 } } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const invocation = resolveCliInvocation('codex-cli', 'codex');
const req: ChatRequest = { system: 'fixture only', turns: [{ role: 'user', content: 'first synthetic input' }], signal: controller.signal };
const worker = new TextWorker({ command: process.execPath, prefixArgs: [fileURLToPath(new URL('./fixtures/codex-fixture-proxy.mjs', import.meta.url))], env: { ...cliSubscriptionEnvironment('codex-cli'), CODEX_HOME: home, MRROBOT_FIXTURE_PORT: String((server.address() as any).port), MRROBOT_FIXTURE_COMMAND: invocation.command, MRROBOT_FIXTURE_PREFIX: JSON.stringify(invocation.prefixArgs) }, model: 'gpt-5.6-terra', providerId: 'fixture', req });
const timeout = setTimeout(() => controller.abort(), 25_000);
try {
  const a = await worker.run(req);
  const next: ChatRequest = { ...req, turns: [...req.turns, { role: 'assistant', content: a.text }, { role: 'user', content: 'second synthetic input' }] };
  assert.ok(worker.accepts(next));
  const b = await worker.run(next);
  assert.equal(b.text, 'fixture answer 2');
  assert.equal(b.usage.promptTokens, 100);
  assert.equal(bodies.length, 2);
  assert.ok(bodies.every(body => (body.tools ?? []).length === 0));
  console.log('Real installed Codex pooled two turns successfully; no native tools; latest-turn usage verified. Synthetic local provider only.');
} finally {
  clearTimeout(timeout); worker.close(); controller.abort(); server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
  for (let i = 0; i < 15; i++) { try { rmSync(home, { recursive: true, force: true }); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
}
