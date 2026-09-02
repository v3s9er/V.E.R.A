import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSslScanPlugin, isPublicIpAddress, SslTlsScanner, validateAndResolveTarget } from '../../src/plugins/sslscan/index.js';

test('public-address policy fails closed for private and special-use ranges', () => {
  for (const blocked of [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.1.1', '192.0.2.1', '192.88.99.2', '198.51.100.1', '203.0.113.1',
    '::', '::1', 'fc00::1', 'fe80::1', 'fec0::1', 'ff02::1', '2001:db8::1', '2002:a00:1::1',
    '64:ff9b::a00:1', '::ffff:127.0.0.1', '::10.0.0.1', '100:0:0:1::1',
    '2001:1::4', '2001:2::1', '2001:5::1', '2001:20::1', '2001:100::1',
    '3fff::1', '5f00::1', '4000::1',
  ]) assert.equal(isPublicIpAddress(blocked), false, blocked);
  for (const allowed of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicIpAddress(allowed), true, allowed);
  }
});

test('request policy requires explicit authorization and rejects URL-shaped targets', async () => {
  const options = { allowedPorts: [443], allowPrivateTargets: false } as const;
  await assert.rejects(
    validateAndResolveTarget({ host: '1.1.1.1', authorizationConfirmed: false }, options),
    /explicit authorization/i,
  );
  await assert.rejects(
    validateAndResolveTarget({ host: 'https:\/\/example.com', authorizationConfirmed: true }, options),
    /single hostname/i,
  );
});

test('request policy blocks internal targets and non-allowlisted ports', async () => {
  const options = { allowedPorts: [443], allowPrivateTargets: false } as const;
  await assert.rejects(
    validateAndResolveTarget({ host: '127.0.0.1', authorizationConfirmed: true }, options),
    /blocked by default/i,
  );
  await assert.rejects(
    validateAndResolveTarget({ host: '1.1.1.1', port: 22, authorizationConfirmed: true }, options),
    /not enabled/i,
  );
});

test('request policy returns a pinned, bounded single target', async () => {
  const target = await validateAndResolveTarget({
    host: '1.1.1.1', port: 443, authorizationConfirmed: true,
    timeoutMs: 500, overallTimeoutMs: 3_000, maxCipherTests: 0,
  }, { allowedPorts: [443], allowPrivateTargets: false });
  assert.deepEqual(target.addresses, [{ address: '1.1.1.1', family: 4 }]);
  assert.equal(target.maxCipherTests, 0);
  assert.equal(target.scanMode, 'quick');
  assert.equal(target.timeoutMs, 500);
});

test('scan modes keep quick low-traffic and require opt-in for broad cipher probing', async () => {
  const options = { allowedPorts: [443], allowPrivateTargets: false } as const;
  const quick = await validateAndResolveTarget({ host: '1.1.1.1', authorizationConfirmed: true }, options);
  const standard = await validateAndResolveTarget({ host: '1.1.1.1', authorizationConfirmed: true, scanMode: 'standard' }, options);
  const deep = await validateAndResolveTarget({ host: '1.1.1.1', authorizationConfirmed: true, scanMode: 'deep' }, options);
  assert.equal(quick.maxCipherTests, 0);
  assert.equal(standard.maxCipherTests, 16);
  assert.equal(deep.maxCipherTests, 96);
  await assert.rejects(
    validateAndResolveTarget({ host: '1.1.1.1', authorizationConfirmed: true, scanMode: 'standard', maxCipherTests: 25 }, options),
    /between 0 and 24/i,
  );
});

test('scanner and manifest advertise conservative defaults', () => {
  const scanner = new SslTlsScanner();
  const status = scanner.status() as { limits: { targetsPerCall: number; privateNetworksAllowed: boolean; maxConcurrentScans: number } };
  assert.equal(status.limits.targetsPerCall, 1);
  assert.equal(status.limits.privateNetworksAllowed, false);
  assert.equal(status.limits.maxConcurrentScans, 1);
  const plugin = createSslScanPlugin();
  assert.equal(plugin.manifest.category, 'pentest');
  assert.equal(plugin.manifest.permissions?.includes('network.client'), true);

  const cacheKey = (scanner as unknown as { cacheKey(target: {
    host: string; port: number; sni?: string; addresses: Array<{ address: string; family: 4 | 6 }>;
    scanMode: 'quick'; maxCipherTests: number; timeoutMs: number; overallTimeoutMs: number;
  }): string }).cacheKey.bind(scanner);
  const baseTarget = {
    host: '1.1.1.1', port: 443, addresses: [{ address: '1.1.1.1', family: 4 as const }],
    scanMode: 'quick' as const, maxCipherTests: 0, timeoutMs: 500, overallTimeoutMs: 3_000,
  };
  assert.notEqual(cacheKey(baseTarget), cacheKey({ ...baseTarget, timeoutMs: 1_000 }));
  assert.notEqual(cacheKey(baseTarget), cacheKey({ ...baseTarget, overallTimeoutMs: 4_000 }));
});

test('pre-cancelled scans perform no connection and release their concurrency slot', async () => {
  const scanner = new SslTlsScanner({ allowedPorts: [443] });
  const controller = new AbortController();
  controller.abort(new Error('test cancellation'));
  await assert.rejects(
    scanner.scan({ host: '1.1.1.1', authorizationConfirmed: true }, controller.signal),
    /cancellation/i,
  );
  const status = scanner.status() as { activeScans: number };
  assert.equal(status.activeScans, 0);
});
