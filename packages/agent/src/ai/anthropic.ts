import type { ReasoningEffort } from '@mr-robot/shared';
import type { AiProvider, ChatRequest, ProviderHealth, ProviderResult, ProviderToolCall, Turn } from './provider.js';
import { toAnthropicTools } from './tools.js';
import { readErrorBody, readSse } from './sse.js';

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
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
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? 4096,
      messages: toAnthropicMessages(req.turns),
      stream: true,
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
    let usage = { promptTokens: 0, completionTokens: 0 };

    for await (const { event, data } of readSse(res)) {
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      switch (event) {
        case 'message_start':
          if (json.message?.usage) usage.promptTokens = json.message.usage.input_tokens ?? 0;
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
          if (json.usage) usage.completionTokens = json.usage.output_tokens ?? 0;
          break;
        default:
          break;
      }
    }

    for (const c of toolCalls) {
      if (c.name) req.onEvent?.({ type: 'tool', call: c });
    }
    return { text, toolCalls, usage };
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
