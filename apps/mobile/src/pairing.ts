import type { CloudflareAccessCredentials, PairingPayload } from './types';

const isSafeHeaderCredential = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0
  && value.length <= 4_096
  && /^[\x21-\x7E]+$/.test(value);

function parseCloudflareAccess(value: unknown): CloudflareAccessCredentials | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cloudflare Access 정보가 올바르지 않습니다.');
  const candidate = value as Partial<CloudflareAccessCredentials>;
  if (!isSafeHeaderCredential(candidate.clientId) || !isSafeHeaderCredential(candidate.clientSecret)) {
    throw new Error('Cloudflare Access 정보가 올바르지 않습니다.');
  }
  return { clientId: candidate.clientId, clientSecret: candidate.clientSecret };
}

function securePairingOrigin(value: string, port: number, protocol: 'http' | 'https'): string {
  const input = value.trim();
  const explicitScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input);
  const parsed = new URL(explicitScheme ? input : `${protocol}://${input}`);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('지원하지 않는 페어링 주소입니다.');
  if (parsed.username || parsed.password || (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('페어링 QR에는 origin 주소만 사용할 수 있습니다.');
  }
  // Address-range membership is not transport authentication. A raw
  // 100.64/10 HTTP route can be captured when the Tailscale adapter is down.
  if (parsed.protocol !== 'https:') {
    throw new Error('페어링 QR은 Cloudflare 또는 Tailscale Serve의 HTTPS 주소가 필요합니다.');
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
    if (obj?.app !== 'mr-robot' || (obj.version !== 3 && obj.version !== 4)) return null;
    if (typeof obj.host !== 'string' || !obj.host.trim() || obj.host.length > 2_048) return null;
    if (!Number.isInteger(obj.port) || Number(obj.port) < 1 || Number(obj.port) > 65_535) return null;
    if (typeof obj.pin !== 'string' || !/^(?:\d{6}|\d{12})$/.test(obj.pin)) return null;
    if (obj.protocol !== undefined && obj.protocol !== 'http' && obj.protocol !== 'https') return null;
    if (obj.hosts !== undefined && (!Array.isArray(obj.hosts)
      || obj.hosts.length > 8
      || obj.hosts.some((host) => typeof host !== 'string' || !host.trim() || host.length > 2_048))) return null;
    if (obj.version === 3 && obj.cloudflareAccess !== undefined) return null;
    if (obj.version === 4 && obj.cloudflareAccess === undefined) return null;
    if (obj.requiresCloudflareAccess !== undefined && obj.requiresCloudflareAccess !== true) return null;
    const expiresAt = Number(obj.expiresAt);
    const hasExpiry = obj.expiresAt !== undefined;
    if ((obj.version === 4 || obj.requiresCloudflareAccess === true) && !hasExpiry) return null;
    if (hasExpiry && (!Number.isSafeInteger(expiresAt)
      || expiresAt <= Date.now()
      || expiresAt > Date.now() + 25 * 60 * 60_000)) return null;
    const cloudflareAccess = parseCloudflareAccess(obj.cloudflareAccess);
    const payload: PairingPayload = {
      app: 'mr-robot',
      version: obj.version,
      host: obj.host.trim(),
      hosts: obj.hosts?.map((host) => host.trim()),
      protocol: obj.protocol,
      port: Number(obj.port),
      pin: obj.pin,
      ...(hasExpiry ? { expiresAt } : {}),
      ...(obj.requiresCloudflareAccess === true ? { requiresCloudflareAccess: true } : {}),
      ...(cloudflareAccess ? { cloudflareAccess } : {}),
    };
    const origins = pairingOrigins(payload);
    if (cloudflareAccess) payload.cloudflareAccessOrigin = origins[0];
    return payload;
  } catch {
    return null;
  }
}
