import type { ChatUsage, ModelReasoningCapabilities, ProviderModelCatalog, ProviderType, ReasoningEffort } from '@mr-robot/shared';

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
  | { type: 'status'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; call: ProviderToolCall };

export interface ChatRequest {
  /** Host-only plain response mode; valid only without broker/native tools. */
  textOnly?: boolean;
  /** Numeric lifecycle metadata, never prompts, credentials or model reasoning. */
  onTiming?: (timing: ProviderTiming) => void;
  /** Host-validated visual evidence for isolated Codex workers, never URLs from model input. */
  evidenceImages?: Array<{ label: string; dataUrl: string }>;
  daybreakEnabled?: boolean;
  system?: string;
  /** Host-provided changing evidence, separate from stable instructions/history. */
  context?: string;
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

export const PROVIDER_TIMING_STAGES = ['queue', 'retirement', 'worker', 'initialized', 'skills', 'thread', 'submitted', 'accepted', 'firstDelta', 'firstText', 'completed', 'failed'] as const;
export interface ProviderTiming {
  transport: 'codex-text' | 'codex-structured' | 'codex-broker' | 'codex-native';
  stage: typeof PROVIDER_TIMING_STAGES[number];
  /** Monotonic milliseconds since entry into this provider call, including queue. */
  elapsedMs: number;
  reused: boolean;
}

/** Host-owned queue: inputs are removed only after the CLI acknowledges them. */
export interface NativeSteeringControl {
  peek(): string[];
  commit(inputs: readonly string[]): boolean;
  subscribe(listener: () => void): () => void;
}

export interface NativeAgentRequest {
  /** Host-owned metadata callback; never accepts provider text or arguments. */
  onTiming?: (timing: ProviderTiming) => void;
  daybreakEnabled?: boolean;
  /** Host-only capability, never deserialized from remote requests. */
  hostTools?: NativeHostTools;
  /** Legacy request shape only. The single-agent runtime rejects opt-in before launch. */
  nativeDelegation?: { maxAgents?: number };
  prompt: string;
  /** Host-only conversation identity and verified transcript, never a client CLI thread id. */
  session?: { key: string; directory: string; history: Turn[]; input: string; instructions: string; context: string };
  cwd: string;
  permissionMode: 'read-only' | 'ask' | 'workspace' | 'full';
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  onStatus?: (status: string) => void;
  onText?: (text: string) => void;
  onTool?: (event: NativeToolEvent) => void;
  steering?: NativeSteeringControl;
  onSteeringApplied?: (inputs: readonly string[]) => void;
}

/** Public lifecycle metadata only: no command arguments, outputs, or reasoning. */
export interface NativeToolEvent {
  name: string;
  callId: string;
  input: Record<string, never>;
  status: 'start' | 'done' | 'error';
  elapsedMs?: number;
  /** Corrects a prior return-only completion; not a second terminal effect. */
  terminalCorrection?: true;
}

export interface NativeToolResult {
  success: boolean;
  contentItems: Array<{ type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }>;
}
export interface NativeHostTools {
  tools: NeutralTool[];
  /** Host-owned per-tool gate. Legacy desktop capabilities default to full only. */
  authorize?(name: string, mode: NativeAgentRequest['permissionMode']): boolean;
  /** Host-owned deadlines; never set by model arguments. */
  timeoutMs?(name: string): number;
  execute(name: string, input: unknown, signal: AbortSignal): Promise<NativeToolResult>;
  dispose(): void;
}

/** Host-owned capability executor. Never constructed from client/model JSON. */
export interface BrokerAgentRequest extends ChatRequest {
  executeTool(name: string, input: unknown, signal: AbortSignal): Promise<string>;
}

export interface AiProvider {
  /** Native model loop with ONLY host-registered tools, no native environment. */
  runBrokerAgent?(req: BrokerAgentRequest): Promise<ProviderResult>;
  /** Optional subscription text worker with native tools/environment removed. */
  chatIsolated?(req: ChatRequest): Promise<ProviderResult>;
  readonly id: string;
  readonly label: string;
  readonly type: ProviderType;
  readonly baseUrl: string;
  readonly model: string;
  readonly supportedReasoning: ReasoningEffort[];
  readonly modelCapabilities?: Record<string, ModelReasoningCapabilities>;
  readonly supportsTools: boolean;
  chat(req: ChatRequest): Promise<ProviderResult>;
  /** Cheap authenticated reachability check. */
  ping(): Promise<ProviderHealth>;
  /** List model ids exposed by this account/provider when supported. */
  models(force?: boolean): Promise<string[]>;
  modelCatalog?(force?: boolean): Promise<ProviderModelCatalog>;
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
