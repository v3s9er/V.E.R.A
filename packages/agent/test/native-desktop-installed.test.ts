// Real installed Codex protocol + synthetic LOCAL model. No account/model usage.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pooledNativeCodex, closeNativeWorkers } from '../src/ai/cli-native-pool.js';
import { waitForCliRetirements } from '../src/ai/cli-process-retirement.js';
import { resolveCliInvocation, cliSubscriptionEnvironment } from '../src/ai/cli.js';
import { DESKTOP_TOOLS } from '../src/computer/desktop-session.js';
const dir = mkdtempSync(join(tmpdir(), 'mrrobot-desktop-installed-'));
mkdirSync(join(dir, 'codex')); const abort = new AbortController();
const bodies: any[] = []; let executed = 0;
const png = 'data:image/png;base64,' + readFileSync(fileURLToPath(new URL('../../../apps/mobile/assets/icon.png', import.meta.url))).toString('base64');
const server = createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c);
  req.on('end', () => {
    bodies.push(JSON.parse(raw));
    const item = bodies.length === 1
      ? { type: 'function_call', id: 'fc_desktop', call_id: 'call_desktop', name: 'desktop_windows', arguments: '{}' }
      : { id: 'msg_done', type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'image received', annotations: [] }] };
    const response = { id: 'resp_' + bodies.length, object: 'response', created_at: 1, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const cli = resolveCliInvocation('codex-cli', 'codex');
const timer = setTimeout(() => abort.abort(), 50_000);
try {
  const result = await pooledNativeCodex({ command: process.execPath,
    prefixArgs: [fileURLToPath(new URL('./fixtures/codex-fixture-proxy.mjs', import.meta.url))],
    env: { ...cliSubscriptionEnvironment('codex-cli'), CODEX_HOME: join(dir, 'codex'), MRROBOT_FIXTURE_TRACE: '1', MRROBOT_FIXTURE_PORT: String((server.address() as any).port), MRROBOT_FIXTURE_COMMAND: cli.command, MRROBOT_FIXTURE_PREFIX: JSON.stringify(cli.prefixArgs) },
    providerId: 'fixture', model: 'gpt-5.6-sol', req: { prompt: 'fixture only', cwd: dir, permissionMode: 'full', signal: abort.signal,
      session: { key: 'desktop-fixture', directory: dir, history: [], input: 'fixture', instructions: 'fixture only', context: '' },
      hostTools: { tools: DESKTOP_TOOLS, dispose() {}, execute: async (name, _input, signal) => {
        signal.throwIfAborted(); assert.equal(name, 'desktop_windows'); executed++;
        return { success: true, contentItems: [{ type: 'inputText', text: 'synthetic window, not user UI' }, { type: 'inputImage', imageUrl: png }] };
      } },
    } });
  assert.equal(result.text, 'image received'); assert.equal(executed, 1); assert.equal(bodies.length, 2);
  assert.ok(JSON.stringify(bodies[1].input).includes('data:image/'), 'the actual image must reach the model request (CLI may normalize image encoding)');
  console.log(JSON.stringify({ installedDesktopProtocol: 'passed', imageDelivered: true, accountUsage: false, userUiRead: false }));
} catch (error) {
  console.error(error);
  console.error(JSON.stringify({ executed, requests: bodies.length, inputTypes: bodies.at(-1)?.input?.map((i: any) => i.type) }));
  try { console.error(readFileSync(join(dir, 'codex', 'fixture-transport.jsonl'), 'utf8').slice(-6000)); } catch {}
  throw error;
} finally {
  clearTimeout(timer); abort.abort(); closeNativeWorkers(); await waitForCliRetirements({ CODEX_HOME: join(dir, 'codex') });
  server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  for (let attempt = 0; attempt < 30; attempt++) {
    try { rmSync(dir, { recursive: true, force: true }); break; }
    catch (error) { if (attempt === 29) throw error; await new Promise(r => setTimeout(r, 100)); }
  }
}
