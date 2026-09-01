import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const dist = resolve(here, '..', 'dist');
const {
  ConfigStore,
  PairingSecretUnavailableError,
  generateSecret,
} = await import(pathToFileURL(join(dist, 'config.js')).href);

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name} ${detail}`);
  }
}

class MemoryProtector {
  values = new Map();
  next = 0;
  failProtect = false;
  failUnprotect = false;

  protect(value) {
    if (this.failProtect) throw new Error('injected DPAPI protect failure');
    const ciphertext = `test-dpapi:v1:${++this.next}`;
    this.values.set(ciphertext, value);
    return ciphertext;
  }

  unprotect(ciphertext) {
    if (this.failUnprotect) throw new Error('injected DPAPI unprotect failure');
    const value = this.values.get(ciphertext);
    if (!value) throw new Error('unknown test ciphertext');
    return value;
  }
}

function parse(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function hasPersistedPairingCredential(file) {
  const pairing = parse(file).pairing ?? {};
  return Object.hasOwn(pairing, 'secret') || Object.hasOwn(pairing, 'pin') || Object.hasOwn(pairing, 'pinCreatedAt');
}

function configShape(pairing) {
  return {
    settings: {},
    providers: [],
    routing: {},
    routingPresets: [],
    workspaces: [],
    pairing,
    deviceLinks: [],
  };
}

function copies(dir, prefix) {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith(prefix)) : [];
}

const home = mkdtempSync(join(tmpdir(), 'mr-robot-pairing-secret-'));

console.log('1. fresh config stores the administrator secret only as protected data');
{
  const dir = join(home, 'fresh');
  const protector = new MemoryProtector();
  const first = new ConfigStore(dir, { pairingVault: protector });
  const firstSecret = first.pairing.secret;
  const firstPin = first.pin;
  const ciphertext = readFileSync(first.pairingSecretFile, 'utf8');
  const second = new ConfigStore(dir, { pairingVault: protector });
  check('in-memory pairing API still exposes the administrator secret', /^[a-f\d]{64}$/i.test(firstSecret));
  check('config.json contains no administrator secret or short PIN', !hasPersistedPairingCredential(first.file));
  check('config.json.bak contains no administrator secret or short PIN', !hasPersistedPairingCredential(first.backupFile));
  check('protected file does not contain plaintext secret', ciphertext.length > 0 && !ciphertext.includes(firstSecret));
  check('protected secret survives restart', second.pairing.secret === firstSecret);
  check('short PIN is regenerated on restart', second.pin !== firstPin && /^\d{6}$/.test(second.pin));
}

console.log('2. legacy plaintext migrates without plaintext backup or quarantine copies');
{
  const dir = join(home, 'legacy');
  const protector = new MemoryProtector();
  const bootstrap = new ConfigStore(dir, { pairingVault: protector });
  const legacySecret = generateSecret();
  const legacyPin = '654321';
  unlinkSync(bootstrap.pairingSecretFile);
  const legacyRaw = JSON.stringify(configShape({
    secret: legacySecret,
    pin: legacyPin,
    createdAt: 1234,
    pinCreatedAt: 1234,
  }), null, 2);
  writeFileSync(bootstrap.file, legacyRaw, 'utf8');
  writeFileSync(bootstrap.backupFile, legacyRaw, 'utf8');

  const migrated = new ConfigStore(dir, { pairingVault: protector });
  const allNamedFiles = readdirSync(dir).map((name) => join(dir, name));
  check('legacy administrator secret is preserved in memory', migrated.pairing.secret === legacySecret);
  check('primary JSON is scrubbed during migration', !hasPersistedPairingCredential(migrated.file));
  check('backup JSON is scrubbed during migration', !hasPersistedPairingCredential(migrated.backupFile));
  check('migration creates no plaintext quarantine copy', copies(dir, 'config.json.corrupt-').length === 0);
  check('legacy credentials appear in no remaining named file', allNamedFiles.every((file) => !readFileSync(file, 'utf8').includes(legacySecret) && !readFileSync(file, 'utf8').includes(legacyPin)));
}

console.log('3. a stale legacy backup is scrubbed even when the primary is already safe');
{
  const dir = join(home, 'backup-scrub');
  const protector = new MemoryProtector();
  const initial = new ConfigStore(dir, { pairingVault: protector });
  const secret = initial.pairing.secret;
  const legacyBackup = configShape({ secret, pin: '123456', createdAt: 12, pinCreatedAt: 12 });
  writeFileSync(initial.backupFile, JSON.stringify(legacyBackup, null, 2), 'utf8');
  const reopened = new ConfigStore(dir, { pairingVault: protector });
  check('safe primary remains usable', reopened.pairing.secret === secret);
  check('stale plaintext backup is overwritten with safe JSON', !hasPersistedPairingCredential(reopened.backupFile));
  check('backup scrub creates no quarantine copy', copies(dir, 'config.json.bak.corrupt-').length === 0);
}

console.log('4. DPAPI failure fails closed without copying plaintext credentials');
{
  const freshDir = join(home, 'dpapi-fresh-failure');
  const freshProtector = new MemoryProtector();
  freshProtector.failProtect = true;
  let freshRejected = false;
  try { new ConfigStore(freshDir, { pairingVault: freshProtector }); }
  catch (error) { freshRejected = error instanceof PairingSecretUnavailableError; }
  check('fresh startup rejects unavailable DPAPI', freshRejected);
  check('fresh failure writes no config, backup, or secret file', !existsSync(join(freshDir, 'config.json')) && !existsSync(join(freshDir, 'config.json.bak')) && !existsSync(join(freshDir, 'pairing-secret.dpapi')));

  const legacyDir = join(home, 'dpapi-legacy-failure');
  mkdirSync(legacyDir, { recursive: true });
  const legacySecret = generateSecret();
  const legacyFile = join(legacyDir, 'config.json');
  const legacyRaw = JSON.stringify(configShape({ secret: legacySecret, pin: '234567', createdAt: 34, pinCreatedAt: 34 }), null, 2);
  writeFileSync(legacyFile, legacyRaw, 'utf8');
  const legacyProtector = new MemoryProtector();
  legacyProtector.failProtect = true;
  let legacyRejected = false;
  try { new ConfigStore(legacyDir, { pairingVault: legacyProtector }); }
  catch (error) { legacyRejected = error instanceof PairingSecretUnavailableError; }
  check('legacy migration rejects unavailable DPAPI', legacyRejected);
  check('failed migration leaves only the original file', readFileSync(legacyFile, 'utf8') === legacyRaw && copies(legacyDir, 'config.json.bak').length === 0 && copies(legacyDir, 'config.json.corrupt-').length === 0);

  const protectedDir = join(home, 'dpapi-unprotect-failure');
  const protectedVault = new MemoryProtector();
  const protectedStore = new ConfigStore(protectedDir, { pairingVault: protectedVault });
  protectedVault.failUnprotect = true;
  let protectedRejected = false;
  try { new ConfigStore(protectedDir, { pairingVault: protectedVault }); }
  catch (error) { protectedRejected = error instanceof PairingSecretUnavailableError; }
  check('unreadable protected secret rejects startup', protectedRejected);
  check('DPAPI failure does not quarantine an otherwise valid config', copies(protectedDir, 'config.json.corrupt-').length === 0 && existsSync(protectedStore.file));
}

console.log('5. secret rotation atomically changes DPAPI state and revokes links');
{
  const dir = join(home, 'rotation');
  const protector = new MemoryProtector();
  const store = new ConfigStore(dir, { pairingVault: protector });
  const link = store.createDeviceLink('rotation test', 'ask');
  const beforeSecret = store.pairing.secret;
  const beforeCiphertext = readFileSync(store.pairingSecretFile, 'utf8');
  const rotated = store.regenerateSecret();
  const afterCiphertext = readFileSync(store.pairingSecretFile, 'utf8');
  const reopened = new ConfigStore(dir, { pairingVault: protector });
  check('rotation returns a different administrator secret', rotated !== beforeSecret && store.pairing.secret === rotated);
  check('rotation changes protected storage without writing plaintext', afterCiphertext !== beforeCiphertext && !afterCiphertext.includes(rotated));
  check('restarted config loads only the rotated secret', reopened.pairing.secret === rotated && reopened.pairing.secret !== beforeSecret);
  check('rotation revokes every existing device link', reopened.deviceLinks.some((item) => item.id === link.link.id && typeof item.revokedAt === 'number'));
  check('rotated primary and backup remain credential-free', !hasPersistedPairingCredential(store.file) && !hasPersistedPairingCredential(store.backupFile));
}

console.log('6. corrupt-primary recovery invalidates credentials preserved in quarantine');
{
  const dir = join(home, 'corrupt-primary-rotation');
  const protector = new MemoryProtector();
  const initial = new ConfigStore(dir, { pairingVault: protector });
  const link = initial.createDeviceLink('must be revoked after recovery', 'ask');
  initial.updateSettings({ deviceName: 'backup includes link' });
  const exposedSecret = initial.pairing.secret;
  const malformed = `{"pairing":{"secret":"${exposedSecret}","truncated":`;
  writeFileSync(initial.file, malformed, 'utf8');

  const recovered = new ConfigStore(dir, { pairingVault: protector });
  const quarantined = copies(dir, 'config.json.corrupt-');
  const quarantinedRaw = quarantined.length === 1 ? readFileSync(join(dir, quarantined[0]), 'utf8') : '';
  const recoveredLink = recovered.deviceLinks.find((item) => item.id === link.link.id);
  check('malformed primary is retained for recovery diagnostics', quarantinedRaw === malformed);
  check('credential still visible in quarantine is no longer valid', quarantinedRaw.includes(exposedSecret) && recovered.pairing.secret !== exposedSecret);
  check('protected storage contains the rotated credential', new ConfigStore(dir, { pairingVault: protector }).pairing.secret === recovered.pairing.secret);
  check('backup recovery revokes every previously active device link', typeof recoveredLink?.revokedAt === 'number');
  check('recovered primary and backup contain no active credential', !hasPersistedPairingCredential(recovered.file) && !hasPersistedPairingCredential(recovered.backupFile));
}

rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? '\nPAIRING SECRET STORAGE TESTS PASSED' : `\n${failures} PAIRING SECRET STORAGE FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
