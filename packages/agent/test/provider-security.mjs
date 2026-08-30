import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const dist = resolve(here, '..', 'dist');
const home = mkdtempSync(join(tmpdir(), 'mr-robot-provider-security-'));
process.env.MR_ROBOT_HOME = home;

const { ConfigStore } = await import(pathToFileURL(join(dist, 'config.js')).href);
const { ProviderRegistry } = await import(pathToFileURL(join(dist, 'ai', 'registry.js')).href);
const { AgentServer } = await import(pathToFileURL(join(dist, 'server', 'server.js')).href);
const { ChatSession } = await import(pathToFileURL(join(dist, 'server', 'chat.js')).href);

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name} ${detail}`);
  }
}

console.log('1. provider URLs cannot carry credentials or covert URL data');
{
  const registry = new ProviderRegistry(new ConfigStore());
  for (const baseUrl of [
    'https://user:password@example.com/v1',
    'https://example.com/v1?api_key=secret',
    'https://example.com/v1#secret',
    'file:///C:/secret',
  ]) {
    let blocked = false;
    try {
      registry.add({ label: 'unsafe', type: 'openai-compatible', baseUrl, model: 'test' });
    } catch {
      blocked = true;
    }
    check(`rejects unsafe URL ${new URL(baseUrl).protocol}`, blocked);
  }
  const safe = registry.add({ label: 'safe', type: 'openai-compatible', baseUrl: 'https://example.com/v1/', model: 'test' });
  check('normalizes a safe HTTPS URL', safe.baseUrl === 'https://example.com/v1', safe.baseUrl);
}

console.log('2. legacy malformed URLs are never returned to clients');
{
  const config = new ConfigStore();
  config.upsertProvider({
    id: 'legacy-secret-url',
    label: 'legacy',
    type: 'openai-compatible',
    baseUrl: 'https://embedded:credential@example.com/v1?token=secret#secret',
    model: 'test',
    apiKey: 'provider-api-secret',
    headers: { Authorization: 'Bearer header-secret' },
    isDefault: false,
    source: 'api',
  });
  const registry = new ProviderRegistry(config);
  const exposed = registry.list().find((provider) => provider.id === 'legacy-secret-url');
  check('legacy credential URL is redacted', exposed?.baseUrl === '', JSON.stringify(exposed));
  check('ProviderInfo contains neither API keys nor secret headers', !JSON.stringify(exposed).includes('provider-api-secret') && !JSON.stringify(exposed).includes('header-secret'));
  check('legacy credential provider is not instantiated', registry.get('legacy-secret-url') === undefined);
}

console.log('3. provider network probes require local administrator access');
{
  const server = new AgentServer();
  const handlers = server.handlers();
  const linked = {
    id: 'linked-client',
    state: {
      auth: { isAdmin: false, linkId: 'linked-device', permissionCap: 'full' },
      chat: new ChatSession(),
    },
  };
  let testBlocked = false;
  let modelsBlocked = false;
  try { await handlers.get('providers.test')({ id: 'missing' }, linked); } catch { testBlocked = true; }
  try { await handlers.get('providers.models')({ id: 'missing' }, linked); } catch { modelsBlocked = true; }
  check('linked clients cannot test provider endpoints', testBlocked);
  check('linked clients cannot enumerate provider models', modelsBlocked);
}

rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? '\nPROVIDER SECURITY TESTS PASSED' : `\n${failures} PROVIDER SECURITY FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
