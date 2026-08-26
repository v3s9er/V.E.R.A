import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginContext } from './context.js';
import type { MrRobotPlugin } from './loader.js';

const MAX_OUTPUT = 2 * 1024 * 1024;
const CODING_REQUEST = /orca|오르카|코드|코딩|개발|프로젝트|리포|저장소|버그|빌드|테스트|리팩터|구현|repo|repository|code|coding|develop|bug|build|test|refactor|implement/i;

type OrcaAgent = 'codex' | 'claude';
type OrcaSetup = 'run' | 'skip' | 'inherit';

interface OrcaConfig {
  enabled: boolean;
  command: string;
  defaultAgent: OrcaAgent;
  defaultRepo: string;
  setup: OrcaSetup;
  autoOpen: boolean;
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const DEFAULT_CONFIG: OrcaConfig = {
  enabled: false,
  command: 'orca',
  defaultAgent: 'codex',
  defaultRepo: '',
  setup: 'inherit',
  autoOpen: false,
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function resolvedOrcaCommand(configured: string): string {
  if (configured !== 'orca' || process.platform !== 'win32') return configured;
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const installed = localAppData ? join(localAppData, 'Programs', 'orca', 'resources', 'bin', 'orca.exe') : '';
  return installed && existsSync(installed) ? installed : configured;
}

function readConfig(ctx: PluginContext): OrcaConfig {
  const stored = ctx.storage.get<Partial<OrcaConfig>>('config') ?? {};
  return {
    enabled: stored.enabled === true,
    command: resolvedOrcaCommand(text(stored.command, DEFAULT_CONFIG.command).trim() || DEFAULT_CONFIG.command),
    defaultAgent: stored.defaultAgent === 'claude' ? 'claude' : 'codex',
    defaultRepo: text(stored.defaultRepo).trim(),
    setup: stored.setup === 'run' || stored.setup === 'skip' ? stored.setup : 'inherit',
    autoOpen: stored.autoOpen === true,
  };
}

function saveConfig(ctx: PluginContext, value: unknown): OrcaConfig {
  const current = readConfig(ctx);
  const patch = record(value);
  const next: OrcaConfig = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    command: text(patch.command, current.command).trim() || 'orca',
    defaultAgent: patch.defaultAgent === 'claude' ? 'claude' : patch.defaultAgent === 'codex' ? 'codex' : current.defaultAgent,
    defaultRepo: typeof patch.defaultRepo === 'string' ? patch.defaultRepo.trim() : current.defaultRepo,
    setup: patch.setup === 'run' || patch.setup === 'skip' || patch.setup === 'inherit' ? patch.setup : current.setup,
    autoOpen: typeof patch.autoOpen === 'boolean' ? patch.autoOpen : current.autoOpen,
  };
  ctx.storage.set('config', next);
  return next;
}

function parseJson(stdout: string): unknown {
  const value = stdout.trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line);
      } catch {
        // Some versions log a human-readable line before the JSON result.
      }
    }
    return { raw: value.slice(-20_000) };
  }
}

function run(command: string, args: string[], timeoutMs = 20_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    if (/\.(?:cmd|bat)$/i.test(command)) {
      reject(new Error('보안을 위해 .cmd/.bat 래퍼는 사용할 수 없습니다. Orca의 orca.exe 경로를 지정하세요.'));
      return;
    }
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`Orca CLI가 ${timeoutMs}ms 안에 응답하지 않았습니다.`)));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (stdout.length < MAX_OUTPUT) stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { if (stderr.length < MAX_OUTPUT) stderr += chunk; });
    child.once('error', (err) => finish(() => reject(err)));
    child.once('close', (exitCode) => finish(() => {
      if (exitCode === 0) resolve({ stdout, stderr, exitCode });
      else reject(new Error((stderr || stdout || `Orca CLI 종료 코드 ${exitCode}`).trim().slice(-4000)));
    }));
  });
}

async function json(command: string, args: string[], timeoutMs?: number): Promise<unknown> {
  const result = await run(command, [...args, '--json'], timeoutMs);
  return parseJson(result.stdout);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') return 'Orca CLI를 찾을 수 없습니다. Orca를 설치하거나 orca.exe 경로를 지정하세요.';
  return err instanceof Error ? err.message : String(err);
}

function runtimeVersion(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const result = (value as { result?: unknown }).result;
  if (!result || typeof result !== 'object') return '';
  const runtime = (result as { runtime?: unknown }).runtime;
  if (!runtime || typeof runtime !== 'object') return '';
  const version = (runtime as { appVersion?: unknown }).appVersion;
  return typeof version === 'string' ? version : '';
}

async function status(ctx: PluginContext): Promise<Record<string, unknown>> {
  const config = readConfig(ctx);
  try {
    const runtime = await json(config.command, ['status'], 7000);
    return {
      enabled: config.enabled,
      installed: true,
      version: runtimeVersion(runtime),
      runtimeConnected: true,
      runtime,
      config,
    };
  } catch (runtimeError) {
    try {
      // The current Orca CLI prints its help for --version. Probe --help only to
      // distinguish an installed CLI from a stopped/unreachable desktop runtime.
      await run(config.command, ['--help'], 7000);
      return {
        enabled: config.enabled,
        installed: true,
        version: '',
        runtimeConnected: false,
        runtimeError: errorMessage(runtimeError),
        config,
      };
    } catch (installError) {
      return { enabled: config.enabled, installed: false, runtimeConnected: false, error: errorMessage(installError), config };
    }
  }
}

async function ensureRuntime(ctx: PluginContext): Promise<OrcaConfig> {
  const config = readConfig(ctx);
  if (!config.enabled) throw new Error('Orca 통합이 꺼져 있습니다. 플러그인 설정에서 활성화하세요.');
  try {
    await json(config.command, ['status'], 7000);
    return config;
  } catch (initialError) {
    if (!config.autoOpen) throw initialError;
    await json(config.command, ['open'], 15_000);
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await json(config.command, ['status'], 5000);
        return config;
      } catch {
        // Keep polling while the desktop runtime starts.
      }
    }
    throw new Error(`Orca를 열었지만 런타임에 연결하지 못했습니다: ${errorMessage(initialError)}`);
  }
}

function taskName(prompt: string): string {
  const compact = prompt.replace(/\s+/g, '-').replace(/[^\p{L}\p{N}._-]/gu, '').replace(/-+/g, '-').slice(0, 48);
  return compact || `mr-robot-task-${Date.now()}`;
}

export function createOrcaPlugin(): MrRobotPlugin {
  return {
    manifest: {
      id: 'orca',
      name: 'Orca 코딩 실행기',
      version: '1.0.0',
      kind: 'integration',
      enabledByDefault: false,
      description: 'Mr.Robot의 코딩 작업을 Orca worktree의 Codex·Claude 에이전트로 위임합니다.',
      capabilities: ['coding.worktree.delegate', 'coding.runtime.status'],
      permissions: ['process.execute', 'filesystem.read', 'filesystem.write'],
      dependencies: [{ id: 'orca', name: 'Orca CLI', required: false }],
    },
    activate(ctx) {
      ctx.registerCommand('orca.config.get', () => readConfig(ctx), {
        description: 'Orca 통합 설정 조회', destructive: false, adminOnly: true,
      });
      ctx.registerCommand('orca.config.set', (params) => saveConfig(ctx, params), {
        description: 'Orca 통합 설정 저장', destructive: false, adminOnly: true,
      });
      ctx.registerCommand('orca.status', () => status(ctx), {
        description: 'Orca 설치 및 런타임 연결 상태를 확인합니다.', tool: true, destructive: false, toolWhen: CODING_REQUEST.test.bind(CODING_REQUEST),
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      });
      ctx.registerCommand('orca.open', async () => {
        const config = readConfig(ctx);
        return parseJson((await run(config.command, ['open', '--json'], 15_000)).stdout);
      }, { description: 'Orca 데스크톱 런타임 열기', destructive: false, adminOnly: true });
      ctx.registerCommand('orca.repos', async () => {
        const config = await ensureRuntime(ctx);
        return json(config.command, ['repo', 'list'], 15_000);
      }, {
        description: 'Orca에 등록된 코드 저장소 목록을 조회합니다.', tool: true, destructive: false, toolWhen: CODING_REQUEST.test.bind(CODING_REQUEST),
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      });
      ctx.registerCommand('orca.worktrees', async (params) => {
        const config = await ensureRuntime(ctx);
        const repo = text(record(params).repo).trim();
        return repo
          ? json(config.command, ['worktree', 'list', '--repo', repo], 15_000)
          : json(config.command, ['worktree', 'ps'], 15_000);
      }, {
        description: 'Orca의 실행 중인 worktree와 에이전트 상태를 조회합니다.', tool: true, destructive: false, toolWhen: CODING_REQUEST.test.bind(CODING_REQUEST),
        parameters: { type: 'object', properties: { repo: { type: 'string', description: '선택적 repo selector (예: id:abc)' } }, additionalProperties: false },
      });
      ctx.registerCommand('orca.delegate', async (params) => {
        const input = record(params);
        const prompt = text(input.prompt).trim();
        if (!prompt) throw new Error('prompt가 필요합니다.');
        if (prompt.length > 50_000) throw new Error('prompt는 50,000자 이하여야 합니다.');
        const config = await ensureRuntime(ctx);
        const repo = text(input.repo, config.defaultRepo).trim();
        if (!repo) throw new Error('Orca repo selector가 필요합니다. 먼저 orca.repos를 호출하거나 기본 저장소를 설정하세요.');
        const agent: OrcaAgent = input.agent === 'claude' ? 'claude' : input.agent === 'codex' ? 'codex' : config.defaultAgent;
        const setup: OrcaSetup = input.setup === 'run' || input.setup === 'skip' || input.setup === 'inherit' ? input.setup : config.setup;
        const name = taskName(text(input.name, prompt));
        const result = await json(config.command, ['worktree', 'create', '--repo', repo, '--name', name, '--agent', agent, '--prompt', prompt, '--setup', setup], 120_000);
        return { delegated: true, agent, repo, name, result };
      }, {
        description: '코딩 작업을 격리된 Orca worktree의 Codex 또는 Claude 에이전트에 위임합니다. 저장소를 모르면 먼저 orca.repos를 호출하세요.',
        tool: true, toolWhen: CODING_REQUEST.test.bind(CODING_REQUEST),
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '에이전트가 수행할 구체적인 코딩 작업' },
            repo: { type: 'string', description: 'Orca repo selector (예: id:abc)' },
            name: { type: 'string', description: '새 worktree 이름' },
            agent: { type: 'string', enum: ['codex', 'claude'], description: '실행할 구독 에이전트' },
            setup: { type: 'string', enum: ['run', 'skip', 'inherit'], description: '저장소 setup hook 정책' },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
      });
      ctx.registerCommand('orca.terminal.read', async (params) => {
        const input = record(params);
        const handle = text(input.handle).trim();
        if (!handle) throw new Error('terminal handle이 필요합니다.');
        const config = await ensureRuntime(ctx);
        const limit = Math.max(100, Math.min(5000, Number(input.limit) || 1000));
        return json(config.command, ['terminal', 'read', '--terminal', handle, '--limit', String(limit)], 20_000);
      }, {
        description: 'Orca 에이전트 터미널의 최신 출력을 읽습니다.', tool: true, destructive: false, toolWhen: CODING_REQUEST.test.bind(CODING_REQUEST),
        parameters: { type: 'object', properties: { handle: { type: 'string' }, limit: { type: 'number' } }, required: ['handle'], additionalProperties: false },
      });
      ctx.registerCommand('orca.terminal.send', async (params) => {
        const input = record(params);
        const handle = text(input.handle).trim();
        const message = text(input.text);
        if (!handle || !message) throw new Error('terminal handle과 text가 필요합니다.');
        const config = await ensureRuntime(ctx);
        return json(config.command, ['terminal', 'send', '--terminal', handle, '--text', message, '--enter'], 20_000);
      }, {
        description: '대기 중인 Orca 에이전트 터미널에 답변이나 추가 지시를 보냅니다.', tool: true, toolWhen: CODING_REQUEST.test.bind(CODING_REQUEST),
        parameters: { type: 'object', properties: { handle: { type: 'string' }, text: { type: 'string' } }, required: ['handle', 'text'], additionalProperties: false },
      });
      ctx.logger.info('Orca integration ready');
    },
  };
}
