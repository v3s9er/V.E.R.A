import { isAbsolute, join, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { mrRobotHome } from '../config.js';

export const MCP_PRESETS = [
  {
    id: 'context7', name: 'Context7',
    description: '라이브러리 이름과 버전을 좁혀 최신 API 문서를 조회합니다.',
    documentation: 'https://context7.com/docs/resources/developer',
    requiredEnvironment: [],
    optionalEnvironment: ['CONTEXT7_API_KEY'],
    setup: '공식 Context7 MCP를 검토·설치한 뒤 dist/index.js의 절대 경로를 지정하세요. API 키는 mcp.servers.add의 env로만 전달하세요.',
  },
  {
    id: 'serena', name: 'Serena',
    description: '지정한 코드 프로젝트의 심볼과 참조를 필요한 범위만 조회합니다.',
    documentation: 'https://oraios.github.io/serena/02-usage/020_running.html',
    requiredEnvironment: [],
    setup: '공식 Serena를 검토·설치한 뒤 실행 파일의 절대 경로와 프로젝트의 절대 경로를 지정하세요. 프로젝트별 서버 ID를 사용하세요.',
  },
] as const;

function absolutePath(raw: unknown, name: string): string {
  if (typeof raw !== 'string' || (!isAbsolute(raw) && !win32.isAbsolute(raw)) || /[\0\r\n]/.test(raw)) {
    throw new Error(`${name}에 절대 경로를 입력하세요.`);
  }
  return raw;
}

/** Electron's execPath is the app binary, including in packaged agent processes. */
export function context7NodeCommand(execPath = process.execPath, electron = Boolean(process.versions.electron)): string {
  if (!electron && (isAbsolute(execPath) || win32.isAbsolute(execPath)) && /^node(?:\.exe)?$/i.test(win32.basename(execPath))) return execPath;
  // Resolve a separately installed Node runtime through the host PATH. Never
  // reuse an application executable as a JavaScript interpreter.
  return 'node';
}

/** Preview only: never installs, launches, persists, authenticates or enables a server. */
export function previewMcpPreset(raw: unknown) {
  const body = (raw ?? {}) as { preset?: unknown; executablePath?: unknown; projectRoot?: unknown };
  const executablePath = absolutePath(body.executablePath, 'executablePath');
  if (body.preset === 'context7') {
    if (!/\.[cm]?js$/i.test(executablePath)) throw new Error('Context7의 설치된 JavaScript 진입 파일을 지정하세요.');
    return {
      id: 'context7', name: 'Context7', command: context7NodeCommand(),
      args: [executablePath, '--transport', 'stdio'], env: {}, enabled: false,
    };
  }
  if (body.preset === 'serena') {
    const projectRoot = absolutePath(body.projectRoot, 'projectRoot');
    return {
      id: 'serena', name: 'Serena', command: executablePath,
      args: ['start-mcp-server', '--transport', 'stdio', '--context', 'ide', '--project', projectRoot, '--open-web-dashboard', 'false', '--enable-web-dashboard', 'false', '--enable-gui-log-window', 'false'],
      cwd: projectRoot,
      env: {
        // Explicit private directories also avoid Windows packaged-app AppData redirection.
        UV_PYTHON_INSTALL_DIR: join(mrRobotHome(), 'tools', 'uv-python'),
        UV_CACHE_DIR: join(mrRobotHome(), 'tools', 'uv-cache'),
        SERENA_HOME: join(mrRobotHome(), 'tools', 'serena-state', createHash('sha256').update(projectRoot).digest('hex').slice(0, 24)),
      }, enabled: false,
    };
  }
  throw new Error('지원하는 MCP 프리셋은 context7, serena입니다.');
}
