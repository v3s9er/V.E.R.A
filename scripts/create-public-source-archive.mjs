import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(execFileSync('git', ['show', 'HEAD:package.json'], {
  cwd: repoRoot,
  encoding: 'utf8',
}));
const version = String(manifest.version ?? '').trim();
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error('HEAD package.json has an invalid version');

// A source archive is a snapshot of HEAD, never of the mutable working tree.
// Refuse a tracked dirty tree so release notes or hardening edits cannot be
// silently omitted. Ignored build products and untracked release assets do not
// affect this check.
for (const args of [['diff', '--quiet'], ['diff', '--cached', '--quiet']]) {
  try {
    execFileSync('git', args, { cwd: repoRoot, stdio: 'ignore' });
  } catch {
    throw new Error('commit all tracked source changes before creating the public source archive');
  }
}
const untrackedSource = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).split('\0').filter((path) => path && !path.replaceAll('\\', '/').startsWith('release/'));
if (untrackedSource.length) {
  throw new Error(`add or ignore all untracked source files before archiving (${untrackedSource.length} found)`);
}

execFileSync(process.execPath, [join(repoRoot, 'scripts', 'audit-public-release.mjs')], {
  cwd: repoRoot,
  stdio: 'inherit',
});

const output = join(repoRoot, 'release', `Mr.Robot-source-${version}.zip`);
const temporary = `${output}.partial`;
mkdirSync(dirname(output), { recursive: true });
rmSync(temporary, { force: true });
try {
  execFileSync('git', [
    'archive', '--format=zip', `--output=${temporary}`, 'HEAD', '--', '.', ':(exclude)release',
  ], { cwd: repoRoot, stdio: 'inherit' });
  if (statSync(temporary).size < 1024) throw new Error('source archive is unexpectedly small');
  rmSync(output, { force: true });
  renameSync(temporary, output);
} finally {
  rmSync(temporary, { force: true });
}
console.log(output);
