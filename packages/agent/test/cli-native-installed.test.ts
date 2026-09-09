// Real installed CLI, synthetic localhost Responses server. No account tokens/model usage.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pooledNativeCodex, closeNativeWorkers } from '../src/ai/cli-native-pool.js';
import { resolveCliInvocation, cliSubscriptionEnvironment } from '../src/ai/cli.js';
import type { NativeAgentRequest } from '../src/ai/provider.js';
const dir = mkdtempSync(join(tmpdir(), 'mrrobot-native-installed-'));
mkdirSync(join(dir, 'codex'));
const controller = new AbortController();
const bodies: any[] = [];
const statuses: string[] = [];
const server = createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c);
  req.on('end', () => {
    bodies.push(JSON.parse(raw));
    const text = `synthetic answer ${bodies.length}`;
    const item = { id: 'msg_' + bodies.length, type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] };
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
const cli = resolveCliInvocation('codex-cli', 'codex');
const req: NativeAgentRequest = { prompt: 'fallback', cwd: dir, permissionMode: 'read-only', reasoningEffort: 'high', signal: controller.signal,
  onStatus: t => statuses.push(t), session: { key: 'fixture-user-ticket', directory: dir, history: [], input: 'Remember synthetic-marker-742. Answer briefly.', instructions: 'Synthetic test. Answer without tools.', context: '' } };
const call = (req: NativeAgentRequest) => pooledNativeCodex({ command: process.execPath,
  prefixArgs: [fileURLToPath(new URL('./fixtures/codex-fixture-proxy.mjs', import.meta.url))],
  env: { ...cliSubscriptionEnvironment('codex-cli'), CODEX_HOME: join(dir, 'codex'), MRROBOT_FIXTURE_TRACE: '1', MRROBOT_FIXTURE_PORT: String((server.address() as any).port), MRROBOT_FIXTURE_COMMAND: cli.command, MRROBOT_FIXTURE_PREFIX: JSON.stringify(cli.prefixArgs) },
  providerId: 'fixture', model: 'gpt-5.6-sol', req });
const timeout = setTimeout(() => controller.abort(), 55_000);
try {
  const started = performance.now();
  let stream = '';
  const a = await call({ ...req, onText: t => stream += t });
  assert.equal(a.text, 'synthetic answer 1'); assert.equal(stream, a.text);
  const coldMs = Math.round(performance.now() - started);
  const second: NativeAgentRequest = { ...req, session: { ...req.session!, history: [{ role: 'user', content: req.session!.input }, { role: 'assistant', content: a.text }], input: 'What was the marker?' } };
  const warm = performance.now();
  const b = await call(second);
  const warmMs = Math.round(performance.now() - warm);
  assert.equal(b.text, 'synthetic answer 2'); assert.equal(b.usage.promptTokens, 100);
  closeNativeWorkers();
  const c = await call({ ...second, session: { ...second.session!, history: [...second.session!.history, { role: 'user', content: second.session!.input }, { role: 'assistant', content: b.text }], input: 'Continue after restart.' } });
  assert.equal(c.text, 'synthetic answer 3'); assert.equal(c.usage.promptTokens, 100);
  assert.equal(bodies.length, 3);
  assert.ok(JSON.stringify(bodies[2].input).includes('synthetic-marker-742'), 'provider retains conversation after process restart');
  assert.ok(statuses.some(t => t.includes('세션 재사용')));
  assert.ok(bodies.every(b => b.reasoning?.effort === 'high'), 'user reasoning choice preserved');
  console.log(JSON.stringify({ installedNativeSessionTest: 'passed', coldMs, warmMs, turns: bodies.length, accountUsage: false }));
} catch (error) {
  try { console.error(readFileSync(join(dir, 'codex', 'fixture-transport.jsonl'), 'utf8').slice(-12000)); } catch { /* no fixture trace */ }
  throw error;
} finally {
  clearTimeout(timeout); closeNativeWorkers(); controller.abort(); server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
  for (let i = 0; i < 30; i++) { try { rmSync(dir, { recursive: true, force: true }); break; } catch (e) { if (i === 29) throw e; await new Promise(r => setTimeout(r, 100)); } }
}
