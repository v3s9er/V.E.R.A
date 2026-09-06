import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { terminateProcessTree } from '../computer/shell.js';
import { CODEX_TEXT_CONFIG, codexTextArgs, isolatedPrompt, ISOLATED_OUTPUT_SCHEMA, parseIsolatedReply } from './cli-isolated.js';
import { normalizeProviderUsageReport, type ChatRequest, type ProviderResult, type Turn } from './provider.js';

type Options = { command: string; prefixArgs: string[]; env: NodeJS.ProcessEnv; model: string; providerId: string; req: ChatRequest };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprints = (turns: Turn[]) => turns.map(t => hash(t));
const pool = new Map<string, TextWorker>();

/** Only a verified prefix in the same conversation/provider/policy can resume.
 * Store hashes, not a second copy of attachment/history text. No cross-user cache.
 */
export class TextWorker {
  private child: ChildProcessWithoutNullStreams;
  private cwd = mkdtempSync(join(tmpdir(), 'mrrobot-pooled-text-'));
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private bytes = 0;
  private thread = '';
  private sequence = 10;
  private history: string[] = [];
  private turnCount = 0;
  private idle?: NodeJS.Timeout;
  private model: string;
  private active?: { req: ChatRequest; resolve(r: ProviderResult): void; reject(e: Error): void; timer: NodeJS.Timeout; abort(): void; text: string; usage: ProviderResult['usage'] };
  closed = false;
  get busy() { return !!this.active; }
  constructor(options: Options) {
    this.model = options.model;
    this.child = spawn(options.command, [...options.prefixArgs, ...codexTextArgs()], { env: options.env, cwd: this.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => this.close(new Error('구독 모델 입력 연결 종료')));
    this.child.on('error', () => this.close(new Error('Codex 구독 실행을 시작하지 못했습니다.')));
    this.child.on('close', () => {
      this.close(new Error('구독 모델 연결이 종료되었습니다. 다시 요청하세요.'));
      // The path is allocated by this instance, never supplied by a user/model.
      try { rmSync(this.cwd, { recursive: true, force: true }); } catch { /* Windows lock: no broader cleanup */ }
    });
    this.child.stderr.on('data', (chunk: Buffer) => this.count(chunk.length));
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (!this.count(chunk.length)) return;
      this.buffer += this.decoder.write(chunk);
      let end: number;
      while (!this.closed && (end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); } catch { this.close(new Error('구독 모델 통신 형식 오류입니다.')); }
      }
    });
  }
  accepts(req: ChatRequest) {
    const next = fingerprints(req.turns);
    return !this.closed && !this.busy && this.turnCount < 20 && this.history.length < next.length
      && this.history.every((h, i) => h === next[i]);
  }
  run(req: ChatRequest): Promise<ProviderResult> {
    req.signal?.throwIfAborted();
    if (this.closed || this.busy) return Promise.reject(new Error('구독 작업 연결을 사용할 수 없습니다.'));
    clearTimeout(this.idle); this.bytes = 0;
    return new Promise((resolve, reject) => {
      const abort = () => this.close(new Error('구독 모델 작업이 중지되었습니다.'));
      const timer = setTimeout(() => this.close(new Error('구독 모델 응답 시간이 초과되었습니다.')), 180_000);
      this.active = { req, resolve, reject, timer, abort, text: '', usage: normalizeProviderUsageReport({}) };
      req.signal?.addEventListener('abort', abort, { once: true });
      req.onEvent?.({ type: 'status', text: this.thread ? '구독 세션 재사용 · 추가 문맥 전달 중' : '격리된 구독 세션 연결 중' });
      if (this.thread) this.startTurn();
      else this.send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'mrrobot_isolated_worker', version: '0.4.18' }, capabilities: { experimentalApi: true } } });
    });
  }
  private send(message: unknown) { if (!this.closed) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  private count(size: number) {
    this.bytes += size;
    if (this.bytes > 4 * 1024 * 1024) this.close(new Error('구독 실행 출력 한도를 초과했습니다.'));
    return !this.closed;
  }
  private startTurn() {
    const req = this.active!.req;
    const text = this.history.length ? `Continue the same broker task. New conversation records only (prior records are unchanged):\n${JSON.stringify(req.turns.slice(this.history.length))}` : isolatedPrompt(req);
    this.send({ id: ++this.sequence, method: 'turn/start', params: { threadId: this.thread, environments: [], runtimeWorkspaceRoots: [], input: [{ type: 'text', text, text_elements: [] }], ...(req.reasoningEffort && req.reasoningEffort !== 'auto' ? { effort: req.reasoningEffort } : {}), outputSchema: ISOLATED_OUTPUT_SCHEMA } });
  }
  private receive(m: any) {
    if (m.error) return this.close(new Error('구독 요청이 거부되었습니다. CLI 로그인·모델 권한을 확인하세요.'));
    if (m.id === 1 && !m.method) {
      this.send({ method: 'initialized', params: {} });
      this.send({ id: 2, method: 'thread/start', params: { model: this.model, cwd: this.cwd, ephemeral: true, environments: [], runtimeWorkspaceRoots: [], dynamicTools: [], selectedCapabilityRoots: [], approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: 'You are a text-only structured response worker. Use no native tools.', config: CODEX_TEXT_CONFIG } });
      return;
    }
    if (m.id === 2 && !m.method) {
      if (!m.result?.thread?.id || !Array.isArray(m.result.instructionSources) || m.result.instructionSources.length) return this.close(new Error('격리 문맥을 확인할 수 없어 중단했습니다.'));
      this.thread = m.result.thread.id; this.startTurn(); return;
    }
    if (m.id !== undefined && m.method) {
      this.send({ id: m.id, error: { code: -32601, message: 'Native tools disabled' } });
      return this.close(new Error('허용되지 않은 네이티브 실행 요청을 차단했습니다.'));
    }
    const active = this.active;
    if (!active) return;
    if (m.params?.threadId && m.params.threadId !== this.thread) return this.close(new Error('구독 대화 식별자가 일치하지 않습니다.'));
    if (m.method === 'thread/tokenUsage/updated') {
      const u = m.params?.tokenUsage?.last;
      if (u) active.usage = normalizeProviderUsageReport({ promptTokens: u.inputTokens, completionTokens: u.outputTokens, cachedPromptTokens: u.cachedInputTokens });
    } else if (m.method === 'item/started' || m.method === 'item/completed') {
      const item = m.params?.item;
      if (!['userMessage', 'agentMessage', 'reasoning', 'plan'].includes(item?.type)) return this.close(new Error('격리 실행에서 네이티브 도구가 감지되어 중단했습니다.'));
      if (m.method === 'item/started' && item?.type === 'reasoning') active.req.onEvent?.({ type: 'status', text: '모델이 요청을 검토하고 있습니다' });
      if (m.method === 'item/completed' && item?.type === 'agentMessage') active.text = item.text;
    } else if (m.method === 'turn/completed') {
      if (m.params?.turn?.status !== 'completed') return this.close(new Error('구독 모델 작업이 완료되지 않았습니다.'));
      try {
        const result = parseIsolatedReply(active.text, active.req, active.usage);
        this.history = fingerprints([...active.req.turns, { role: 'assistant', content: result.text, ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}) }]);
        this.turnCount++;
        clearTimeout(active.timer); active.req.signal?.removeEventListener('abort', active.abort);
        this.active = undefined;
        this.idle = setTimeout(() => this.close(), 120_000); this.idle.unref();
        active.resolve(result);
      } catch (e) { this.close(e instanceof Error ? e : new Error('구독 응답 형식 오류')); }
    }
  }
  close(error = new Error('구독 세션 만료')) {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.idle);
    if (this.active) {
      clearTimeout(this.active.timer); this.active.req.signal?.removeEventListener('abort', this.active.abort);
      this.active.reject(error); this.active = undefined;
    }
    this.history = []; this.buffer = '';
    for (const [key, worker] of pool) if (worker === this) pool.delete(key);
    terminateProcessTree(this.child, true);
  }
}

export async function pooledCodexText(options: Options): Promise<ProviderResult> {
  options.req.signal?.throwIfAborted();
  const key = options.req.promptCacheKey ? hash([options.req.promptCacheKey, options.providerId, options.model, options.command, options.prefixArgs, options.req.system, options.req.tools]) : undefined;
  let worker = key ? pool.get(key) : undefined;
  if (worker?.busy) throw new Error('같은 대화의 구독 작업이 이미 실행 중입니다.');
  if (worker && !worker.accepts(options.req)) { worker.close(); worker = undefined; }
  if (!worker) {
    if (pool.size >= 4) {
      const idle = [...pool.values()].find(w => !w.busy);
      if (idle) idle.close();
      else throw new Error('구독 작업이 모두 사용 중입니다. 잠시 후 다시 요청하세요.');
    }
    worker = new TextWorker(options);
    pool.set(key ?? randomUUID(), worker);
  }
  try { return await worker.run(options.req); }
  finally { if (!key) worker.close(); }
}

export function closeTextWorkers() { for (const worker of [...pool.values()]) worker.close(); }
