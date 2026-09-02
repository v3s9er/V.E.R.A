import type { CloudflareAccessBootstrap, PairingPayload } from './types';

const BOOTSTRAP_TTL_MAX_MS = 10 * 60_000;

function parseCloudflareBootstrap(value: unknown, payloadExpiresAt: number): CloudflareAccessBootstrap | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cloudflare 부트스트랩 정보가 올바르지 않습니다.');
  const candidate = value as Partial<CloudflareAccessBootstrap>;
  const now = Date.now();
  const expiresAt = Number(candidate.expiresAt);
  if (candidate.type !== 'cf-authorization'
    || typeof candidate.token !== 'string'
    || candidate.token.length < 64
    || candidate.token.length > 4_096
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(candidate.token)
    || !Number.isSafeInteger(expiresAt)
    || expiresAt <= now
    || expiresAt > now + BOOTSTRAP_TTL_MAX_MS
    || expiresAt > payloadExpiresAt) {
    throw new Error('Cloudflare 부트스트랩 정보가 만료되었거나 올바르지 않습니다.');
  }
  return { type: 'cf-authorization', token: candidate.token, expiresAt };
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

/** Give the scanner a useful recovery message without accepting stale data. */
export function pairingPayloadExpired(raw: string, now = Date.now()): boolean {
  try {
    const obj = JSON.parse(raw) as { app?: unknown; version?: unknown; expiresAt?: unknown; cloudflareBootstrap?: { expiresAt?: unknown } };
    if (obj.app !== 'mr-robot' || (obj.version !== 3 && obj.version !== 5)) return false;
    const payloadExpiry = Number(obj.expiresAt);
    const bootstrapExpiry = Number(obj.cloudflareBootstrap?.expiresAt);
    return (Number.isSafeInteger(payloadExpiry) && payloadExpiry <= now)
      || (obj.version === 5 && Number.isSafeInteger(bootstrapExpiry) && bootstrapExpiry <= now);
  } catch {
    return false;
  }
}

export function parsePairingPayload(raw: string): PairingPayload | null {
  try {
    const obj = JSON.parse(raw) as Partial<PairingPayload> & {
      cloudflareAccess?: unknown;
      requiresCloudflareAccess?: unknown;
    };
    if (obj?.app !== 'mr-robot' || (obj.version !== 3 && obj.version !== 5)) return null;
    if (typeof obj.host !== 'string' || !obj.host.trim() || obj.host.length > 2_048) return null;
    if (!Number.isInteger(obj.port) || Number(obj.port) < 1 || Number(obj.port) > 65_535) return null;
    if (typeof obj.pin !== 'string' || !/^(?:\d{6}|\d{12})$/.test(obj.pin)) return null;
    if (obj.version === 5 && !/^\d{12}$/.test(obj.pin)) return null;
    if (obj.protocol !== undefined && obj.protocol !== 'http' && obj.protocol !== 'https') return null;
    if (obj.hosts !== undefined && (!Array.isArray(obj.hosts)
      || obj.hosts.length > 8
      || obj.hosts.some((host) => typeof host !== 'string' || !host.trim() || host.length > 2_048))) return null;
    if (obj.cloudflareAccess !== undefined) return null;
    if (obj.requiresCloudflareAccess !== undefined) return null;
    if (obj.version === 5 && obj.cloudflareBootstrap === undefined) return null;
    if (obj.version !== 5 && obj.cloudflareBootstrap !== undefined) return null;
    const expiresAt = Number(obj.expiresAt);
    const hasExpiry = obj.expiresAt !== undefined;
    if (obj.version === 5 && !hasExpiry) return null;
    if (hasExpiry && (!Number.isSafeInteger(expiresAt)
      || expiresAt <= Date.now()
      || expiresAt > Date.now() + 25 * 60 * 60_000)) return null;
    const cloudflareBootstrap = parseCloudflareBootstrap(obj.cloudflareBootstrap, expiresAt);
    const payload: PairingPayload = {
      app: 'mr-robot',
      version: obj.version,
      host: obj.host.trim(),
      hosts: obj.hosts?.map((host) => host.trim()),
      protocol: obj.protocol,
      port: Number(obj.port),
      pin: obj.pin,
      ...(hasExpiry ? { expiresAt } : {}),
      ...(cloudflareBootstrap ? { cloudflareBootstrap } : {}),
    };
    const origins = pairingOrigins(payload);
    if (cloudflareBootstrap) payload.cloudflareBootstrapOrigin = origins[0];
    return payload;
  } catch {
    return null;
  }
}
