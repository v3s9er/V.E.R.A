import type { ChatUsage, ProviderType, ReasoningEffort } from '@mr-robot/shared';

/** Provider-agnostic conversation turn. Each provider maps this to its wire format. */
export interface Turn {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant: tool calls the model requested */
  toolCalls?: ProviderToolCall[];
  /** tool: results keyed by tool call id */
  toolResults?: { id: string; name: string; content: string }[];
}

export interface ProviderToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments string (as emitted by the model). */
  args: string;
}

export interface NeutralTool {
  name: string;
  description: string;
  /** JSON-schema object for the tool's parameters. */
  parameters: Record<string, unknown>;
}

export interface ProviderResult {
  text: string;
  toolCalls: ProviderToolCall[];
  usage: ChatUsage;
}

export interface ProviderHealth {
  ok: boolean;
  error?: string;
}

export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; call: ProviderToolCall };

export interface ChatRequest {
  system?: string;
  turns: Turn[];
  tools?: NeutralTool[];
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  /** Stream deltas (text and finalized tool calls) as they arrive. */
  onEvent?: (e: ProviderEvent) => void;
}

export interface NativeAgentRequest {
  prompt: string;
  cwd: string;
  permissionMode: 'read-only' | 'ask' | 'workspace' | 'full';
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  onStatus?: (status: string) => void;
}

export interface AiProvider {
  readonly id: string;
  readonly label: string;
  readonly type: ProviderType;
  readonly baseUrl: string;
  readonly model: string;
  readonly supportedReasoning: ReasoningEffort[];
  readonly supportsTools: boolean;
  chat(req: ChatRequest): Promise<ProviderResult>;
  /** Cheap authenticated reachability check. */
  ping(): Promise<ProviderHealth>;
  /** List model ids exposed by this account/provider when supported. */
  models(): Promise<string[]>;
  /** Optional native coding-agent execution (Codex/Claude CLI keeps its own tools and harness). */
  runAgent?(req: NativeAgentRequest): Promise<ProviderResult>;
}

export function parseToolArgs(raw: string): unknown {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { _raw: raw };
  }
}
