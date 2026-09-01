import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const types = read('src/types.ts');
const pcs = read('src/pcs.ts');
const rpc = read('src/rpc.ts');
const app = read('App.tsx');
const pcList = read('src/screens/PcListScreen.tsx');
const files = read('src/screens/FilesScreen.tsx');
const chat = read('src/screens/ChatScreen.tsx');
const androidApplication = read('android/app/src/main/java/com/mrrobot/mobile/MainApplication.kt');
const dependencyPatch = read('../../scripts/patch-expo-file-system-security.mjs');
const installedLegacyFileSystem = read('node_modules/expo-file-system/android/src/main/java/expo/modules/filesystem/legacy/FileSystemLegacyModule.kt');
const mobilePackage = JSON.parse(read('package.json'));

function check(description, condition) {
  if (!condition) throw new Error(`CLOUDFLARE ACCESS CONTRACT FAILED: ${description}`);
}

const pairingBundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/pairing.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const { parsePairingPayload } = await import(`data:text/javascript;base64,${Buffer.from(pairingBundle.outputFiles[0].contents).toString('base64')}`);

const basePayload = {
  app: 'mr-robot',
  host: 'https://robot.example.com',
  protocol: 'https',
  port: 443,
  pin: '123456',
};
const cloudflareAccess = { clientId: 'mobile-client.access', clientSecret: 'service-token-secret' };
const validExpiresAt = Date.now() + 60_000;

check('legacy version 3 QR remains supported', parsePairingPayload(JSON.stringify({ ...basePayload, version: 3 }))?.version === 3);
const v4 = parsePairingPayload(JSON.stringify({ ...basePayload, version: 4, expiresAt: validExpiresAt, cloudflareAccess }));
check('version 4 QR carries a complete Access service token', v4?.cloudflareAccess?.clientId === cloudflareAccess.clientId
  && v4.cloudflareAccess.clientSecret === cloudflareAccess.clientSecret
  && v4.cloudflareAccessOrigin === 'https://robot.example.com:443');
check('version 3 QR cannot smuggle Access credentials', parsePairingPayload(JSON.stringify({ ...basePayload, version: 3, cloudflareAccess })) === null);
const namedHandoff = parsePairingPayload(JSON.stringify({
  ...basePayload,
  version: 3,
  expiresAt: validExpiresAt,
  requiresCloudflareAccess: true,
}));
check('named handoff QR carries only a bounded one-use marker, never an Access secret',
  namedHandoff?.requiresCloudflareAccess === true
  && namedHandoff.expiresAt === validExpiresAt
  && namedHandoff.cloudflareAccess === undefined);
check('partial Access credentials are rejected', parsePairingPayload(JSON.stringify({
  ...basePayload,
  version: 4,
  expiresAt: validExpiresAt,
  cloudflareAccess: { clientId: cloudflareAccess.clientId },
})) === null);
check('header injection is rejected', parsePairingPayload(JSON.stringify({
  ...basePayload,
  version: 4,
  expiresAt: validExpiresAt,
  cloudflareAccess: { ...cloudflareAccess, clientSecret: 'secret\r\nInjected: yes' },
})) === null);
check('version 4 QR requires a live bounded expiry',
  parsePairingPayload(JSON.stringify({ ...basePayload, version: 4, cloudflareAccess })) === null
  && parsePairingPayload(JSON.stringify({ ...basePayload, version: 4, expiresAt: Date.now() - 1, cloudflareAccess })) === null
  && parsePairingPayload(JSON.stringify({ ...basePayload, version: 4, expiresAt: Date.now() + 26 * 60 * 60_000, cloudflareAccess })) === null
  && v4?.expiresAt === validExpiresAt);
check('version 4 QR always requires complete Access credentials', parsePairingPayload(JSON.stringify({
  ...basePayload,
  version: 4,
  expiresAt: validExpiresAt,
})) === null);

check('wire types expose version 3 and 4 without making Access mandatory', types.includes('version: 3 | 4;')
  && types.includes('cloudflareAccess?: CloudflareAccessCredentials;')
  && types.includes('requiresCloudflareAccess?: boolean;'));
check('both Access values have independent SecureStore namespaces', pcs.includes('CF_ACCESS_CLIENT_ID_PREFIX')
  && pcs.includes('CF_ACCESS_CLIENT_SECRET_PREFIX'));
check('AsyncStorage serialization strips agent and Access credentials', pcs.includes('function withoutCredentials')
  && pcs.includes('cloudflareAccess: _cloudflareAccess')
  && pcs.includes('JSON.stringify(normalized.map(withoutCredentials))'));
check('legacy plaintext Access metadata is migrated then removed', pcs.includes("Object.prototype.hasOwnProperty.call(item, 'cloudflareAccess')")
  && pcs.includes('SecureStore.setItemAsync(cloudflareAccessClientIdKey(item.id)')
  && pcs.includes('SecureStore.setItemAsync(cloudflareAccessClientSecretKey(item.id)'));
check('deleting a PC deletes all three secure credential entries', pcs.includes('SecureStore.deleteItemAsync(secretKey(pc.id))')
  && pcs.includes('SecureStore.deleteItemAsync(cloudflareAccessClientIdKey(pc.id))')
  && pcs.includes('SecureStore.deleteItemAsync(cloudflareAccessClientSecretKey(pc.id))'));

check('pair exchange binds Access headers to the exact enrollment origin', pcs.includes('cloudflareAccessHeaders(cloudflareAccess, binding, base)'));
check('ticket exchange binds Access headers to the exact WSS origin', rpc.includes('cloudflareAccessHeaders(cloudflareAccess, cloudflareAccessOrigin, requestOrigin)'));
check('credential-bearing native fetches reject redirects', pcs.includes("redirect: 'error'")
  && rpc.includes("redirect: 'error'")
  && (files.match(/redirect: 'error'/g) ?? []).length >= 3);
check('WSS upgrade uses React Native custom headers', rpc.includes('new ReactNativeWebSocket(url, protocols, { headers: accessHeaders })'));
check('native OkHttp WebSocket redirects are disabled before React Native starts', androidApplication.includes('WebSocketModule.setCustomClientBuilder')
  && androidApplication.includes('followRedirects(false)')
  && androidApplication.includes('followSslRedirects(false)')
  && androidApplication.indexOf('WebSocketModule.setCustomClientBuilder') < androidApplication.indexOf('loadReactNative(this)'));
check('streaming Expo FileSystem upload/download redirects are disabled without buffering files in JS memory', dependencyPatch.includes('followRedirects(false)')
  && dependencyPatch.includes('followSslRedirects(false)')
  && installedLegacyFileSystem.includes('followRedirects(false)')
  && installedLegacyFileSystem.includes('followSslRedirects(false)')
  && files.includes('FileSystem.createUploadTask')
  && files.includes('FileSystem.createDownloadResumable'));
check('Android compiles the patched expo-file-system source instead of the unmodified prebuilt Maven artifact', mobilePackage.expo?.autolinking?.android?.buildFromSource?.includes('expo-file-system') === true);
check('Expo dependency upgrades fail installation instead of silently losing redirect hardening', dependencyPatch.includes('throw new Error')
  && dependencyPatch.includes('refusing to install without redirect hardening'));
check('file transfers reject every redirect response before reporting success or sharing', (files.match(/result\.status < 200 \|\| result\.status >= 300/g) ?? []).length >= 2
  && chat.includes('result.status < 200 || result.status >= 300'));
check('plaintext WebSocket rejects bound Access credentials', rpc.includes("Object.keys(accessHeaders).length && parsed.protocol !== 'wss:'"));
check('manual registration accepts both Access values', pcList.includes('optionalCloudflareAccess(accessClientId, accessClientSecret)')
  && pcList.includes('secureTextEntry'));
check('QR registration forwards version 4 Access values and exact origin binding', pcList.includes('payload.cloudflareAccessOrigin'));
check('secret-free named QR moves to local Android Access entry before enrollment',
  pcList.includes('payload.requiresCloudflareAccess && !payload.cloudflareAccess')
  && pcList.includes('setHostPort(primary.origin)')
  && pcList.includes('setAccessRequired(true)')
  && pcList.includes('if (accessRequired && !cloudflareAccess)')
  && pcList.includes('setShowAdd(true)'));
check('successful QR enrollment drops the credential-bearing payload from React state', pcList.includes('setDetectedPayload(null);')
  && pcList.indexOf('setDetectedPayload(null);', pcList.indexOf('if (connected)')) > pcList.indexOf('if (connected)'));
check('manual connection and automatic reconnect both pass Access credentials and origin binding', pcList.includes('pc.cloudflareAccessOrigin')
  && app.includes('pc.cloudflareAccessOrigin'));
check('file APIs use the shared authenticated header builder', (files.match(/pcAuthenticatedHeaders\(/g) ?? []).length >= 7);
check('chat attachment upload uses the shared authenticated header builder', chat.includes('headers: pcAuthenticatedHeaders(pc,'));
check('mobile screens contain no remaining direct bearer-only header literal', !files.includes("headers: { 'x-mr-robot-token'")
  && !chat.includes("headers: { 'content-type': file.mimeType")
  && !pcList.includes("headers: { 'x-mr-robot-token'"));

const asyncStorage = new Map();
const secureStorage = new Map();
globalThis.__mrRobotAsyncStorageMock = {
  getItem: async (key) => asyncStorage.get(key) ?? null,
  setItem: async (key, value) => { asyncStorage.set(key, value); },
  removeItem: async (key) => { asyncStorage.delete(key); },
};
globalThis.__mrRobotSecureStoreMock = {
  getItemAsync: async (key) => secureStorage.get(key) ?? null,
  setItemAsync: async (key, value) => { secureStorage.set(key, value); },
  deleteItemAsync: async (key) => { secureStorage.delete(key); },
};

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/pcs.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [{
    name: 'mobile-storage-mocks',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@react-native-async-storage\/async-storage$/ }, () => ({ path: 'async-storage', namespace: 'storage-mock' }));
      buildApi.onResolve({ filter: /^expo-secure-store$/ }, () => ({ path: 'secure-store', namespace: 'storage-mock' }));
      buildApi.onLoad({ filter: /^async-storage$/, namespace: 'storage-mock' }, () => ({
        contents: 'export default globalThis.__mrRobotAsyncStorageMock;',
        loader: 'js',
      }));
      buildApi.onLoad({ filter: /^secure-store$/, namespace: 'storage-mock' }, () => ({
        contents: [
          'export const getItemAsync = (...args) => globalThis.__mrRobotSecureStoreMock.getItemAsync(...args);',
          'export const setItemAsync = (...args) => globalThis.__mrRobotSecureStoreMock.setItemAsync(...args);',
          'export const deleteItemAsync = (...args) => globalThis.__mrRobotSecureStoreMock.deleteItemAsync(...args);',
        ].join('\n'),
        loader: 'js',
      }));
    },
  }],
});
const pcsRuntime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
await pcsRuntime.loadPcs();
const runtimePc = {
  id: 'pc-secure-test',
  name: 'Secure PC',
  host: 'robot.example.com',
  protocol: 'https',
  port: 443,
  origins: ['https://robot.example.com:443'],
  secret: 'agent-bearer-secret',
  cloudflareAccess,
  cloudflareAccessConfigured: true,
  cloudflareAccessOrigin: 'https://robot.example.com:443',
  addedAt: 1,
};
await pcsRuntime.savePcs([runtimePc]);
const storedMetadata = asyncStorage.get('mr-robot.pcs');
check('runtime save never writes bearer or Access values to AsyncStorage', typeof storedMetadata === 'string'
  && !storedMetadata.includes(runtimePc.secret)
  && !storedMetadata.includes(cloudflareAccess.clientId)
  && !storedMetadata.includes(cloudflareAccess.clientSecret)
  && JSON.parse(storedMetadata)[0].cloudflareAccessConfigured === true);
check('runtime save writes all credentials to separate SecureStore entries', secureStorage.get(`mr-robot.pc.secret.${runtimePc.id}`) === runtimePc.secret
  && secureStorage.get(`mr-robot.pc.cloudflare-access.client-id.${runtimePc.id}`) === cloudflareAccess.clientId
  && secureStorage.get(`mr-robot.pc.cloudflare-access.client-secret.${runtimePc.id}`) === cloudflareAccess.clientSecret);
const reloaded = await pcsRuntime.loadPcs();
check('runtime load reconstructs Access credentials only in memory', reloaded[0]?.cloudflareAccess?.clientId === cloudflareAccess.clientId
  && reloaded[0]?.cloudflareAccess?.clientSecret === cloudflareAccess.clientSecret);
const exactHeaders = pcsRuntime.pcAuthenticatedHeaders(reloaded[0], 'https://robot.example.com:443/api/ping');
const alternateHeaders = pcsRuntime.pcAuthenticatedHeaders(reloaded[0], 'https://alternate.example.com:443/api/ping');
const similarHeaders = pcsRuntime.pcAuthenticatedHeaders(reloaded[0], 'https://robot.example.com.attacker.invalid:443/api/ping');
check('Access credentials are injected only for the persisted exact HTTPS origin', exactHeaders['CF-Access-Client-Id'] === cloudflareAccess.clientId
  && alternateHeaders['CF-Access-Client-Id'] === undefined
  && alternateHeaders['CF-Access-Client-Secret'] === undefined
  && similarHeaders['CF-Access-Client-Id'] === undefined
  && similarHeaders['CF-Access-Client-Secret'] === undefined);
const unsignedAlternate = {
  ...reloaded[0],
  origins: ['https://robot.example.com:443', 'https://attacker.invalid:443'],
  credentialOrigin: 'https://robot.example.com:443',
};
check('device bearer is bound to the one origin that issued it',
  pcsRuntime.connectionOrigins(unsignedAlternate).length === 1
  && pcsRuntime.connectionOrigins(unsignedAlternate)[0] === 'https://robot.example.com:443'
  && pcsRuntime.pcAuthenticatedHeaders(unsignedAlternate, 'https://attacker.invalid:443/api/ping')['x-mr-robot-token'] === undefined);
const mobileMesh = await pcsRuntime.upsertPc(reloaded, {
  name: 'Second execution PC',
  host: 'laptop.example.com',
  protocol: 'https',
  port: 443,
  origins: ['https://laptop.example.com:443'],
  activeOrigin: 'https://laptop.example.com:443',
  credentialOrigin: 'https://laptop.example.com:443',
  secret: 'second-agent-bearer',
});
check('mobile registry keeps independently authenticated execution PCs side by side', mobileMesh.length === 2
  && mobileMesh[0].id === runtimePc.id
  && pcsRuntime.connectionOrigins(mobileMesh[1])[0] === 'https://laptop.example.com:443');
await pcsRuntime.savePcs([]);
check('runtime deletion removes every SecureStore credential', [...secureStorage.keys()].every((key) => !key.endsWith(runtimePc.id)));

asyncStorage.set('mr-robot.pcs', JSON.stringify([{
  ...runtimePc,
  id: 'pc-legacy-test',
  secret: 'legacy-agent-secret',
  cloudflareAccess: { clientId: 'legacy.access', clientSecret: 'legacy-access-secret' },
}]));
const migrated = await pcsRuntime.loadPcs();
const migratedMetadata = asyncStorage.get('mr-robot.pcs');
check('legacy plaintext credentials migrate to SecureStore', migrated[0]?.secret === 'legacy-agent-secret'
  && migrated[0]?.cloudflareAccess?.clientId === 'legacy.access'
  && secureStorage.get('mr-robot.pc.cloudflare-access.client-secret.pc-legacy-test') === 'legacy-access-secret');
check('legacy plaintext credentials are scrubbed from AsyncStorage after migration', typeof migratedMetadata === 'string'
  && !migratedMetadata.includes('legacy-agent-secret')
  && !migratedMetadata.includes('legacy-access-secret'));

delete globalThis.__mrRobotAsyncStorageMock;
delete globalThis.__mrRobotSecureStoreMock;

console.log('CLOUDFLARE ACCESS CONTRACT PASSED');
