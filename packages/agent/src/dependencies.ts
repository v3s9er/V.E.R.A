import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { DependencyId, DependencyInfo, DependencyInstallResult } from '@mr-robot/shared';
import { mrRobotHome } from './config.js';

interface ProcessResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

interface Definition {
  id: DependencyId;
  name: string;
  description: string;
  command: string;
  versionArgs: string[];
  required: boolean;
  requiresLogin: boolean;
  wingetId?: string;
  npmPackage?: string;
  candidates: () => string[];
}

const envPath = (name: string): string => process.env[name] ?? '';
const programFiles = (): string => envPath('ProgramFiles') || 'C:\\Program Files';
const localAppData = (): string => envPath('LOCALAPPDATA');
const appData = (): string => envPath('APPDATA');
const windowsDir = (): string => envPath('WINDIR') || 'C:\\Windows';

const SENSE_VOICE_FOLDER = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
const SENSE_VOICE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${SENSE_VOICE_FOLDER}.tar.bz2`;
const KOREAN_VOICE_FOLDER = 'sherpa-onnx-zipformer-korean-2024-06-24';
const KOREAN_VOICE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${KOREAN_VOICE_FOLDER}.tar.bz2`;
const SILERO_VAD_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx';

function localVoicePaths() {
  const root = join(mrRobotHome(), 'voice');
  const modelRoot = join(root, SENSE_VOICE_FOLDER);
  const koreanRoot = join(root, KOREAN_VOICE_FOLDER);
  return {
    root,
    archive: join(root, `${SENSE_VOICE_FOLDER}.tar.bz2`),
    modelRoot,
    model: join(modelRoot, 'model.int8.onnx'),
    tokens: join(modelRoot, 'tokens.txt'),
    vad: join(root, 'silero_vad.onnx'),
    koreanRoot,
    koreanArchive: join(root, `${KOREAN_VOICE_FOLDER}.tar.bz2`),
    koreanEncoder: join(koreanRoot, 'encoder-epoch-99-avg-1.int8.onnx'),
    koreanDecoder: join(koreanRoot, 'decoder-epoch-99-avg-1.int8.onnx'),
    koreanJoiner: join(koreanRoot, 'joiner-epoch-99-avg-1.int8.onnx'),
    koreanTokens: join(koreanRoot, 'tokens.txt'),
  };
}

const DEFINITIONS: Definition[] = [
  {
    id: 'node', name: 'Node.js LTS', command: 'node', versionArgs: ['--version'], required: true, requiresLogin: false,
    description: 'Codex·Claude CLI 설치와 로컬 자동화에 필요합니다.', wingetId: 'OpenJS.NodeJS.LTS',
    candidates: () => [join(programFiles(), 'nodejs', 'node.exe')],
  },
  {
    id: 'git', name: 'Git for Windows', command: 'git', versionArgs: ['--version'], required: true, requiresLogin: false,
    description: 'Orca worktree와 코드 작업에 필요합니다.', wingetId: 'Git.Git',
    candidates: () => [join(programFiles(), 'Git', 'cmd', 'git.exe')],
  },
  {
    id: 'speech-ko', name: '로컬 한국어 음성 엔진', command: 'py', versionArgs: [], required: false, requiresLogin: false,
    description: '경량 호출 감지와 한국어 전용 고정확도 명령 인식을 오프라인으로 처리합니다. AI 토큰을 사용하지 않습니다.',
    candidates: () => [],
  },
  {
    id: 'codex', name: 'Codex CLI', command: 'codex', versionArgs: ['--version'], required: false, requiresLogin: true,
    description: 'ChatGPT 구독 기반 코딩 에이전트입니다. 설치 후 로그인이 필요합니다.', npmPackage: '@openai/codex@latest',
    candidates: () => [join(appData(), 'npm', 'codex.cmd'), join(localAppData(), 'Microsoft', 'WindowsApps', 'codex.exe')],
  },
  {
    id: 'claude', name: 'Claude Code', command: 'claude', versionArgs: ['--version'], required: false, requiresLogin: true,
    description: 'Claude 구독 기반 코딩 에이전트입니다. 설치 후 로그인이 필요합니다.', npmPackage: '@anthropic-ai/claude-code@latest',
    candidates: () => [join(appData(), 'npm', 'claude.cmd')],
  },
  {
    id: 'orca', name: 'Orca', command: 'orca', versionArgs: [], required: false, requiresLogin: false,
    description: '격리된 Git worktree에서 코딩 에이전트를 실행합니다.', wingetId: 'StablyAI.Orca',
    candidates: () => [join(localAppData(), 'Programs', 'orca', 'resources', 'bin', 'orca.exe')],
  },
  {
    id: 'ollama', name: 'Ollama', command: 'ollama', versionArgs: ['--version'], required: false, requiresLogin: false,
    description: '로컬 모델을 실행할 때 사용합니다.', wingetId: 'Ollama.Ollama',
    candidates: () => [join(localAppData(), 'Programs', 'Ollama', 'ollama.exe')],
  },
  {
    id: 'tailscale', name: 'Tailscale', command: 'tailscale', versionArgs: ['version'], required: false, requiresLogin: true,
    description: '같은 Google 계정의 휴대폰·노트북을 외부망에서도 암호화 연결합니다.', wingetId: 'Tailscale.Tailscale',
    candidates: () => [join(programFiles(), 'Tailscale', 'tailscale.exe')],
  },
  {
    id: 'docker', name: 'Docker Desktop', command: 'docker', versionArgs: ['--version'], required: false, requiresLogin: false,
    description: 'CTF 문제와 위험한 도구를 격리된 샌드박스에서 실행합니다.', wingetId: 'Docker.DockerDesktop',
    candidates: () => [join(programFiles(), 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')],
  },
];

function boundedAppend(current: string, chunk: Buffer | string, limit = 16_000): string {
  const next = current + chunk.toString();
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function run(command: string, args: string[], timeoutMs = 20_000): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode, output: output.trim(), timedOut });
    };
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, shell: false, env: process.env });
    } catch (error) {
      output = error instanceof Error ? error.message : String(error);
      finish(null);
      return;
    }
    child.stdout.on('data', (chunk) => { output = boundedAppend(output, chunk); });
    child.stderr.on('data', (chunk) => { output = boundedAppend(output, chunk); });
    child.on('error', (error) => { output = boundedAppend(output, error.message); finish(null); });
    child.on('close', (code) => finish(code));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish(null);
    }, timeoutMs);
  });
}

async function probeKoreanSpeech(definition: Definition): Promise<DependencyInfo> {
  if (process.platform !== 'win32') return {
    id: definition.id, name: definition.name, description: definition.description,
    installed: false, required: definition.required, requiresLogin: false, canInstall: false,
  };
  const paths = localVoicePaths();
  const py = await findOnPath('py') ?? (existsSync(join(windowsDir(), 'py.exe')) ? join(windowsDir(), 'py.exe') : undefined);
  const accurateModelReady = existsSync(paths.koreanEncoder) && existsSync(paths.koreanDecoder)
    && existsSync(paths.koreanJoiner) && existsSync(paths.koreanTokens);
  if (py && existsSync(paths.model) && existsSync(paths.tokens) && existsSync(paths.vad) && accurateModelReady) {
    const imports = await run(py, ['-c', 'import sherpa_onnx, sounddevice, numpy; print(sherpa_onnx.__version__)'], 20_000);
    if (imports.exitCode === 0) return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      installed: true,
      required: definition.required,
      requiresLogin: false,
      canInstall: true,
      version: `Sherpa ONNX ${imports.output.split(/\r?\n/).find(Boolean) ?? 'local'} · 한국어 Zipformer 고정확도`,
      path: paths.koreanRoot,
    };
  }

  // Older Windows images may already include a compatible Korean SAPI
  // recognizer. Keep supporting it without forcing the local model download.
  const script = [
    "$ErrorActionPreference='Stop'",
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new()',
    'Add-Type -AssemblyName System.Speech',
    "$r=[System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -eq 'ko-KR' } | Select-Object -First 1",
    "if($null -ne $r){ [Console]::Out.WriteLine('__MR_SPEECH__'+$r.Id+'|'+$r.Description) }",
  ].join('; ');
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 15_000);
  const match = result.output.split(/\r?\n/).find((line) => line.startsWith('__MR_SPEECH__'));
  const [id = '', description = ''] = match?.slice('__MR_SPEECH__'.length).split('|') ?? [];
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    installed: false,
    required: definition.required,
    requiresLogin: false,
    canInstall: true,
    ...(description ? { version: `Windows SAPI 대체 엔진 있음 · 고정확도 모델 설치 필요 (${description})` } : {}),
    ...(id ? { path: id } : {}),
  };
}

async function findOnPath(command: string): Promise<string | undefined> {
  const result = await run('where.exe', [command], 5_000);
  if (result.exitCode !== 0) return undefined;
  return result.output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

async function resolveExecutable(definition: Definition): Promise<string | undefined> {
  const known = definition.candidates().filter(Boolean).find((candidate) => existsSync(candidate));
  return known ?? findOnPath(definition.command);
}

async function probe(definition: Definition): Promise<DependencyInfo> {
  if (definition.id === 'speech-ko') return probeKoreanSpeech(definition);
  const executable = await resolveExecutable(definition);
  let version: string | undefined;
  let installed = Boolean(executable);
  if (executable && definition.versionArgs.length > 0) {
    const isCmd = executable.toLowerCase().endsWith('.cmd');
    // Windows command shims are enough to prove installation. Avoid invoking
    // them through a shell merely to display a version string.
    const result = isCmd ? null : await run(executable, definition.versionArgs, 12_000);
    if (!isCmd) installed = result?.exitCode === 0;
    if (result?.exitCode === 0) version = result.output.split(/\r?\n/).find(Boolean)?.trim();
  }
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    installed,
    required: definition.required,
    requiresLogin: definition.requiresLogin,
    canInstall: process.platform === 'win32',
    ...(version ? { version } : {}),
    ...(executable ? { path: executable } : {}),
  };
}

function npmRuntime(): { command: string; args: string[] } | null {
  const node = [join(programFiles(), 'nodejs', 'node.exe'), ...envPath('PATH').split(delimiter).map((part) => join(part, 'node.exe'))]
    .find((candidate) => candidate && existsSync(candidate));
  const cli = join(programFiles(), 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (node && existsSync(cli)) return { command: node, args: [cli] };
  return null;
}

export class DependencyManager {
  private installing: DependencyId | null = null;

  async status(): Promise<DependencyInfo[]> {
    return Promise.all(DEFINITIONS.map(probe));
  }

  has(id: string): id is DependencyId {
    return DEFINITIONS.some((definition) => definition.id === id);
  }

  async packageManagerAvailable(): Promise<boolean> {
    return Boolean(await findOnPath('winget'));
  }

  async install(id: DependencyId): Promise<DependencyInstallResult> {
    if (this.installing) throw new Error(`${this.installing} 설치가 이미 진행 중입니다.`);
    const definition = DEFINITIONS.find((item) => item.id === id);
    if (!definition) throw new Error('지원하지 않는 의존성입니다.');
    if (process.platform !== 'win32') throw new Error('자동 설치는 Windows에서만 지원됩니다.');

    this.installing = id;
    try {
      const before = await probe(definition);
      if (before.installed) return { ok: true, item: before, output: '이미 설치되어 있습니다.' };

      let result: ProcessResult;
      if (definition.id === 'speech-ko') {
        const paths = localVoicePaths();
        mkdirSync(paths.root, { recursive: true });
        let py = await findOnPath('py') ?? (existsSync(join(windowsDir(), 'py.exe')) ? join(windowsDir(), 'py.exe') : undefined);
        let combined = '';
        if (!py) {
          const winget = await findOnPath('winget');
          if (!winget) throw new Error('로컬 음성 엔진 설치에 Python과 winget이 필요합니다.');
          const pythonInstall = await run(winget, [
            'install', '--id', 'Python.Python.3.13', '--exact', '--source', 'winget', '--silent', '--disable-interactivity',
            '--accept-package-agreements', '--accept-source-agreements',
          ], 15 * 60_000);
          combined += pythonInstall.output;
          py = await findOnPath('py') ?? (existsSync(join(windowsDir(), 'py.exe')) ? join(windowsDir(), 'py.exe') : undefined);
          if (pythonInstall.exitCode !== 0 || !py) throw new Error(`Python 설치 실패: ${pythonInstall.output}`);
        }

        const pip = await run(py, ['-m', 'pip', 'install', '--user', '--disable-pip-version-check', 'sherpa-onnx==1.13.6', 'sounddevice>=0.5.0'], 15 * 60_000);
        combined += `\n${pip.output}`;
        if (pip.exitCode !== 0) {
          result = { ...pip, output: combined.trim() };
        } else {
          const curl = await findOnPath('curl.exe') ?? join(windowsDir(), 'System32', 'curl.exe');
          const tar = await findOnPath('tar.exe') ?? join(windowsDir(), 'System32', 'tar.exe');
          let failed: ProcessResult | null = null;
          if (!existsSync(paths.model) || !existsSync(paths.tokens)) {
            const download = await run(curl, ['-L', '--fail', '--retry', '3', '-o', paths.archive, SENSE_VOICE_URL], 30 * 60_000);
            combined += `\n${download.output}`;
            if (download.exitCode !== 0) failed = download;
            if (!failed) {
              const extract = await run(tar, ['-xjf', paths.archive, '-C', paths.root], 10 * 60_000);
              combined += `\n${extract.output}`;
              if (extract.exitCode !== 0) failed = extract;
            }
            if (!failed && existsSync(paths.archive)) unlinkSync(paths.archive);
          }
          if (!failed && !existsSync(paths.vad)) {
            const vad = await run(curl, ['-L', '--fail', '--retry', '3', '-o', paths.vad, SILERO_VAD_URL], 10 * 60_000);
            combined += `\n${vad.output}`;
            if (vad.exitCode !== 0) failed = vad;
          }
          if (!failed && (!existsSync(paths.koreanEncoder) || !existsSync(paths.koreanDecoder) || !existsSync(paths.koreanJoiner) || !existsSync(paths.koreanTokens))) {
            const download = await run(curl, ['-L', '--fail', '--retry', '3', '-o', paths.koreanArchive, KOREAN_VOICE_URL], 45 * 60_000);
            combined += `\n${download.output}`;
            if (download.exitCode !== 0) failed = download;
            if (!failed) {
              const extract = await run(tar, ['-xjf', paths.koreanArchive, '-C', paths.root], 15 * 60_000);
              combined += `\n${extract.output}`;
              if (extract.exitCode !== 0) failed = extract;
            }
            if (!failed && existsSync(paths.koreanArchive)) unlinkSync(paths.koreanArchive);
            // The archive also contains large fp32 copies. The runtime uses only
            // the explicit int8 files above, so remove only these known duplicates.
            if (!failed) {
              for (const duplicate of [
                join(paths.koreanRoot, 'encoder-epoch-99-avg-1.onnx'),
                join(paths.koreanRoot, 'decoder-epoch-99-avg-1.onnx'),
                join(paths.koreanRoot, 'joiner-epoch-99-avg-1.onnx'),
              ]) {
                if (existsSync(duplicate)) unlinkSync(duplicate);
              }
            }
          }
          result = failed ? { ...failed, output: combined.trim() } : { exitCode: 0, output: `${combined.trim()}\n로컬 한국어 고정확도 음성 엔진 설치 완료`.trim(), timedOut: false };
        }
      } else if (definition.wingetId) {
        const winget = await findOnPath('winget');
        if (!winget) throw new Error('Windows 패키지 관리자(winget)를 찾을 수 없습니다.');
        result = await run(winget, [
          'install', '--id', definition.wingetId, '--exact', '--source', 'winget', '--silent', '--disable-interactivity',
          '--accept-package-agreements', '--accept-source-agreements',
        ], 15 * 60_000);
      } else if (definition.npmPackage) {
        let runtime = npmRuntime();
        if (!runtime) {
          const nodeDefinition = DEFINITIONS.find((item) => item.id === 'node')!;
          const winget = await findOnPath('winget');
          if (!winget || !nodeDefinition.wingetId) throw new Error('Node.js와 winget이 필요합니다.');
          const nodeInstall = await run(winget, [
            'install', '--id', nodeDefinition.wingetId, '--exact', '--source', 'winget', '--silent', '--disable-interactivity',
            '--accept-package-agreements', '--accept-source-agreements',
          ], 15 * 60_000);
          if (nodeInstall.exitCode !== 0) throw new Error(`Node.js 설치 실패: ${nodeInstall.output}`);
          runtime = npmRuntime();
        }
        if (!runtime) throw new Error('Node.js 설치 후 npm 실행 파일을 찾지 못했습니다. 앱을 다시 시작하고 재시도하세요.');
        result = await run(runtime.command, [...runtime.args, 'install', '--global', definition.npmPackage], 15 * 60_000);
      } else {
        throw new Error('자동 설치 명령이 정의되지 않았습니다.');
      }

      const after = await probe(definition);
      const ok = result.exitCode === 0 && after.installed;
      return {
        ok,
        item: after,
        output: result.timedOut ? '설치 시간이 초과되었습니다.' : result.output || (ok ? '설치 완료' : '설치 프로그램이 실패했습니다.'),
      };
    } finally {
      this.installing = null;
    }
  }
}
