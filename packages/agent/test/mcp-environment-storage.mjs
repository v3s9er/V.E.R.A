import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const dist = resolve(here, '..', 'dist');
const { createMcpPlugin } = await import(pathToFileURL(join(dist, 'plugins', 'mcp.js')).href);
const { SecretVault } = await import(pathToFileURL(join(dist, 'secrets.js')).href);

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name} ${detail}`);
  }
}

class MemoryVault {
  values = new Map();
  next = 0;
  failProtectAt = 0;

  protect(value) {
    this.next++;
    if (this.failProtectAt === this.next) throw new Error('injected DPAPI failure');
    const ciphertext = `test-dpapi:v1:${this.next}`;
    this.values.set(ciphertext, value);
    return ciphertext;
  }

  unprotect(ciphertext) {
    const value = this.values.get(ciphertext);
    if (value === undefined) throw new Error('unknown test ciphertext');
    return value;
  }
}

function context(initial = {}) {
  const state = structuredClone(initial);
  const commands = new Map();
  return {
    state,
    commands,
    ctx: {
      storage: {
        get: (key) => state[key],
        set: (key, value) => { state[key] = structuredClone(value); },
      },
      registerCommand: (name, handler) => commands.set(name, handler),
    },
  };
}

function pluginWith(vault) {
  return createMcpPlugin({
    protectEnvironment: (value) => vault.protect(value),
    unprotectEnvironment: (value) => vault.unprotect(value),
  });
}

console.log('1. new MCP environments are protected at rest and redacted from RPC results');
{
  const vault = new MemoryVault();
  const test = context({ servers: [] });
  await pluginWith(vault).activate(test.ctx);
  const secret = 'new-server-token-that-must-not-leak';
  const added = await test.commands.get('mcp.servers.add')({
    id: 'private-server',
    command: 'node',
    args: ['server.js'],
    env: { MCP_API_TOKEN: secret, EMPTY_VALUE: '' },
  });
  const listed = await test.commands.get('mcp.servers.list')();
  const persisted = JSON.stringify(test.state.servers);
  const rpc = JSON.stringify({ added, listed });
  check('generic plugin storage contains ciphertext but no environment values',
    persisted.includes('test-dpapi:v1:') && !persisted.includes(secret) && !persisted.includes('EMPTY_VALUE":""'), persisted);
  check('add and list return only environment variable names',
    added.env.join(',') === 'MCP_API_TOKEN,EMPTY_VALUE' && listed[0].env.join(',') === 'MCP_API_TOKEN,EMPTY_VALUE');
  check('RPC results contain neither values nor protected payloads',
    !rpc.includes(secret) && !rpc.includes('test-dpapi:v1:'), rpc);
  check('the protected payload preserves values for process launch',
    vault.unprotect(test.state.servers[0].envProtected) === JSON.stringify({ MCP_API_TOKEN: secret, EMPTY_VALUE: '' }));
}

console.log('2. legacy plaintext is migrated before commands become available');
{
  const vault = new MemoryVault();
  const legacySecret = 'legacy-token-that-must-be-scrubbed';
  const test = context({
    servers: [{
      id: 'legacy-server', name: 'Legacy', command: 'node', args: [], enabled: true,
      env: { LEGACY_TOKEN: legacySecret },
    }],
  });
  await pluginWith(vault).activate(test.ctx);
  const persisted = JSON.stringify(test.state.servers);
  const listed = await test.commands.get('mcp.servers.list')();
  check('migration removes the legacy environment object in one replacement write',
    !Object.hasOwn(test.state.servers[0], 'env') && !persisted.includes(legacySecret), persisted);
  check('migrated values are recoverable only through the protector',
    JSON.parse(vault.unprotect(test.state.servers[0].envProtected)).LEGACY_TOKEN === legacySecret);
  check('the migrated list response remains value-free',
    listed[0].env.join(',') === 'LEGACY_TOKEN' && !JSON.stringify(listed).includes(legacySecret));
}

console.log('3. a failed legacy migration fails closed without a partial rewrite');
{
  const vault = new MemoryVault();
  vault.failProtectAt = 2;
  const initial = {
    servers: [
      { id: 'first-server', name: 'First', command: 'node', args: [], enabled: true, env: { FIRST_TOKEN: 'first-secret' } },
      { id: 'second-server', name: 'Second', command: 'node', args: [], enabled: true, env: { SECOND_TOKEN: 'second-secret' } },
    ],
  };
  const test = context(initial);
  let rejected = false;
  try { await pluginWith(vault).activate(test.ctx); } catch { rejected = true; }
  check('activation rejects when any value cannot be protected', rejected);
  check('no RPC command is registered after failed migration', test.commands.size === 0);
  check('failed migration leaves the original legacy record unchanged',
    JSON.stringify(test.state) === JSON.stringify(initial), JSON.stringify(test.state));
}

console.log('4. a failed add never replaces the existing protected configuration');
{
  const vault = new MemoryVault();
  const test = context({ servers: [] });
  const plugin = pluginWith(vault);
  await plugin.activate(test.ctx);
  await test.commands.get('mcp.servers.add')({ id: 'stable-server', command: 'node', env: { TOKEN: 'stable-secret' } });
  const before = JSON.stringify(test.state);
  vault.failProtectAt = vault.next + 1;
  let rejected = false;
  try {
    await test.commands.get('mcp.servers.add')({ id: 'stable-server', command: 'node', env: { TOKEN: 'replacement-secret' } });
  } catch { rejected = true; }
  check('the add command reports a protection failure', rejected);
  check('the prior protected record remains authoritative', JSON.stringify(test.state) === before);
}

console.log('5. the production DPAPI vault uses an MCP-specific protection domain');
{
  if (process.platform !== 'win32') {
    check('DPAPI domain test is Windows-only', true);
  } else {
    const mcpVault = new SecretVault('mcp-server-environment');
    const providerVault = new SecretVault('provider');
    const plaintext = 'mcp-domain-separation-test';
    const ciphertext = mcpVault.protect(plaintext);
    let crossDomainRejected = false;
    try { providerVault.unprotect(ciphertext); } catch { crossDomainRejected = true; }
    check('the MCP vault round-trips in its own domain', mcpVault.unprotect(ciphertext) === plaintext);
    check('provider vault cannot unprotect MCP environment ciphertext', crossDomainRejected);
  }
}

console.log(failures === 0 ? '\nMCP ENVIRONMENT STORAGE TESTS PASSED' : `\n${failures} MCP ENVIRONMENT STORAGE FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
