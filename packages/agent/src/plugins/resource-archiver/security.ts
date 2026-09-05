import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { ArchiveLimits } from './types.js';

const PRIVATE_IPV4 = new BlockList();
const PRIVATE_IPV6 = new BlockList();
const GLOBAL_UNICAST_IPV6 = new BlockList();
GLOBAL_UNICAST_IPV6.addSubnet('2000::', 3, 'ipv6');
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.2', 32], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) PRIVATE_IPV4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['100:0:0:1::', 64], ['2001::', 23], ['2001:2::', 48], ['2001:10::', 28],
  ['2001:20::', 28], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7],
  ['3fff::', 20], ['5f00::', 16], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) PRIVATE_IPV6.addSubnet(network, prefix, 'ipv6');

const SAFE_RESPONSE_HEADERS = new Set(['cache-control', 'content-length', 'content-type', 'etag', 'last-modified']);

export class SafeFetchError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface FetchPolicy {
  pageHost: string;
  allowedCrossOriginHosts: ReadonlySet<string>;
}

export interface SafeFetchResult {
  body: Uint8Array;
  finalUrl: string;
  status: number;
  mimeType: string;
  headers: Record<string, string>;
}

/** Shared across concurrent requests so aggregate decoded traffic cannot race past the run cap. */
export interface SharedByteBudget {
  remaining: number;
}

/** Shared by every worker in one archive run. Reservations prevent concurrent DNS
 * lookups from racing past the remaining physical-request allowance. */
export interface SharedRequestBudget {
  readonly limit: number;
  used: number;
  reserved: number;
}

export type PinnedTarget = { address: string; family: 4 | 6 };
export type ResolvedTargetCache = Map<string, Promise<PinnedTarget>>;

export interface RequestPermit {
  commit(): void;
  release(): void;
}

export function reserveNetworkRequest(budget: SharedRequestBudget): RequestPermit {
  if (budget.used + budget.reserved >= budget.limit) {
    throw new SafeFetchError(`네트워크 요청 ${budget.limit}회 한도를 모두 사용했습니다.`);
  }
  budget.reserved += 1;
  let state: 'reserved' | 'committed' | 'released' = 'reserved';
  return {
    commit() {
      if (state !== 'reserved') return;
      budget.reserved -= 1;
      budget.used += 1;
      state = 'committed';
    },
    release() {
      if (state !== 'reserved') return;
      budget.reserved -= 1;
      state = 'released';
    },
  };
}

export function parseWebUrl(raw: unknown, label = 'URL'): URL {
  const value = String(raw ?? '').trim();
  if (!value || value.length > 8_192) throw new Error(`${label} 길이가 올바르지 않습니다.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} 형식이 올바르지 않습니다.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${label}은(는) HTTP 또는 HTTPS여야 합니다.`);
  if (url.username || url.password) throw new Error(`${label}에 사용자 이름이나 비밀번호를 넣을 수 없습니다.`);
  if ((url.protocol === 'http:' && url.port && url.port !== '80') || (url.protocol === 'https:' && url.port && url.port !== '443')) {
    throw new Error(`${label}은(는) 표준 웹 포트(80/443)만 사용할 수 있습니다.`);
  }
  url.hash = '';
  return url;
}

export function canonicalResourceUrl(raw: string, base?: string): string {
  if (!raw || raw.length > 8_192) throw new Error('리소스 URL 길이가 올바르지 않습니다.');
  const url = base ? new URL(raw, base) : new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('지원하지 않는 리소스 URL입니다.');
  if (url.username || url.password) throw new Error('자격 증명이 포함된 리소스 URL은 사용할 수 없습니다.');
  url.hash = '';
  return url.href;
}

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[REDACTED]');
    return url.href;
  } catch {
    return '[invalid-url]';
  }
}

export function normalizeAllowedHosts(raw: unknown, pageHost: string): Set<string> {
  if (raw === undefined) return new Set();
  if (!Array.isArray(raw)) throw new Error('allowedCrossOriginHosts는 정확한 호스트 이름 배열이어야 합니다.');
  if (raw.length > 32) throw new Error('교차 출처 허용 호스트는 최대 32개입니다.');
  const result = new Set<string>();
  for (const item of raw) {
    const host = String(item).trim().toLowerCase().replace(/\.$/, '');
    if (!host || host.length > 253 || host.includes('*') || host.includes('/') || host.includes('@') || host.includes(':')) {
      throw new Error(`교차 출처 호스트가 올바르지 않습니다: ${String(item)}`);
    }
    if (host !== pageHost) result.add(host);
  }
  return result;
}

export function isPublicAddress(raw: string): boolean {
  const address = raw.split('%', 1)[0];
  const family = isIP(address);
  if (family === 4) return !PRIVATE_IPV4.check(address, 'ipv4');
  if (family === 6) return GLOBAL_UNICAST_IPV6.check(address, 'ipv6') && !PRIVATE_IPV6.check(address, 'ipv6');
  return false;
}

export async function resolvePublicTarget(
  url: URL,
  policy: FetchPolicy,
  resolver: typeof dnsLookup = dnsLookup,
): Promise<PinnedTarget> {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host !== policy.pageHost && !policy.allowedCrossOriginHosts.has(host)) {
    throw new SafeFetchError(`교차 출처 호스트가 허용 목록에 없습니다: ${host}`);
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new SafeFetchError(`로컬/내부 호스트는 가져올 수 없습니다: ${host}`);
  }
  const directFamily = isIP(host);
  if (directFamily) {
    if (!isPublicAddress(host)) throw new SafeFetchError(`사설·예약 주소는 가져올 수 없습니다: ${host}`);
    return { address: host, family: directFamily as 4 | 6 };
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await resolver(host, { all: true, verbatim: true }) as Array<{ address: string; family: number }>;
  } catch {
    throw new SafeFetchError(`DNS 조회에 실패했습니다: ${host}`, true);
  }
  const list = records;
  if (list.length === 0) throw new SafeFetchError(`DNS 결과가 없습니다: ${host}`, true);
  if (list.some((record) => !isPublicAddress(record.address))) {
    throw new SafeFetchError(`공개 주소와 사설·예약 주소가 섞인 DNS 응답을 거부했습니다: ${host}`);
  }
  // Prefer IPv4 when both families are advertised: many Windows hosts have an
  // IPv6 resolver result but no usable IPv6 route. Every answer was already
  // validated above, so this preference does not weaken the SSRF boundary.
  const selected = list.find((record) => record.family === 4) ?? list[0];
  return { address: selected.address, family: selected.family as 4 | 6 };
}

/** Cache only validated, pinned answers for the lifetime of one archive run. A
 * rejected lookup is evicted so a bounded retry can perform a fresh lookup. */
export async function resolvePublicTargetCached(
  url: URL,
  policy: FetchPolicy,
  cache: ResolvedTargetCache,
  resolver: typeof dnsLookup = dnsLookup,
  signal?: AbortSignal,
): Promise<PinnedTarget> {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  let pending = cache.get(host);
  if (!pending) {
    pending = resolvePublicTarget(url, policy, resolver);
    cache.set(host, pending);
  }
  try {
    return await awaitWithSignal(pending, signal);
  } catch (error) {
    if (cache.get(host) === pending) cache.delete(host);
    throw error;
  }
}

export async function fetchPublicResource(
  rawUrl: string,
  policy: FetchPolicy,
  limits: ArchiveLimits,
  signal?: AbortSignal,
  sharedBudget?: SharedByteBudget,
  beforeRequest?: () => Promise<void>,
  requestBudget?: SharedRequestBudget,
  resolutionCache?: ResolvedTargetCache,
): Promise<SafeFetchResult> {
  let current = parseWebUrl(rawUrl, '리소스 URL');
  for (let redirects = 0; ; redirects += 1) {
    signal?.throwIfAborted();
    const permit = requestBudget ? reserveNetworkRequest(requestBudget) : undefined;
    let result: OneResponse;
    try {
      const pinned = await resolveThenPaceRequest(
        () => resolutionCache
          ? resolvePublicTargetCached(current, policy, resolutionCache, dnsLookup, signal)
          : awaitWithSignal(resolvePublicTarget(current, policy), signal),
        beforeRequest,
        signal,
      );
      permit?.commit();
      result = await requestOnce(current, pinned, limits.maxResourceBytes, limits.timeoutMs, signal, sharedBudget);
    } catch (error) {
      permit?.release();
      throw error;
    }
    if (result.redirect) {
      if (redirects >= limits.maxRedirects) throw new SafeFetchError('리디렉션 횟수 한도를 초과했습니다.');
      current = validateRedirectTarget(current, result.redirect);
      continue;
    }
    return {
      body: result.body!,
      finalUrl: current.href,
      status: result.status,
      mimeType: result.mimeType,
      headers: result.headers,
    };
  }
}

export async function resolveThenPaceRequest<T>(
  resolveTarget: () => Promise<T>,
  beforeRequest?: () => Promise<void>,
  signal?: AbortSignal,
): Promise<T> {
  const target = await resolveTarget();
  signal?.throwIfAborted();
  await beforeRequest?.();
  signal?.throwIfAborted();
  return target;
}

async function awaitWithSignal<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await pending;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error('작업이 취소되었습니다.'));
    signal.addEventListener('abort', aborted, { once: true });
    void pending.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}

export function validateRedirectTarget(current: URL, location: string): URL {
  const next = parseWebUrl(new URL(location, current).href, '리디렉션 URL');
  if (current.protocol === 'https:' && next.protocol === 'http:') {
    throw new SafeFetchError('HTTPS에서 HTTP로 내려가는 리디렉션을 거부했습니다.');
  }
  return next;
}

interface OneResponse {
  body?: Uint8Array;
  redirect?: string;
  status: number;
  mimeType: string;
  headers: Record<string, string>;
}

async function requestOnce(
  url: URL,
  pinned: { address: string; family: 4 | 6 },
  maxBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
  sharedBudget?: SharedByteBudget,
): Promise<OneResponse> {
  const lookup = ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  }) as LookupFunction;
  const options: RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    lookup,
    signal,
    timeout: timeoutMs,
    headers: {
      accept: '*/*',
      'accept-encoding': 'identity',
      'user-agent': 'MrRobot-ResourceArchiver/1.0',
    },
  };
  return await new Promise<OneResponse>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(options, (response) => {
      void handleResponse(response, maxBytes, sharedBudget).then(resolve, reject);
    });
    request.once('timeout', () => request.destroy(new SafeFetchError('요청 시간이 초과되었습니다.', true)));
    request.once('error', (error) => reject(error instanceof SafeFetchError ? error : new SafeFetchError('네트워크 요청에 실패했습니다.', true)));
    request.end();
  });
}

async function handleResponse(response: IncomingMessage, maxBytes: number, sharedBudget?: SharedByteBudget): Promise<OneResponse> {
  const status = response.statusCode ?? 0;
  const headers = safeResponseHeaders(response.headers);
  const redirect = response.headers.location;
  if ([301, 302, 303, 307, 308].includes(status) && typeof redirect === 'string') {
    response.destroy();
    return { redirect, status, mimeType: '', headers };
  }
  if (status < 200 || status >= 300) {
    response.destroy();
    throw new SafeFetchError(`HTTP ${status} 응답을 저장하지 않았습니다.`, status === 408 || status === 425 || status === 429 || status >= 500);
  }
  const announced = Number(response.headers['content-length'] ?? 0);
  if (Number.isFinite(announced) && announced > maxBytes) {
    response.destroy();
    throw new SafeFetchError(`응답이 리소스당 ${maxBytes}바이트 한도를 초과합니다.`);
  }
  const stream = decodedStream(response);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        stream.destroy();
        response.destroy();
        throw new SafeFetchError(`압축 해제된 응답이 리소스당 ${maxBytes}바이트 한도를 초과합니다.`);
      }
      if (sharedBudget && chunk.byteLength > sharedBudget.remaining) {
        sharedBudget.remaining = 0;
        stream.destroy();
        response.destroy();
        throw new SafeFetchError('전체 네트워크 바이트 예산을 초과했습니다.');
      }
      if (sharedBudget) sharedBudget.remaining -= chunk.byteLength;
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof SafeFetchError) throw error;
    throw new SafeFetchError('응답 본문을 읽지 못했습니다.', true);
  }
  const contentType = String(response.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  return { body: Buffer.concat(chunks), status, mimeType: contentType, headers };
}

function decodedStream(response: IncomingMessage): IncomingMessage | Transform {
  const encoding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase();
  if (!encoding || encoding === 'identity') return response;
  let decoder: Transform;
  if (encoding === 'gzip' || encoding === 'x-gzip') decoder = createGunzip();
  else if (encoding === 'deflate') decoder = createInflate();
  else if (encoding === 'br') decoder = createBrotliDecompress();
  else {
    response.destroy();
    throw new SafeFetchError(`지원하지 않는 Content-Encoding입니다: ${encoding}`);
  }
  return response.pipe(decoder);
}

export function safeResponseHeaders(raw: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalized = key.toLowerCase();
    if (!SAFE_RESPONSE_HEADERS.has(normalized) || value === undefined) continue;
    const rendered = (Array.isArray(value) ? value.join(', ') : String(value)).replace(/[\r\n]/g, ' ').slice(0, 512);
    result[normalized] = rendered;
  }
  return result;
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new Error('작업이 취소되었습니다.'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
