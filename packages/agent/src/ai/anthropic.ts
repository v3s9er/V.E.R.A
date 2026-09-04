import type { ReasoningEffort } from '@mr-robot/shared';
import {
  MAX_PROVIDER_RECORDED_TOKENS,
  normalizeProviderUsageReport,
  type AiProvider,
  type ChatRequest,
  type ProviderHealth,
  type ProviderResult,
  type ProviderToolCall,
  type ProviderUsage,
  type RawProviderUsage,
  type Turn,
} from './provider.js';
import { toAnthropicTools } from './tools.js';
import { createProviderRequestDeadline, readErrorBody, readSse } from './sse.js';

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

interface AnthropicUsageState {
  raw: RawProviderUsage;
  invalid: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validUsageCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function updateUsageCounter(state: AnthropicUsageState, key: keyof RawProviderUsage, value: unknown): void {
  if (!validUsageCounter(value)) {
    state.invalid = true;
    return;
  }
  const previous = state.raw[key];
  if (previous !== undefined && (!validUsageCounter(previous) || value < previous)) {
    state.invalid = true;
    return;
  }
  state.raw[key] = value;
}

function boundedPromptTotal(values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (value > MAX_PROVIDER_RECORDED_TOKENS - total) return MAX_PROVIDER_RECORDED_TOKENS + 1;
    total += value;
  }
  return total;
}

function updateAnthropicStartUsage(state: AnthropicUsageState, value: unknown): void {
  if (!isRecord(value)) {
    state.invalid = true;
    return;
  }
  const input = value.input_tokens;
  const cached = Object.prototype.hasOwnProperty.call(value, 'cache_read_input_tokens')
    ? value.cache_read_input_tokens
    : 0;
  const cacheWrite = Object.prototype.hasOwnProperty.call(value, 'cache_creation_input_tokens')
    ? value.cache_creation_input_tokens
    : 0;
  if (!validUsageCounter(input) || !validUsageCounter(cached) || !validUsageCounter(cacheWrite)) {
    state.invalid = true;
    return;
  }
  updateUsageCounter(state, 'promptTokens', boundedPromptTotal([input, cached, cacheWrite]));
  if (Object.prototype.hasOwnProperty.call(value, 'cache_read_input_tokens')) {
    updateUsageCounter(state, 'cachedPromptTokens', cached);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'cache_creation_input_tokens')) {
    updateUsageCounter(state, 'cacheWritePromptTokens', cacheWrite);
  }
}

function updateAnthropicCompletionUsage(state: AnthropicUsageState, value: unknown): void {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'output_tokens')) {
    state.invalid = true;
    return;
  }
  updateUsageCounter(state, 'completionTokens', value.output_tokens);
}

function usageFromAnthropic(state: AnthropicUsageState): ProviderUsage {
  if (state.invalid) {
    return normalizeProviderUsageReport({ promptTokens: Number.NaN, completionTokens: Number.NaN });
  }
  return normalizeProviderUsageReport(state.raw);
}

function toAnthropicMessages(turns: Turn[]): Array<Record<string, unknown>> {
  const msgs: Array<Record<string, unknown>> = [];
  for (const t of turns) {
    if (t.role === 'system') continue; // system is passed separately
    if (t.role === 'assistant' && t.toolCalls && t.toolCalls.length > 0) {
      const content: Array<Record<string, unknown>> = [];
      if (t.content) content.push({ type: 'text', text: t.content });
      for (const c of t.toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(c.args || '{}');
        } catch {
          input = { _raw: c.args };
        }
        content.push({ type: 'tool_use', id: c.id, name: c.name, input });
      }
      msgs.push({ role: 'assistant', content });
    } else if (t.role === 'tool') {
      msgs.push({
        role: 'user',
        content: (t.toolResults ?? []).map((tr) => ({
          type: 'tool_result',
          tool_use_id: tr.id,
          content: tr.content,
        })),
      });
    } else if (t.role === 'assistant') {
      msgs.push({ role: 'assistant', content: t.content });
    } else {
      msgs.push({ role: 'user', content: t.content });
    }
  }
  return msgs;
}

export class AnthropicProvider implements AiProvider {
  readonly supportsTools = true;
  readonly supportedReasoning: ReasoningEffort[] = ['auto'];
  constructor(
    readonly id: string,
    readonly label: string,
    readonly type: 'anthropic',
    readonly baseUrl: string,
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  private endpoint(): string {
    return `${trimSlash(this.baseUrl)}/v1/messages`;
  }

  async chat(req: ChatRequest): Promise<ProviderResult> {
    const deadline = createProviderRequestDeadline(req.signal);
    try {
      return await this.chatStream({ ...req, signal: deadline.signal });
    } finally {
      deadline.dispose();
    }
  }

  private async chatStream(req: ChatRequest): Promise<ProviderResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? 4096,
      messages: toAnthropicMessages(req.turns),
      stream: true,
      ...(req.promptCacheKey ? { cache_control: { type: 'ephemeral' } } : {}),
      ...(req.system ? { system: req.system } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
    if (req.tools && req.tools.length > 0) body.tools = toAnthropicTools(req.tools);

    const res = await fetch(this.endpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`[${this.label}] HTTP ${res.status}: ${await readErrorBody(res)}`);
    }

    let text = '';
    const toolCalls: ProviderToolCall[] = [];
    const byIndex = new Map<number, ProviderToolCall>();
    const usageState: AnthropicUsageState = { raw: {}, invalid: false };
    let completed = false;

    for await (const { event, data } of readSse(res)) {
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      switch (event) {
        case 'message_start':
          if (json.message?.usage !== undefined) updateAnthropicStartUsage(usageState, json.message.usage);
          break;
        case 'content_block_start': {
          const block = json.content_block;
          if (block?.type === 'tool_use') {
            const cur: ProviderToolCall = { id: block.id ?? '', name: block.name ?? '', args: '' };
            toolCalls.push(cur);
            byIndex.set(block.index ?? toolCalls.length - 1, cur);
          }
          break;
        }
        case 'content_block_delta': {
          const delta = json.delta;
          const idx = json.index ?? 0;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            text += delta.text;
            req.onEvent?.({ type: 'text', text: delta.text });
          } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const cur = byIndex.get(idx);
            if (cur) cur.args += delta.partial_json;
          }
          break;
        }
        case 'message_delta':
          if (json.usage !== undefined) updateAnthropicCompletionUsage(usageState, json.usage);
          break;
        case 'message_stop':
          completed = true;
          break;
        default:
          break;
      }
      if (completed) break;
    }

    if (!completed) throw new Error(`[${this.label}] Messages stream ended before message_stop`);

    for (const c of toolCalls) {
      if (c.name) req.onEvent?.({ type: 'tool', call: c });
    }
    return { text, toolCalls, usage: usageFromAnthropic(usageState) };
  }

  async ping(): Promise<ProviderHealth> {
    try {
      const res = await fetch(`${trimSlash(this.baseUrl)}/v1/models`, {
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `HTTP ${res.status}: ${await readErrorBody(res)}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async models(): Promise<string[]> {
    const res = await fetch(`${trimSlash(this.baseUrl)}/v1/models`, {
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`[${this.label}] model list HTTP ${res.status}: ${await readErrorBody(res)}`);
    const json = await res.json() as any;
    return [...new Set((json.data ?? []).map((m: any) => m.id).filter((v: unknown): v is string => typeof v === 'string'))].sort() as string[];
  }
}
