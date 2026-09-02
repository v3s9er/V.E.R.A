import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:tls';
import { test } from 'node:test';
import { SslTlsScanner } from '../../src/plugins/sslscan/index.js';

function runReference(binary: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [
      '--no-colour', '--iana-names', '--show-certificate', '--show-sigs',
      '--no-heartbleed', '--no-fallback', '--no-renegotiation', '--no-compression', '--no-groups',
      '--timeout=1', '--connect-timeout=2', `127.0.0.1:${port}`,
    ], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk: Buffer): void => { if (output.length < 2_000_000) output += chunk.toString(); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timeout = setTimeout(() => child.kill(), 60_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(output);
      else reject(new Error(`sslscan exited with ${code}: ${output.slice(-2_000)}`));
    });
  });
}

const binary = process.env.SSLSCAN_REFERENCE_BINARY;
const pfxPath = process.env.SSLSCAN_TEST_PFX;
const pfxPassword = process.env.SSLSCAN_TEST_PFX_PASSWORD;

test('independent scanner agrees with official sslscan on common local TLS evidence', {
  skip: !binary || !pfxPath || !pfxPassword ? 'Set SSLSCAN_REFERENCE_BINARY, SSLSCAN_TEST_PFX, and SSLSCAN_TEST_PFX_PASSWORD.' : false,
  timeout: 90_000,
}, async () => {
  const server = createServer({
    pfx: readFileSync(pfxPath!),
    passphrase: pfxPassword,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    ciphers: 'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384',
  });
  let tcpConnections = 0;
  server.on('connection', () => { tcpConnections += 1; });
  server.on('tlsClientError', () => { /* Expected while unsupported versions/ciphers are rejected. */ });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const scanner = new SslTlsScanner({
      allowedPorts: [address.port], allowPrivateTargets: true, maxConcurrentScans: 1, minTargetIntervalMs: 0,
    });
    const baseRequest = {
      host: '127.0.0.1', port: address.port, sni: 'localhost', authorizationConfirmed: true,
      timeoutMs: 1_000, overallTimeoutMs: 60_000,
    } as const;

    const quickStart = tcpConnections;
    const quickProgress: Array<{ percent: number; status: string }> = [];
    const quick = await scanner.scan(
      { ...baseRequest, scanMode: 'quick' },
      undefined,
      (progress) => quickProgress.push({ percent: progress.percent, status: progress.status }),
    );
    const quickConnections = tcpConnections - quickStart;

    const cacheStart = tcpConnections;
    const cachedQuick = await scanner.scan({ ...baseRequest, scanMode: 'quick' });
    const cachedQuickConnections = tcpConnections - cacheStart;

    const deepStart = tcpConnections;
    const ours = await scanner.scan({ ...baseRequest, scanMode: 'deep', maxCipherTests: 96 });
    const deepConnections = tcpConnections - deepStart;

    const referenceStart = tcpConnections;
    const reference = await runReference(binary!, address.port);
    const referenceConnections = tcpConnections - referenceStart;

    const oursSupported = ours.protocols.filter((probe) => probe.supported).map((probe) => probe.requested);
    assert.equal(quick.cipherProbe.tested, 0);
    assert.ok(quickConnections <= 4, `quick mode should use at most four TCP connections, observed ${quickConnections}`);
    assert.deepEqual(quickProgress.at(-1), { percent: 100, status: 'completed' });
    assert.equal(cachedQuick.cache.hit, true);
    assert.equal(cachedQuickConnections, 0);
    assert.ok(deepConnections <= 4 + ours.cipherProbe.tested, 'each deep probe should use at most one pinned TCP connection');
    assert.ok(referenceConnections > quickConnections, 'reference full cipher enumeration should use more connections than quick mode');
    assert.deepEqual(oursSupported, ['TLSv1.2', 'TLSv1.3']);
    assert.match(reference, /TLSv1\.2\s+enabled/i);
    assert.match(reference, /TLSv1\.3\s+enabled/i);
    assert.doesNotMatch(reference, /TLSv1(?:\.0)?\s+enabled/i);
    assert.match(ours.certificate?.subject ?? '', /CN=localhost/i);
    assert.equal(ours.certificate?.hostnameValid, true);
    assert.match(reference, /Subject:.*CN=localhost/i);

    const oursIana = new Set(ours.supportedCiphers.map((cipher) => cipher.standardName).filter(Boolean));
    const expectedCommon = [
      'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
      'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
    ].filter((cipher) => oursIana.has(cipher) && reference.includes(cipher));
    assert.ok(expectedCommon.length >= 1, 'at least one configured TLS 1.2 cipher should be reported by both scanners');

    process.stdout.write(`${JSON.stringify({
      target: `127.0.0.1:${address.port}`,
      tcpConnections: {
        mrRobotQuick: quickConnections,
        mrRobotQuickCacheHit: cachedQuickConnections,
        mrRobotDeep: deepConnections,
        officialSslscan: referenceConnections,
      },
      ours: {
        protocols: oursSupported,
        certificateSubject: ours.certificate?.subject,
        tls12Ciphers: [...oursIana].sort(),
      },
      sslscan: {
        version: reference.match(/Version:\s*([^\r\n]+)/i)?.[1]?.trim(),
        tls12: /TLSv1\.2\s+enabled/i.test(reference),
        tls13: /TLSv1\.3\s+enabled/i.test(reference),
        certificateSubject: reference.match(/Subject:\s*([^\r\n]+)/i)?.[1]?.trim(),
      },
      commonTls12Ciphers: expectedCommon,
    }, null, 2)}\n`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
