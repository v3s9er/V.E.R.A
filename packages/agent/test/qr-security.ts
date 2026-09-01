import { parsePairingPayload as parseMobile } from '../../../apps/mobile/src/pairing.ts';
import { parsePairingPayload as parseWeb } from '../../web/src/rpc.ts';

function check(label: string, ok: boolean): void {
  if (!ok) throw new Error(`FAIL: ${label}`);
  console.log(`  ok  ${label}`);
}

const parsers = [
  ['mobile', parseMobile],
  ['web', parseWeb],
] as const;

for (const [name, parse] of parsers) {
  const https = parse(JSON.stringify({ app: 'mr-robot', version: 3, host: 'https://safe.trycloudflare.com', hosts: ['https://safe.trycloudflare.com'], protocol: 'https', port: 443, pin: '123456' }));
  check(`${name} accepts a v3 HTTPS one-time PIN payload`, https?.pin === '123456');
  const handoff = parse(JSON.stringify({ app: 'mr-robot', version: 3, host: 'https://safe.trycloudflare.com', protocol: 'https', port: 443, pin: '123456789012' }));
  check(`${name} accepts a 12-digit travel handoff code`, handoff?.pin === '123456789012');
  check(`${name} rejects raw 100.64/10 HTTP even when labelled as Tailscale`, parse(JSON.stringify({ app: 'mr-robot', version: 3, host: '100.64.12.34', port: 8787, pin: '654321' })) === null);
  check(`${name} rejects a legacy long-lived secret QR`, parse(JSON.stringify({ app: 'mr-robot', version: 2, host: 'https://safe.trycloudflare.com', port: 443, secret: 'long-lived-device-token' })) === null);
  check(`${name} rejects secret even when disguised as v3`, parse(JSON.stringify({ app: 'mr-robot', version: 3, host: 'https://safe.trycloudflare.com', port: 443, secret: 'long-lived-device-token' })) === null);
  for (const invalidPin of ['12345', '1234567', '12345678901', '1234567890123', '12345x']) {
    check(`${name} rejects unsupported pairing code ${invalidPin}`, parse(JSON.stringify({ app: 'mr-robot', version: 3, host: 'https://safe.trycloudflare.com', port: 443, pin: invalidPin })) === null);
  }
  check(`${name} rejects plaintext LAN origins`, parse(JSON.stringify({ app: 'mr-robot', version: 3, host: '192.168.1.5', port: 8787, pin: '123456' })) === null);
  check(`${name} rejects an unsafe fallback host`, parse(JSON.stringify({ app: 'mr-robot', version: 3, host: 'https://safe.trycloudflare.com', hosts: ['192.168.1.5'], port: 443, pin: '123456' })) === null);
  check(`${name} rejects embedded URL credentials`, parse(JSON.stringify({ app: 'mr-robot', version: 3, host: 'https://user:password@safe.trycloudflare.com', port: 443, pin: '123456' })) === null);
}

check('web accepts its own loopback one-time PIN payload', Boolean(parseWeb(JSON.stringify({ app: 'mr-robot', version: 3, host: '127.0.0.1', port: 8787, pin: '123456' }))));
check('mobile rejects a loopback payload that would address the phone itself', parseMobile(JSON.stringify({ app: 'mr-robot', version: 3, host: '127.0.0.1', port: 8787, pin: '123456' })) === null);

console.log('\nQR SECURITY TESTS PASSED');
