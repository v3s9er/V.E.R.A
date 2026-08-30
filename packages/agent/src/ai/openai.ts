import type { ProviderType, ReasoningEffort } from '@mr-robot/shared';
import type { AiProvider, ChatRequest, ProviderHealth, ProviderResult, ProviderToolCall, ProviderUsage, Turn } from './provider.js';
import { toOpenAiTools } from './tools.js';
import { readErrorBody, readSse } from './sse.js';

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

function usageFromOpenAi(value: any, current: ProviderUsage = { promptTokens: 0, completionTokens: 0 }): ProviderUsage {
  const input = value?.prompt_tokens ?? value?.input_tokens ?? current.promptTokens;
  const output = value?.completion_tokens ?? value?.output_tokens ?? current.completionTokens;
  const cached = value?.prompt_tokens_details?.cached_tokens
    ?? value?.input_tokens_details?.cached_tokens
    ?? current.cachedPromptTokens;
  const reasoning = value?.completion_tokens_details?.reasoning_tokens
    ?? value?.output_tokens_details?.reasoning_tokens
    ?? current.reasoningTokens;
  return {
    promptTokens: typeof input === 'number' ? input : 0,
    completionTokens: typeof output === 'number' ? output : 0,
    ...(typeof cached === 'number' ? { cachedPromptTokens: cached } : {}),
    ...(typeof reasoning === 'number' ? { reasoningTokens: reasoning } : {}),
  };
}

function cacheKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 64) || undefined;
}

function toOpenAiMessages(turns: Turn[], system?: string): Array<Record<string, unknown>> {
  const msgs: Array<Record<string, unknown>> = [];
  if (system) msgs.push({ role: 'system', content: system });
  for (const t of turns) {
    if (t.role === 'assistant' && t.toolCalls && t.toolCalls.length > 0) {
      msgs.push({
        role: 'assistant',
        content: t.content || null,
        tool_calls: t.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.args },
        })),
      });
    } else if (t.role === 'tool') {
      for (const tr of t.toolResults ?? []) {
        msgs.push({ role: 'tool', tool_call_id: tr.id, content: tr.content });
      }
    } else {
      msgs.push({ role: t.role, content: t.content });
    }
  }
  return msgs;
}

function toResponsesInput(turns: Turn[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const turn of turns) {
    if (turn.role === 'assistant' && turn.toolCalls?.length) {
      if (turn.content) input.push({ role: 'assistant', content: turn.content });
      for (const call of turn.toolCalls) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.args });
    } else if (turn.role === 'tool') {
      for (const result of turn.toolResults ?? []) input.push({ type: 'function_call_output', call_id: result.id, output: result.content });
    } else if (turn.role !== 'system') {
      input.push({ role: turn.role, content: turn.content });
    }
  }
  return input;
}

/**
 * Covers OpenAI, Groq, OpenRouter, Mistral, xAI, DeepSeek, Together, LM Studio,
 * local gateways, and Ollama's OpenAI-compatible endpoint. Any base URL + key
 * that speaks `/chat/completions` works — this is the "plug in any key" path.
 */
export class OpenAICompatibleProvider implements AiProvider {
  readonly supportsTools = true;
  readonly supportedReasoning: ReasoningEffort[] = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];
  constructor(
    readonly id: string,
    readonly label: string,
    readonly type: ProviderType,
    readonly baseUrl: string,
    readonly model: string,
    private readonly apiKey: string,
    private readonly extraHeaders: Record<string, string> = {},
  ) {}

  private normalizedBase(): string {
    let base = trimSlash(this.baseUrl).replace(/\/(chat\/completions|responses)$/i, '');
    if (this.type === 'ollama') base = base.replace(/\/v1$/i, '');
    return base;
  }

  private endpoint(): string {
    const base = this.normalizedBase();
    // Tolerate users pasting the FULL endpoint URL into the base URL field.
    if (/\/chat\/completions$/i.test(base)) return base;
    return this.type === 'ollama' ? `${base}/v1/chat/completions` : `${base}/chat/completions`;
  }

  private usesResponsesApi(): boolean {
    try {
      return new URL(this.baseUrl).hostname.toLowerCase() === 'api.openai.com';
    } catch {
      return false;
    }
  }

  private responsesEndpoint(): string {
    const base = trimSlash(this.baseUrl);
    return /\/responses$/i.test(base) ? base : `${base}/responses`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...this.extraHeaders };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async chat(req: ChatRequest): Promise<ProviderResult> {
    if (this.usesResponsesApi()) return this.chatResponses(req);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAiMessages(req.turns, req.system),
      stream: true,
      stream_options: { include_usage: true },
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.reasoningEffort && req.reasoningEffort !== 'auto' ? { reasoning_effort: req.reasoningEffort } : {}),
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = toOpenAiTools(req.tools);
      body.tool_choice = 'auto';
    }

    const res = await fetch(this.endpoint(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`[${this.label}] HTTP ${res.status}: ${await readErrorBody(res)}`);
    }

    let text = '';
    const byIndex = new Map<number, ProviderToolCall>();
    let usage: ProviderUsage = { promptTokens: 0, completionTokens: 0 };
    let sawDone = false;

    for await (const { data } of readSse(res)) {
      if (data === '[DONE]') {
        sawDone = true;
        break;
      }
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) throw new Error(`[${this.label}] ${json.error.message ?? JSON.stringify(json.error)}`);
      const choice = json.choices?.[0];
      if (choice) {
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          text += delta.content;
          req.onEvent?.({ type: 'text', text: delta.content });
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          let cur = byIndex.get(idx);
          if (!cur) {
            cur = { id: '', name: '', args: '' };
            byIndex.set(idx, cur);
          }
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
        }
      }
      if (json.usage) {
        usage = usageFromOpenAi(json.usage, usage);
      }
    }

    if (!sawDone) {
      throw new Error(`[${this.label}] Chat Completions stream ended before [DONE]`);
    }

    const toolCalls: ProviderToolCall[] = [];
    for (const c of byIndex.values()) {
      if (c.name || c.args) {
        toolCalls.push(c);
        req.onEvent?.({ type: 'tool', call: c });
      }
    }
    return { text, toolCalls, usage };
  }

  private async chatResponses(req: ChatRequest): Promise<ProviderResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: toResponsesInput(req.turns),
      stream: true,
      store: false,
      parallel_tool_calls: true,
      ...(req.system ? { instructions: req.system } : {}),
      ...(req.maxTokens !== undefined ? { max_output_tokens: req.maxTokens } : {}),
      ...(req.reasoningEffort && req.reasoningEffort !== 'auto' ? { reasoning: { effort: req.reasoningEffort } } : {}),
      ...(cacheKey(req.promptCacheKey) ? { prompt_cache_key: cacheKey(req.promptCacheKey) } : {}),
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters }));
      body.tool_choice = 'auto';
    }
    const res = await fetch(this.responsesEndpoint(), {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: req.signal,
    });
    if (!res.ok || !res.body) throw new Error(`[${this.label}] HTTP ${res.status}: ${await readErrorBody(res)}`);

    let text = '';
    let refusalText = '';
    let sawRefusal = false;
    let completed = false;
    let usage: ProviderUsage = { promptTokens: 0, completionTokens: 0 };
    const calls = new Map<number, ProviderToolCall>();
    const emitted = new Set<string>();
    const emitCall = (call: ProviderToolCall): void => {
      const key = call.id || `${call.name}:${call.args}`;
      if (emitted.has(key)) return;
      emitted.add(key);
      req.onEvent?.({ type: 'tool', call: { ...call } });
    };
    const setFinalRefusal = (value: unknown): void => {
      sawRefusal = true;
      if (typeof value !== 'string' || value.length === 0) return;
      if (value.startsWith(refusalText)) {
        const suffix = value.slice(refusalText.length);
        if (suffix) req.onEvent?.({ type: 'text', text: suffix });
      } else if (!refusalText) {
        req.onEvent?.({ type: 'text', text: value });
      }
      refusalText = value;
    };

    for await (const { data } of readSse(res)) {
      if (data === '[DONE]') continue;
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.type === 'response.failed') {
        const detail = event.response?.error?.message
          ?? event.response?.error?.code
          ?? event.error?.message
          ?? event.message
          ?? 'unknown response failure';
        throw new Error(`[${this.label}] Responses stream failed: ${detail}`);
      }
      if (event.type === 'response.incomplete') {
        const reason = event.response?.incomplete_details?.reason
          ?? event.response?.status
          ?? 'unknown reason';
        throw new Error(`[${this.label}] Responses stream incomplete: ${reason}`);
      }
      if (event.type === 'error' || event.error) {
        const detail = event.error?.message ?? event.message ?? JSON.stringify(event.error ?? event);
        throw new Error(`[${this.label}] ${detail}`);
      }
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        text += event.delta;
        req.onEvent?.({ type: 'text', text: event.delta });
      }
      if (event.type === 'response.refusal.delta') {
        sawRefusal = true;
        if (typeof event.delta === 'string' && event.delta.length > 0) {
          refusalText += event.delta;
          req.onEvent?.({ type: 'text', text: event.delta });
        }
      }
      if (event.type === 'response.refusal.done') setFinalRefusal(event.refusal);

      const index = Number.isInteger(event.output_index) ? Number(event.output_index) : 0;
      const item = event.item;
      if ((event.type === 'response.output_item.added' || event.type === 'response.output_item.done') && item?.type === 'function_call') {
        const call = calls.get(index) ?? { id: '', name: '', args: '' };
        if (item.call_id || item.id) call.id = String(item.call_id ?? item.id);
        if (item.name) call.name = String(item.name);
        if (typeof item.arguments === 'string') call.args = item.arguments;
        calls.set(index, call);
      }
      if (event.type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
        const call = calls.get(index) ?? { id: String(event.call_id ?? event.item_id ?? ''), name: '', args: '' };
        call.args += event.delta;
        calls.set(index, call);
      }
      if (event.type === 'response.function_call_arguments.done') {
        const call = calls.get(index) ?? { id: String(event.call_id ?? event.item_id ?? ''), name: '', args: '' };
        if (typeof event.name === 'string') call.name = event.name;
        if (typeof event.arguments === 'string') call.args = event.arguments;
        calls.set(index, call);
      }
      if (event.type === 'response.completed') {
        if (event.response?.status && event.response.status !== 'completed') {
          throw new Error(`[${this.label}] Responses stream ended with unexpected status: ${event.response.status}`);
        }
        completed = true;
        usage = usageFromOpenAi(event.response?.usage, usage);
        if (!text) {
          for (const output of event.response?.output ?? []) {
            if (output.type !== 'message') continue;
            for (const content of output.content ?? []) {
              if ((content.type === 'output_text' || content.type === 'text') && typeof content.text === 'string') text += content.text;
              if (content.type === 'refusal') setFinalRefusal(content.refusal);
            }
          }
          if (text) req.onEvent?.({ type: 'text', text });
        }
      }
      if (event.usage) usage = usageFromOpenAi(event.usage, usage);
      if (completed) break;
    }

    if (!completed) {
      throw new Error(`[${this.label}] Responses stream ended before response.completed`);
    }
    if (!text && sawRefusal) {
      if (!refusalText) throw new Error(`[${this.label}] Model refused the request without an explanation`);
      text = refusalText;
    }

    const toolCalls = [...calls.values()].filter((call) => call.name || call.args);
    for (const call of toolCalls) emitCall(call);
    return { text, toolCalls, usage };
  }

  async ping(): Promise<ProviderHealth> {
    try {
      const base = this.normalizedBase();
      const url = this.type === 'ollama' ? `${base}/api/tags` : `${base}/models`;
      const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(4000) });
      if (res.ok) return { ok: true };
      return { ok: false, error: `HTTP ${res.status}: ${await readErrorBody(res)}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async models(): Promise<string[]> {
    const base = this.normalizedBase();
    const url = this.type === 'ollama' ? `${base}/api/tags` : `${base}/models`;
    const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`[${this.label}] model list HTTP ${res.status}: ${await readErrorBody(res)}`);
    const json = await res.json() as any;
    const values: unknown[] = this.type === 'ollama' ? (json.models ?? []).map((m: any) => m.name ?? m.model) : (json.data ?? []).map((m: any) => m.id);
    const strings = values.filter((v: unknown): v is string => typeof v === 'string' && v.length > 0);
    return [...new Set<string>(strings)].sort();
  }
}
