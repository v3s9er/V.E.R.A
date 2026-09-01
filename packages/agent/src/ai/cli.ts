import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { ProviderType, ReasoningEffort } from '@mr-robot/shared';
import type { AiProvider, ChatRequest, NativeAgentRequest, ProviderHealth, ProviderResult, ProviderUsage, Turn } from './provider.js';
import { terminateProcessTree } from '../computer/shell.js';

const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_HELP_OUTPUT = 256 * 1024;
const CHAT_TIMEOUT_MS = 10 * 60_000;
const NATIVE_AGENT_TIMEOUT_MS = 30 * 60_000;

const SUBSCRIPTION_ENV_ALLOWLIST = [
  'PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec',
  'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'LANG', 'LC_ALL', 'TERM', 'NO_COLOR',
] as const;

export const CURRENT_CODEX_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6'] as const;
export const CURRENT_CLAUDE_MODELS = [
  'fable',
  'opus',
  'sonnet',
  'haiku',
  'claude-fable-5',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
] as const;

export interface CliInvocation {
  command: string;
  prefixArgs: string[];
}

/** Subscription adapters must never silently fall back to billable API-key auth. */
export function cliSubscriptionEnvironment(
  type: Extract<ProviderType, 'codex-cli' | 'claude-cli'>,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // A desktop process often inherits unrelated provider keys, cloud tokens,
  // signing passwords and package-manager credentials. Subscription CLIs need
  // OS paths and their own on-disk login only; passing every parent variable is
  // an unnecessary cross-provider credential boundary.
  const env: NodeJS.ProcessEnv = {};
  const entries = Object.entries(source);
  for (const allowed of SUBSCRIPTION_ENV_ALLOWLIST) {
    const found = entries.find(([key]) => key.toLowerCase() === allowed.toLowerCase());
    if (found && typeof found[1] === 'string') env[allowed] = found[1];
  }
  if (type === 'codex-cli') {
    // The CLI currently emits harmless plugin-icon and PowerShell snapshot
    // warnings on every Windows run. Keep native-agent errors actionable.
    env.RUST_LOG = 'error';
  }
  return env;
}

/** Keep optional CLI customization from weakening Mr.Robot's security flags. */
export function safeCliExtraArgs(
  type: Extract<ProviderType, 'codex-cli' | 'claude-cli'>,
  input: string[],
): string[] {
  const allowedPairs = type === 'claude-cli'
    ? new Set(['--autocompact', '--fallback-model', '--prompt-suggestions'])
    : new Set(['--color']);
  const output: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const flag = input[index];
    if (!allowedPairs.has(flag)) continue;
    const value = input[index + 1];
    if (!value || value.startsWith('-') || value.length > 200) continue;
    output.push(flag, value);
    index++;
  }
  return output;
}

function firstExisting(paths: Array<string | undefined>): string | undefined {
  for (const value of paths) if (value && existsSync(value)) return value;
  return undefined;
}

function executableOnPath(name: string): string | undefined {
  const stem = name.replace(/\.(?:cmd|ps1|exe)$/i, '');
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, `${stem}.exe`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Pull model names and aliases exposed by newer CLI help output. */
export function extractCliModels(
  type: Extract<ProviderType, 'codex-cli' | 'claude-cli'>,
  output: string,
): string[] {
  const pattern = type === 'codex-cli'
    ? /\bgpt-\d[\w.-]*\b/gi
    : /\b(?:claude-)?(?:fable|opus|sonnet|haiku)(?:-\d[\w.-]*)?\b/gi;
  return [...new Set(output.match(pattern)?.map((value) => value.toLowerCase()) ?? [])];
}

/** Resolve npm/PowerShell CLI shims to a shell-free Windows executable. */
export function resolveCliInvocation(
  type: Extract<ProviderType, 'codex-cli' | 'claude-cli'>,
  configuredCommand: string,
): CliInvocation {
  const command = configuredCommand.trim() || (type === 'codex-cli' ? 'codex' : 'claude');
  if (process.platform !== 'win32') return { command, prefixArgs: [] };

  // Explicit executable overrides remain authoritative.
  if (isAbsolute(command) && /\.exe$/i.test(command) && existsSync(command)) return { command, prefixArgs: [] };

  const appData = process.env.APPDATA ?? '';
  const npmModules = appData ? join(appData, 'npm', 'node_modules') : '';
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const native = type === 'codex-cli'
    ? firstExisting([
      npmModules ? join(npmModules, '@openai', 'codex', 'node_modules', '@openai', `codex-win32-${architecture}`, 'vendor', triple, 'bin', 'codex.exe') : undefined,
    ])
    : firstExisting([
      npmModules ? join(npmModules, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : undefined,
      npmModules ? join(npmModules, '@anthropic-ai', 'claude-code', 'node_modules', '@anthropic-ai', `claude-code-win32-${architecture}`, 'claude.exe') : undefined,
    ]);
  if (native) return { command: native, prefixArgs: [] };

  // Codex's JavaScript entry is also safe when launched with node.exe directly.
  const script = type === 'codex-cli' && npmModules ? join(npmModules, '@openai', 'codex', 'bin', 'codex.js') : '';
  const node = firstExisting([
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe'),
    executableOnPath('node'),
  ]);
  if (script && existsSync(script) && node) return { command: node, prefixArgs: [script] };

  return { command: executableOnPath(command) ?? command, prefixArgs: [] };
}

function transcript(system: string | undefined, turns: Turn[]): string {
  const parts: string[] = [];
  if (system) parts.push(`SYSTEM\n${system}`);
  for (const turn of turns) {
    if (turn.role === 'tool') {
      for (const result of turn.toolResults ?? []) parts.push(`TOOL ${result.name}\n${result.content}`);
    } else {
      parts.push(`${turn.role.toUpperCase()}\n${turn.content}`);
    }
  }
  parts.push('ASSISTANT\n');
  return parts.join('\n\n');
}

export interface ParsedCliOutput {
  text: string;
  usage: ProviderUsage;
}

function tokenCount(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(Number(value))) : 0;
}

export function parseClaudeOutput(raw: string): ParsedCliOutput {
  try {
    const parsed = JSON.parse(raw) as {
      result?: string;
      totalTokens?: number;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        output_tokens_details?: { thinking_tokens?: number };
      };
    };
    const input = tokenCount(parsed.usage?.input_tokens);
    const cacheWrite = tokenCount(parsed.usage?.cache_creation_input_tokens);
    const cacheRead = tokenCount(parsed.usage?.cache_read_input_tokens);
    const output = tokenCount(parsed.usage?.output_tokens);
    const reported = input + cacheWrite + cacheRead + output;
    const totalFallback = tokenCount(parsed.totalTokens);
    return {
      text: typeof parsed.result === 'string' ? parsed.result : raw,
      usage: {
        promptTokens: reported > 0 ? input + cacheWrite + cacheRead : totalFallback,
        completionTokens: output,
        ...(cacheRead > 0 ? { cachedPromptTokens: cacheRead } : {}),
        ...(cacheWrite > 0 ? { cacheWritePromptTokens: cacheWrite } : {}),
        ...(tokenCount(parsed.usage?.output_tokens_details?.thinking_tokens) > 0
          ? { reasoningTokens: tokenCount(parsed.usage?.output_tokens_details?.thinking_tokens) }
          : {}),
      },
    };
  } catch {
    return { text: raw, usage: { promptTokens: 0, completionTokens: 0 } };
  }
}

export function parseCodexOutput(raw: string): ParsedCliOutput {
  let final = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedPromptTokens = 0;
  let reasoningTokens = 0;
  for (const line of raw.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as Record<string, any>;
      const text = event.item?.text ?? event.message?.content ?? event.text;
      if (typeof text === 'string' && text.trim()) final = text;
      if (event.type === 'turn.completed' || event.type === 'turn_completed' || event.type === 'turn.complete') {
        const usage = event.usage ?? event.turn?.usage ?? {};
        promptTokens += tokenCount(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens);
        completionTokens += tokenCount(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens);
        cachedPromptTokens += tokenCount(usage.cached_input_tokens ?? usage.cachedInputTokens);
        reasoningTokens += tokenCount(usage.output_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens);
      }
    } catch {
      // Codex JSONL may be followed by a plain final line in older versions.
    }
  }
  return {
    text: final || raw,
    usage: {
      promptTokens,
      completionTokens,
      ...(cachedPromptTokens > 0 ? { cachedPromptTokens } : {}),
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    },
  };
}

function cliFailure(label: string, code: number | null, stdout: string, stderr: string): Error {
  const details: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { type?: string; message?: string; error?: { message?: string } };
      if ((event.type === 'error' || event.type === 'turn.failed') && (event.message || event.error?.message)) {
        details.push(event.message || event.error?.message || '');
      }
    } catch { /* non-JSON stdout is ignored here */ }
  }
  const usefulStderr = stderr.split(/\r?\n/).filter((line) => line.trim()
    && !/Reading additional input from stdin/i.test(line)
    && !/codex_skills::interface.*ignoring interface\.icon_/i.test(line)
    && !/codex_core::shell_snapshot.*Shell snapshot not supported yet for PowerShell/i.test(line));
  details.push(...usefulStderr);
  const detail = [...new Set(details.map((value) => value.trim()).filter(Boolean))].join('\n').slice(-3000);
  return new Error(`[${label}] 네이티브 에이전트가 종료되었습니다 (코드 ${code ?? 'unknown'}).${detail ? `\n${detail}` : '\nCodex CLI 로그에 상세 오류가 없습니다. 연결 상태와 선택 모델을 다시 확인하세요.'}`);
}

interface CliProcessOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  label: string;
  stdin: string;
  timeoutMs: number;
  cwd?: string;
  signal?: AbortSignal;
  onStatus?: (status: string) => void;
}

function runCliProcess(options: CliProcessOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      shell: false,
      windowsHide: true,
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env,
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(stdout);
    };
    const abort = (): void => terminateProcessTree(child);
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, options.timeoutMs);
    timer.unref?.();

    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT) {
        outputExceeded = true;
        terminateProcessTree(child);
        return;
      }
      const text = chunk.toString('utf8');
      stdout += text;
      if (/tool|command|exec|file/i.test(text)) options.onStatus?.('native-agent:working');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT) {
        outputExceeded = true;
        terminateProcessTree(child);
        return;
      }
      stderr += chunk.toString('utf8');
    });
    child.stdin?.on('error', () => { /* close/error below owns the outcome */ });
    child.stdin?.end(options.stdin, 'utf8');
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (options.signal?.aborted) finish(new Error('작업이 중지되었습니다.'));
      else if (timedOut) finish(new Error(`[${options.label}] 실행 시간이 ${Math.ceil(options.timeoutMs / 60_000)}분을 초과하여 중지했습니다.`));
      else if (outputExceeded) finish(new Error(`[${options.label}] 출력 한도 ${MAX_OUTPUT / 1024 / 1024}MB를 초과하여 중지했습니다.`));
      else if (code === 0) finish();
      else finish(cliFailure(options.label, code, stdout, stderr));
    });
  });
}

/**
 * Official CLI bridge for subscription-backed Codex and Claude Code.
 * It launches the user's already-authenticated CLI without a shell, so no
 * credentials are copied into Mr.Robot. CLIs run read-only here; Mr.Robot remains
 * the only component allowed to mutate the computer through audited tools.
 */
export class CliProvider implements AiProvider {
  readonly supportsTools = false;
  readonly supportedReasoning: ReasoningEffort[];
  private modelList?: Promise<string[]>;

  constructor(
    readonly id: string,
    readonly label: string,
    readonly type: Extract<ProviderType, 'codex-cli' | 'claude-cli'>,
    readonly baseUrl: string,
    readonly model: string,
    private readonly command: string,
    private readonly extraArgs: string[] = [],
  ) {
    this.supportedReasoning = type === 'codex-cli'
      ? ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
      : ['auto'];
  }

  async chat(req: ChatRequest): Promise<ProviderResult> {
    if (req.tools?.length) {
      // Deliberately ignored. Local CLI adapters are reasoning workers, while
      // Mr.Robot executes computer tools under its own permission policy.
    }
    const prompt = transcript(req.system, req.turns);
    const effort = req.reasoningEffort && req.reasoningEffort !== 'auto' ? req.reasoningEffort : undefined;
    const extras = safeCliExtraArgs(this.type, this.extraArgs);
    const args = this.type === 'claude-cli'
      ? [
        '-p', prompt, '--output-format', 'json', '--no-session-persistence',
        '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--disable-slash-commands', '--no-chrome', '--permission-mode', 'plan', '--tools', '',
        ...(this.model ? ['--model', this.model] : []), ...extras,
      ]
      : [
        'exec', '--json', '--strict-config', '--ignore-user-config', '--ignore-rules',
        '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only',
        ...(this.model ? ['--model', this.model] : []),
        ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), ...extras,
      ];

    const invocation = resolveCliInvocation(this.type, this.command);
    const raw = await runCliProcess({
      command: invocation.command,
      args: [...invocation.prefixArgs, ...args],
      env: cliSubscriptionEnvironment(this.type),
      label: this.label,
      stdin: this.type === 'codex-cli' ? prompt : '',
      timeoutMs: CHAT_TIMEOUT_MS,
      signal: req.signal,
    });

    const parsed = this.type === 'claude-cli' ? parseClaudeOutput(raw) : parseCodexOutput(raw);
    req.onEvent?.({ type: 'text', text: parsed.text });
    return { text: parsed.text, toolCalls: [], usage: parsed.usage };
  }

  async runAgent(req: NativeAgentRequest): Promise<ProviderResult> {
    if (req.permissionMode === 'ask') throw new Error('네이티브 CLI에는 확인 대기 권한을 직접 전달할 수 없습니다. 먼저 명시적으로 승인해야 합니다.');
    if (this.type === 'claude-cli' && req.permissionMode !== 'full') {
      throw new Error('Claude Code 네이티브 도구는 OS 수준 작업공간 격리를 보장하지 않아 완전 접근에서만 실행할 수 있습니다.');
    }
    const effort = req.reasoningEffort && req.reasoningEffort !== 'auto' ? req.reasoningEffort : undefined;
    const permission = req.permissionMode;
    const extras = safeCliExtraArgs(this.type, this.extraArgs);
    const args = this.type === 'claude-cli'
      ? [
        '-p', req.prompt,
        '--output-format', 'json',
        '--no-session-persistence',
        '--safe-mode',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--disable-slash-commands', '--no-chrome',
        '--model', this.model,
        ...(effort ? ['--effort', effort] : []),
        ...extras,
        '--allow-dangerously-skip-permissions', '--dangerously-skip-permissions',
      ]
      : [
        'exec', '--json', '--strict-config', '--ignore-user-config', '--ignore-rules',
        '--skip-git-repo-check', '--ephemeral',
        '--sandbox', permission === 'full' ? 'danger-full-access' : permission === 'workspace' ? 'workspace-write' : 'read-only',
        '-C', req.cwd,
        ...(this.model ? ['--model', this.model] : []),
        ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []),
        ...extras,
      ];
    const invocation = resolveCliInvocation(this.type, this.command);
    req.onStatus?.(`native-agent:${this.label}:${this.model}`);
    const raw = await runCliProcess({
      command: invocation.command,
      args: [...invocation.prefixArgs, ...args],
      env: cliSubscriptionEnvironment(this.type),
      label: this.label,
      stdin: this.type === 'codex-cli' ? req.prompt : '',
      timeoutMs: NATIVE_AGENT_TIMEOUT_MS,
      cwd: req.cwd,
      signal: req.signal,
      onStatus: req.onStatus,
    });
    const parsed = this.type === 'claude-cli' ? parseClaudeOutput(raw) : parseCodexOutput(raw);
    return { text: parsed.text, toolCalls: [], usage: parsed.usage };
  }

  async ping(): Promise<ProviderHealth> {
    const invocation = resolveCliInvocation(this.type, this.command);
    return await new Promise<ProviderHealth>((resolve) => {
      const authArgs = this.type === 'codex-cli' ? ['login', 'status'] : ['auth', 'status'];
      const child = spawn(invocation.command, [...invocation.prefixArgs, ...authArgs], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: cliSubscriptionEnvironment(this.type),
      });
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { if (output.length < MAX_HELP_OUTPUT) output += chunk; });
      child.stderr.on('data', (chunk: string) => { if (output.length < MAX_HELP_OUTPUT) output += chunk; });
      const timer = setTimeout(() => {
        terminateProcessTree(child);
        resolve({ ok: false, error: 'CLI 응답 시간이 초과되었습니다.' });
      }, 6000);
      child.once('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: err.message });
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (this.type === 'codex-cli') {
          resolve(code === 0 && /logged in/i.test(output)
            ? { ok: true }
            : { ok: false, error: output.trim() || `Codex 로그인 확인 실패 (종료 코드 ${code})` });
          return;
        }
        try {
          const status = JSON.parse(output) as { loggedIn?: boolean; authMethod?: string };
          resolve(status.loggedIn
            ? { ok: true }
            : { ok: false, error: 'Claude 구독 로그인이 필요합니다. 터미널에서 claude auth login을 실행하세요.' });
        } catch {
          resolve({ ok: false, error: output.trim() || `Claude 로그인 확인 실패 (종료 코드 ${code})` });
        }
      });
    });
  }

  async models(): Promise<string[]> {
    this.modelList ??= this.discoverModels();
    return this.modelList;
  }

  private async discoverModels(): Promise<string[]> {
    const fallback = this.type === 'codex-cli' ? CURRENT_CODEX_MODELS : CURRENT_CLAUDE_MODELS;
    const invocation = resolveCliInvocation(this.type, this.command);
    const help = await new Promise<string>((resolve) => {
      const child = spawn(invocation.command, [...invocation.prefixArgs, '--help'], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: cliSubscriptionEnvironment(this.type),
      });
      let output = '';
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(output);
      };
      const append = (chunk: string): void => {
        if (output.length < MAX_HELP_OUTPUT) output += chunk;
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.once('error', finish);
      child.once('close', finish);
      const timer = setTimeout(() => {
        terminateProcessTree(child);
        finish();
      }, 4000);
    });
    return [...new Set<string>([...fallback, ...extractCliModels(this.type, help), ...(this.model ? [this.model] : [])])];
  }
}
