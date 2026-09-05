import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface RoutingTrace {
  id: string;
  at: number;
  conversationId?: string;
  providerId?: string;
  providerLabel?: string;
  model?: string;
  role?: string;
  effort?: string;
  promptTokens: number;
  completionTokens: number;
  /** Host-accounted tokens after conservative reservation floors. */
  accountedTokens?: number;
  cachedPromptTokens?: number;
  cacheWritePromptTokens?: number;
  reasoningTokens?: number;
  toolCalls: number;
  latencyMs: number;
  estimatedCost: number;
  ok: boolean;
  error?: string;
}

export class TelemetryStore {
  private readonly file: string;
  constructor(home: string) { this.file = join(home, 'routing-traces.jsonl'); }

  record(trace: RoutingTrace): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(trace)}\n`, 'utf8');
    const entries = this.list(1200);
    if (entries.length >= 1200) writeFileSync(this.file, `${entries.slice(0, 1000).reverse().map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  }

  list(limit = 100): RoutingTrace[] {
    if (!existsSync(this.file)) return [];
    try {
      return readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).reverse().map((line) => JSON.parse(line) as RoutingTrace);
    } catch { return []; }
  }

  summary(): { turns: number; promptTokens: number; completionTokens: number; accountedTokens: number; cachedPromptTokens: number; cacheWritePromptTokens: number; reasoningTokens: number; cacheHitRate: number; toolCalls: number; estimatedCost: number; failures: number; byModel: Array<{ model: string; turns: number }> } {
    const entries = this.list(1000);
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.model ?? '알 수 없음', (counts.get(entry.model ?? '알 수 없음') ?? 0) + 1);
    const promptTokens = entries.reduce((sum, item) => sum + item.promptTokens, 0);
    const cachedPromptTokens = entries.reduce((sum, item) => sum + (item.cachedPromptTokens ?? 0), 0);
    return {
      turns: entries.length,
      promptTokens,
      completionTokens: entries.reduce((sum, item) => sum + item.completionTokens, 0),
      accountedTokens: entries.reduce((sum, item) => sum + (item.accountedTokens ?? item.promptTokens + item.completionTokens), 0),
      cachedPromptTokens,
      cacheWritePromptTokens: entries.reduce((sum, item) => sum + (item.cacheWritePromptTokens ?? 0), 0),
      reasoningTokens: entries.reduce((sum, item) => sum + (item.reasoningTokens ?? 0), 0),
      cacheHitRate: promptTokens > 0 ? cachedPromptTokens / promptTokens : 0,
      toolCalls: entries.reduce((sum, item) => sum + item.toolCalls, 0),
      estimatedCost: entries.reduce((sum, item) => sum + item.estimatedCost, 0),
      failures: entries.filter((item) => !item.ok).length,
      byModel: [...counts.entries()].map(([model, turns]) => ({ model, turns })).sort((a, b) => b.turns - a.turns),
    };
  }
}
