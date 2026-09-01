import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..', '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const main = read('packages/desktop/main.mjs');
const preload = read('packages/desktop/preload.cjs');
const rpc = read('packages/web/src/rpc.ts');
const pcs = read('packages/web/src/pcs.ts');

const failures = [];
const check = (name, condition) => {
  if (condition) console.log(`  ok  ${name}`);
  else { failures.push(name); console.error(`FAIL  ${name}`); }
};

console.log('desktop administrator credential boundary');
check('local connection IPC never returns the global administrator secret', !/mr-robot:local-connection[\s\S]{0,500}secret:\s*server\.secret/.test(main));
check('main process owns WebSocket authentication', main.includes("callLocalRpc('auth', { secret: credential }") && main.includes('mr-robot:local-rpc.connect'));
check('preload exposes calls and events but no secret getter', preload.includes('connectLocalRpc') && preload.includes('callLocalRpc') && !preload.includes('server.secret'));
check('renderer uses an inert local-session marker', rpc.includes("DESKTOP_LOCAL_AUTH_TOKEN = 'electron-main-process-managed-session'") && pcs.includes('secret: DESKTOP_LOCAL_AUTH_TOKEN'));
check('loopback REST authorization is injected after the renderer boundary', main.includes('onBeforeSendHeaders') && main.includes('resolveDesktopCredential(reference, parsed.origin)') && main.includes('return server.secret'));
check('renderer cannot invoke a second auth exchange', main.includes("!allowAuth && normalizedMethod === 'auth'"));
check('credential rotation response is stripped before IPC', main.includes("normalizedMethod === 'pairing.regenerate'") && main.includes('secret: _discarded'));
check('encrypted PC registry is redacted before IPC', main.includes('value: redactPcRegistry(loaded.value)') && main.includes('DESKTOP_REMOTE_AUTH_PREFIX'));
check('stored remote origins cannot be rebound by renderer save', main.includes('...stored,') && main.includes('stored.origins.includes(pc.activeOrigin)') && main.includes('item.id === referencedId && item.id === pc.id'));
check('remote WebSocket authentication stays in main process', main.includes('resolveDesktopCredential(credentialReference, origin)') && main.includes("headers: { 'x-mr-robot-token': credential") && rpc.includes('isDesktopManagedAuthToken(secret)'));
check('remote HTTP bearer is injected only for the registered origin', main.includes('resolveDesktopCredential(reference, parsed.origin)') && main.includes('item.origins.includes(origin)'));
check('Electron pairing response is retained as a short-lived main-process reference', main.includes('pendingPcCredentials.set') && main.includes('DESKTOP_PENDING_AUTH_PREFIX') && preload.includes('pairRemotePc'));
check('renderer reloads redacted registry before first remote connection', pcs.includes('window.mrRobotDesktop?.pairRemotePc') && read('packages/web/src/components/ConnectGate.tsx').includes('const securedNext = window.mrRobotDesktop ? await loadPcsForEnvironment() : next'));

console.log(failures.length === 0 ? '\nDESKTOP AUTH BOUNDARY TESTS PASSED' : `\n${failures.length} DESKTOP AUTH BOUNDARY FAILURES`);
process.exitCode = failures.length === 0 ? 0 : 1;
