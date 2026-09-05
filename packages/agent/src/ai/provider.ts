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
  usage: ProviderUsage;
}

/** Provider-native usage details that do not require widening the public RPC protocol. */
export interface ProviderUsage extends ChatUsage {
  cachedPromptTokens?: number;
  cacheWritePromptTokens?: number;
  reasoningTokens?: number;
  /** Internal trust signal for admission/audit code; never supplied by callers. */
  reportStatus?: 'reported' | 'missing' | 'invalid' | 'capped';
}

export const MAX_PROVIDER_RECORDED_TOKENS = 1_000_000_000_000;

export interface RawProviderUsage {
  promptTokens?: unknown;
  completionTokens?: unknown;
  cachedPromptTokens?: unknown;
  cacheWritePromptTokens?: unknown;
  reasoningTokens?: unknown;
}

/**
 * Provider metering is untrusted input. Validate the report atomically so one
 * plausible field cannot hide a negative/NaN/otherwise malformed companion.
 * Missing or invalid reports normalize to zero; adaptive admission therefore
 * retains its conservative pre-call reservation instead of treating them as
 * free. Very large finite counters saturate at the persistence-safe ceiling.
 */
export function normalizeProviderUsageReport(raw: RawProviderUsage): ProviderUsage {
  const requiredMissing = raw.promptTokens === undefined || raw.completionTokens === undefined;
  const supplied = [
    raw.promptTokens,
    raw.completionTokens,
    raw.cachedPromptTokens,
    raw.cacheWritePromptTokens,
    raw.reasoningTokens,
  ].filter((value) => value !== undefined);
  const invalid = supplied.some((value) => (
    typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0
  ));
  if (requiredMissing || invalid) {
    return {
      promptTokens: 0,
      completionTokens: 0,
      reportStatus: invalid ? 'invalid' : 'missing',
    };
  }
  const capped = supplied.some((value) => Number(value) > MAX_PROVIDER_RECORDED_TOKENS);
  const token = (value: unknown): number => Math.min(MAX_PROVIDER_RECORDED_TOKENS, Number(value));
  return {
    promptTokens: token(raw.promptTokens),
    completionTokens: token(raw.completionTokens),
    ...(raw.cachedPromptTokens !== undefined ? { cachedPromptTokens: token(raw.cachedPromptTokens) } : {}),
    ...(raw.cacheWritePromptTokens !== undefined ? { cacheWritePromptTokens: token(raw.cacheWritePromptTokens) } : {}),
    ...(raw.reasoningTokens !== undefined ? { reasoningTokens: token(raw.reasoningTokens) } : {}),
    reportStatus: capped ? 'capped' : 'reported',
  };
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
  /** Stable, non-secret prefix used by providers to reuse cached prompt prefixes. */
  promptCacheKey?: string;
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
