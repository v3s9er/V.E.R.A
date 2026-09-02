import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: scriptRoot,
  encoding: 'utf8',
}).trim();
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const failures = [];
const findings = new Set();

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
    stdio: options.stdio,
  });
}

function trackedFiles() {
  return git(['ls-files', '-z']).split('\0').filter(Boolean).map((path) => path.replaceAll('\\', '/'));
}

function isText(buffer) {
  return buffer.length <= MAX_TEXT_BYTES && !buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

function forbiddenTrackedPath(path) {
  const normalized = path.replaceAll('\\', '/');
  const lower = normalized.toLowerCase();
  const rootRuntimeFiles = new Set([
    'config.json', 'config.json.bak', 'conversations.json', 'conversations.json.bak',
    'memory.json', 'schedules.json', 'routing-traces.jsonl', 'pairing-secret.dpapi',
    'android-password.dpapi',
  ]);
  if (rootRuntimeFiles.has(lower)) return 'repository-root runtime state';
  if (/^(?:\.mr-robot|context-cache|private|runtime|shared|voice|docker|signing)\//i.test(normalized)) {
    return 'repository-root runtime directory';
  }
  if (/^plugins\/[^/]+\.json$/i.test(normalized)) return 'plugin runtime state';
  if (/(?:^|\/)\.env(?:\..*)?$/i.test(normalized) || /(?:^|\/)\.dev\.vars(?:\..*)?$/i.test(normalized)) {
    return 'environment secret file';
  }
  if (/(?:^|\/)\.wrangler\//i.test(normalized)) return 'Cloudflare local state';
  if (/\.(?:dpapi|jks|keystore|p12|pfx|pkcs12|key)$/i.test(normalized)) return 'credential or signing material';
  if (/\.pem$/i.test(normalized) && !/\.(?:cert|certificate|public)\.pem$/i.test(normalized)) return 'private PEM material';
  if (/(?:^|\/)(?:credentials|service-account(?:-credentials)?)\.json$/i.test(normalized)) return 'service credential file';
  if (/(?:^|\/)\.mr-robot-output\//i.test(normalized) || /(?:^|\/)\.mr-robot-[^/]+\.part$/i.test(normalized)) {
    return 'generated work or partial transfer';
  }
  if (lower.startsWith('release/')) {
    const allowed = /^(?:release\/Mr\.Robot-Setup-[0-9.]+-x64\.exe|release\/mobile\/Mr\.Robot-Mobile-[0-9.]+\.apk|release\/SHA256SUMS-[0-9.]+\.txt)$/;
    if (!allowed.test(normalized)) return 'unexpected tracked release payload';
  }
  return undefined;
}

const secretPatterns = [
  ['private key block', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g, false],
  ['OpenAI-compatible API token', /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}\b/g, false],
  ['GitHub access token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, false],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}\b/g, false],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, false],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, false],
  ['DPAPI runtime payload', /dpapi:v1(?::|\/)[A-Za-z0-9+/=]{16,}/g, false],
  ['Cloudflare Access service secret', /\bcfast_[A-Za-z0-9]{48}\b/g, false],
  ['JWT or Cloudflare Tunnel credential', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, false],
  ['literal high-entropy credential', /["']?(?:secret|adminSecret|pairingSecret|accessClientId|accessClientSecret|clientSecret|tunnelToken|api[_-]?key)["']?\s*[:=]\s*(?:["'][A-Za-z0-9+/_=-]{32,}["']|[A-Za-z0-9+/_=-]{32,})/gi, true],
  ['pairing or one-time code', /(?:(?:current|pairing|one[- ]?time)[\s_-]*(?:pin|code)|(?:현재|일회용|페어링)\s*(?:PIN|핀|코드))\s*[:=]\s*\d{6,12}\b/gi, true],
];

// Fail closed if a future regex edit silently disables the two runtime-secret
// detectors most relevant to remote access. Build canaries dynamically so the
// audit script itself never contains a value that its repository scan flags.
for (const [kind, canary] of [
  ['DPAPI runtime payload', `dpapi:v1:${'A'.repeat(32)}`],
  ['Cloudflare Access service secret', `cfast_${'A'.repeat(48)}`],
]) {
  const entry = secretPatterns.find(([candidate]) => candidate === kind);
  if (!entry) throw new Error(`public audit detector missing: ${kind}`);
  const pattern = entry[1];
  pattern.lastIndex = 0;
  if (!pattern.test(canary)) throw new Error(`public audit detector self-test failed: ${kind}`);
}

function inspectText(label, path, text, options = {}) {
  const testFixture = /(?:^|\/)test(?:s)?\//i.test(path);
  for (const [kind, pattern, heuristic] of secretPatterns) {
    if (heuristic && (options.strongOnly === true || testFixture)) continue;
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.add(`${label}: ${path}: ${kind}`);
  }
  // Credential-bearing URL fixtures are useful in security tests. Outside a
  // test directory, however, an embedded username/password is always unsafe.
  if (options.checkEmbeddedUrl !== false && !testFixture && /https?:\/\/[^\s/:@]+:[^\s/@]+@/i.test(text)) {
    findings.add(`${label}: ${path}: URL-embedded credential`);
  }
}

function walkFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const tracked = trackedFiles();
for (const path of tracked) {
  const reason = forbiddenTrackedPath(path);
  if (reason) failures.push(`tracked path is unsafe (${reason}): ${path}`);

  const worktreePath = join(repoRoot, path);
  if (existsSync(worktreePath) && statSync(worktreePath).isFile() && statSync(worktreePath).size <= MAX_TEXT_BYTES) {
    const worktreeBuffer = readFileSync(worktreePath);
    if (isText(worktreeBuffer)) inspectText('worktree', path, worktreeBuffer.toString('utf8'));
  }
}

// A staged credential that was subsequently removed from the worktree is not
// visible in the file scan above. Inspect the staged textual patch as a second
// surface; URL fixtures are handled per-file by the worktree scan.
const stagedPatch = git(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', '.', ':(exclude)release']);
inspectText('index', '(staged changes)', stagedPatch, { checkEmbeddedUrl: false, strongOnly: true });

for (const path of tracked.filter((item) => /^(?:release\/.*\.exe|release\/mobile\/.*\.apk)$/i.test(item))) {
  const indexBuffer = git(['show', `:${path}`], { encoding: 'buffer' });
  const pointer = indexBuffer.toString('utf8');
  if (indexBuffer.length > 256 || !pointer.startsWith('version https://git-lfs.github.com/spec/v1\n') || !/\noid sha256:[a-f0-9]{64}\nsize [1-9][0-9]*\n?$/.test(pointer)) {
    failures.push(`release binary is not a valid Git LFS pointer: ${path}`);
  }
  const archiveAttribute = git(['check-attr', 'export-ignore', '--', path]).trim();
  if (!archiveAttribute.endsWith(': export-ignore: set')) {
    failures.push(`release binary is not excluded from source archives: ${path}`);
  }
}

const requiredIgnoreProbes = [
  'config.json', 'config.json.bak', 'conversations.json', 'memory.json', 'schedules.json',
  'routing-traces.jsonl', 'pairing-secret.dpapi', 'plugins/remote-link.json',
  'context-cache/stats.json', 'private/work-calendar/state.bin', 'runtime/cloudflared.yml',
  'shared/private.txt', 'voice/model/file', 'docker/ctf-toolbox/Dockerfile',
  'signing/mr-robot-release.jks', 'android-password.dpapi', '.dev.vars.local',
  '.wrangler/state.json', '.mr-robot-output/result.txt', '.mr-robot-transfer.part',
];
for (const path of requiredIgnoreProbes) {
  try {
    git(['check-ignore', '-q', '--no-index', path], { stdio: 'ignore' });
  } catch {
    failures.push(`runtime or credential path is not ignored: ${path}`);
  }
}

// Scan every reachable textual patch so a current clean tree cannot conceal a
// credential that remains downloadable from public Git history. Release LFS
// objects are excluded; their index pointers are verified separately above.
const history = git([
  'log', '--all', '-p', '--no-ext-diff', '--no-textconv', '--', '.', ':(exclude)release',
], { maxBuffer: 512 * 1024 * 1024 });
inspectText('history', '(all reachable commits)', history, { checkEmbeddedUrl: false, strongOnly: true });
const nonTestHistory = git([
  'log', '--all', '-p', '--no-ext-diff', '--no-textconv', '--', '.',
  ':(exclude)release', ':(exclude,glob)**/test/**', ':(exclude,glob)**/tests/**',
]);
inspectText('history', '(non-test reachable commits)', nonTestHistory);

// The desktop stage is exactly what electron-builder packages. Inspect it when
// present to catch accidental runtime-copy regressions even though it is ignored.
const stage = join(repoRoot, 'packages', 'desktop', '.stage');
for (const file of walkFiles(stage)) {
  const path = relative(stage, file).replaceAll('\\', '/');
  const runtimeReason = forbiddenTrackedPath(path);
  if (runtimeReason) failures.push(`desktop stage contains unsafe path (${runtimeReason}): ${path}`);
  const stat = statSync(file);
  if (stat.size <= MAX_TEXT_BYTES) {
    const buffer = readFileSync(file);
    if (isText(buffer)) inspectText('desktop stage', path, buffer.toString('utf8'));
  }
}

for (const finding of findings) failures.push(finding);

if (failures.length) {
  console.error(`PUBLIC RELEASE HYGIENE FAILED (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  const sourceCount = tracked.filter((path) => !path.startsWith('release/')).length;
  console.log(`PUBLIC RELEASE HYGIENE PASSED · ${sourceCount} source files · ${tracked.length - sourceCount} tracked release pointers`);
  console.log('Runtime/plugin state, platform credentials, signing material, and known token formats are absent from the public source surface and reachable Git history.');
}
