import type { ProviderType, ReasoningEffort } from '@mr-robot/shared';
import type { AiProvider, ChatRequest, ProviderHealth, ProviderResult, ProviderToolCall, Turn } from './provider.js';
import { toOpenAiTools } from './tools.js';
import { readErrorBody, readSse } from './sse.js';

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
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
    let usage = { promptTokens: 0, completionTokens: 0 };

    for await (const { data } of readSse(res)) {
      if (data === '[DONE]') continue;
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
        usage = {
          promptTokens: json.usage.prompt_tokens ?? usage.promptTokens,
          completionTokens: json.usage.completion_tokens ?? usage.completionTokens,
        };
      }
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
      ...(req.system ? { instructions: req.system } : {}),
      ...(req.maxTokens !== undefined ? { max_output_tokens: req.maxTokens } : {}),
      ...(req.reasoningEffort && req.reasoningEffort !== 'auto' ? { reasoning: { effort: req.reasoningEffort } } : {}),
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters }));
      body.tool_choice = 'auto';
    }
    const res = await fetch(this.responsesEndpoint(), {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: req.signal,
    });
    if (!res.ok) throw new Error(`[${this.label}] HTTP ${res.status}: ${await readErrorBody(res)}`);
    const json = await res.json() as any;
    const toolCalls: ProviderToolCall[] = [];
    let text = typeof json.output_text === 'string' ? json.output_text : '';
    for (const item of json.output ?? []) {
      if (item.type === 'function_call') toolCalls.push({ id: item.call_id ?? item.id ?? '', name: item.name ?? '', args: item.arguments ?? '{}' });
      if (!text && item.type === 'message') {
        for (const content of item.content ?? []) if ((content.type === 'output_text' || content.type === 'text') && typeof content.text === 'string') text += content.text;
      }
    }
    if (text) req.onEvent?.({ type: 'text', text });
    for (const call of toolCalls) req.onEvent?.({ type: 'tool', call });
    return {
      text,
      toolCalls,
      usage: { promptTokens: json.usage?.input_tokens ?? 0, completionTokens: json.usage?.output_tokens ?? 0 },
    };
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
