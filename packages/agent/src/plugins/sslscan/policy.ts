import { isIP } from 'node:net';
import { resolve4, resolve6 } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import type { ResolvedTarget, ScanMode, SslScanRequest } from './types.js';

export const DEFAULT_SSL_PORTS = Object.freeze([
  443, 465, 563, 636, 853, 989, 990, 992, 993, 994, 995, 2376, 5061, 8443, 9443,
]);

const HOST_MAX_LENGTH = 253;
const MIN_SOCKET_TIMEOUT_MS = 500;
const MAX_SOCKET_TIMEOUT_MS = 5_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 2_500;
const MIN_OVERALL_TIMEOUT_MS = 3_000;
const MAX_OVERALL_TIMEOUT_MS = 60_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 30_000;
const MAX_CIPHER_TESTS = 96;
const SCAN_MODE_CIPHER_LIMITS: Readonly<Record<ScanMode, { default: number; max: number }>> = Object.freeze({
  quick: { default: 0, max: 0 },
  standard: { default: 16, max: 24 },
  deep: { default: 96, max: 96 },
});

function boundedInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

function normalizeDnsName(input: string, label: string): string {
  const candidate = input.trim().replace(/\.$/, '');
  if (!candidate || candidate.length > HOST_MAX_LENGTH || /[\s\u0000-\u001f\u007f\\/@?#]/.test(candidate)) {
    throw new Error(`${label} must be a single hostname or IP address, not a URL or target list.`);
  }
  const literalFamily = isIP(candidate);
  if (literalFamily !== 0) return candidate.toLowerCase();
  if (/^[0-9.]+$/.test(candidate)) throw new Error(`${label} is not a valid hostname.`);
  const ascii = domainToASCII(candidate).toLowerCase();
  if (!ascii || ascii.length > HOST_MAX_LENGTH) throw new Error(`${label} is not a valid hostname.`);
  const labels = ascii.split('.');
  if (labels.some((part) => !part || part.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) {
    throw new Error(`${label} is not a valid hostname.`);
  }
  return ascii;
}

function ipv4ToNumber(address: string): number {
  return address.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0) >>> 0;
}

function ipv4InCidr(address: string, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(base) & mask);
}

function ipv6InCidr(address: string, base: string, prefix: number): boolean {
  const words = normalizeIpv6(address);
  const baseWords = normalizeIpv6(base);
  if (words.length !== 8 || baseWords.length !== 8 || prefix < 0 || prefix > 128) return false;
  const wholeWords = Math.floor(prefix / 16);
  for (let index = 0; index < wholeWords; index += 1) {
    if (words[index] !== baseWords[index]) return false;
  }
  const remaining = prefix % 16;
  if (remaining === 0) return true;
  const mask = (0xffff << (16 - remaining)) & 0xffff;
  return (words[wholeWords] & mask) === (baseWords[wholeWords] & mask);
}

function normalizeIpv6(address: string): number[] {
  let value = address.toLowerCase().split('%')[0];
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const ipv4 = value.slice(lastColon + 1);
    const parts = ipv4.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return [];
    value = `${value.slice(0, lastColon)}:${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return [];
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return [];
  const words = [...left, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return [];
  return words.map((word) => Number.parseInt(word, 16));
}

/**
 * True only for globally routable unicast addresses. Ambiguous/special ranges
 * fail closed so a DNS name cannot turn the scanner into an internal-network proxy.
 */
export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const blocked: Array<[string, number]> = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.2', 32], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4],
    ];
    return !blocked.some(([base, prefix]) => ipv4InCidr(address, base, prefix));
  }
  if (family !== 6) return false;
  // IANA currently allocates globally routable unicast from 2000::/3. Keep
  // future/reserved blocks fail-closed until their routing semantics are reviewed.
  if (!ipv6InCidr(address, '2000::', 3)) return false;
  const blocked: Array<[string, number]> = [
    ['2001::', 23], ['2001:2::', 48], ['2001:10::', 28], ['2001:20::', 28],
    ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ];
  return !blocked.some(([base, prefix]) => ipv6InCidr(address, base, prefix));
}

async function resolveAddresses(host: string, timeoutMs: number, signal?: AbortSignal): Promise<Array<{ address: string; family: 4 | 6 }>> {
  signal?.throwIfAborted();
  const literalFamily = isIP(host);
  if (literalFamily) return [{ address: host, family: literalFamily as 4 | 6 }];
  const resolution = Promise.allSettled([resolve4(host), resolve6(host)]);
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`DNS resolution timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error('Scan cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
  });
  let answers: PromiseSettledResult<string[]>[];
  try {
    answers = await Promise.race([resolution, timeout, cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
  const [v4, v6] = answers;
  const addresses = [
    ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 as const })) : []),
    ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 as const })) : []),
  ];
  const unique = [...new Map(addresses.map((entry) => [`${entry.family}:${entry.address}`, entry])).values()];
  if (unique.length === 0) throw new Error('The target hostname did not resolve to an IPv4 or IPv6 address.');
  if (unique.length > 16) throw new Error('The target resolved to too many addresses.');
  return unique;
}

export async function validateAndResolveTarget(
  raw: unknown,
  options: { allowedPorts: readonly number[]; allowPrivateTargets: boolean; signal?: AbortSignal },
): Promise<ResolvedTarget> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('A scan request object is required.');
  const request = raw as Partial<SslScanRequest>;
  if (request.authorizationConfirmed !== true) {
    throw new Error('Confirm that you own the target or have explicit authorization before scanning.');
  }
  const displayHost = String(request.host ?? '').trim();
  const host = normalizeDnsName(displayHost, 'host');
  const port = boundedInteger(request.port, 443, 1, 65_535, 'port');
  if (!options.allowedPorts.includes(port)) {
    throw new Error(`Port ${port} is not enabled for this plugin. Allowed ports: ${options.allowedPorts.join(', ')}.`);
  }
  const sni = request.sni === undefined ? (isIP(host) ? undefined : host) : normalizeDnsName(String(request.sni), 'sni');
  if (sni && isIP(sni)) throw new Error('sni must be a DNS hostname.');
  const timeoutMs = boundedInteger(request.timeoutMs, DEFAULT_SOCKET_TIMEOUT_MS, MIN_SOCKET_TIMEOUT_MS, MAX_SOCKET_TIMEOUT_MS, 'timeoutMs');
  const overallTimeoutMs = boundedInteger(request.overallTimeoutMs, DEFAULT_OVERALL_TIMEOUT_MS, MIN_OVERALL_TIMEOUT_MS, MAX_OVERALL_TIMEOUT_MS, 'overallTimeoutMs');
  const scanMode: ScanMode = request.scanMode === undefined ? 'quick' : request.scanMode;
  if (!Object.hasOwn(SCAN_MODE_CIPHER_LIMITS, scanMode)) throw new Error('scanMode must be quick, standard, or deep.');
  const cipherLimit = SCAN_MODE_CIPHER_LIMITS[scanMode];
  const maxCipherTests = boundedInteger(request.maxCipherTests, cipherLimit.default, 0, cipherLimit.max, `maxCipherTests for ${scanMode} mode`);
  const addresses = await resolveAddresses(host, Math.min(5_000, overallTimeoutMs), options.signal);
  if (!options.allowPrivateTargets) {
    const blocked = addresses.filter((entry) => !isPublicIpAddress(entry.address));
    if (blocked.length > 0) {
      throw new Error('Private, loopback, link-local, documentation, multicast, and other special-use targets are blocked by default.');
    }
  }
  return {
    host,
    displayHost,
    port,
    sni,
    addresses,
    timeoutMs,
    overallTimeoutMs,
    scanMode,
    maxCipherTests,
    forceRefresh: request.forceRefresh === true,
  };
}

export const scanLimits = Object.freeze({
  maxHostLength: HOST_MAX_LENGTH,
  socketTimeoutMs: { min: MIN_SOCKET_TIMEOUT_MS, max: MAX_SOCKET_TIMEOUT_MS, default: DEFAULT_SOCKET_TIMEOUT_MS },
  overallTimeoutMs: { min: MIN_OVERALL_TIMEOUT_MS, max: MAX_OVERALL_TIMEOUT_MS, default: DEFAULT_OVERALL_TIMEOUT_MS },
  maxCipherTests: MAX_CIPHER_TESTS,
  scanModes: SCAN_MODE_CIPHER_LIMITS,
});
