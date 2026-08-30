import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'packages', 'desktop');
const stage = join(desktop, '.stage');
const notices = join(root, 'THIRD_PARTY_NOTICES.txt');

function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}
if (!stage.startsWith(`${desktop}\\`) && !stage.startsWith(`${desktop}/`)) throw new Error('invalid desktop stage path');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

execFileSync(process.execPath, [join(root, 'scripts', 'third-party-notices.mjs')], { stdio: 'inherit' });
copyFileSync(notices, join(stage, 'THIRD_PARTY_NOTICES.txt'));

// The esbuild JS service can crash on some Windows/Node combinations when the
// workspace path contains non-ASCII characters. The CLI uses the same pinned
// binary and options without keeping the fragile service process in this Node
// instance.
const esbuildCli = join(root, 'node_modules', 'esbuild', 'bin', 'esbuild');
execFileSync(process.execPath, [
  esbuildCli,
  join(root, 'packages', 'agent', 'src', 'index.ts'),
  '--bundle',
  '--platform=node',
  '--target=node20',
  '--format=esm',
  '--external:electron',
  `--outfile=${join(stage, 'agent.mjs')}`,
  `--banner:js=import { createRequire as __mrRobotCreateRequire } from 'node:module'; const require = __mrRobotCreateRequire(import.meta.url);`,
], { stdio: 'inherit' });

copyFileSync(join(desktop, 'main.mjs'), join(stage, 'main.mjs'));
copyFileSync(join(desktop, 'preload.cjs'), join(stage, 'preload.cjs'));
const web = join(root, 'packages', 'web', 'dist');
if (!existsSync(join(web, 'index.html'))) throw new Error('web build is missing; run npm run build first');
copyTree(web, join(stage, 'web'));
writeFileSync(join(stage, 'package.json'), JSON.stringify({
  name: 'mr-robot-desktop', version: '0.3.4', description: 'Mr.Robot PC AI Agent', author: 'Mr.Robot', type: 'module', main: 'main.mjs',
}, null, 2));
console.log(`Desktop staging complete: ${stage}`);
