import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { terminateProcessTree } from '../computer/shell.js';
import { normalizeProviderUsageReport, type ChatRequest, type ProviderResult } from './provider.js';

export const ISOLATED_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['text', 'toolCalls'],
  properties: { text: { type: 'string' }, toolCalls: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['name', 'arguments'],
    properties: { name: { type: 'string' }, arguments: { type: 'string', description: 'JSON object encoded as a string' } },
  } } },
};

/** These are data requests to our broker, never native CLI function calls. */
export function isolatedPrompt(req: ChatRequest): string {
  return [req.system, 'You are a text-only worker using the existing subscription. Native tools and computer environment are disabled. Return ONLY JSON with {"text":"user-facing answer", "toolCalls":[{"name":"allowed tool", "arguments":"JSON object string"}]}. To request work, choose only the broker tools below; Mr.Robot validates and executes them outside this worker. Use an empty toolCalls array when finished. Do not print this JSON protocol to the user.',
    `Broker tools: ${JSON.stringify(req.tools ?? [])}`,
    `Conversation: ${JSON.stringify(req.turns)}`].join('\n\n');
}
export function parseIsolatedReply(text: string, req: ChatRequest, usage: ProviderResult['usage']): ProviderResult {
  if (text.length > 384 * 1024) throw new Error('구독 모델의 응답 크기가 너무 큽니다.');
  let value: any;
  try { value = JSON.parse(text); } catch { throw new Error('구독 모델의 작업 응답 형식이 올바르지 않습니다. 다시 요청하세요.'); }
  if (!value || typeof value.text !== 'string' || !Array.isArray(value.toolCalls) || value.toolCalls.length > 4) throw new Error('구독 모델의 작업 응답 형식이 올바르지 않습니다.');
  const allowed = new Set(req.tools?.map(t => t.name));
  const toolCalls = value.toolCalls.map((call: any) => {
    if (!call || !allowed.has(call.name) || typeof call.arguments !== 'string' || call.arguments.length > 128 * 1024) throw new Error('사용자 권한에 없는 도구 요청을 차단했습니다.');
    const input = JSON.parse(call.arguments);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('작업 도구 입력이 올바르지 않습니다.');
    return { id: randomUUID(), name: call.name, args: call.arguments };
  });
  if (value.text) req.onEvent?.({ type: 'text', text: value.text });
  return { text: value.text, toolCalls, usage };
}

export const CODEX_TEXT_CONFIG: Record<string, unknown> = {
  mcp_servers: {}, 'apps._default.enabled': false, 'agents.enabled': false,
  project_doc_max_bytes: 0, web_search: 'disabled',
  developer_instructions: '',
  ...Object.fromEntries(['shell_tool', 'shell_snapshot', 'unified_exec', 'plugins', 'remote_plugin', 'hooks', 'apps', 'memories', 'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'computer_use', 'view_image', 'image_generation', 'skill_search', 'skill_mcp_dependency_install', 'workspace_dependencies', 'code_mode_host', 'sleep_tool', 'goals', 'tool_suggest'].map(name => [`features.${name}`, false])),
  'features.code_mode.enabled': false,
  'features.skip_host_skill_discovery': true,
};
/** thread/start config uses nested JSON tables, unlike CLI dotted -c keys. */
export const CODEX_BROKER_CONFIG = { ...CODEX_TEXT_CONFIG, 'features.code_mode_host': true, 'features.code_mode.enabled': true, 'features.code_mode.excluded_tool_namespaces': ['skills'] };
export function codexThreadConfig(broker = false): Record<string, unknown> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(broker ? CODEX_BROKER_CONFIG : CODEX_TEXT_CONFIG)) {
    const parts = key.split('.'); let target = result;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)!] = value;
  }
  return result;
}
function toml(value: unknown): string { return Array.isArray(value) ? JSON.stringify(value) : typeof value === 'object' ? '{}' : JSON.stringify(value); }
export function codexTextArgs(overrides: Record<string, unknown> = {}): string[] {
  return ['app-server', '--listen', 'stdio://', ...Object.entries({ ...CODEX_TEXT_CONFIG, ...overrides }).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`])];
}

/** Uses official app-server environments:[] at BOTH thread and turn boundaries.
 * No model-controlled method can reach this transport; unknown server requests
 * are rejected. Auth stays inside the installed CLI; nothing is copied to Discord.
 */
export async function codexTextOnly(options: { command: string; prefixArgs: string[]; env: NodeJS.ProcessEnv; cwd: string; model: string; req: ChatRequest; config?: Record<string, unknown> }): Promise<ProviderResult> {
  const { req } = options;
  req.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, [...options.prefixArgs, ...codexTextArgs(options.config)], { env: options.env, cwd: options.cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');
    let buffer = '', bytes = 0, finished = false, threadId = '', finalText = '';
    let usage = normalizeProviderUsageReport({});
    const send = (message: unknown) => { if (!finished) child.stdin.write(JSON.stringify(message) + '\n'); };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer); req.signal?.removeEventListener('abort', abort);
      terminateProcessTree(child, true);
      if (error) reject(error);
      else { try { resolve(parseIsolatedReply(finalText, req, usage)); } catch (e) { reject(e); } }
    };
    const abort = () => finish(new Error('구독 모델 작업이 중지되었습니다.'));
    const timer = setTimeout(() => finish(new Error('구독 모델 응답 시간이 초과되었습니다.')), 180_000);
    req.signal?.addEventListener('abort', abort, { once: true });
    child.stdin.on('error', () => {});
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) finish(new Error('구독 실행 출력 한도를 초과했습니다.')); });
    child.on('error', () => finish(new Error('Codex 구독 실행을 시작하지 못했습니다.')));
    child.on('close', () => finish(new Error('Codex 격리 연결이 종료되었습니다. CLI 업데이트·로그인 상태를 확인하세요.')));
    const receive = (m: any) => {
      if (m.error) return finish(new Error('Codex 격리 요청이 거부되었습니다. CLI 버전·로그인·모델 사용 권한을 확인하세요.'));
      if (m.id === 1) {
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'thread/start', params: { model: options.model, cwd: options.cwd, ephemeral: true, environments: [], runtimeWorkspaceRoots: [], dynamicTools: [], selectedCapabilityRoots: [], approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: 'You are a text-only structured response worker. Use no native tools.', config: CODEX_TEXT_CONFIG } });
      } else if (m.id === 2) {
        if (!m.result?.thread?.id || !Array.isArray(m.result.instructionSources) || m.result.instructionSources.length !== 0) return finish(new Error('PC 문맥이 없는 격리 실행을 확인할 수 없어 중단했습니다.'));
        threadId = m.result.thread.id;
        send({ id: 3, method: 'turn/start', params: { threadId, environments: [], runtimeWorkspaceRoots: [], input: [{ type: 'text', text: isolatedPrompt(req), text_elements: [] }], ...(req.reasoningEffort && req.reasoningEffort !== 'auto' ? { effort: req.reasoningEffort } : {}), outputSchema: ISOLATED_OUTPUT_SCHEMA } });
      } else if (m.method === 'thread/tokenUsage/updated') {
        const u = m.params?.tokenUsage?.total;
        if (u) usage = normalizeProviderUsageReport({ promptTokens: u.inputTokens, completionTokens: u.outputTokens, cachedPromptTokens: u.cachedInputTokens });
      } else if (m.method === 'item/completed' || m.method === 'item/started') {
        const item = m.params?.item;
        if (!['userMessage', 'agentMessage', 'reasoning', 'plan'].includes(item?.type)) return finish(new Error('격리 실행에서 네이티브 도구가 감지되어 중단했습니다.'));
        if (m.method === 'item/completed' && item?.type === 'agentMessage') finalText = item.text;
      } else if (m.method === 'turn/completed') {
        if (m.params?.turn?.status !== 'completed') return finish(new Error('구독 모델 작업이 완료되지 않았습니다.'));
        finish();
      } else if (m.id !== undefined && m.method) {
        send({ id: m.id, error: { code: -32601, message: 'Native tool and approval requests are disabled' } });
        finish(new Error('허용되지 않은 네이티브 실행 요청을 차단했습니다.'));
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (finished) return;
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) return finish(new Error('구독 실행 출력 한도를 초과했습니다.'));
      buffer += decoder.write(chunk);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1 && !finished) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try { receive(JSON.parse(line)); } catch { finish(new Error('Codex 격리 통신 형식 오류입니다.')); }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'mrrobot_isolated_worker', version: '0.4.16' }, capabilities: { experimentalApi: true } } });
    if (req.signal?.aborted) abort();
  });
}
