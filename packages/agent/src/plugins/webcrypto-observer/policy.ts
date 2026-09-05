import { lookup as systemDnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { isPublicAddress, parseWebUrl, redactUrl } from '../resource-archiver/security.js';
import type {
  DnsLookup,
  NormalizedObserveRequest,
  ObservationLimits,
  ObservationLimitsInput,
  ObserveRequest,
  RuntimeObservationHostPolicy,
  WebCryptoObserverHostPolicyProvider,
} from './types.js';

const MiB = 1024 * 1024;
const MAX_POLICY_DOMAINS = 64;
const DNS_TIMEOUT_MS = 5_000;

export const WEBCRYPTO_OBSERVER_LIMITS = Object.freeze({
  durationMs: { min: 1_000, max: 30_000, default: 10_000 },
  maxRequests: { min: 1, max: 40, default: 20 },
  maxResponseBytes: { min: 64 * 1024, max: 8 * MiB, default: 4 * MiB },
  maxConcurrentRequests: { min: 1, max: 8, default: 4 },
  maxRingEvents: { min: 1, max: 128, default: 64 },
  maxRequestBodyBytes: { min: 0, max: 256 * 1024, default: 64 * 1024 },
  maxUploadBytes: { min: 0, max: 512 * 1024, default: 128 * 1024 },
  maxPlaintextPreviewBytes: 128,
  maxSourceBytes: 256 * 1024,
  maxLiteralBytes: 64,
  maxSessions: 1,
} as const);

export async function normalizeObserveRequest(
  raw: unknown,
  policyProvider: WebCryptoObserverHostPolicyProvider | undefined,
  dnsLookup: DnsLookup = systemDnsLookup as DnsLookup,
  signal?: AbortSignal,
): Promise<NormalizedObserveRequest> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('관찰 요청 객체가 필요합니다.');
  const request = raw as Partial<ObserveRequest>;
  rejectUnknownKeys(request as Record<string, unknown>, new Set([
    'authorizationConfirmed', 'sessionEnabled', 'targetUrl', 'plaintextPreview',
    'allowStateChangingRequests', 'stateChangingRequestsConfirmed', 'limits',
  ]), '관찰 요청');
  if (request.authorizationConfirmed !== true) throw new Error('대상을 소유하거나 명시적으로 허가받았음을 확인해야 합니다.');
  if (request.sessionEnabled !== true) throw new Error('이 관찰 세션을 명시적으로 활성화해야 합니다.');
  if (!policyProvider) throw new Error('네이티브 관리자 도메인 정책이 구성되지 않아 관찰을 실행할 수 없습니다.');

  signal?.throwIfAborted();
  const policy = await withTimeout(policyProvider.getPolicy(), 2_000, '관리자 정책 확인', signal);
  if (!policy?.enabled) throw new Error('네이티브 관리자가 WebCrypto 관찰을 활성화하지 않았습니다.');
  const allowedDomains = normalizePolicyDomains(policy);
  if (allowedDomains.size === 0) throw new Error('네이티브 관리자가 설정한 정확한 도메인 allowlist가 필요합니다.');

  const url = parseWebUrl(request.targetUrl, '대상 URL');
  if (url.protocol !== 'https:' || url.port) {
    throw new Error('WebCrypto 런타임 관찰은 HTTPS 기본 포트 443 대상만 허용합니다.');
  }
  const host = normalizeDnsDomain(url.hostname, '대상 호스트');
  if (isIP(host) !== 0) throw new Error('대상은 정확한 allowlist와 공개 DNS 검증이 가능한 DNS 이름이어야 합니다.');
  if (!allowedDomains.has(host)) throw new Error('대상 호스트가 네이티브 관리자의 정확한 도메인 allowlist에 없습니다.');
  url.hostname = host;

  const limits = normalizeObservationLimits(request.limits);
  const allowStateChangingRequests = request.allowStateChangingRequests === true
    && request.stateChangingRequestsConfirmed === true;
  if ((request.allowStateChangingRequests === true) !== (request.stateChangingRequestsConfirmed === true)) {
    throw new Error('상태 변경 요청에는 활성화와 별도 확인이 모두 필요합니다.');
  }
  const preview = normalizePlaintextPreview(request.plaintextPreview);
  const answers = await withTimeout(dnsLookup(host, { all: true, verbatim: true }), DNS_TIMEOUT_MS, '공개 DNS 확인', signal);
  const addresses = [...new Map(answers.map((entry) => [`${entry.family}:${entry.address}`, entry])).values()];
  if (addresses.length === 0 || addresses.length > 16) throw new Error('대상 DNS 응답 수가 안전 범위를 벗어났습니다.');
  if (addresses.some((entry) => (entry.family !== 4 && entry.family !== 6) || !isPublicAddress(entry.address))) {
    throw new Error('사설, 루프백, 링크 로컬, 문서용 또는 기타 특수 IP가 포함된 DNS 대상은 차단됩니다.');
  }
  const pinned = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  signal?.throwIfAborted();
  return {
    target: {
      url: url.href,
      redactedUrl: redactUrl(url.href),
      origin: url.origin,
      host,
      pinnedAddress: pinned.address,
      family: pinned.family as 4 | 6,
      resolvedAddressCount: addresses.length,
    },
    limits,
    preview,
    allowStateChangingRequests,
    browserExecutable: policy.browserExecutable,
  };
}

export function normalizeObservationLimits(raw: ObservationLimitsInput | undefined): ObservationLimits {
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('limits는 객체여야 합니다.');
  const source = (raw ?? {}) as Record<string, unknown>;
  rejectUnknownKeys(source, new Set([
    'durationMs', 'maxRequests', 'maxResponseBytes', 'maxConcurrentRequests',
    'maxRingEvents', 'maxRequestBodyBytes', 'maxUploadBytes',
  ]), 'limits');
  return {
    durationMs: boundedInteger(source.durationMs, WEBCRYPTO_OBSERVER_LIMITS.durationMs, 'durationMs'),
    maxRequests: boundedInteger(source.maxRequests, WEBCRYPTO_OBSERVER_LIMITS.maxRequests, 'maxRequests'),
    maxResponseBytes: boundedInteger(source.maxResponseBytes, WEBCRYPTO_OBSERVER_LIMITS.maxResponseBytes, 'maxResponseBytes'),
    maxConcurrentRequests: boundedInteger(source.maxConcurrentRequests, WEBCRYPTO_OBSERVER_LIMITS.maxConcurrentRequests, 'maxConcurrentRequests'),
    maxRingEvents: boundedInteger(source.maxRingEvents, WEBCRYPTO_OBSERVER_LIMITS.maxRingEvents, 'maxRingEvents'),
    maxRequestBodyBytes: boundedInteger(source.maxRequestBodyBytes, WEBCRYPTO_OBSERVER_LIMITS.maxRequestBodyBytes, 'maxRequestBodyBytes'),
    maxUploadBytes: boundedInteger(source.maxUploadBytes, WEBCRYPTO_OBSERVER_LIMITS.maxUploadBytes, 'maxUploadBytes'),
  };
}

export function chromiumHostResolverRules(host: string, address: string): string {
  const normalizedHost = normalizeDnsDomain(host, '고정 대상 호스트');
  const family = isIP(address);
  if (family === 0 || !isPublicAddress(address)) throw new Error('검증된 공개 IP만 브라우저에 고정할 수 있습니다.');
  const renderedAddress = family === 6 ? `[${address}]` : address;
  return `MAP ${normalizedHost} ${renderedAddress}, MAP * ~NOTFOUND`;
}

export async function policyStatus(provider: WebCryptoObserverHostPolicyProvider | undefined): Promise<{
  configured: boolean;
  enabled: boolean;
  exactDomainCount: number;
}> {
  if (!provider) return { configured: false, enabled: false, exactDomainCount: 0 };
  try {
    const policy = await withTimeout(provider.getPolicy(), 2_000, '관리자 정책 확인');
    if (!policy) return { configured: false, enabled: false, exactDomainCount: 0 };
    const domains = normalizePolicyDomains(policy);
    return { configured: domains.size > 0, enabled: policy.enabled === true, exactDomainCount: domains.size };
  } catch {
    return { configured: false, enabled: false, exactDomainCount: 0 };
  }
}

function normalizePolicyDomains(policy: RuntimeObservationHostPolicy): Set<string> {
  if (!Array.isArray(policy.allowedDomains) || policy.allowedDomains.length > MAX_POLICY_DOMAINS) {
    throw new Error(`관리자 도메인 allowlist는 1~${MAX_POLICY_DOMAINS}개의 정확한 DNS 이름이어야 합니다.`);
  }
  const result = new Set<string>();
  for (const value of policy.allowedDomains) result.add(normalizeDnsDomain(String(value), 'allowlist 도메인'));
  return result;
}

function normalizeDnsDomain(raw: string, label: string): string {
  const candidate = raw.trim().replace(/\.$/, '');
  if (!candidate || candidate.length > 253 || candidate.includes('*') || candidate.includes(':')
    || candidate.includes('[') || candidate.includes(']') || /[\s\u0000-\u001f\u007f\\/@?#]/.test(candidate)) {
    throw new Error(`${label}은 와일드카드 없는 정확한 DNS 이름이어야 합니다.`);
  }
  const ascii = domainToASCII(candidate).toLowerCase();
  const labels = ascii.split('.');
  if (!ascii || labels.some((part) => !part || part.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) {
    throw new Error(`${label} 형식이 올바르지 않습니다.`);
  }
  return ascii;
}

function normalizePlaintextPreview(raw: unknown): { enabled: boolean; maxBytes: number } {
  if (raw === undefined) return { enabled: false, maxBytes: 0 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('plaintextPreview는 객체여야 합니다.');
  const preview = raw as Record<string, unknown>;
  rejectUnknownKeys(preview, new Set(['enabled', 'previewConfirmed', 'maxBytes']), 'plaintextPreview');
  if (preview.enabled !== true || preview.previewConfirmed !== true) {
    throw new Error('평문 미리보기에는 세션별 활성화와 별도 확인이 모두 필요합니다.');
  }
  const maxBytes = preview.maxBytes === undefined
    ? 64
    : boundedInteger(preview.maxBytes, { min: 1, max: WEBCRYPTO_OBSERVER_LIMITS.maxPlaintextPreviewBytes, default: 64 }, 'plaintextPreview.maxBytes');
  return { enabled: true, maxBytes };
}

function boundedInteger(
  value: unknown,
  range: { min: number; max: number; default: number },
  label: string,
): number {
  if (value === undefined) return range.default;
  if (!Number.isInteger(value) || Number(value) < range.min || Number(value) > range.max) {
    throw new Error(`${label}은 ${range.min}~${range.max} 범위의 정수여야 합니다.`);
  }
  return Number(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label}에 지원하지 않는 필드가 있습니다: ${unknown.slice(0, 3).join(', ')}`);
}

async function withTimeout<T>(pending: T | Promise<T>, timeoutMs: number, label: string, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`${label} 시간이 ${timeoutMs}ms를 초과했습니다.`))), timeoutMs);
    timer.unref?.();
    const abort = () => finish(() => reject(signal?.reason ?? new Error('작업이 취소되었습니다.')));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(new Error(`${label}에 실패했습니다.`))),
    );
  });
}
