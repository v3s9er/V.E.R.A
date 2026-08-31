import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const dist = resolve(here, '..', 'dist');
const home = mkdtempSync(join(tmpdir(), 'mr-robot-storage-recovery-'));
const { ConfigStore, generatePin, nextPairingPin } = await import(pathToFileURL(join(dist, 'config.js')).href);
const { ConversationStore } = await import(pathToFileURL(join(dist, 'conversations.js')).href);

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name} ${detail}`);
  }
}

function corruptCopies(dir, baseName) {
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${baseName}.corrupt-`))
    .map((name) => join(dir, name));
}

console.log('1. config keeps a last-known-good backup and recovers without overwriting corrupt bytes');
{
  const dir = join(home, 'config-backup');
  const store = new ConfigStore(dir);
  store.updateSettings({ network: { ...store.settings.network, port: 31_111 } });
  store.updateSettings({ deviceName: 'newer-than-backup' });
  const backupRaw = readFileSync(store.backupFile, 'utf8');
  const corruptRaw = '{"broken":';
  writeFileSync(store.file, corruptRaw, 'utf8');

  const recovered = new ConfigStore(dir);
  const quarantined = corruptCopies(dir, 'config.json');
  check('config backup exists and contains the previous valid state', existsSync(store.backupFile) && JSON.parse(backupRaw).settings.network.port === 31_111);
  check('config restores the previous valid state', recovered.settings.network.port === 31_111);
  check('corrupt config bytes survive in a timestamped quarantine', quarantined.length === 1 && readFileSync(quarantined[0], 'utf8') === corruptRaw);
  check('config recovery is diagnosable', recovered.recovery.degraded && recovered.recovery.diagnostics.some((item) => item.code === 'config-backup-recovered'));
  check('restored config is valid JSON', Boolean(JSON.parse(readFileSync(store.file, 'utf8')).pairing));
}

console.log('2. missing config backup starts safely but preserves the original');
{
  const dir = join(home, 'config-no-backup');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'config.json');
  const corruptRaw = 'not-json-at-all';
  writeFileSync(file, corruptRaw, 'utf8');
  const recovered = new ConfigStore(dir);
  const quarantined = corruptCopies(dir, 'config.json');
  check('fresh recovery writes a valid replacement only after quarantine', Boolean(JSON.parse(readFileSync(file, 'utf8')).pairing));
  check('fresh recovery preserves exact corrupt bytes', quarantined.length === 1 && readFileSync(quarantined[0], 'utf8') === corruptRaw);
  check('fresh recovery reports that no usable backup existed', recovered.recovery.diagnostics.some((item) => item.code === 'config-fresh-recovery'));
}

console.log('3. one unavailable DPAPI secret does not discard other settings or ciphertext');
{
  const dir = join(home, 'config-secret');
  const initial = new ConfigStore(dir);
  const persisted = JSON.parse(readFileSync(initial.file, 'utf8'));
  const pairingSecret = persisted.pairing.secret;
  const protectedValue = 'dpapi:v1:not-valid-dpapi-ciphertext';
  persisted.providers = [{
    id: 'unavailable-provider',
    label: 'Unavailable provider',
    type: 'openai-compatible',
    baseUrl: 'https://example.invalid/v1',
    model: 'model',
    isDefault: true,
    apiKeyProtected: protectedValue,
  }];
  writeFileSync(initial.file, JSON.stringify(persisted, null, 2), 'utf8');

  const loaded = new ConfigStore(dir);
  check('provider survives DPAPI failure with an unavailable key', loaded.providers.length === 1 && loaded.providers[0].apiKey === '' && loaded.isProviderSecretUnavailable('unavailable-provider'));
  check('DPAPI failure is reported against only that provider', loaded.recovery.diagnostics.some((item) => item.code === 'provider-secret-unavailable' && item.providerId === 'unavailable-provider'));
  loaded.updateSettings({ deviceName: 'preserved-after-secret-failure' });
  const saved = JSON.parse(readFileSync(initial.file, 'utf8'));
  check('later saves retain unavailable ciphertext instead of deleting it', saved.providers[0].apiKeyProtected === protectedValue && saved.providers[0].apiKey === undefined);
  check('later saves preserve unrelated pairing state', saved.pairing.secret === pairingSecret);
  check('DPAPI failure does not quarantine an otherwise valid config', corruptCopies(dir, 'config.json').length === 0);
}

console.log('4. legacy pairing data receives pinCreatedAt and regeneration refreshes it');
{
  const dir = join(home, 'config-pin-migration');
  const original = new ConfigStore(dir);
  const persisted = JSON.parse(readFileSync(original.file, 'utf8'));
  delete persisted.pairing.pinCreatedAt;
  writeFileSync(original.file, JSON.stringify(persisted, null, 2), 'utf8');

  const migrated = new ConfigStore(dir);
  check('legacy PIN timestamp migrates from pairing createdAt', migrated.pinCreatedAt === persisted.pairing.createdAt);
  const beforeTimestamp = migrated.pinCreatedAt;
  const beforePin = migrated.pin;
  migrated.regeneratePin();
  const savedPairing = JSON.parse(readFileSync(migrated.file, 'utf8')).pairing;
  const collisionFallback = nextPairingPin(beforePin, () => beforePin);
  check('regeneratePin refreshes the PIN timestamp', migrated.pinCreatedAt >= beforeTimestamp && savedPairing.pinCreatedAt === migrated.pinCreatedAt);
  check('pairing PIN uses a six-digit generator contract', /^\d{6}$/.test(generatePin()));
  check('collision fallback cannot reissue the consumed PIN', collisionFallback !== beforePin && /^\d{6}$/.test(collisionFallback));
  check('regeneratePin persists a fresh six-digit PIN', migrated.pin !== beforePin && savedPairing.pin === migrated.pin && /^\d{6}$/.test(migrated.pin));
}

console.log('5. conversations recover from backup and keep corrupt source bytes');
{
  const dir = join(home, 'conversation-backup');
  const store = new ConversationStore(dir);
  const first = store.create({ title: 'last known good' });
  store.create({ title: 'newer than backup' });
  const corruptRaw = '[{"truncated":';
  writeFileSync(join(dir, 'conversations.json'), corruptRaw, 'utf8');

  const recovered = new ConversationStore(dir);
  const quarantined = corruptCopies(dir, 'conversations.json');
  check('conversation backup restores the prior committed snapshot', recovered.list().length === 1 && recovered.get(first.id)?.title === 'last known good');
  check('corrupt conversation bytes survive in timestamped quarantine', quarantined.length === 1 && readFileSync(quarantined[0], 'utf8') === corruptRaw);
  check('conversation recovery is diagnosable', recovered.recovery.degraded && recovered.recovery.diagnostics.some((item) => item.code === 'conversations-backup-recovered'));
  recovered.create({ title: 'safe after recovery' });
  check('normal saves continue after recovery', JSON.parse(readFileSync(join(dir, 'conversations.json'), 'utf8')).length === 2);
}

console.log('6. failed conversation updates roll back every in-memory field');
{
  const dir = join(home, 'conversation-update-rollback');
  const store = new ConversationStore(dir);
  const created = store.create({
    title: 'stable title',
    pinned: false,
    reasoningEffort: 'low',
    providerId: 'stable-provider',
    providerModel: 'stable-model',
    routingPresetId: 'stable-preset',
    workspaceId: 'stable-workspace',
    permissionMode: 'ask',
  });
  const beforeDetail = store.get(created.id);
  const beforeSnapshot = store.exportSnapshot().find((item) => item.id === created.id);
  const persistedBefore = readFileSync(join(dir, 'conversations.json'), 'utf8');
  const liveBefore = store.require(created.id);
  const originalSave = store.save;
  store.save = () => { throw new Error('injected save failure'); };

  let rejected = false;
  try {
    store.update(created.id, {
      title: 'must not survive',
      status: 'archived',
      pinned: true,
      reasoningEffort: 'max',
      providerId: null,
      providerModel: 'new-model',
      routingPresetId: null,
      workspaceId: null,
      permissionMode: 'full',
    });
  } catch (error) {
    rejected = error instanceof Error && error.message === 'injected save failure';
  } finally {
    store.save = originalSave;
  }

  const recoveredDetail = store.get(created.id);
  const recoveredSnapshot = store.exportSnapshot().find((item) => item.id === created.id);
  const liveAfter = store.require(created.id);
  check('injected save failure propagates to the caller', rejected);
  check('get returns the complete pre-update conversation', JSON.stringify(recoveredDetail) === JSON.stringify(beforeDetail));
  check('sync revision and ancestry are restored with the payload', JSON.stringify(recoveredSnapshot) === JSON.stringify(beforeSnapshot));
  check('rollback preserves the live conversation object identity', liveAfter === liveBefore);
  check('failed update leaves the persisted conversation unchanged', readFileSync(join(dir, 'conversations.json'), 'utf8') === persistedBefore);
}

rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? '\nSTORAGE RECOVERY TESTS PASSED' : `\n${failures} STORAGE RECOVERY FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
