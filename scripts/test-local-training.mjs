import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const help = 'Python 3.10 이상 실행 파일을 준비한 뒤 MR_ROBOT_PYTHON에 전체 경로를 지정하세요. PowerShell 예: $env:MR_ROBOT_PYTHON = "C:\\Python312\\python.exe"; npm run test:local-training';
const isFile = file => { try { return existsSync(file) && statSync(file).isFile(); } catch { return false; } };
const storeAlias = value => /(?:^|[\\/])Microsoft[\\/]WindowsApps(?:[\\/]|$)/i.test(value);

/** Find exact binaries, never shell aliases, command fragments or .cmd files. */
export function pythonCandidates(env = process.env, platform = process.platform, fileExists = isFile) {
  const windows = platform === 'win32';
  const pathOps = windows ? win32 : { isAbsolute, join, resolve };
  const explicit = env.MR_ROBOT_PYTHON;
  if (explicit !== undefined) {
    if (!explicit || explicit !== explicit.trim() || !pathOps.isAbsolute(explicit) || (windows && !/\.exe$/i.test(explicit)) || storeAlias(explicit) || !fileExists(explicit)) {
      throw new Error(`MR_ROBOT_PYTHON은 명령어나 별칭이 아닌 실제 Python 실행 파일의 절대 경로여야 합니다. ${help}`);
    }
    return [{ command: explicit, prefix: [] }];
  }
  const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
  const dirs = [...new Set(pathValue.split(windows ? ';' : delimiter).map(value => value.replace(/^"|"$/g, '').trim()).filter(value => value && pathOps.isAbsolute(value) && !storeAlias(value)))];
  const names = windows ? ['python.exe', 'python3.exe', 'py.exe'] : ['python', 'python3', 'py'];
  const candidates = [];
  const seen = new Set();
  for (const name of names) for (const directory of dirs) {
    const command = pathOps.join(directory, name);
    const key = windows ? command.toLowerCase() : command;
    if (!seen.has(key) && fileExists(command)) {
      seen.add(key); candidates.push({ command, prefix: /^py(?:\.exe)?$/i.test(name) ? ['-3'] : [] });
    }
  }
  return candidates.slice(0, 24);
}

export function probePython(candidate, run = spawnSync) {
  const result = run(candidate.command, [...candidate.prefix, '-I', '-c', 'import json,sys; print(json.dumps({"version": list(sys.version_info[:3]), "executable": sys.executable}))'], {
    cwd: root, env: process.env, shell: false, windowsHide: true, timeout: 3000, maxBuffer: 8192, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) return undefined;
  try {
    const value = JSON.parse(result.stdout);
    if (!Array.isArray(value.version) || value.version.length !== 3 || value.version.some(number => !Number.isInteger(number)) || value.version[0] !== 3 || value.version[1] < 10 || typeof value.executable !== 'string' || !value.executable) return undefined;
    return { ...candidate, version: value.version };
  } catch { return undefined; }
}

export function main() {
  let selected;
  try {
    for (const candidate of pythonCandidates()) {
      selected = probePython(candidate);
      if (selected) break;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : help);
    return 1;
  }
  if (!selected) { console.error(`실행 가능한 Python 3.10 이상을 찾지 못했습니다. Windows Store 별칭은 사용하지 않습니다. ${help}`); return 1; }
  console.log(`Python ${selected.version.join('.')} · 합성 로컬 학습 테스트만 실행합니다. 설치·다운로드·모델 학습은 하지 않습니다.`);
  const result = spawnSync(selected.command, [...selected.prefix, '-I', '-m', 'unittest', 'discover', '-s', 'scripts/tests', '-p', 'test_local_finetune.py', '-v'], {
    cwd: root, env: process.env, shell: false, windowsHide: true, timeout: 180_000, stdio: 'inherit',
  });
  if (result.error) { console.error(`Python 테스트 실행 실패 (${result.error.code ?? 'unknown'}). ${help}`); return 1; }
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
