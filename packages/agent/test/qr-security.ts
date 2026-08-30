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
  check(`${name} accepts a v3 Tailscale one-time PIN payload`, Boolean(parse(JSON.stringify({ app: 'mr-robot', version: 3, host: '100.64.12.34', port: 8787, pin: '654321' }))));
  check(`${name} rejects a legacy long-lived secret QR`, parse(JSON.stringify({ app: 'mr-robot', version: 2, host: 'https://safe.trycloudflare.com', port: 443, secret: 'long-lived-device-token' })) === null);
  check(`${name} rejects secret even when disguised as v3`, parse(JSON.stringify({ app: 'mr-robot', version: 3, host: 'https://safe.trycloudflare.com', port: 443, secret: 'long-lived-device-token' })) === null);
  check(`${name} rejects non-six-digit PINs`, parse(JSON.stringify({ app: 'mr-robot', version: 3, host: 'https://safe.trycloudflare.com', port: 443, pin: '12345' })) === null);
  check(`${name} rejects plaintext LAN origins`, parse(JSON.stringify({ app: 'mr-robot', version: 3, host: '192.168.1.5', port: 8787, pin: '123456' })) === null);
  check(`${name} rejects an unsafe fallback host`, parse(JSON.stringify({ app: 'mr-robot', version: 3, host: 'https://safe.trycloudflare.com', hosts: ['192.168.1.5'], port: 443, pin: '123456' })) === null);
  check(`${name} rejects embedded URL credentials`, parse(JSON.stringify({ app: 'mr-robot', version: 3, host: 'https://user:password@safe.trycloudflare.com', port: 443, pin: '123456' })) === null);
}

console.log('\nQR SECURITY TESTS PASSED');
