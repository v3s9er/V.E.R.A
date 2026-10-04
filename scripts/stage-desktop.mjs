import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'packages', 'desktop');
const stage = join(desktop, '.stage');
const notices = join(root, 'THIRD_PARTY_NOTICES.txt');

function copyTree(source, destination, skipModules = false) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory() && !(skipModules && entry.name === 'node_modules')) copyTree(from, to, skipModules);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}
// Preserve npm's installed resolution layout and include only production edges.
// No startup installs/downloads and no development dependency tree in the app.
const stagedModules = new Set();
function stageDependency(name, from = root, optional = false) {
  const paths = createRequire(join(from, 'package.json')).resolve.paths(name) ?? [];
  const source = paths.map(path => join(path, name)).find(path => existsSync(join(path, 'package.json')));
  if (!source) { if (optional) return; throw new Error(`Missing runtime dependency: ${name}`); }
  const location = relative(root, source);
  if (!location.startsWith(`node_modules${sep}`) || location.split(sep).includes('..')) throw new Error(`Runtime dependency outside install root: ${name}`);
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (stagedModules.has(source)) return manifest.version;
  stagedModules.add(source);
  copyTree(source, join(stage, location), true);
  for (const dep of Object.keys(manifest.dependencies ?? {})) stageDependency(dep, source);
  for (const dep of Object.keys(manifest.optionalDependencies ?? {})) stageDependency(dep, source, true);
  for (const dep of Object.keys(manifest.peerDependencies ?? {})) stageDependency(dep, source, manifest.peerDependenciesMeta?.[dep]?.optional === true);
  return manifest.version;
}
if (!stage.startsWith(`${desktop}\\`) && !stage.startsWith(`${desktop}/`)) throw new Error('invalid desktop stage path');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

execFileSync(process.execPath, [join(root, 'scripts', 'third-party-notices.mjs')], { stdio: 'inherit' });
copyFileSync(notices, join(stage, 'THIRD_PARTY_NOTICES.txt'));
copyFileSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));

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
  '--external:playwright-core',
  `--outfile=${join(stage, 'agent.mjs')}`,
  `--banner:js=import { createRequire as __mrRobotCreateRequire } from 'node:module'; const require = __mrRobotCreateRequire(import.meta.url);`,
], { stdio: 'inherit' });

copyFileSync(join(desktop, 'main.mjs'), join(stage, 'main.mjs'));
copyFileSync(join(desktop, 'window-recovery.mjs'), join(stage, 'window-recovery.mjs'));
copyFileSync(join(desktop, 'window-bounds.mjs'), join(stage, 'window-bounds.mjs'));
copyFileSync(join(desktop, 'branding.mjs'), join(stage, 'branding.mjs'));
copyFileSync(join(desktop, 'nmap-route.mjs'), join(stage, 'nmap-route.mjs'));
copyFileSync(join(desktop, 'remote-pair-security.mjs'), join(stage, 'remote-pair-security.mjs'));
copyFileSync(join(desktop, 'preload.cjs'), join(stage, 'preload.cjs'));
// Exact tooling allowlist: never package page sources, frontend assets, or
// generated Workers from the publisher's development directory.
for (const name of ['index.mjs', 'scripts/site_manager.py', 'scripts/build_worker.py', 'scripts/serve_preview.py']) {
  const destination = join(stage, 'plugins', 'mr-robot', name);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(root, 'plugins', 'mr-robot', name), destination);
}
mkdirSync(join(stage, 'integrations', 'lid-display'), { recursive: true });
mkdirSync(join(stage, 'integrations', 'computer-use'), { recursive: true });
mkdirSync(join(stage, 'integrations', 'evidence-ocr'), { recursive: true });
for (const name of ['runtime.cjs', 'README.md', 'NOTICE.txt']) copyFileSync(join(root, 'integrations', 'evidence-ocr', name), join(stage, 'integrations', 'evidence-ocr', name));
// Exact offline-training allowlist: never bundle datasets, weights or private state.
mkdirSync(join(stage, 'integrations', 'local-training'), { recursive: true });
copyFileSync(join(root, 'scripts', 'local-finetune.py'), join(stage, 'integrations', 'local-training', 'local-finetune.py'));
copyFileSync(join(root, 'docs', 'local-finetuning.md'), join(stage, 'integrations', 'local-training', 'README.md'));
copyFileSync(join(root, 'integrations', 'computer-use', 'runtime.ps1'), join(stage, 'integrations', 'computer-use', 'runtime.ps1'));
for (const name of ['bridge.ps1', 'LidDisplay.cs', 'README.md']) copyFileSync(join(root, 'integrations', 'lid-display', name), join(stage, 'integrations', 'lid-display', name));
mkdirSync(join(stage, 'integrations', 'discordbot'), { recursive: true });
copyFileSync(join(root, 'integrations', 'discordbot', 'LICENSE'), join(stage, 'integrations', 'discordbot', 'LICENSE'));
for (const name of ['bridge.py', 'presentation.py', 'standalone.py', 'legacy_adapter.py', 'thread_sessions.py', 'attachments.py', 'attachment_cache.py', 'attachment_worker.py', 'audio_worker.py', 'attachment_ocr.ps1', 'requirements.txt', 'README.md']) copyFileSync(join(root, 'integrations', 'discordbot', name), join(stage, 'integrations', 'discordbot', name));
// Keep the live window and tray on the exact same full icon as Android.
copyFileSync(join(root, 'apps', 'mobile', 'assets', 'icon.png'), join(stage, 'icon.png'));
// main.mjs uses ws for native Cloudflare Access headers on WSS upgrades.
// Copy the audited runtime dependency because the staged Electron app is
// intentionally self-contained and does not run npm install at startup.
const dependencies = Object.fromEntries(['ws', 'pngjs', 'tesseract.js', '@tesseract.js-data/eng', 'playwright-core'].map(name => [name, stageDependency(name)]));
const web = join(root, 'packages', 'web', 'dist');
if (!existsSync(join(web, 'index.html'))) throw new Error('web build is missing; run npm run build first');
copyTree(web, join(stage, 'web'));
writeFileSync(join(stage, 'package.json'), JSON.stringify({
  name: 'mr-robot-desktop', version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, license: 'MIT', description: 'V.E.R.A PC AI Agent', author: 'v3s9er', type: 'module', main: 'main.mjs', dependencies,
}, null, 2));
console.log(`Desktop staging complete: ${stage}`);
