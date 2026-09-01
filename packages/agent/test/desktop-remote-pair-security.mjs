import assert from 'node:assert/strict';
import {
  isAllowedRemotePairAddress,
  normalizeRemotePairOrigin,
  resolvePinnedRemotePairTarget,
} from '../../desktop/remote-pair-security.mjs';

console.log('desktop remote pairing network boundary');

assert.equal(normalizeRemotePairOrigin('https://robot.example.com'), 'https://robot.example.com');
assert.throws(() => normalizeRemotePairOrigin('http://robot.example.com'));
assert.throws(() => normalizeRemotePairOrigin('https://robot.example.com:8443'));
assert.throws(() => normalizeRemotePairOrigin('https://robot.example.com/redirect'));
assert.throws(() => normalizeRemotePairOrigin('https://user:pass@robot.example.com'));

for (const address of [
  '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254',
  '100.64.0.1', '192.0.2.1', '198.51.100.4', '203.0.113.5', '224.0.0.1',
  '::1', 'fc00::1', 'fe80::1', '2001:db8::1', 'ff02::1',
]) assert.equal(isAllowedRemotePairAddress(address, 'robot.example.com'), false, address);
assert.equal(isAllowedRemotePairAddress('1.1.1.1', 'robot.example.com'), true);
assert.equal(isAllowedRemotePairAddress('2606:4700:4700::1111', 'robot.example.com'), true);
assert.equal(isAllowedRemotePairAddress('100.72.1.2', 'machine.tailnet.ts.net'), true);
assert.equal(isAllowedRemotePairAddress('fd7a:115c:a1e0::1234', 'machine.tailnet.ts.net'), true);
assert.equal(isAllowedRemotePairAddress('fd7a:115c:a1e1::1', 'machine.tailnet.ts.net'), false);
assert.equal(isAllowedRemotePairAddress('fd7a:115c:a1e0::1234', 'robot.example.com'), false);
assert.equal(isAllowedRemotePairAddress('100.72.1.2', 'machine.ts.net.attacker.example'), false);
assert.equal(isAllowedRemotePairAddress('1.1.1.1', 'machine.tailnet.ts.net'), false);

const pinned = await resolvePinnedRemotePairTarget('https://robot.example.com', async () => [
  { address: '2606:4700:4700::1111', family: 6 },
  { address: '1.1.1.1', family: 4 },
]);
assert.deepEqual(pinned, {
  origin: 'https://robot.example.com',
  hostname: 'robot.example.com',
  address: '1.1.1.1',
  family: 4,
});

await assert.rejects(
  resolvePinnedRemotePairTarget('https://robot.example.com', async () => [
    { address: '1.1.1.1', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]),
  /사설·로컬·예약/,
);
await assert.rejects(
  resolvePinnedRemotePairTarget('https://machine.tailnet.ts.net', async () => [{ address: '1.1.1.1', family: 4 }]),
  /사설·로컬·예약/,
);

console.log('DESKTOP REMOTE PAIRING SECURITY TESTS PASSED');
