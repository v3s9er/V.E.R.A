import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { ProviderType, ReasoningEffort } from '@mr-robot/shared';
import type { AiProvider, ChatRequest, NativeAgentRequest, ProviderHealth, ProviderResult, Turn } from './provider.js';
import { terminateProcessTree } from '../computer/shell.js';

const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_HELP_OUTPUT = 256 * 1024;

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
  const env = { ...source };
  if (type === 'codex-cli') {
    delete env.OPENAI_API_KEY;
    // The CLI currently emits harmless plugin-icon and PowerShell snapshot
    // warnings on every Windows run. Keep native-agent errors actionable.
    env.RUST_LOG = 'error';
  } else delete env.ANTHROPIC_API_KEY;
  return env;
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

function parseClaude(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { result?: string };
    return typeof parsed.result === 'string' ? parsed.result : raw;
  } catch {
    return raw;
  }
}

function parseCodex(raw: string): string {
  let final = '';
  for (const line of raw.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as Record<string, any>;
      const text = event.item?.text ?? event.message?.content ?? event.text;
      if (typeof text === 'string' && text.trim()) final = text;
    } catch {
      // Codex JSONL may be followed by a plain final line in older versions.
    }
  }
  return final || raw;
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
    const args = this.type === 'claude-cli'
      ? ['-p', prompt, '--output-format', 'json', '--permission-mode', 'plan', '--tools', '', ...(this.model ? ['--model', this.model] : []), ...this.extraArgs]
      : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', ...(this.model ? ['--model', this.model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), ...this.extraArgs];

    const invocation = resolveCliInvocation(this.type, this.command);
    const raw = await new Promise<string>((resolve, reject) => {
      const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: cliSubscriptionEnvironment(this.type),
      });
      let stdout = '';
      let stderr = '';
      const abort = (): void => terminateProcessTree(child);
      if (req.signal?.aborted) abort();
      else req.signal?.addEventListener('abort', abort, { once: true });
      child.stdin.end(this.type === 'codex-cli' ? prompt : '', 'utf8');
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk;
      });
      child.once('error', (error) => {
        req.signal?.removeEventListener('abort', abort);
        reject(error);
      });
      child.once('close', (code) => {
        req.signal?.removeEventListener('abort', abort);
        if (req.signal?.aborted) reject(new Error('작업이 중지되었습니다.'));
        else if (code === 0) resolve(stdout);
        else reject(cliFailure(this.label, code, stdout, stderr));
      });
    });

    const text = this.type === 'claude-cli' ? parseClaude(raw) : parseCodex(raw);
    req.onEvent?.({ type: 'text', text });
    return { text, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 } };
  }

  async runAgent(req: NativeAgentRequest): Promise<ProviderResult> {
    const effort = req.reasoningEffort && req.reasoningEffort !== 'auto' ? req.reasoningEffort : undefined;
    const permission = req.permissionMode;
    const args = this.type === 'claude-cli'
      ? [
        '-p', req.prompt,
        '--output-format', 'json',
        '--no-session-persistence',
        '--model', this.model,
        ...(effort ? ['--effort', effort] : []),
        ...(permission === 'read-only' || permission === 'ask'
          ? ['--permission-mode', 'plan', '--tools', 'Read,Glob,Grep']
          : permission === 'full'
            ? ['--allow-dangerously-skip-permissions', '--dangerously-skip-permissions']
            : ['--permission-mode', 'acceptEdits']),
        ...this.extraArgs,
      ]
      : [
        'exec', '--json', '--skip-git-repo-check', '--ephemeral',
        '--sandbox', permission === 'full' ? 'danger-full-access' : permission === 'workspace' ? 'workspace-write' : 'read-only',
        '-C', req.cwd,
        ...(this.model ? ['--model', this.model] : []),
        ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []),
        ...this.extraArgs,
      ];
    const invocation = resolveCliInvocation(this.type, this.command);
    req.onStatus?.(`native-agent:${this.label}:${this.model}`);
    const raw = await new Promise<string>((resolve, reject) => {
      const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
        shell: false,
        windowsHide: true,
        cwd: req.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: cliSubscriptionEnvironment(this.type),
      });
      let stdout = '';
      let stderr = '';
      const abort = (): void => terminateProcessTree(child);
      if (req.signal?.aborted) abort();
      else req.signal?.addEventListener('abort', abort, { once: true });
      child.stdin.end(this.type === 'codex-cli' ? req.prompt : '', 'utf8');
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk;
        if (/tool|command|exec|file/i.test(chunk)) req.onStatus?.('native-agent:working');
      });
      child.stderr.on('data', (chunk: string) => { if (stderr.length < MAX_OUTPUT) stderr += chunk; });
      child.once('error', (error) => {
        req.signal?.removeEventListener('abort', abort);
        reject(error);
      });
      child.once('close', (code) => {
        req.signal?.removeEventListener('abort', abort);
        if (req.signal?.aborted) reject(new Error('작업이 중지되었습니다.'));
        else if (code === 0) resolve(stdout);
        else reject(cliFailure(this.label, code, stdout, stderr));
      });
    });
    const text = this.type === 'claude-cli' ? parseClaude(raw) : parseCodex(raw);
    return { text, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 } };
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
