import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const types = read('src/types.ts');
const pairingType = types.slice(types.indexOf('export interface PairingPayload'), types.indexOf('export interface SystemStatus'));
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
const { pairingPayloadExpired, parsePairingPayload } = await import(`data:text/javascript;base64,${Buffer.from(pairingBundle.outputFiles[0].contents).toString('base64')}`);

const basePayload = {
  app: 'mr-robot',
  host: 'https://robot.example.com',
  protocol: 'https',
  port: 443,
  pin: '123456',
};
const cloudflareAccess = { clientId: 'mobile-client.access', clientSecret: 'service-token-secret' };
const validExpiresAt = Date.now() + 60_000;
const bootstrapToken = `${'a'.repeat(48)}.${'b'.repeat(96)}.${'c'.repeat(64)}`;
const cloudflareBootstrap = { type: 'cf-authorization', token: bootstrapToken, expiresAt: validExpiresAt };

check('legacy version 3 QR remains supported', parsePairingPayload(JSON.stringify({ ...basePayload, version: 3 }))?.version === 3);
check('legacy version 4 QR is rejected even when it carries complete Access credentials',
  parsePairingPayload(JSON.stringify({ ...basePayload, version: 4, expiresAt: validExpiresAt, cloudflareAccess })) === null);
check('version 3 QR cannot smuggle Access credentials', parsePairingPayload(JSON.stringify({ ...basePayload, version: 3, cloudflareAccess })) === null);
check('version 3 stays a general pairing payload and rejects obsolete Access markers',
  parsePairingPayload(JSON.stringify({ ...basePayload, version: 3, requiresCloudflareAccess: true })) === null);
const v5 = parsePairingPayload(JSON.stringify({
  ...basePayload,
  version: 5,
  pin: '123456789012',
  expiresAt: validExpiresAt,
  cloudflareBootstrap,
}));
check('version 5 QR carries only a short-lived bootstrap bound to the exact first origin',
  v5?.cloudflareBootstrap?.token === bootstrapToken
  && v5.cloudflareBootstrapOrigin === 'https://robot.example.com:443'
  && v5.cloudflareAccess === undefined);
check('version 5 QR rejects long-lived Access credentials and incomplete bootstrap tokens',
  parsePairingPayload(JSON.stringify({ ...basePayload, version: 5, pin: '123456789012', expiresAt: validExpiresAt, cloudflareBootstrap, cloudflareAccess })) === null
  && parsePairingPayload(JSON.stringify({ ...basePayload, version: 5, pin: '123456', expiresAt: validExpiresAt, cloudflareBootstrap })) === null
  && parsePairingPayload(JSON.stringify({ ...basePayload, version: 5, pin: '123456789012', expiresAt: validExpiresAt, requiresCloudflareAccess: true, cloudflareBootstrap })) === null
  && parsePairingPayload(JSON.stringify({ ...basePayload, version: 5, pin: '123456789012', expiresAt: validExpiresAt, cloudflareBootstrap: { ...cloudflareBootstrap, token: 'not-a-jwt' } })) === null
  && parsePairingPayload(JSON.stringify({ ...basePayload, version: 5, pin: '123456789012', expiresAt: validExpiresAt, cloudflareBootstrap: { ...cloudflareBootstrap, expiresAt: Date.now() - 1 } })) === null);
check('scanner can distinguish an expired Mr.Robot QR without accepting it', pairingPayloadExpired(JSON.stringify({
  ...basePayload,
  version: 5,
  pin: '123456789012',
  expiresAt: Date.now() - 1,
  cloudflareBootstrap: { ...cloudflareBootstrap, expiresAt: Date.now() - 1 },
})) === true
  && pcList.includes('pairingPayloadExpired(data)')
  && pcList.includes('PC에서 새 1회용 QR을 만드세요.'));

check('wire types expose only secret-free legacy and automatic bootstrap versions', pairingType.includes('version: 3 | 5;')
  && !pairingType.includes('cloudflareAccess?: CloudflareAccessCredentials;')
  && !pairingType.includes('requiresCloudflareAccess')
  && types.includes('cloudflareBootstrap?: CloudflareAccessBootstrap;'));
check('device and Access credentials use one versioned SecureStore bundle', pcs.includes("const CREDENTIAL_BUNDLE_VERSION = 1 as const")
  && pcs.includes('credentialBundleKey(pc.id)')
  && pcs.includes('serializeCredentialBundle(pc.secret, access)'));
check('AsyncStorage serialization strips agent and Access credentials', pcs.includes('function withoutCredentials')
  && pcs.includes('cloudflareAccess: _cloudflareAccess')
  && pcs.includes('JSON.stringify(normalized.map(withoutCredentials))'));
check('legacy credential keys migrate into the bundle and are removed', pcs.includes("Object.prototype.hasOwnProperty.call(item, 'cloudflareAccess')")
  && pcs.includes('deleteLegacyCredentialKeys(item.id)')
  && pcs.includes('SecureStore.setItemAsync(\n              credentialBundleKey(item.id)'));
check('save failure snapshots and rolls back each whole credential bundle', pcs.includes('const snapshots = new Map<string, string | null>()')
  && pcs.includes('for (const key of touched.reverse())')
  && pcs.includes('saveQueue.then(() => savePcsAtomic(pcs))'));

check('pair exchange binds Access headers to the exact enrollment origin', pcs.includes('cloudflareAccessHeaders(cloudflareAccess, binding, base)'));
check('ticket exchange binds Access headers to the exact WSS origin', rpc.includes('cloudflareAccessHeaders(cloudflareAccess, cloudflareAccessOrigin, requestOrigin)'));
check('blocked Access redirects are explained without weakening fail-closed requests',
  pcs.includes('explainCredentialFetchFailure(error, Object.keys(accessHeaders).length > 0)')
  && rpc.includes('explainCredentialFetchFailure(error, Object.keys(accessHeaders).length > 0)')
  && pcs.includes('보안을 위해 리다이렉트는 따라가지 않았습니다.'));
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
check('manual Access entry remains an explicit fallback outside the QR flow',
  pcList.includes('if (accessRequired && !cloudflareAccess)')
  && pcList.includes('setShowAdvancedAccess'));
check('version 5 QR performs automatic bootstrap and drops it before persistence or reconnect',
  pcList.includes('payload.cloudflareBootstrapOrigin')
  && pcList.includes('if (payload.cloudflareBootstrap) {')
  && pcList.includes('const enrolledAccess = paired.cloudflareAccess;')
  && pcList.includes("payload.cloudflareBootstrap.token = ''")
  && pcList.includes("/1회성|자동 보안 등록|자동 등록 세션/")
  && pcList.includes("detectedPayload.cloudflareBootstrap ? ' · 자동 보안 등록'"));
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
let asyncSetFailuresRemaining = 0;
let secureSetThrowAfterWriteKey = '';
globalThis.__mrRobotAsyncStorageMock = {
  getItem: async (key) => asyncStorage.get(key) ?? null,
  setItem: async (key, value) => {
    if (asyncSetFailuresRemaining > 0) {
      asyncSetFailuresRemaining -= 1;
      throw new Error('injected AsyncStorage commit failure');
    }
    asyncStorage.set(key, value);
  },
  removeItem: async (key) => { asyncStorage.delete(key); },
};
globalThis.__mrRobotSecureStoreMock = {
  getItemAsync: async (key) => secureStorage.get(key) ?? null,
  setItemAsync: async (key, value) => {
    secureStorage.set(key, value);
    if (key === secureSetThrowAfterWriteKey) {
      secureSetThrowAfterWriteKey = '';
      throw new Error('injected SecureStore write-after-commit failure');
    }
  },
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
const pcsModuleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`;
const pcsRuntime = await import(`${pcsModuleUrl}#normal`);
await pcsRuntime.loadPcs();
const originalFetch = globalThis.fetch;
const pairingRequests = [];
globalThis.fetch = async (input, init = {}) => {
  pairingRequests.push({ url: String(input), init });
  const automatic = Boolean(init?.headers?.['cf-access-token']);
  return new Response(JSON.stringify({
    secret: 'paired-device-secret-value-longer-than-thirty-two-characters',
    ...(automatic ? { cloudflareAccess } : {}),
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
await pcsRuntime.exchangePin('https://robot.example.com:443', '123456', 'manual', 'ask', 1_000, cloudflareAccess);
await pcsRuntime.exchangePinAcrossOrigins(
  ['https://robot.example.com:443'],
  '123456789012',
  'qr',
  cloudflareAccess,
  'https://robot.example.com:443',
);
const automaticPairing = await pcsRuntime.exchangePin(
  'https://robot.example.com:443',
  '123456789012',
  'automatic-qr',
  'ask',
  1_000,
  undefined,
  undefined,
  cloudflareBootstrap,
  'https://robot.example.com:443',
);
check('manual PIN exchange sends both Access headers to the exact enrollment origin',
  pairingRequests[0]?.url === 'https://robot.example.com:443/api/pair'
  && pairingRequests[0]?.init?.headers?.['CF-Access-Client-Id'] === cloudflareAccess.clientId
  && pairingRequests[0]?.init?.headers?.['CF-Access-Client-Secret'] === cloudflareAccess.clientSecret
  && pairingRequests[0]?.init?.redirect === 'error');
check('QR PIN exchange forwards the same exact-origin Access headers',
  pairingRequests[1]?.url === 'https://robot.example.com:443/api/pair'
  && pairingRequests[1]?.init?.headers?.['CF-Access-Client-Id'] === cloudflareAccess.clientId
  && pairingRequests[1]?.init?.headers?.['CF-Access-Client-Secret'] === cloudflareAccess.clientSecret
  && pairingRequests[1]?.init?.redirect === 'error');
check('automatic QR sends only the short-lived application-token header and receives long-lived credentials after PIN consumption',
  pairingRequests[2]?.url === 'https://robot.example.com:443/api/pair'
  && pairingRequests[2]?.init?.headers?.['cf-access-token'] === bootstrapToken
  && pairingRequests[2]?.init?.headers?.Cookie === undefined
  && pairingRequests[2]?.init?.headers?.['CF-Access-Client-Id'] === undefined
  && pairingRequests[2]?.init?.headers?.['CF-Access-Client-Secret'] === undefined
  && pairingRequests[2]?.init?.redirect === 'error'
  && pairingRequests[2]?.init?.credentials === 'omit'
  && automaticPairing.cloudflareAccess?.clientId === cloudflareAccess.clientId
  && automaticPairing.cloudflareAccess?.clientSecret === cloudflareAccess.clientSecret);
const requestsBeforeOriginMismatch = pairingRequests.length;
let bootstrapOriginMismatch = '';
try {
  await pcsRuntime.exchangePin(
    'https://attacker.invalid:443',
    '123456789012',
    'automatic-qr',
    'ask',
    1_000,
    undefined,
    undefined,
    cloudflareBootstrap,
    'https://robot.example.com:443',
  );
} catch (error) {
  bootstrapOriginMismatch = error instanceof Error ? error.message : String(error);
}
check('automatic bootstrap is refused before fetch when the exact HTTPS origin differs',
  pairingRequests.length === requestsBeforeOriginMismatch
  && bootstrapOriginMismatch.includes('HTTPS 주소가 일치하지 않습니다'));

globalThis.fetch = async () => { throw new TypeError("fetch failed: Redirect is not allowed when redirect mode is 'error'"); };
let redirectWithAccess = '';
let redirectWithoutAccess = '';
let redirectWithBootstrap = '';
try {
  await pcsRuntime.exchangePin('https://robot.example.com:443', '123456', 'manual', 'ask', 1_000, cloudflareAccess);
} catch (error) {
  redirectWithAccess = error instanceof Error ? error.message : String(error);
}
try {
  await pcsRuntime.exchangePin('https://robot.example.com:443', '123456', 'manual', 'ask', 1_000);
} catch (error) {
  redirectWithoutAccess = error instanceof Error ? error.message : String(error);
}
try {
  await pcsRuntime.exchangePin(
    'https://robot.example.com:443',
    '123456789012',
    'automatic-qr',
    'ask',
    1_000,
    undefined,
    undefined,
    cloudflareBootstrap,
    'https://robot.example.com:443',
  );
} catch (error) {
  redirectWithBootstrap = error instanceof Error ? error.message : String(error);
}
check('a rejected service token is distinguished from a missing service token without exposing values',
  redirectWithAccess.includes('헤더는 이 HTTPS 주소에 전송됐지만')
  && redirectWithAccess.includes('Service Auth')
  && !redirectWithAccess.includes(cloudflareAccess.clientSecret)
  && redirectWithoutAccess.includes('Client ID와 Secret을 모두 입력하세요')
  && !redirectWithoutAccess.includes(cloudflareAccess.clientSecret));
check('a rejected one-time bootstrap tells the user to refresh the QR instead of entering a long-lived secret',
  redirectWithBootstrap.includes('1회성 자동 등록 세션')
  && redirectWithBootstrap.includes('새 QR')
  && !redirectWithBootstrap.includes('Client ID와 Secret을 모두 입력'));

const capturePairFailure = async (responseFactory) => {
  globalThis.fetch = async () => responseFactory();
  try {
    await pcsRuntime.exchangePin(
      'https://robot.example.com:443',
      '123456789012',
      'automatic-qr',
      'ask',
      1_000,
      undefined,
      undefined,
      cloudflareBootstrap,
      'https://robot.example.com:443',
    );
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
const expiredFailure = await capturePairFailure(() => new Response(JSON.stringify({ code: 'PAIRING_EXPIRED', error: 'expired' }), {
  status: 400,
  headers: { 'content-type': 'application/json' },
}));
const consumedFailure = await capturePairFailure(() => new Response(JSON.stringify({ code: 'PAIRING_CONSUMED', error: 'already used' }), {
  status: 400,
  headers: { 'content-type': 'application/json' },
}));
const invalidJsonFailure = await capturePairFailure(() => new Response('<html>not json</html>', {
  status: 200,
  headers: { 'content-type': 'text/html' },
}));
const oversizedFailure = await capturePairFailure(() => new Response('{}', {
  status: 200,
  headers: { 'content-type': 'application/json', 'content-length': String(64 * 1024 + 1) },
}));
const injectedCredentialFailure = await capturePairFailure(() => new Response(JSON.stringify({
  secret: 'paired-device-secret-value-longer-than-thirty-two-characters',
  cloudflareAccess: { clientId: cloudflareAccess.clientId, clientSecret: 'bad\r\nInjected: yes' },
}), {
  status: 200,
  headers: { 'content-type': 'application/json' },
}));
const injectedDeviceFailure = await capturePairFailure(() => new Response(JSON.stringify({
  secret: `${'d'.repeat(40)}\r\nInjected: yes`,
  cloudflareAccess,
}), {
  status: 200,
  headers: { 'content-type': 'application/json' },
}));
check('expired and consumed one-use QR responses have distinct recovery guidance',
  expiredFailure.includes('만료') && expiredFailure.includes('새 QR')
  && consumedFailure.includes('이미 사용') && consumedFailure.includes('새 QR'));
check('pair response rejects invalid JSON, oversized bodies, and unsafe returned header credentials',
  invalidJsonFailure.includes('올바른 JSON')
  && oversizedFailure.includes('허용 크기')
  && injectedCredentialFailure.includes('Client ID와 Secret')
  && injectedDeviceFailure.includes('PC 연결 자격증명 응답'));
globalThis.fetch = originalFetch;
const runtimePc = {
  id: 'pc-secure-test',
  name: 'Secure PC',
  host: 'robot.example.com',
  protocol: 'https',
  port: 443,
  origins: ['https://robot.example.com:443'],
  secret: automaticPairing.secret,
  cloudflareAccess: automaticPairing.cloudflareAccess,
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
const runtimeBundleKey = `mr-robot.pc.credentials.${runtimePc.id}`;
const runtimeBundle = JSON.parse(secureStorage.get(runtimeBundleKey));
check('runtime save commits the device token and complete Access pair in one versioned bundle', runtimeBundle.version === 1
  && runtimeBundle.secret === runtimePc.secret
  && runtimeBundle.cloudflareAccess?.clientId === cloudflareAccess.clientId
  && runtimeBundle.cloudflareAccess?.clientSecret === cloudflareAccess.clientSecret
  && ![...secureStorage.keys()].some((key) => key.startsWith('mr-robot.pc.secret.') || key.startsWith('mr-robot.pc.cloudflare-access.')));
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
  id: 'pc-three-key-legacy',
  secret: undefined,
  cloudflareAccess: undefined,
  cloudflareAccessConfigured: true,
}]));
secureStorage.set('mr-robot.pc.secret.pc-three-key-legacy', 'three-key-device-token');
secureStorage.set('mr-robot.pc.cloudflare-access.client-id.pc-three-key-legacy', 'three-key.access');
secureStorage.set('mr-robot.pc.cloudflare-access.client-secret.pc-three-key-legacy', 'three-key-access-secret');
const threeKeyMigrated = await pcsRuntime.loadPcs();
const threeKeyBundle = JSON.parse(secureStorage.get('mr-robot.pc.credentials.pc-three-key-legacy'));
check('installed three-key credentials migrate atomically into one bundle and obsolete keys are deleted',
  threeKeyMigrated[0]?.secret === 'three-key-device-token'
  && threeKeyBundle.cloudflareAccess?.clientId === 'three-key.access'
  && threeKeyBundle.cloudflareAccess?.clientSecret === 'three-key-access-secret'
  && !secureStorage.has('mr-robot.pc.secret.pc-three-key-legacy')
  && !secureStorage.has('mr-robot.pc.cloudflare-access.client-id.pc-three-key-legacy')
  && !secureStorage.has('mr-robot.pc.cloudflare-access.client-secret.pc-three-key-legacy'));
await pcsRuntime.savePcs([]);

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
  && JSON.parse(secureStorage.get('mr-robot.pc.credentials.pc-legacy-test')).cloudflareAccess.clientSecret === 'legacy-access-secret');
check('legacy plaintext credentials are scrubbed from AsyncStorage after migration', typeof migratedMetadata === 'string'
  && !migratedMetadata.includes('legacy-agent-secret')
  && !migratedMetadata.includes('legacy-access-secret'));

const faultBundleKey = 'mr-robot.pc.credentials.pc-legacy-test';
const baselineBundle = secureStorage.get(faultBundleKey);
const baselineMetadata = asyncStorage.get('mr-robot.pcs');
const secureFaultRuntime = await import(`${pcsModuleUrl}#secure-fault`);
const secureFaultPcs = await secureFaultRuntime.loadPcs();
secureSetThrowAfterWriteKey = faultBundleKey;
let secureFault = '';
try {
  await secureFaultRuntime.savePcs([{
    ...secureFaultPcs[0],
    secret: 'replacement-device-token',
    cloudflareAccess: { clientId: 'replacement.access', clientSecret: 'replacement-access-secret' },
  }]);
} catch (error) {
  secureFault = error instanceof Error ? error.message : String(error);
}
check('SecureStore write-after-commit failure restores the previous complete bundle and metadata', secureFault.includes('injected SecureStore')
  && secureStorage.get(faultBundleKey) === baselineBundle
  && asyncStorage.get('mr-robot.pcs') === baselineMetadata);

const metadataFaultRuntime = await import(`${pcsModuleUrl}#metadata-fault`);
const metadataFaultPcs = await metadataFaultRuntime.loadPcs();
asyncSetFailuresRemaining = 1;
let metadataFault = '';
try {
  await metadataFaultRuntime.savePcs([{
    ...metadataFaultPcs[0],
    secret: 'second-replacement-device-token',
    cloudflareAccess: { clientId: 'second.access', clientSecret: 'second-access-secret' },
  }]);
} catch (error) {
  metadataFault = error instanceof Error ? error.message : String(error);
}
check('metadata commit failure rolls the already-written credential bundle back as one unit', metadataFault.includes('injected AsyncStorage')
  && secureStorage.get(faultBundleKey) === baselineBundle
  && asyncStorage.get('mr-robot.pcs') === baselineMetadata);

delete globalThis.__mrRobotAsyncStorageMock;
delete globalThis.__mrRobotSecureStoreMock;

console.log('CLOUDFLARE ACCESS CONTRACT PASSED');
