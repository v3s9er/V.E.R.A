import type { PairingPayload } from './types';

function isTailnetHost(hostname: string): boolean {
  const octets = hostname.replace(/^\[|\]$/g, '').split('.').map(Number);
  return octets.length === 4
    && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    && octets[0] === 100
    && octets[1] >= 64
    && octets[1] <= 127;
}

function securePairingOrigin(value: string, port: number, protocol: 'http' | 'https'): string {
  const input = value.trim();
  const explicitScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input);
  const parsed = new URL(explicitScheme ? input : `${protocol}://${input}`);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('지원하지 않는 페어링 주소입니다.');
  if (parsed.username || parsed.password || (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('페어링 QR에는 origin 주소만 사용할 수 있습니다.');
  }
  if (parsed.protocol !== 'https:' && !isTailnetHost(parsed.hostname)) {
    throw new Error('페어링 QR은 Cloudflare HTTPS 원격 링크 또는 Tailscale 주소가 필요합니다.');
  }
  const resolvedPort = Number(parsed.port || (explicitScheme && parsed.protocol === 'https:' ? 443 : port));
  if (!Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65_535) throw new Error('페어링 포트가 올바르지 않습니다.');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  return `${parsed.protocol}//${host.includes(':') ? `[${host}]` : host}:${resolvedPort}`;
}

export function pairingOrigins(payload: PairingPayload): string[] {
  const protocol = payload.protocol ?? 'http';
  return [...new Set([payload.host, ...(payload.hosts ?? [])]
    .map((host) => securePairingOrigin(host, payload.port, protocol)))];
}

export function parsePairingPayload(raw: string): PairingPayload | null {
  try {
    const obj = JSON.parse(raw) as Partial<PairingPayload>;
    if (obj?.app !== 'mr-robot' || obj.version !== 3) return null;
    if (typeof obj.host !== 'string' || !obj.host.trim() || obj.host.length > 2_048) return null;
    if (!Number.isInteger(obj.port) || Number(obj.port) < 1 || Number(obj.port) > 65_535) return null;
    if (typeof obj.pin !== 'string' || !/^\d{6}$/.test(obj.pin)) return null;
    if (obj.protocol !== undefined && obj.protocol !== 'http' && obj.protocol !== 'https') return null;
    if (obj.hosts !== undefined && (!Array.isArray(obj.hosts)
      || obj.hosts.length > 8
      || obj.hosts.some((host) => typeof host !== 'string' || !host.trim() || host.length > 2_048))) return null;
    const payload: PairingPayload = {
      app: 'mr-robot',
      version: 3,
      host: obj.host.trim(),
      hosts: obj.hosts?.map((host) => host.trim()),
      protocol: obj.protocol,
      port: Number(obj.port),
      pin: obj.pin,
    };
    pairingOrigins(payload);
    return payload;
  } catch {
    return null;
  }
}
