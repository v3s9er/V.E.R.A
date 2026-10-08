// Optional live third-party tool check: no AI model invocation and no user files.
// Uses a generated Python fixture; Context7 receives only a public API query.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

if (!process.argv.includes('--run')) throw new Error('Pass --run to start installed external tools against synthetic data.');
const root = mkdtempSync(join(tmpdir(), 'vera-harness-mcp-'));
const tools = join(process.env.MR_ROBOT_HOME ?? join(homedir(), '.mr-robot'), 'tools');
const project = join(root, 'fixture');
mkdirSync(join(project, '.serena'), { recursive: true });
writeFileSync(join(project, 'sample.py'), 'def vera_fixture_add(left: int, right: int) -> int:\n    return left + right\n');
writeFileSync(join(project, '.serena', 'project.yml'), 'project_name: vera_harness_fixture\nlanguage_servers: [python]\nencoding: utf-8\nread_only: true\n');
const specs = [
  { name: 'context7', command: process.execPath, args: [join(tools, 'context7-4.2.0/node_modules/@upstash/context7-mcp/dist/index.js'), '--transport', 'stdio'], env: {} },
  { name: 'serena', command: join(tools, 'serena-1.7.0', process.platform === 'win32' ? 'Scripts/serena.exe' : 'bin/serena'),
    args: ['start-mcp-server', '--transport', 'stdio', '--context', 'ide', '--project', project, '--open-web-dashboard', 'false', '--enable-web-dashboard', 'false', '--enable-gui-log-window', 'false'],
    env: { SERENA_HOME: join(root, 'serena-home'), UV_PYTHON_INSTALL_DIR: join(tools, 'uv-python'), UV_CACHE_DIR: join(tools, 'uv-cache') } },
];
let failed = false;
for (const spec of specs) {
  const start = performance.now();
  const env = { ...getDefaultEnvironment(), ...spec.env };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = [dirname(spec.command), env[pathKey]].filter(Boolean).join(delimiter);
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env, cwd: project, stderr: 'pipe' });
  // Drain logs without publishing local paths, source or host configuration.
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'vera-functional-fixture', version: '0.8.0' }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: 90_000 });
    const listing = await client.listTools({}, { timeout: 60_000 });
    const name = spec.name === 'context7' ? 'resolve-library-id' : 'get_symbols_overview';
    assert.ok(listing.tools.some(tool => tool.name === name), `missing ${name}`);
    const result = await client.callTool({ name, arguments: spec.name === 'context7'
      ? { libraryName: 'node.js', query: 'Node.js URL constructor documentation' }
      : { relative_path: 'sample.py', depth: 1 } }, undefined, { timeout: 90_000 });
    const text = JSON.stringify(result);
    const contentVerified = !result.isError && (spec.name === 'serena' ? text.includes('vera_fixture_add') : /\/nodejs\/|\/websites\/nodejs|\/nodejs_org/i.test(text));
    console.log(JSON.stringify({ name: spec.name, handshake: true, tools: listing.tools.length, operation: name, contentVerified, elapsedMs: Math.round(performance.now() - start),
      ...(!contentVerified ? { diagnostic: text.slice(0, 600) } : {}) }));
    if (!contentVerified) failed = true;
  } catch (error) { failed = true; console.log(JSON.stringify({ name: spec.name, passed: false, error: String(error).slice(0, 250) })); }
  finally { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
}
process.exitCode = failed ? 1 : 0;
