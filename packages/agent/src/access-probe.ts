/**
 * Side-effect-free invalid pairing request used only to prove that Cloudflare
 * Access protects the enrollment path. It deliberately contains no PIN or
 * device data and is rejected before pairing rate limits or host state.
 */
export const CLOUDFLARE_ACCESS_PAIR_PROBE = 'mr-robot-cloudflare-access-pair-probe-v1';
export const CLOUDFLARE_ACCESS_PAIR_PROBE_ERROR = 'cloudflare access pairing probe rejected';
export const CLOUDFLARE_ACCESS_BOOTSTRAP_PROBE = 'mr-robot-cloudflare-access-bootstrap-probe-v1';
export const CLOUDFLARE_ACCESS_BOOTSTRAP_COOKIE = '__Host-MrRobot-Access-Bootstrap';

export function isCloudflareAccessPairProbe(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && record.probe === CLOUDFLARE_ACCESS_PAIR_PROBE;
}

/**
 * A service-token-authenticated caller uses this side-effect-free request to
 * obtain, and then independently replay-test, the short-lived Access
 * application assertion that Cloudflare put on the request. The random
 * challenge prevents a stale/cached response from being accepted.
 */
export function cloudflareAccessBootstrapChallenge(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2
    || record.probe !== CLOUDFLARE_ACCESS_BOOTSTRAP_PROBE
    || typeof record.challenge !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(record.challenge)) return undefined;
  return record.challenge;
}
