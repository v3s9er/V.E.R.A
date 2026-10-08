// Installs optional upstream tools separately from VERA's source/distribution.
// Never edits a Codex/Claude profile, registers a server or copies credentials.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const pins = Object.freeze({ context7: '4.2.0', serena: '1.7.0', uv: '0.12.23' });
export function setupPlan(home, python) {
  if (!isAbsolute(home) || !isAbsolute(python) || /[\0\r\n]/.test(home + python)) throw new Error('Absolute home and Python paths required');
  const root = join(home, 'tools');
  return { root, python, context7: join(root, `context7-${pins.context7}`), serena: join(root, `serena-${pins.serena}`) };
}
function run(executable, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`Tool setup exited ${code}`)));
  });
}
export async function main(argv) {
  const install = argv.includes('--install');
  const rest = argv.filter(value => value !== '--install');
  if (rest.length !== 2 || rest[0] !== '--python') throw new Error('Usage: npm run setup:harness-tools -- --python ABSOLUTE_PYTHON [--install]');
  const plan = setupPlan(process.env.MR_ROBOT_HOME ?? join(homedir(), '.mr-robot'), rest[1]);
  console.log(JSON.stringify({ mode: install ? 'install' : 'plan-only', ...plan, versions: pins,
    notice: 'Separate upstream packages with their own licenses. No client configuration or account changes.' }));
  if (!install) return;
  if (!existsSync(plan.python)) throw new Error('Python executable not found');
  const npm = process.env.npm_execpath;
  if (!npm || !isAbsolute(npm) || !existsSync(npm)) throw new Error('Run through npm run setup:harness-tools');
  mkdirSync(plan.root, { recursive: true });
  await run(process.execPath, [npm, 'install', '--prefix', plan.context7, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `@upstash/context7-mcp@${pins.context7}`]);
  const venvPython = join(plan.serena, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  if (!existsSync(venvPython)) await run(plan.python, ['-m', 'venv', plan.serena]);
  await run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', `uv==${pins.uv}`, `serena-agent==${pins.serena}`]);
  console.log('Installed. In VERA Plugins > MCP, load the installed path, choose a project for Serena, and save.');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
