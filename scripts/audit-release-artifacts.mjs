// Read-only audit of GitHub release payloads (including historical installers).
// Reports categories and file locations, never matched secret values.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { listPackage, extractFile } from '@electron/asar';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repo = 'v3s9er/Mr.Robot';
const sevenZip = process.env.MR_ROBOT_AUDIT_7ZIP || 'C:/Program Files/7-Zip/7z.exe';
const parent = join(homedir(), '.mr-robot', 'private', 'audits');
mkdirSync(parent, { recursive: true });
const auditRoot = mkdtempSync(join(parent, 'release-artifacts-'));
const findings = [], scanned = [], errors = [], knownPublicFixtures = [];
const hash = b => createHash('sha256').update(b).digest('hex');
const patterns = [
  ['private-key-data', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----\s+[A-Za-z0-9+/=]{48,}/],
  ['api-token', /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['discord-token', /\b(?:[MNO][A-Za-z0-9_-]{22,30}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}|mfa\.[A-Za-z0-9_-]{80,})\b/],
  ['dpapi-payload', /dpapi:v1(?::|\/)[A-Za-z0-9+/=]{16,}/],
  ['cloudflare-access-secret', /\bcfast_[A-Za-z0-9]{48}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];
const unsafePath = path => /(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]+\.(?:dpapi|jks|keystore|p12|pfx|pkcs12|key))$/i.test(path)
  || /^(?:\.mr-robot|private|runtime|signing)\//i.test(path)
  || /^(?:config(?:\.json\.bak|\.json)|conversations(?:\.json\.bak|\.json)|native-sessions\.json|pairing-secret\.dpapi)$/.test(path);
function inspect(asset, path, bytes) {
  path = path.replaceAll('\\', '/').replace(/^\//, '');
  if (unsafePath(path)) findings.push({ asset, path, kind: 'sensitive-file-path' });
  // Read bytecode/native resources too: plaintext credentials can survive inside
  // Hermes, DEX, PE and resources even when a file is not classified as text.
  if (bytes.length > 64 * 1024 * 1024) { errors.push({ asset, path, error: 'oversized-unscanned-entry' }); return; }
  for (const encoding of ['utf8', 'utf16le']) {
    const text = bytes.toString(encoding);
    for (const [kind, re] of patterns) for (const match of text.matchAll(new RegExp(re.source, 'g'))) {
      // Verified against upstream colinhacks/zod blob
      // 3f6e086b317219915c9d4ff919ff21b6609dd42b. Narrow allowlist: exact token
      // fingerprint AND exact dependency test path, never all test credentials.
      if (kind === 'jwt' && path === 'node_modules/zod/src/v4/mini/tests/string.test.ts'
        && hash(Buffer.from(match[0])) === '7f75367e7881255134e1375e723d1dea8ad5f6a4fdb79d938df1f1754a830606') {
        knownPublicFixtures.push({ asset, path, kind: 'verified-public-zod-test-fixture' });
      } else findings.push({ asset, path, kind });
    }
  }
}
function zip(asset, bytes) {
  let total = 0;
  const files = unzipSync(bytes, { filter: f => {
    total += f.originalSize;
    if (total > 1024 * 1024 * 1024 || f.originalSize > 64 * 1024 * 1024) throw Error('archive size bound exceeded');
    return !f.name.endsWith('/');
  } });
  for (const [path, data] of Object.entries(files)) inspect(asset, path, Buffer.from(data));
}
function installer(asset, path) {
  const scratch = mkdtempSync(join(auditRoot, 'extract-'));
  try {
    // Never run the installer. Extract the NSIS payload, then only app resources.
    execFileSync(sevenZip, ['e', '-y', `-o${scratch}`, path, '$PLUGINSDIR/app-64.7z'], { stdio: 'pipe', maxBuffer: 1024 * 1024 });
    const packed = join(scratch, 'app-64.7z');
    if (!existsSync(packed)) throw Error('installer layout unsupported');
    execFileSync(sevenZip, ['x', '-y', `-o${scratch}`, packed, 'resources/*'], { stdio: 'pipe', maxBuffer: 1024 * 1024 });
    const resources = join(scratch, 'resources');
    const archive = join(resources, 'app.asar');
    if (!existsSync(archive)) throw Error('app.asar missing');
    for (const entry of listPackage(archive)) {
      let bytes;
      try { bytes = extractFile(archive, entry.replace(/^[/\\]/, '')); }
      catch (error) { if (/directory/i.test(String(error))) continue; throw error; }
      inspect(asset, entry, bytes);
    }
    const walk = (dir, prefix = '') => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name), label = prefix + entry.name;
        if (entry.isDirectory()) walk(p, label + '/');
        else if (entry.isFile() && entry.name !== 'app.asar') inspect(asset, label, readFileSync(p));
      }
    };
    walk(resources);
  } finally {
    // Fresh private audit scratch only. No repository/user directories removed.
    if (!resolve(scratch).startsWith(resolve(auditRoot) + '/'.replace('/', process.platform === 'win32' ? '\\' : '/'))) throw Error('invalid scratch path');
    rmSync(scratch, { recursive: true, force: true });
  }
}
const args = process.argv.slice(2);
let assets;
if (args.length) assets = args.map(path => ({ name: basename(path), local: resolve(path) }));
else {
  const releases = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/releases?per_page=100`, '--paginate', '--slurp'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })).flat();
  assets = releases.flatMap(r => r.assets.map(a => ({ ...a, tag: r.tag_name })));
}
for (const asset of assets) {
  try {
    if (!/^[\w. -]+$/.test(asset.name)) throw Error('invalid asset filename');
    let path = asset.local;
    if (!path) {
      const local = join(root, 'release', asset.name.endsWith('.apk') ? 'mobile' : '', asset.name);
      if (existsSync(local) && asset.digest === `sha256:${hash(readFileSync(local))}`) path = local;
      else {
        const dir = mkdtempSync(join(auditRoot, 'download-'));
        execFileSync('gh', ['release', 'download', asset.tag, '--repo', repo, '--pattern', asset.name, '--dir', dir], { stdio: 'pipe', maxBuffer: 1024 * 1024 });
        path = join(dir, asset.name);
      }
    }
    const bytes = readFileSync(path), sha256 = hash(bytes);
    if (asset.digest && asset.digest !== `sha256:${sha256}`) throw Error('download digest mismatch');
    if (/\.exe$/i.test(path)) installer(asset.name, path);
    else if (/\.(?:zip|apk)$/i.test(path)) zip(asset.name, bytes);
    else inspect(asset.name, asset.name, bytes);
    scanned.push({ name: asset.name, sha256, size: statSync(path).size });
    console.log(`Scanned ${asset.name}`);
  } catch (error) {
    // External command stderr may contain data. Never echo it into chat/logs.
    errors.push({ asset: asset.name, error: error?.status !== undefined ? 'archive-or-download-command-failed' : String(error.message).slice(0, 160) });
  }
}
const unique = [...new Map(findings.map(f => [JSON.stringify(f), f])).values()];
const fixtures = [...new Map(knownPublicFixtures.map(f => [JSON.stringify(f), f])).values()];
const report = { scanned, findings: unique, knownPublicFixtures: fixtures, errors, coverage: 'Known credential formats and sensitive paths in release archives; no guarantee against unknown/encoded historical secrets.' };
const reportPath = join(auditRoot, 'report.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ scanned: scanned.length, findings: unique, knownPublicFixtures: fixtures.length, errors, reportPath }));
if (unique.length || errors.length) process.exitCode = 1;
