import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SecretVault } from '../secrets.js';
import type { MrRobotPlugin } from './loader.js';
import type { PluginContext } from './context.js';

interface McpServerConfigBase {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  enabled: boolean;
}

interface StoredMcpServerConfig extends McpServerConfigBase {
  /** Environment variable names are non-secret and preserve the list RPC contract. */
  envKeys?: string[];
  /** A single authenticated-by-DPAPI JSON payload prevents any values being stored in plaintext. */
  envProtected?: string;
  /** Legacy v0.2 storage only. Removed before the plugin registers any command. */
  env?: Record<string, string>;
}

interface McpServerConfig extends McpServerConfigBase {
  env: Record<string, string>;
}

interface PublicMcpServerConfig extends McpServerConfigBase {
  env: string[];
}

interface LiveClient { client: Client; transport: StdioClientTransport }

export interface McpPluginRuntime {
  /** Test seams; production always uses the MCP-specific Windows DPAPI vault. */
  protectEnvironment?(value: string): string;
  unprotectEnvironment?(value: string): string;
}

function environmentMap(raw: unknown): Record<string, string> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('MCP 서버 환경 변수 형식이 올바르지 않습니다.');
  }
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value)]));
}

function publicConfig(config: StoredMcpServerConfig): PublicMcpServerConfig {
  const { env, envKeys, envProtected: _envProtected, ...safe } = config;
  return { ...safe, env: [...(envKeys ?? Object.keys(env ?? {}))] };
}

export function createMcpPlugin(runtime: McpPluginRuntime = {}): MrRobotPlugin {
  const vault = new SecretVault('mcp-server-environment');
  const protectEnvironment = runtime.protectEnvironment ?? ((value: string) => vault.protect(value));
  const unprotectEnvironment = runtime.unprotectEnvironment ?? ((value: string) => vault.unprotect(value));
  const live = new Map<string, LiveClient>();
  let pluginCtx: PluginContext | undefined;
  const storedConfigs = (): StoredMcpServerConfig[] => pluginCtx?.storage.get<StoredMcpServerConfig[]>('servers') ?? [];
  const protectEnv = (raw: unknown): Pick<StoredMcpServerConfig, 'envKeys' | 'envProtected'> => {
    const env = environmentMap(raw);
    try {
      const plaintext = JSON.stringify(env);
      const envProtected = protectEnvironment(plaintext);
      if (!envProtected || envProtected === plaintext) throw new Error('unsafe protected environment');
      return { envKeys: Object.keys(env), envProtected };
    } catch {
      throw new Error('MCP 서버 환경 변수를 Windows 보안 저장소에 저장할 수 없습니다.');
    }
  };
  const unprotectEnv = (config: StoredMcpServerConfig): Record<string, string> => {
    if (!config.envProtected) throw new Error('보호된 MCP 서버 환경 변수가 없습니다.');
    try {
      return environmentMap(JSON.parse(unprotectEnvironment(config.envProtected)) as unknown);
    } catch {
      throw new Error('MCP 서버 환경 변수를 Windows 보안 저장소에서 읽을 수 없습니다.');
    }
  };
  const migrateLegacyEnvironment = (ctx: PluginContext): void => {
    const current = ctx.storage.get<StoredMcpServerConfig[]>('servers') ?? [];
    if (!current.some((item) => Object.hasOwn(item, 'env') || !item.envProtected)) return;
    try {
      const migrated = current.map((item) => {
        if (!Object.hasOwn(item, 'env') && item.envProtected) return item;
        const { env, envProtected: _envProtected, envKeys: _envKeys, ...safe } = item;
        return { ...safe, ...protectEnv(env) };
      });
      // Commit only after every legacy environment has been protected. If
      // protection or persistence fails, activation aborts and no command can
      // consume or return the legacy plaintext values.
      ctx.storage.set('servers', migrated);
    } catch {
      throw new Error('기존 MCP 서버 환경 변수를 안전하게 마이그레이션할 수 없습니다.');
    }
  };
  const connect = async (id: string): Promise<LiveClient> => {
    const existing = live.get(id);
    if (existing) return existing;
    const stored = storedConfigs().find((item) => item.id === id && item.enabled);
    if (!stored) throw new Error('활성 MCP 서버를 찾을 수 없습니다.');
    if (!/^[a-z0-9._:@+\\/ -]+$/i.test(stored.command)) throw new Error('MCP 실행 명령이 올바르지 않습니다.');
    const config: McpServerConfig = { ...stored, env: unprotectEnv(stored) };
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
      stderr: 'pipe',
      maxBufferSize: 8 * 1024 * 1024,
    });
    const client = new Client({ name: 'mr-robot', version: '0.2.0' }, { capabilities: {} });
    await client.connect(transport);
    const value = { client, transport };
    live.set(id, value);
    transport.onclose = () => live.delete(id);
    return value;
  };
  const close = async (id: string) => {
    const item = live.get(id);
    live.delete(id);
    if (item) await item.transport.close().catch(() => undefined);
  };
  return {
    manifest: {
      id: 'mcp-host', name: 'MCP Tool Connector', version: '0.2.0', kind: 'tool', enabledByDefault: true,
      description: '표준 MCP stdio 서버를 명시적 권한과 승인 경계 안에서 연결합니다.',
      capabilities: ['mcp.stdio', 'mcp.tools.discover', 'mcp.tools.call'],
      permissions: ['mcp.connect', 'process.execute', 'network.client'],
      dependencies: [],
    },
    activate(ctx) {
      migrateLegacyEnvironment(ctx);
      pluginCtx = ctx;
      ctx.registerCommand('mcp.servers.list', () => storedConfigs().map(publicConfig), { destructive: false });
      ctx.registerCommand('mcp.servers.add', async (raw) => {
        const body = (raw ?? {}) as Partial<McpServerConfig>;
        const id = String(body.id ?? '').trim().toLowerCase();
        const command = String(body.command ?? '').trim();
        if (!/^[a-z0-9][a-z0-9._-]{1,62}$/i.test(id)) throw new Error('MCP 서버 ID는 영문·숫자·점·밑줄·하이픈으로 입력하세요.');
        if (!command) throw new Error('실행 명령이 필요합니다.');
        const next = storedConfigs().filter((item) => item.id !== id);
        next.push({ id, name: String(body.name ?? id).slice(0, 100), command, args: Array.isArray(body.args) ? body.args.map(String) : [], cwd: body.cwd ? String(body.cwd) : undefined, ...protectEnv(body.env), enabled: body.enabled !== false });
        ctx.storage.set('servers', next);
        await close(id);
        return publicConfig(next.find((item) => item.id === id)!);
      }, { destructive: true, adminOnly: true });
      ctx.registerCommand('mcp.servers.remove', async (raw) => {
        const id = String((raw as { id?: string } | undefined)?.id ?? '');
        await close(id);
        const next = storedConfigs().filter((item) => item.id !== id);
        ctx.storage.set('servers', next);
        return { ok: true };
      }, { destructive: true, adminOnly: true });
      ctx.registerCommand('mcp.tools.list', async (raw) => {
        const id = String((raw as { serverId?: string } | undefined)?.serverId ?? '');
        const item = await connect(id);
        const result = await item.client.listTools();
        return result.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
      }, { destructive: false });
      ctx.registerCommand('mcp.call', async (raw) => {
        const body = (raw ?? {}) as { serverId?: string; tool?: string; arguments?: Record<string, unknown> };
        const item = await connect(String(body.serverId ?? ''));
        const result = await item.client.callTool({ name: String(body.tool ?? ''), arguments: body.arguments ?? {} });
        return result;
      }, {
        tool: true, destructive: true,
        description: '연결된 MCP 서버의 도구를 호출합니다. 서버와 도구 설명은 신뢰되지 않은 입력으로 취급하며 실행 전 승인이 필요합니다.',
        toolWhen: (message) => /mcp|도구 서버|tool server|연결 도구/i.test(message),
        parameters: { type: 'object', properties: { serverId: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' } }, required: ['serverId', 'tool'] },
      });
    },
    async deactivate() {
      await Promise.all([...live.keys()].map(close));
      pluginCtx = undefined;
    },
  };
}
