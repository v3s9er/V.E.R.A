/**
 * Side-effect-free invalid pairing request used only to prove that Cloudflare
 * Access protects the enrollment path. It deliberately contains no PIN or
 * device data and is rejected before pairing rate limits or host state.
 */
export const CLOUDFLARE_ACCESS_PAIR_PROBE = 'mr-robot-cloudflare-access-pair-probe-v1';
export const CLOUDFLARE_ACCESS_PAIR_PROBE_ERROR = 'cloudflare access pairing probe rejected';

export function isCloudflareAccessPairProbe(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && record.probe === CLOUDFLARE_ACCESS_PAIR_PROBE;
}
