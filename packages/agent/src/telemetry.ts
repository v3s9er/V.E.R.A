import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteUtf8 } from './config.js';
import { PROVIDER_TIMING_STAGES, type ProviderTiming } from './ai/provider.js';

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
  /** Sum of observed tool durations, not wall time (tools may overlap). */
  toolElapsedMs?: number;
  latencyMs: number;
  /** First visible answer delta. Undefined means unobserved, never zero. */
  firstTextMs?: number;
  /** Allowlisted numeric transport milestones only, including failed runs. */
  transport?: Array<ProviderTiming & { atMs: number }>;
  cancelled?: boolean;
  estimatedCost: number;
  ok: boolean;
  error?: string;
  /** Per-worker counters are already included in aggregate usage above. */
  agents?: import('@mr-robot/shared').CoordinationAgent[];
  /** Counts only; never persist private fact/provenance bodies in traces. */
  knowledge?: import('@mr-robot/shared').KnowledgeMetrics;
}

export class TelemetryStore {
  private readonly file: string;
  private entries: RoutingTrace[] = [];
  private stamp?: string;
  private cachedSummary?: ReturnType<TelemetryStore['computeSummary']>;
  constructor(home: string) { this.file = join(home, 'routing-traces.jsonl'); }

  record(trace: RoutingTrace): void {
    const entry = normalizeTrace(trace);
    if (!entry) throw new Error('실행 측정값이 올바르지 않습니다.');
    this.refresh();
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.entries.push(entry);
    this.cachedSummary = undefined;
    this.stamp = this.fileStamp();
    if (this.entries.length >= 1200) {
      const retained = this.entries.slice(-1000);
      atomicWriteUtf8(this.file, `${retained.map(item => JSON.stringify(item)).join('\n')}\n`);
      this.entries = retained;
      this.stamp = this.fileStamp();
    }
  }

  list(limit = 100): RoutingTrace[] {
    this.refresh();
    const count = Number.isFinite(limit) ? Math.max(0, Math.min(1200, Math.floor(limit))) : 100;
    return count ? structuredClone(this.entries.slice(-count).reverse()) : [];
  }

  private fileStamp(): string {
    try { const info = statSync(this.file); return `${info.size}:${info.mtimeMs}:${info.ctimeMs}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
  }

  /** Read only when another writer or process restart changes the file. */
  private refresh(): void {
    const stamp = this.fileStamp();
    if (stamp === this.stamp) return;
    let entries: RoutingTrace[] = [];
    if (stamp !== 'missing') {
      const descriptor = openSync(this.file, 'r');
      try {
        const size = statSync(this.file).size;
        const start = Math.max(0, size - 8 * 1024 * 1024);
        const bytes = Buffer.alloc(Math.min(size, 8 * 1024 * 1024));
        let offset = 0;
        while (offset < bytes.length) {
          const read = readSync(descriptor, bytes, offset, bytes.length - offset, start + offset);
          if (!read) break;
          offset += read;
        }
        const lines = bytes.subarray(0, offset).toString('utf8').split('\n');
        if (start) lines.shift(); // possible partial UTF-8/JSON line
        entries = lines.slice(-1500).flatMap(line => {
          if (!line || Buffer.byteLength(line) > 64 * 1024) return [];
          try { const entry = normalizeTrace(JSON.parse(line)); return entry ? [entry] : []; }
          catch { return []; } // one damaged row does not hide every measurement
        }).slice(-1200);
      } finally { closeSync(descriptor); }
    }
    this.entries = entries;
    this.stamp = stamp;
    this.cachedSummary = undefined;
  }

  summary(): ReturnType<TelemetryStore['computeSummary']> {
    this.refresh();
    this.cachedSummary ??= this.computeSummary();
    return structuredClone(this.cachedSummary);
  }

  private computeSummary() {
    const entries = this.entries.slice(-1000);
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
      cacheHitRate: promptTokens > 0 ? Math.min(1, cachedPromptTokens / promptTokens) : 0,
      toolCalls: entries.reduce((sum, item) => sum + item.toolCalls, 0),
      estimatedCost: entries.reduce((sum, item) => sum + item.estimatedCost, 0),
      failures: entries.filter((item) => !item.ok).length,
      performance: performanceSummary(entries),
      byModel: [...counts.entries()].map(([model, turns]) => ({ model, turns })).sort((a, b) => b.turns - a.turns),
    };
  }
}

const validNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e15;
function normalizeTrace(input: unknown): RoutingTrace | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const row = input as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.ok !== 'boolean') return undefined;
  for (const key of ['at', 'promptTokens', 'completionTokens', 'toolCalls', 'latencyMs', 'estimatedCost']) if (!validNumber(row[key])) return undefined;
  const trace: RoutingTrace = { id: row.id.slice(0, 128), at: Number(row.at), promptTokens: Number(row.promptTokens), completionTokens: Number(row.completionTokens), toolCalls: Number(row.toolCalls), latencyMs: Number(row.latencyMs), estimatedCost: Number(row.estimatedCost), ok: row.ok };
  for (const key of ['conversationId', 'providerId', 'providerLabel', 'model', 'role', 'effort', 'error'] as const) if (typeof row[key] === 'string') trace[key] = row[key].slice(0, key === 'error' ? 500 : 256);
  for (const key of ['accountedTokens', 'cachedPromptTokens', 'cacheWritePromptTokens', 'reasoningTokens', 'firstTextMs', 'toolElapsedMs'] as const) if (validNumber(row[key])) trace[key] = row[key];
  if (row.cancelled === true) trace.cancelled = true;
  if (Array.isArray(row.transport)) trace.transport = row.transport.slice(0, 128).flatMap(t => {
    if (!t || !['codex-text', 'codex-structured', 'codex-broker'].includes(t.transport)
      || !PROVIDER_TIMING_STAGES.includes(t.stage) || !validNumber(t.elapsedMs) || !validNumber(t.atMs) || typeof t.reused !== 'boolean') return [];
    return [{ transport: t.transport, stage: t.stage, elapsedMs: t.elapsedMs, atMs: t.atMs, reused: t.reused }];
  });
  if (row.knowledge && typeof row.knowledge === 'object') {
    const k = row.knowledge as Record<string, unknown>;
    if (['asserted','inferred','conflicts','contextBytes','retrievalMs'].every(key => validNumber(k[key])) && typeof k.truncated === 'boolean')
      trace.knowledge = { asserted: Number(k.asserted), inferred: Number(k.inferred), conflicts: Number(k.conflicts), contextBytes: Number(k.contextBytes), retrievalMs: Number(k.retrievalMs), truncated: k.truncated };
  }
  if (Array.isArray(row.agents)) trace.agents = row.agents.slice(0, 6).flatMap(agent => {
    if (!agent || typeof agent !== 'object' || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(agent.state)
      || !validNumber(agent.usage?.promptTokens) || !validNumber(agent.usage?.completionTokens)) return [];
    return [{ agentId: String(agent.agentId ?? '').slice(0, 128), label: String(agent.label ?? '').slice(0, 80), model: String(agent.model ?? '').slice(0, 256), providerId: String(agent.providerId ?? '').slice(0, 128), state: agent.state,
      sequence: validNumber(agent.sequence) ? agent.sequence : 0, turns: validNumber(agent.turns) ? agent.turns : 0, status: String(agent.status ?? '').slice(0, 200),
      usage: { promptTokens: agent.usage.promptTokens, completionTokens: agent.usage.completionTokens } }];
  });
  return trace;
}

function distribution(values: number[]) {
  const sorted = values.filter(validNumber).sort((a, b) => a - b);
  const at = (fraction: number): number | null => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]! : null;
  return { samples: sorted.length, p50: at(.5), p95: at(.95) };
}
function performanceSummary(entries: RoutingTrace[]) {
  const completed = entries.filter(entry => entry.ok);
  return {
    window: entries.length, successes: completed.length, cancelled: entries.filter(entry => entry.cancelled).length,
    completionMs: distribution(completed.map(entry => entry.latencyMs)),
    firstTextMs: distribution(completed.flatMap(entry => entry.firstTextMs === undefined ? [] : [entry.firstTextMs])),
    byModel: [...new Set(entries.map(entry => entry.model ?? '알 수 없음'))].map(model => {
      const group = entries.filter(entry => (entry.model ?? '알 수 없음') === model);
      const ok = group.filter(entry => entry.ok);
      return { model, samples: group.length, successes: ok.length,
        completionMs: distribution(ok.map(entry => entry.latencyMs)),
        firstTextMs: distribution(ok.flatMap(entry => entry.firstTextMs === undefined ? [] : [entry.firstTextMs])),
        averageTokens: group.reduce((sum, entry) => sum + entry.promptTokens + entry.completionTokens, 0) / group.length };
    }).sort((a, b) => b.samples - a.samples),
  };
}
