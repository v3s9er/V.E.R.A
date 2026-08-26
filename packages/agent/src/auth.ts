import { createHash, timingSafeEqual } from 'node:crypto';

/** Timing-safe string comparison (prevents timing side-channels on the secret). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '••••••••';
  return secret.slice(0, 4) + '••••••••••••' + secret.slice(-4);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Build the pairing payload encoded in the QR code. */
export function pairingPayload(host: string, port: number, pin: string, hosts: string[] = [host]): string {
  return JSON.stringify({ app: 'mr-robot', version: 3, host, hosts: [...new Set(hosts)], port, pin });
}
