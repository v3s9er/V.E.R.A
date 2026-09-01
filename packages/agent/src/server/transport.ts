import { networkInterfaces } from 'node:os';

export function isLoopback(remote: string): boolean {
  const normalized = remote.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

export function isTailnetAddress(remote: string): boolean {
  const octets = remote.replace(/^::ffff:/, '').split('.').map(Number);
  return octets.length === 4
    && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    && octets[0] === 100
    && octets[1] >= 64
    && octets[1] <= 127;
}

export function tailscaleInterfaceAddresses(): Set<string> {
  const addresses = new Set<string>();
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (!/tailscale/i.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !isTailnetAddress(entry.address)) continue;
      addresses.add(entry.address.replace(/^::ffff:/, ''));
    }
  }
  return addresses;
}

/**
 * Both endpoints being in 100.64/10 is still insufficient: enterprise and ISP
 * LANs may use that range. The accepted local address must belong to the real
 * Tailscale adapter (or an explicitly supplied trusted set in tests).
 */
export function isEncryptedTailnetTransport(
  remote: string,
  local: string,
  trustedLocalAddresses: ReadonlySet<string> = tailscaleInterfaceAddresses(),
): boolean {
  const normalizedLocal = local.replace(/^::ffff:/, '');
  return isTailnetAddress(remote)
    && isTailnetAddress(normalizedLocal)
    && trustedLocalAddresses.has(normalizedLocal);
}
