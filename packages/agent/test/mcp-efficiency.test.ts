import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpPlugin, type McpPluginRuntime } from '../src/plugins/mcp.js';
import { McpDiscovery } from '../src/plugins/mcp-discovery.js';
import { boundMcpResult, mcpResultLimit } from '../src/plugins/mcp-output.js';
import { context7NodeCommand, MCP_PRESETS, previewMcpPreset } from '../src/plugins/mcp-presets.js';
import type { PluginContext } from '../src/plugins/context.js';
import type { PluginExecutionContext, RegisterCommandOptions } from '../src/plugins/commands.js';

const tool = (name: string) => ({ name, description: 'A precise tool. '.repeat(50), inputSchema: { type: 'object' as const, properties: { query: { type: 'string', description: 'schema details '.repeat(200) } } } });

test('discovery keeps schemas lazy and paginates both local and upstream pages without refetching', async () => {
  const discovery = new McpDiscovery();
  const requests: (string | undefined)[] = [];
  const tools = Array.from({ length: 30 }, (_, index) => tool(`tool_${index}`));
  const list = async (cursor?: string) => {
    requests.push(cursor);
    return cursor === 'remote-page-2' ? { tools: [tool('last_tool')] } : { tools, nextCursor: 'remote-page-2' };
  };
  const first = await discovery.discover('serena', { limit: 20 }, list);
  assert.equal(first.tools?.length, 20);
  assert.equal(JSON.stringify(first).includes('inputSchema'), true); // Only schemaHint mentions the field.
  assert.equal(first.tools?.some((item) => 'inputSchema' in item), false);
  assert.ok(JSON.stringify(first).length < JSON.stringify({ tools }).length / 10);
  const second = await discovery.discover('serena', { cursor: first.nextCursor }, list);
  assert.equal(second.tools?.[0]?.name, 'tool_20');
  assert.equal(second.tools?.length, 10);
  const selected = await discovery.discover('serena', { cursor: first.nextCursor, tool: 'tool_25' }, list);
  assert.deepEqual(selected.tool?.inputSchema, tools[25]!.inputSchema);
  assert.deepEqual(requests, [undefined]);
  const third = await discovery.discover('serena', { cursor: second.nextCursor }, list);
  assert.equal(third.tools?.[0]?.name, 'last_tool');
  assert.equal(third.nextCursor, undefined);
  assert.deepEqual(requests, [undefined, 'remote-page-2']);
  await assert.rejects(discovery.discover('context7', { cursor: first.nextCursor }, list), /cursor/);
});

test('discovery cache expires, clears per server, and rejects invalid or oversized input before listing', async () => {
  let now = 1;
  let calls = 0;
  const discovery = new McpDiscovery(() => now);
  const list = async () => { calls++; return { tools: [tool('only')] }; };
  await assert.rejects(discovery.discover('serena', { limit: 50 }, list), /limit/);
  await assert.rejects(discovery.discover('serena', { cursor: 'invalid' }, list), /cursor/);
  assert.equal(calls, 0);
  await discovery.discover('serena', {}, list);
  await discovery.discover('serena', {}, list);
  assert.equal(calls, 1);
  now = 60_002;
  await discovery.discover('serena', {}, list);
  assert.equal(calls, 2);
  discovery.clear('serena');
  await discovery.discover('serena', {}, list);
  assert.equal(calls, 3);
  const large = { ...tool('large'), inputSchema: { type: 'object' as const, description: 'x'.repeat(25_000) } };
  await assert.rejects(discovery.discover('large-server', { tool: 'large' }, async () => ({ tools: [large] })), /schema/);
  const huge = { ...tool('huge'), description: 'x'.repeat(1_000_000) };
  await assert.rejects(discovery.discover('huge-server', {}, async () => ({ tools: [huge] })), /페이지가 너무 큽니다/);
});

test('tool output bounds include JSON escaping and preserve the server error flag', () => {
  const small = { content: [{ type: 'text', text: 'ready' }], isError: false };
  assert.equal(boundMcpResult(small), small);
  for (const value of ['x'.repeat(100_000), '\"\n\t\\'.repeat(50_000), '😀'.repeat(50_000)]) {
    const result = boundMcpResult({ content: [{ type: 'text', text: value }], isError: true }, 1_000) as { isError: boolean; _mrRobot: { truncated: boolean } };
    assert.equal(result.isError, true);
    assert.equal(result._mrRobot.truncated, true);
    assert.ok(JSON.stringify(result).length <= 1_000);
  }
  assert.equal(mcpResultLimit(undefined), 12_000);
  assert.equal(mcpResultLimit(32_000), 32_000);
  for (const invalid of [0, 999, 32_001, 1_000.5, '12000', NaN]) assert.throws(() => mcpResultLimit(invalid));
});

test('keyword search ranks across upstream pages and returns an exact schema cursor, not every schema', async () => {
  const discovery = new McpDiscovery();
  const requested: (string | undefined)[] = [];
  const list = async (cursor?: string) => {
    requested.push(cursor);
    return cursor === 'second' ? { tools: [tool('findSymbol'), tool('symbolReferences')] }
      : { tools: [...Array.from({ length: 100 }, (_, i) => tool(`unrelated_${i}`)), { ...tool('unrelated'), description: 'Find symbol help' }], nextCursor: 'second' };
  };
  const search = await discovery.discover('code', { query: 'find symbol', limit: 2 }, list);
  assert.ok('searchComplete' in search && search.searchComplete);
  assert.equal(search.tools?.[0].name, 'findSymbol');
  assert.equal(search.tools?.length, 2);
  assert.equal(search.tools?.some(item => 'inputSchema' in item), false);
  assert.ok(JSON.stringify(search).length < 1800);
  const first = search.tools![0];
  assert.ok('cursor' in first);
  const schema = await discovery.discover('code', { tool: first.name, cursor: first.cursor }, list);
  assert.equal(schema.tool?.name, 'findSymbol');
  assert.ok(schema.tool?.inputSchema);
  assert.deepEqual(requested, [undefined, 'second']);
});

test('search bounds upstream work and binds continuation to the same server and query', async () => {
  const discovery = new McpDiscovery(); let calls = 0;
  const list = async (cursor?: string) => { calls++; const n = Number(cursor ?? 0); return { tools: [tool(`needle_${n}`)], ...(n < 5 ? { nextCursor: String(n + 1) } : {}) }; };
  const first = await discovery.discover('many', { query: 'needle', limit: 2 }, list);
  assert.ok('searchComplete' in first && !first.searchComplete);
  assert.equal(calls, 4); assert.equal(first.tools?.length, 2);
  await assert.rejects(discovery.discover('other', { query: 'needle', cursor: first.nextCursor }, list), /cursor/);
  await assert.rejects(discovery.discover('many', { query: 'changed', cursor: first.nextCursor }, list), /cursor/);
  await assert.rejects(discovery.discover('many', { cursor: first.nextCursor }, list), /cursor/);
  const next = await discovery.discover('many', { query: 'needle', cursor: first.nextCursor }, list);
  assert.ok('searchComplete' in next && next.searchComplete);
  assert.equal(calls, 6);
});

test('search rejects invalid input before I/O, treats regex-like text literally and detects cyclic pages', async () => {
  const discovery = new McpDiscovery(); let calls = 0;
  const list = async () => { calls++; return { tools: [tool('find_symbol')] }; };
  for (const query of ['', ' ', 'x'.repeat(257), 123, '.*']) {
    await assert.rejects(discovery.discover('code', { query: query as string }, list), /검색어/);
  }
  await assert.rejects(discovery.discover('code', { query: 'find', tool: 'find_symbol' }, list), /함께/);
  assert.equal(calls, 0);
  const result = await discovery.discover('code', { query: '(find)+' }, list);
  assert.equal(result.tools?.[0].name, 'find_symbol');
  await assert.rejects(discovery.discover('cycle', { query: 'find' }, async cursor => ({ tools: [], nextCursor: cursor === 'a' ? 'b' : 'a' })), /순환/);
});

test('list invalidation during a fetch cannot resurrect obsolete schemas', async () => {
  for (const all of [false, true]) {
    const discovery = new McpDiscovery(); let finish!: () => void;
    const pending = discovery.discover('code', { tool: 'old' }, async () => {
      await new Promise<void>(resolve => { finish = resolve; }); return { tools: [tool('old')] };
    });
    discovery.clear(all ? undefined : 'code'); finish();
    await assert.rejects(pending, /목록이 변경/);
    const fresh = await discovery.discover('code', { tool: 'new' }, async () => ({ tools: [tool('new')] }));
    assert.equal(fresh.tool?.name, 'new');
  }
});

test('invalidation between cached search pages prevents mixed-generation results', async () => {
  const discovery = new McpDiscovery(); let finish!: () => void;
  const pending = discovery.discover('code', { query: 'find' }, async cursor => {
    if (!cursor) return { tools: [tool('old_find')], nextCursor: 'next' };
    await new Promise<void>(resolve => { finish = resolve; }); return { tools: [tool('new_find')] };
  });
  while (!finish) await new Promise<void>(resolve => setImmediate(resolve));
  discovery.clear('code'); finish(); await assert.rejects(pending, /목록이 변경/);
});

test('presets create disabled local previews with no installation commands or credential values', () => {
  const context7 = previewMcpPreset({ preset: 'context7', executablePath: 'C:\\MCP\\context7\\dist\\index.js' });
  assert.equal(context7.enabled, false);
  assert.equal(context7.command, context7NodeCommand());
  assert.deepEqual(context7.env, {});
  const serena = previewMcpPreset({ preset: 'serena', executablePath: 'C:\\MCP\\serena.exe', projectRoot: 'C:\\작업\\project' });
  assert.equal(serena.enabled, false);
  assert.equal(serena.cwd, 'C:\\작업\\project');
  assert.ok(serena.args.includes('ide'));
  assert.ok(serena.args.includes('C:\\작업\\project'));
  assert.doesNotMatch(JSON.stringify([context7, serena]), /npx|uvx|git\+|--api-key/);
  assert.deepEqual(MCP_PRESETS[0].requiredEnvironment, ['CONTEXT7_API_KEY']);
  assert.throws(() => previewMcpPreset({ preset: 'serena', executablePath: 'serena', projectRoot: 'C:\\project' }), /절대 경로/);
});

test('Context7 resolves Node independently of a packaged Electron executable', () => {
  assert.equal(context7NodeCommand('C:\\Program Files\\Mr.Robot\\Mr.Robot.exe', true), 'node');
  assert.equal(context7NodeCommand('C:\\Program Files\\Mr.Robot\\electron.exe', true), 'node');
  assert.equal(context7NodeCommand('C:\\Program Files\\nodejs\\node.exe', false), 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(context7NodeCommand('/usr/local/bin/node', false), '/usr/local/bin/node');
  assert.equal(context7NodeCommand('C:\\unexpected-host.exe', false), 'node');
  assert.equal(context7NodeCommand('node.exe', false), 'node');
});

function harness(connect: NonNullable<McpPluginRuntime['connect']>) {
  const state = new Map<string, unknown>();
  const commands = new Map<string, { handler: Parameters<PluginContext['registerCommand']>[1]; options: RegisterCommandOptions }>();
  const plugin = createMcpPlugin({
    protectEnvironment: (value) => `test-protected:${Buffer.from(value).toString('base64')}`,
    unprotectEnvironment: (value) => Buffer.from(value.slice('test-protected:'.length), 'base64').toString(),
    connect,
  });
  const ctx = {
    storage: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => state.set(key, value) },
    registerCommand: (name: string, handler: Parameters<PluginContext['registerCommand']>[1], options: RegisterCommandOptions = {}) => commands.set(name, { handler, options }),
  } as unknown as PluginContext;
  return {
    plugin, ctx, state, commands,
    call: async (name: string, params?: unknown, execution?: PluginExecutionContext) => commands.get(name)!.handler(params, execution) as Promise<any>,
  };
}

test('paging is offered with MCP discovery, never for unrelated mathematics', async () => {
  const h = harness(async () => { throw new Error('must not connect'); });
  await h.plugin.activate!(h.ctx);
  for (const name of ['mcp.discover', 'mcp.call', 'mcp.result']) {
    const when = h.commands.get(name)!.options.toolWhen!;
    assert.equal(when('Solve this mathematics problem: x + 2 = 4'), false);
    assert.equal(when('MCP 결과 다음 페이지 읽어줘'), true);
    assert.equal(when('context7 documentation'), true);
  }
  await h.plugin.deactivate!();
});

test('plugin discovers lazily, forwards cancellation, preserves secret storage and bounds call output', async () => {
  let connections = 0;
  let closed = 0;
  let listSignal: AbortSignal | undefined;
  let callSignal: AbortSignal | undefined;
  const runtimeConnect: NonNullable<McpPluginRuntime['connect']> = async (config) => {
    connections++;
    assert.equal(config.env.CONTEXT7_API_KEY, 'test-secret');
    return {
      client: {
        listTools: async (_params, options) => { listSignal = options?.signal; return { tools: [tool('query-docs')] }; },
        callTool: async (_params, _schema, options) => { callSignal = options?.signal; return { content: [{ type: 'text', text: 'docs'.repeat(10_000) }] }; },
      },
      transport: { close: async () => { closed++; } },
    };
  };
  const h = harness(runtimeConnect);
  await h.plugin.activate!(h.ctx);
  await h.call('mcp.presets.list');
  await h.call('mcp.servers.add', { id: 'context7', command: 'node', env: { CONTEXT7_API_KEY: 'test-secret' }, enabled: false });
  assert.deepEqual(await h.call('mcp.discover'), { servers: [] });
  await assert.rejects(h.call('mcp.discover', { serverId: 'context7' }), /활성 MCP/);
  assert.equal(connections, 0);
  await assert.rejects(h.call('mcp.discover', { query: 'query docs' }), /serverId/);
  assert.equal(connections, 0);
  await h.call('mcp.servers.add', { id: 'context7', command: 'node', env: { CONTEXT7_API_KEY: 'test-secret' }, enabled: true });
  assert.deepEqual(await h.call('mcp.discover'), { servers: [{ id: 'context7', name: 'context7' }] });
  const controller = new AbortController();
  const execution: PluginExecutionContext = { signal: controller.signal, permissionMode: 'full', destructiveApproved: true, approvalSource: 'prompt' };
  await h.call('mcp.discover', { serverId: 'context7' }, execution);
  assert.equal(listSignal, controller.signal);
  const search = await h.call('mcp.discover', { serverId: 'context7', query: 'query docs' }, execution);
  assert.equal(search.tools[0].name, 'query-docs');
  const selected = await h.call('mcp.discover', { serverId: 'context7', tool: search.tools[0].name, cursor: search.tools[0].cursor }, execution);
  assert.equal(selected.tool.name, 'query-docs');
  assert.match(JSON.stringify(h.commands.get('mcp.discover')!.options.parameters), /"query"/);
  const result = await h.call('mcp.call', { serverId: 'context7', tool: 'query-docs' }, execution);
  assert.equal(callSignal, controller.signal);
  assert.equal(result._mrRobot.truncated, true);
  assert.ok(JSON.stringify(result).length <= 12_000);
  assert.equal(connections, 1);
  assert.doesNotMatch(JSON.stringify(await h.call('mcp.servers.list')), /test-secret|test-protected/);
  assert.doesNotMatch(JSON.stringify([...h.state.values()]), /test-secret/);
  assert.equal(h.commands.get('mcp.discover')!.options.destructive, true);
  assert.equal(h.commands.get('mcp.call')!.options.destructive, true);
  assert.equal(h.commands.get('mcp.call')!.options.toolWhen?.('Serena로 코드 확인'), true);
  assert.equal(h.commands.get('mcp.call')!.options.toolWhen?.('오늘 날씨'), false);
  controller.abort();
  await assert.rejects(h.call('mcp.discover', { serverId: 'context7' }, execution), /abort/i);
  await assert.rejects(h.call('mcp.call', { serverId: 'context7', tool: 'query-docs' }, execution), /abort/i);
  await h.plugin.deactivate?.(h.ctx);
  assert.equal(closed, 1);
});

test('shutdown closes a connection that is still starting and does not keep it live', async () => {
  let finish: (() => void) | undefined;
  let closed = 0;
  let starts = 0;
  const h = harness(async () => {
    starts++;
    await new Promise<void>((resolve) => { finish = resolve; });
    return { client: { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }) }, transport: { close: async () => { closed++; } } };
  });
  await h.plugin.activate!(h.ctx);
  await h.call('mcp.servers.add', { id: 'starting', command: 'node' });
  const first = h.call('mcp.discover', { serverId: 'starting' });
  const second = h.call('mcp.discover', { serverId: 'starting' });
  const firstRejected = assert.rejects(first, /연결 설정이 변경/);
  const secondRejected = assert.rejects(second, /연결 설정이 변경/);
  const shutdown = h.plugin.deactivate?.(h.ctx);
  finish!();
  await Promise.all([firstRejected, secondRejected, shutdown]);
  assert.equal(starts, 1);
  assert.equal(closed, 1);
});

test('server discovery is paginated without starting processes and invalid tool input never connects', async () => {
  let connections = 0;
  const h = harness(async () => { connections++; throw new Error('must not connect'); });
  await h.plugin.activate!(h.ctx);
  for (let index = 0; index < 25; index++) await h.call('mcp.servers.add', { id: `server-${index}`, command: 'node' });
  const first = await h.call('mcp.discover', { limit: 20 });
  const second = await h.call('mcp.discover', { limit: 20, cursor: first.nextCursor });
  assert.equal(first.servers.length, 20);
  assert.equal(second.servers.length, 5);
  assert.equal(second.servers[0].id, 'server-20');
  assert.equal(second.nextCursor, undefined);
  await assert.rejects(h.call('mcp.discover', { serverId: 'server-0', limit: 100 }), /limit/);
  await assert.rejects(h.call('mcp.discover', { serverId: 'server-0', cursor: 'bad' }), /cursor/);
  await assert.rejects(h.call('mcp.call', { serverId: 'server-0', tool: 'read', arguments: [] }), /arguments/);
  await assert.rejects(h.call('mcp.call', { serverId: 'server-0', tool: 'read', maxResultChars: 33_000 }), /maxResultChars/);
  assert.equal(connections, 0);
  await h.plugin.deactivate?.(h.ctx);
});

test('retained originals are scoped and invalidated when the server is removed', async () => {
  const h = harness(async () => ({ client: { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ type: 'text', text: 'original'.repeat(4000) }] }) }, transport: { close: async () => {} } }));
  await h.plugin.activate!(h.ctx);
  await h.call('mcp.servers.add', { id: 'originals', command: 'node' });
  const execution: PluginExecutionContext = { scopeKey: 'ticket:a:full', permissionMode: 'full', destructiveApproved: true, approvalSource: 'prompt' };
  const response = await h.call('mcp.call', { serverId: 'originals', tool: 'read' }, execution);
  assert.equal(typeof response._mrRobot.resultId, 'string');
  const page = await h.call('mcp.result', { resultId: response._mrRobot.resultId }, execution);
  assert.match(page.text, /original/);
  await assert.rejects(h.call('mcp.result', { resultId: response._mrRobot.resultId }, { ...execution, scopeKey: 'ticket:b:full' }), /없거나 만료/);
  await h.call('mcp.servers.remove', { id: 'originals' });
  await assert.rejects(h.call('mcp.result', { resultId: response._mrRobot.resultId }, execution), /없거나 만료/);
  await h.plugin.deactivate?.(h.ctx);
});

test('a cancelled waiter exits promptly while another request finishes connecting', async () => {
  let finish: (() => void) | undefined;
  const h = harness(async () => {
    await new Promise<void>((resolve) => { finish = resolve; });
    return { client: { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }) }, transport: { close: async () => {} } };
  });
  await h.plugin.activate!(h.ctx);
  await h.call('mcp.servers.add', { id: 'starting', command: 'node' });
  const first = h.call('mcp.discover', { serverId: 'starting' });
  const controller = new AbortController();
  const execution: PluginExecutionContext = { signal: controller.signal, permissionMode: 'full', destructiveApproved: true, approvalSource: 'prompt' };
  const second = h.call('mcp.discover', { serverId: 'starting' }, execution);
  controller.abort();
  await assert.rejects(second, /abort/i);
  finish!();
  await first;
  await h.plugin.deactivate?.(h.ctx);
});
