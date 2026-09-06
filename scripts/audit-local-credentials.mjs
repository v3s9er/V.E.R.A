// Read-only supplemental release check. Never prints credential values or paths
// from private config. Build the agent first to use the existing DPAPI decoder.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import { SecretVault } from '../packages/agent/dist/secrets.js';

const root = resolve(import.meta.dirname, '..');
const home = join(homedir(), '.mr-robot');
const secrets = new Set();
let decoded = 0;
function add(value) {
  if (typeof value === 'string' && value.length >= 16) secrets.add(value);
}
function collect(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && /token|secret|password|api.?key|client.?id/i.test(key)) add(item);
    else if (item && typeof item === 'object') collect(item);
  }
}
function json(file) { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; }
function unprotect(value, purpose) {
  if (!value) return;
  add(value);
  const plain = new SecretVault(purpose).unprotect(value);
  decoded++;
  add(plain);
  try { collect(JSON.parse(plain)); } catch { /* scalar secret */ }
}
try {
  const config = json(join(home, 'config.json'));
  collect(config.providers);
  for (const provider of config.providers ?? []) unprotect(provider.apiKeyProtected, 'provider');
  const pairing = join(home, 'pairing-secret.dpapi');
  if (existsSync(pairing)) unprotect(readFileSync(pairing, 'utf8').trim(), 'pairing-administrator');
  const discord = json(join(home, 'plugins', 'discord-agent.json'));
  if (discord.config?.botDirectory) collect(json(join(discord.config.botDirectory, 'config.json')));
  const remote = json(join(home, 'plugins', 'remote-link.json')).config ?? {};
  collect(remote);
  unprotect(remote.tunnelTokenProtected, remote.tunnelTokenPurpose === 'remote-link-v1' ? 'remote-link' : 'provider');
  unprotect(remote.accessCredentialsProtected, remote.accessCredentialsPurpose === 'remote-link-v1' ? 'remote-link' : 'provider');
} catch {
  console.error('LOCAL CREDENTIAL AUDIT INCOMPLETE: private credential could not be read/decoded. No values logged.');
  process.exit(1);
}
if (!secrets.size) throw new Error('No local secrets available; cannot claim exact-match verification');
const needles = [...secrets].flatMap(value => [Buffer.from(value), Buffer.from(value, 'utf16le'), Buffer.from(Buffer.from(value).toString('base64'))]);
const findings = new Set();
let checked = 0;
function scan(label, value) {
  const buffer = Buffer.from(value);
  checked++;
  if (needles.some(needle => buffer.includes(needle))) findings.add(label);
}
function git(args) { return execFileSync('git', args, { cwd: root, maxBuffer: 512 * 1024 * 1024 }); }
for (const file of git(['ls-files', '-z']).toString().split('\0').filter(Boolean)) {
  if (file.startsWith('release/')) continue;
  scan(`index: ${file}`, git(['show', `:${file}`]));
}
scan('reachable Git history', git(['log', '--all', '-p', '--no-ext-diff', '--no-textconv', '--', '.', ':(exclude)release']));
function walk(folder) {
  if (!existsSync(folder)) return;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile()) scan('desktop stage', readFileSync(path));
  }
}
walk(join(root, 'packages', 'desktop', '.stage'));
const version = json(join(root, 'package.json')).version;
const apk = join(root, 'release', 'mobile', `Mr.Robot-Mobile-${version}.apk`);
if (!existsSync(apk)) throw new Error('Current APK missing; build it before release audit');
const entries = unzipSync(readFileSync(apk));
for (const [name, bytes] of Object.entries(entries)) {
  scan(`APK: ${name}`, bytes);
  if (/(?:^|\/)(?:\.env|config\.json|credentials\.json)|\.(?:dpapi|jks|keystore|pfx|key)$/i.test(name)) findings.add(`APK unexpected private path: ${name}`);
}
if (findings.size) {
  console.error('LOCAL CREDENTIAL AUDIT FAILED (values suppressed):\n' + [...findings].join('\n'));
  process.exitCode = 1;
} else {
  console.log(`LOCAL CREDENTIAL AUDIT PASSED: ${secrets.size} known values, ${decoded} DPAPI decodes, ${checked} surfaces. No credential values logged. Short PINs and unknown external secrets require separate format/manual checks.`);
}
