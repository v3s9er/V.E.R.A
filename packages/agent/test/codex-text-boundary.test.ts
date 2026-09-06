import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexTextOnly } from '../src/ai/cli-isolated.js';
import { cliSubscriptionEnvironment, resolveCliInvocation } from '../src/ai/cli.js';

const home = mkdtempSync(join(tmpdir(), 'mrrobot-text-boundary-'));
const controller = new AbortController();
let body: any;
const server = createServer((req, res) => {
  let text = '';
  req.on('data', chunk => text += chunk);
  req.on('end', () => {
    try { body = JSON.parse(text); } catch { body = {}; }
    res.writeHead(503).end(); controller.abort();
  });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const invocation = resolveCliInvocation('codex-cli', 'codex');
  const port = (server.address() as any).port;
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    await codexTextOnly({ ...invocation, env: { ...cliSubscriptionEnvironment('codex-cli'), CODEX_HOME: home }, cwd: home, model: 'gpt-5.6-terra', req: { system: 'fixture', turns: [{ role: 'user', content: 'fixture' }], signal: controller.signal }, config: {
      model_provider: 'fixture', 'model_providers.fixture.name': 'fixture', 'model_providers.fixture.base_url': `http://127.0.0.1:${port}/v1`, 'model_providers.fixture.wire_api': 'responses', 'model_providers.fixture.requires_openai_auth': false,
    } });
  } catch (e) { if (!body) throw e; } finally { clearTimeout(timeout); }
  assert.ok(body, 'real installed CLI must reach the controlled mock transport');
  const names = (body.tools ?? []).map((tool: any) => tool.name ?? tool.type);
  console.log(JSON.stringify({ nativeTools: names, toolCount: names.length }));
  assert.deepEqual(names, [], 'environments:[] must expose no native tools');
  console.log('Installed Codex no-environment tool boundary passed (mock provider; no account credentials or paid call).');
} finally {
  controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  // App-server shutdown closes Windows SQLite handles asynchronously.
  for (let attempt = 0; attempt < 10; attempt++) { try { rmSync(home, { recursive: true, force: true }); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
}
