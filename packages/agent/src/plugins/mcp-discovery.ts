import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

type ToolPage = Awaited<ReturnType<Client['listTools']>>;
type Tool = ToolPage['tools'][number];
interface CachedPage { serverId: string; page: ToolPage; expiresAt: number; chars: number }
interface Position { serverId: string; cursor?: string; offset: number }
export interface McpDiscoveryRequest { cursor?: string; limit?: number; tool?: string }
const MAX_CACHE_CHARS = 2_000_000;
const MAX_PAGE_CHARS = 1_000_000;
const MAX_SCHEMA_CHARS = 24_000;

function decodePosition(serverId: string, cursor?: string): Position {
  if (cursor === undefined) return { serverId, offset: 0 };
  try {
    if (typeof cursor !== 'string' || cursor.length > 8_000) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Position;
    if (value.serverId !== serverId || !Number.isInteger(value.offset) || value.offset < 0 ||
        (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 4_000))) throw new Error();
    return value;
  } catch {
    throw new Error('MCP discovery cursor가 올바르지 않습니다. 첫 페이지부터 다시 조회하세요.');
  }
}

const encodePosition = (position: Position): string => Buffer.from(JSON.stringify(position)).toString('base64url');
const summary = (tool: Tool) => ({ name: tool.name, description: tool.description?.slice(0, 240) });

/** Schemas stay out of the model prompt until one exact tool is requested. */
export class McpDiscovery {
  private readonly pages = new Map<string, CachedPage>();
  constructor(private readonly now: () => number = Date.now) {}

  clear(serverId?: string): void {
    for (const [key, entry] of this.pages) if (!serverId || entry.serverId === serverId) this.pages.delete(key);
  }

  async discover(serverId: string, request: McpDiscoveryRequest, list: (cursor?: string) => Promise<ToolPage>) {
    const position = decodePosition(serverId, request.cursor);
    const limit = request.limit ?? 12;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('MCP discovery limit은 1~20 사이의 정수여야 합니다.');
    if (request.tool !== undefined && (typeof request.tool !== 'string' || !request.tool || request.tool.length > 200)) {
      throw new Error('정확한 MCP 도구 이름을 입력하세요.');
    }
    for (const [key, entry] of this.pages) if (entry.expiresAt <= this.now()) this.pages.delete(key);
    const key = JSON.stringify([serverId, position.cursor ?? null]);
    let page = this.pages.get(key)?.page;
    if (!page) {
      page = await list(position.cursor);
      const chars = JSON.stringify(page).length;
      if (chars > MAX_PAGE_CHARS || page.tools.length > 2_000) throw new Error('MCP 도구 페이지가 너무 큽니다. 서버의 tools/list 페이지 크기를 줄이세요.');
      if (page.tools.some((tool) => !tool.name || tool.name.length > 200)) throw new Error('MCP 서버가 유효하지 않은 도구 이름을 반환했습니다.');
      if (page.nextCursor !== undefined && (page.nextCursor.length > 4_000 || page.nextCursor === position.cursor)) {
        throw new Error('MCP 서버가 유효하지 않은 다음 페이지 cursor를 반환했습니다.');
      }
      let used = [...this.pages.values()].reduce((sum, entry) => sum + entry.chars, 0);
      for (const [oldKey, entry] of this.pages) {
        if (used + chars <= MAX_CACHE_CHARS && this.pages.size < 32) break;
        this.pages.delete(oldKey);
        used -= entry.chars;
      }
      this.pages.set(key, { serverId, page, chars, expiresAt: this.now() + 60_000 });
    }
    if (position.offset > page.tools.length) throw new Error('MCP 도구 목록이 변경되었습니다. 첫 페이지부터 다시 조회하세요.');
    if (request.tool) {
      const tool = page.tools.find((candidate) => candidate.name === request.tool);
      if (tool) {
        const selected = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
        if (JSON.stringify(selected).length > MAX_SCHEMA_CHARS) throw new Error('MCP 도구 schema가 24000자를 초과합니다. 서버에서 schema를 간소화하세요.');
        return { serverId, tool: selected };
      }
      return { serverId, tool: null, nextCursor: page.nextCursor === undefined ? undefined : encodePosition({ serverId, cursor: page.nextCursor, offset: 0 }) };
    }
    const end = Math.min(position.offset + limit, page.tools.length);
    const next = end < page.tools.length
      ? { serverId, cursor: position.cursor, offset: end }
      : page.nextCursor === undefined ? undefined : { serverId, cursor: page.nextCursor, offset: 0 };
    return {
      serverId, tools: page.tools.slice(position.offset, end).map(summary),
      nextCursor: next ? encodePosition(next) : undefined,
      schemaHint: '정확한 tool 이름과 이 페이지의 cursor로 mcp.discover를 호출하면 해당 inputSchema만 반환합니다.',
    };
  }
}
