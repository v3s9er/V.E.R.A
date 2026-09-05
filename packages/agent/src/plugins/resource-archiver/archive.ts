import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import { basename, dirname, extname, posix } from 'node:path';
import { zip } from 'fflate';
import { resolveWorkspacePath } from '../../path-security.js';
import type { PluginExecutionContext } from '../commands.js';
import { discoverReferences, isCss, isHtml, rewriteResourceLinks } from './extract.js';
import {
  SafeFetchError,
  abortableDelay,
  canonicalResourceUrl,
  fetchPublicResource,
  normalizeAllowedHosts,
  parseWebUrl,
  redactUrl,
  safeResponseHeaders,
  type FetchPolicy,
  type ResolvedTargetCache,
  type SharedByteBudget,
  type SharedRequestBudget,
} from './security.js';
import type {
  ArchiveFailure,
  ArchiveLimits,
  CapturedResourceInput,
  CollectedResource,
  ResourceArchiveManifest,
  ResourceArchivePreview,
  ResourceArchiveProgress,
  ResourceArchiveRequest,
  ResourceArchiveResult,
  ResourceManifestEntry,
} from './types.js';

const MiB = 1024 * 1024;
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxResources: 200,
  maxNetworkRequests: 40,
  maxResourceBytes: 8 * MiB,
  maxTotalBytes: 32 * MiB,
  maxDepth: 2,
  concurrency: 2,
  timeoutMs: 10_000,
  retries: 0,
  maxRedirects: 4,
  minRequestIntervalMs: 150,
  overallTimeoutMs: 60_000,
};

const MIME_EXTENSIONS: Record<string, string> = {
  'text/html': '.html', 'application/xhtml+xml': '.xhtml', 'text/css': '.css',
  'text/javascript': '.js', 'application/javascript': '.js', 'application/json': '.json',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/svg+xml': '.svg', 'image/x-icon': '.ico', 'font/woff': '.woff', 'font/woff2': '.woff2',
  'font/ttf': '.ttf', 'font/otf': '.otf', 'audio/mpeg': '.mp3', 'video/mp4': '.mp4',
  'application/wasm': '.wasm', 'application/xml': '.xml', 'text/xml': '.xml',
};

interface ParsedArchiveRequest {
  request: ResourceArchiveRequest;
  page: URL;
  limits: ArchiveLimits;
  fetchMissing: boolean;
  discoverDependencies: boolean;
  rewriteOfflineLinks: boolean;
  allowedHosts: Set<string>;
}

export function validateResourceArchiveRequest(raw: unknown): {
  pageUrl: string;
  capturedResources: number;
  harEntries: number;
  fetchMissing: boolean;
  limits: ArchiveLimits;
  allowedCrossOriginHosts: string[];
} {
  const parsed = parseRequest(raw);
  return {
    pageUrl: redactUrl(parsed.page.href),
    capturedResources: parsed.request.capturedResources?.length ?? 0,
    harEntries: parsed.request.har?.log?.entries?.length ?? 0,
    fetchMissing: parsed.fetchMissing,
    limits: parsed.limits,
    allowedCrossOriginHosts: [...parsed.allowedHosts],
  };
}

export function previewResourceArchive(raw: unknown): ResourceArchivePreview {
  const parsed = parseRequest(raw);
  const inputs = [...(parsed.request.capturedResources ?? []), ...harResources(parsed.request.har)];
  const seen = new Map<string, { body?: Uint8Array; method: string; mimeType: string }>();
  let suppliedDecodedBytes = 0;
  let suppliedBodies = 0;
  for (const input of inputs) {
    const body = decodeInputBody(input, parsed.limits.maxResourceBytes);
    const url = normalizeCapturedUrl(input.url, parsed.page, body);
    const existing = seen.get(url);
    if (body && !existing?.body) {
      suppliedBodies += 1;
      suppliedDecodedBytes += body.byteLength;
    }
    seen.set(url, {
      body: existing?.body ?? body,
      method: normalizeMethod(input.method),
      mimeType: normalizeMime(input.mimeType) ?? '',
    });
  }
  if (!seen.has(parsed.page.href)) {
    if (seen.size >= parsed.limits.maxResources) throw new Error('페이지 본문을 위한 리소스 슬롯이 남아 있지 않습니다.');
    seen.set(parsed.page.href, { method: 'GET', mimeType: '' });
  }
  const references = new Set<string>();
  for (const [ownerUrl, resource] of seen) {
    if (!resource.body || !parsed.discoverDependencies) continue;
    const remaining = Math.max(0, parsed.limits.maxResources - seen.size - references.size);
    if (remaining === 0) break;
    for (const target of discoverReferences(resource.body, resource.mimeType, ownerUrl, remaining)) references.add(target);
  }
  const missingUrls = new Set([...seen.entries()].filter(([, resource]) => !resource.body).map(([url]) => url));
  for (const url of references) if (!seen.get(url)?.body) missingUrls.add(url);
  const missingBodies = missingUrls.size;
  const fetchableMissing = [...missingUrls].filter((url) => (seen.get(url)?.method ?? 'GET') === 'GET' && isHttpUrl(url)).length;
  const warnings: string[] = [];
  if (!parsed.fetchMissing && missingBodies > 0) warnings.push('네트워크 가져오기는 꺼져 있으며 본문이 없는 항목은 결과에서 제외됩니다.');
  if (parsed.fetchMissing) warnings.push('직접 네트워크 가져오기를 명시적으로 켰습니다. 페이지 호스트와 정확히 허용한 공개 호스트만 요청합니다.');
  if (parsed.fetchMissing && fetchableMissing > parsed.limits.maxNetworkRequests) {
    warnings.push(`알려진 누락 리소스가 네트워크 요청 한도 ${parsed.limits.maxNetworkRequests}회를 초과합니다. 리디렉션과 재시도도 각각 한도를 사용합니다.`);
  }
  if (suppliedDecodedBytes > parsed.limits.maxTotalBytes) warnings.push('공급된 본문만으로 전체 바이트 한도를 초과합니다.');
  const modes: ResourceArchivePreview['inputModes'] = [];
  if ((parsed.request.capturedResources?.length ?? 0) > 0) modes.push('browser-capture');
  if ((parsed.request.har?.log?.entries?.length ?? 0) > 0) modes.push('har');
  if (parsed.fetchMissing) modes.push('direct-url');
  return {
    dryRun: true,
    pageUrl: manifestUrl(parsed.page.href),
    inputModes: modes,
    suppliedResources: inputs.length,
    suppliedBodies,
    uniqueSuppliedUrls: seen.size,
    suppliedDecodedBytes,
    discoveredReferences: references.size,
    missingBodies,
    estimatedNetworkRequests: parsed.fetchMissing ? fetchableMissing : 0,
    networkRequestLimit: parsed.limits.maxNetworkRequests,
    networkOptIn: parsed.fetchMissing,
    outputPath: String(parsed.request.outputPath ?? `resource-archives/${sanitizeSegment(parsed.page.hostname)}-<timestamp>.zip`),
    limits: parsed.limits,
    allowedFetchHosts: [parsed.page.hostname.toLowerCase(), ...parsed.allowedHosts].sort(),
    warnings,
    trafficProfile: trafficProfile(parsed),
  };
}

export async function archiveWebResources(
  raw: unknown,
  execution?: PluginExecutionContext,
  onProgress: (progress: ResourceArchiveProgress) => void = () => undefined,
): Promise<ResourceArchiveResult> {
  onProgress({ phase: 'validating', completed: 0, total: 1 });
  const parsed = parseRequest(raw);
  if (!execution?.workspaceRoot) throw new Error('리소스 ZIP을 저장하려면 대화에서 작업 폴더를 먼저 선택하세요.');
  if (execution.permissionMode === 'read-only') throw new Error('읽기 전용 권한에서는 리소스 보존 ZIP을 만들 수 없습니다.');
  if (!execution.destructiveApproved) throw new Error('리소스 보존 작업 승인이 필요합니다.');
  const deadline = combinedDeadlineSignal(execution.signal, parsed.limits.overallTimeoutMs);
  try {
    deadline.throwIfExpired();
    onProgress({ phase: 'validating', completed: 1, total: 1 });
    return await archiveWebResourcesWithinDeadline(
      parsed,
      { ...execution, workspaceRoot: execution.workspaceRoot, signal: deadline.signal },
      onProgress,
      deadline.throwIfExpired,
    );
  } finally {
    deadline.cleanup();
  }
}

async function archiveWebResourcesWithinDeadline(
  parsed: ParsedArchiveRequest,
  execution: PluginExecutionContext & { workspaceRoot: string },
  onProgress: (progress: ResourceArchiveProgress) => void,
  throwIfExpired: () => void,
): Promise<ResourceArchiveResult> {
  const resources = new Map<string, CollectedResource>();
  const failures: ArchiveFailure[] = [];
  const graph = new Set<string>();
  let totalBytes = 0;
  onProgress({ phase: 'ingesting', completed: 0, total: (parsed.request.capturedResources?.length ?? 0) + (parsed.request.har?.log?.entries?.length ?? 0) + 1 });

  const addResource = (input: CapturedResourceInput, source: CollectedResource['source'], depth: number): void => {
    const decoded = decodeInputBody(input, parsed.limits.maxResourceBytes);
    const url = normalizeCapturedUrl(input.url, parsed.page, decoded);
    const method = normalizeMethod(input.method);
    const headers = safeResponseHeaders(input.responseHeaders ?? {});
    const mimeType = normalizeMime(input.mimeType) ?? normalizeMime(headers['content-type']);
    const existing = resources.get(url);
    if (existing) {
      existing.depth = Math.min(existing.depth, depth);
      if (existing.body && decoded && sha256(existing.body) !== sha256(decoded)) {
        failures.push({ url: manifestUrl(url), stage: 'input', reason: '같은 URL에 서로 다른 캡처 본문이 있어 먼저 제공된 본문만 사용했습니다.' });
      }
      if (!existing.body && decoded) {
        if (totalBytes + decoded.byteLength > parsed.limits.maxTotalBytes) throw new Error('입력 본문 합계가 전체 크기 한도를 초과합니다.');
        existing.body = decoded;
        existing.mimeType = existing.mimeType ?? mimeType;
        existing.status = existing.status ?? finiteStatus(input.status);
        existing.headers = existing.headers && Object.keys(existing.headers).length > 0 ? existing.headers : headers;
        totalBytes += decoded.byteLength;
      }
      return;
    }
    if (resources.size >= parsed.limits.maxResources) throw new Error(`입력 리소스가 ${parsed.limits.maxResources}개 한도를 초과합니다.`);
    if (decoded && totalBytes + decoded.byteLength > parsed.limits.maxTotalBytes) throw new Error('입력 본문 합계가 전체 크기 한도를 초과합니다.');
    if (decoded) totalBytes += decoded.byteLength;
    resources.set(url, {
      url,
      method,
      source,
      depth,
      body: decoded,
      status: finiteStatus(input.status),
      mimeType,
      headers,
      fetchEligible: method === 'GET' && isHttpUrl(url),
      graphScanned: false,
    });
  };

  for (const item of parsed.request.capturedResources ?? []) {
    addResource(item, 'browser-capture', sameUrl(item.url, parsed.page.href) ? 0 : 1);
    throwIfExpired();
  }
  for (const item of harResources(parsed.request.har)) {
    addResource(item, 'har', sameUrl(item.url, parsed.page.href) ? 0 : 1);
    throwIfExpired();
  }
  if (!resources.has(parsed.page.href)) {
    if (resources.size >= parsed.limits.maxResources) throw new Error('페이지 본문을 위한 리소스 슬롯이 남아 있지 않습니다.');
    resources.set(parsed.page.href, {
      url: parsed.page.href,
      method: 'GET',
      source: 'network',
      depth: 0,
      fetchEligible: true,
      graphScanned: false,
    });
  } else {
    resources.get(parsed.page.href)!.depth = 0;
  }
  onProgress({ phase: 'ingesting', completed: resources.size, total: resources.size });

  const policy: FetchPolicy = { pageHost: parsed.page.hostname.toLowerCase(), allowedCrossOriginHosts: parsed.allowedHosts };
  const networkBudget: SharedByteBudget = { remaining: Math.max(0, parsed.limits.maxTotalBytes - totalBytes) };
  const requestBudget: SharedRequestBudget = { limit: parsed.limits.maxNetworkRequests, used: 0, reserved: 0 };
  const resolutionCache: ResolvedTargetCache = new Map();
  const requestPacer = new RequestPacer(parsed.limits.minRequestIntervalMs);
  let discoveryLimitReported = false;
  for (let depth = 0; depth <= parsed.limits.maxDepth; depth += 1) {
    execution.signal?.throwIfAborted();
    const missing = [...resources.values()].filter((resource) => resource.depth === depth && !resource.body && !resource.error);
    if (parsed.fetchMissing) {
      const fetchable = missing.filter((resource) => resource.fetchEligible);
      let fetchCompleted = 0;
      onProgress({ phase: 'fetching', completed: 0, total: fetchable.length, detail: `dependency depth ${depth}` });
      await mapConcurrent(fetchable, parsed.limits.concurrency, async (resource) => {
        const outcome = await fetchWithRetries(resource.url, policy, parsed.limits, execution.signal, networkBudget, requestPacer, requestBudget, resolutionCache);
        resource.attempts = outcome.attempts;
        if ('error' in outcome) {
          resource.error = outcome.error;
          failures.push({ url: manifestUrl(resource.url), stage: 'fetch', reason: outcome.error, attempts: outcome.attempts });
          fetchCompleted += 1;
          onProgress({ phase: 'fetching', completed: fetchCompleted, total: fetchable.length, detail: `dependency depth ${depth}` });
          return;
        }
        if (totalBytes + outcome.result.body.byteLength > parsed.limits.maxTotalBytes) {
          resource.error = '전체 압축 전 크기 한도를 초과하여 제외했습니다.';
          failures.push({ url: manifestUrl(resource.url), stage: 'limit', reason: resource.error, attempts: outcome.attempts });
          fetchCompleted += 1;
          onProgress({ phase: 'fetching', completed: fetchCompleted, total: fetchable.length, detail: `dependency depth ${depth}` });
          return;
        }
        resource.body = outcome.result.body;
        resource.status = outcome.result.status;
        resource.mimeType = outcome.result.mimeType || resource.mimeType;
        resource.headers = outcome.result.headers;
        resource.finalUrl = canonicalResourceUrl(outcome.result.finalUrl);
        resource.source = 'network';
        totalBytes += resource.body.byteLength;
        fetchCompleted += 1;
        onProgress({ phase: 'fetching', completed: fetchCompleted, total: fetchable.length, detail: `dependency depth ${depth}` });
      });
    }

    if (!parsed.discoverDependencies || depth >= parsed.limits.maxDepth) continue;
    for (const resource of [...resources.values()]) {
      if (resource.depth !== depth || !resource.body || resource.graphScanned) continue;
      resource.graphScanned = true;
      const remainingReferences = Math.max(0, Math.min(
        parsed.limits.maxResources - graph.size,
        parsed.limits.maxResources - resources.size,
      ));
      for (const target of discoverReferences(resource.body, resource.mimeType ?? '', resource.finalUrl ?? resource.url, remainingReferences)) {
        if (graph.size >= parsed.limits.maxResources) break;
        graph.add(`${resource.url}\0${target}`);
        if (resources.has(target)) {
          resources.get(target)!.depth = Math.min(resources.get(target)!.depth, depth + 1);
          continue;
        }
        if (resources.size >= parsed.limits.maxResources) {
          if (!discoveryLimitReported) {
            failures.push({ url: manifestUrl(target), stage: 'limit', reason: `발견 리소스 ${parsed.limits.maxResources}개 한도에 도달했습니다.` });
            discoveryLimitReported = true;
          }
          continue;
        }
        resources.set(target, {
          url: target,
          method: 'GET',
          source: 'discovered',
          depth: depth + 1,
          fetchEligible: true,
          graphScanned: false,
        });
      }
      throwIfExpired();
    }
  }

  for (const resource of resources.values()) {
    if (!resource.body && !resource.error) {
      const reason = resource.fetchEligible
        ? parsed.fetchMissing ? '본문을 가져오지 못했습니다.' : '본문이 제공되지 않았고 네트워크 가져오기가 꺼져 있습니다.'
        : `${resource.method} 응답은 안전하게 재요청하지 않습니다.`;
      failures.push({ url: manifestUrl(resource.url), stage: 'fetch', reason });
    }
  }
  const saved = [...resources.values()].filter((resource): resource is CollectedResource & { body: Uint8Array } => Boolean(resource.body));
  if (saved.length === 0) throw new Error(`저장할 수 있는 리소스가 없습니다. 첫 실패: ${failures[0]?.reason ?? '본문 없음'}`);

  const pathByResource = assignArchivePaths(saved);
  const duplicateOf = deduplicateBinaryBodies(saved, pathByResource);
  throwIfExpired();
  const urlToPath = new Map<string, string>();
  for (const resource of saved) {
    const archivePath = pathByResource.get(resource)!;
    urlToPath.set(resource.url, archivePath);
    if (resource.finalUrl) urlToPath.set(resource.finalUrl, archivePath);
  }

  const archiveEntries: Record<string, Uint8Array> = {};
  const manifestEntries: ResourceManifestEntry[] = [];
  let finalDecodedBytes = 0;
  let remainingOriginalBytes = saved.reduce((sum, resource) => sum + resource.body.byteLength, 0);
  onProgress({ phase: 'rewriting', completed: 0, total: saved.length });
  for (const resource of saved) {
    const archivePath = pathByResource.get(resource)!;
    let body = resource.body;
    remainingOriginalBytes -= resource.body.byteLength;
    if (parsed.rewriteOfflineLinks && !duplicateOf.has(resource) && (isHtml(resource.mimeType ?? '', resource.url) || isCss(resource.mimeType ?? '', resource.url))) {
      try {
        const rewriteByteLimit = Math.min(
          parsed.limits.maxResourceBytes,
          parsed.limits.maxTotalBytes - finalDecodedBytes - remainingOriginalBytes,
        );
        const rewritten = rewriteResourceLinks(body, resource.mimeType ?? '', resource.finalUrl ?? resource.url, archivePath, urlToPath, rewriteByteLimit);
        if (rewritten.byteLength > parsed.limits.maxResourceBytes) {
          failures.push({ url: manifestUrl(resource.url), stage: 'rewrite', reason: '재작성 결과가 리소스당 크기 한도를 초과하여 원본을 보존했습니다.' });
        } else if (finalDecodedBytes + rewritten.byteLength + remainingOriginalBytes > parsed.limits.maxTotalBytes) {
          failures.push({ url: manifestUrl(resource.url), stage: 'rewrite', reason: '재작성 결과가 전체 크기 한도를 초과하여 원본을 보존했습니다.' });
        } else {
          body = rewritten;
        }
      } catch (error) {
        const processingLimit = error instanceof Error && /재작성 처리 한도/.test(error.message);
        const bounded = error instanceof Error && /출력 바이트 한도|재인코딩 결과/.test(error.message);
        failures.push({
          url: manifestUrl(resource.url),
          stage: 'rewrite',
          reason: processingLimit
            ? '텍스트가 안전한 재작성 처리 한도를 초과하여 원본을 보존했습니다.'
            : bounded
            ? '재작성 결과가 리소스당 또는 전체 크기 한도를 초과하여 원본을 보존했습니다.'
            : '오프라인 링크 재작성에 실패하여 원본을 보존했습니다.',
        });
      }
    }
    if (body.byteLength > parsed.limits.maxResourceBytes || finalDecodedBytes + body.byteLength + remainingOriginalBytes > parsed.limits.maxTotalBytes) {
      throw new Error('보존 본문이 설정된 개별 또는 전체 크기 한도를 초과했습니다.');
    }
    finalDecodedBytes += body.byteLength;
    if (!duplicateOf.has(resource)) archiveEntries[archivePath] = body;
    const storedBody = duplicateOf.has(resource) ? archiveEntries[archivePath] : body;
    manifestEntries.push({
      url: manifestUrl(resource.url),
      urlSha256: sha256(resource.url),
      finalUrl: resource.finalUrl && resource.finalUrl !== resource.url ? manifestUrl(resource.finalUrl) : undefined,
      archivePath,
      mimeType: resource.mimeType || 'application/octet-stream',
      status: resource.status,
      bytes: storedBody.byteLength,
      sha256: sha256(storedBody),
      source: resource.source,
      duplicateOf: duplicateOf.get(resource) ? manifestUrl(duplicateOf.get(resource)!.url) : undefined,
      headers: resource.headers && Object.keys(resource.headers).length > 0 ? resource.headers : undefined,
    });
    onProgress({ phase: 'rewriting', completed: manifestEntries.length, total: saved.length });
    throwIfExpired();
  }

  const manifest: ResourceArchiveManifest = {
    format: 'mr-robot-resource-archive/v1',
    createdAt: new Date().toISOString(),
    pageUrl: manifestUrl(parsed.page.href),
    authorization: 'Caller confirmed ownership or explicit permission before collection.',
    options: {
      dependencyDiscovery: parsed.discoverDependencies,
      offlineLinksRewritten: parsed.rewriteOfflineLinks,
      allowedCrossOriginHosts: [...parsed.allowedHosts].sort(),
      limits: parsed.limits,
    },
    summary: {
      saved: manifestEntries.length,
      uniqueBodies: Object.keys(archiveEntries).length,
      deduplicated: duplicateOf.size,
      failed: failures.length,
      totalDecodedBytes: finalDecodedBytes,
      networkRequestsUsed: requestBudget.used,
    },
    resources: manifestEntries.sort((a, b) => a.archivePath.localeCompare(b.archivePath) || a.url.localeCompare(b.url)),
    graph: [...graph].map((edge) => {
      const [from, to] = edge.split('\0');
      return { from: manifestUrl(from), to: manifestUrl(to) };
    }),
    failures,
  };
  throwIfExpired();
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  throwIfExpired();
  const resourceEntryBytes = Object.values(archiveEntries).reduce((sum, body) => sum + body.byteLength, 0);
  if (resourceEntryBytes + manifestBytes.byteLength > parsed.limits.maxTotalBytes) {
    throw new Error('리소스와 manifest가 전체 압축 전 크기 한도를 초과합니다.');
  }
  archiveEntries['mr-robot-manifest.json'] = manifestBytes;
  const checksumLines: string[] = [];
  for (const [path, body] of Object.entries(archiveEntries).sort(([a], [b]) => a.localeCompare(b))) {
    checksumLines.push(`${sha256(body)}  ${path}`);
    throwIfExpired();
  }
  const checksumsBytes = Buffer.from(`${checksumLines.join('\n')}\n`, 'utf8');
  if (resourceEntryBytes + manifestBytes.byteLength + checksumsBytes.byteLength > parsed.limits.maxTotalBytes) {
    throw new Error('리소스, manifest, 체크섬이 전체 압축 전 크기 한도를 초과합니다.');
  }
  archiveEntries['SHA256SUMS.txt'] = checksumsBytes;

  throwIfExpired();
  onProgress({ phase: 'packing', completed: 0, total: Object.keys(archiveEntries).length });
  const zipped = await zipArchiveEntries(archiveEntries, execution.signal, throwIfExpired);
  throwIfExpired();
  if (zipped.byteLength > parsed.limits.maxTotalBytes) throw new Error('ZIP 파일이 설정된 전체 크기 한도를 초과합니다.');
  onProgress({ phase: 'packing', completed: Object.keys(archiveEntries).length, total: Object.keys(archiveEntries).length });
  onProgress({ phase: 'writing', completed: 0, total: zipped.byteLength });
  const outputPath = await writeArchive(execution.workspaceRoot, parsed.request.outputPath, parsed.page.hostname, zipped, execution.signal);
  throwIfExpired();
  onProgress({ phase: 'writing', completed: zipped.byteLength, total: zipped.byteLength });
  onProgress({ phase: 'complete', completed: manifestEntries.length, total: manifestEntries.length });
  const warnings = failures.length > 0 ? [`${failures.length}개 리소스가 실패했으며 성공한 항목은 ZIP에 보존했습니다.`] : [];
  if (failures.length > 100) warnings.push('명령 결과에는 첫 100개 실패만 표시되며 전체 목록은 ZIP manifest에 있습니다.');
  return {
    status: failures.length > 0 ? 'partial' : 'complete',
    outputPath,
    manifest: manifest.summary,
    failures: failures.slice(0, 100),
    warnings,
    trafficProfile: trafficProfile(parsed, requestBudget.used),
  };
}

function parseRequest(raw: unknown): ParsedArchiveRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('리소스 보존 요청 객체가 필요합니다.');
  const request = raw as ResourceArchiveRequest;
  if (request.authorizationConfirmed !== true) throw new Error('소유하거나 명시적으로 허가받은 페이지인지 먼저 확인해야 합니다.');
  const page = parseWebUrl(request.pageUrl, '페이지 URL');
  if (request.outputPath !== undefined) validateOutputPath(String(request.outputPath).trim());
  const limits = normalizeLimits(request.limits);
  if (request.capturedResources !== undefined && !Array.isArray(request.capturedResources)) throw new Error('capturedResources는 배열이어야 합니다.');
  if ((request.capturedResources?.length ?? 0) > limits.maxResources) throw new Error(`입력 리소스가 ${limits.maxResources}개 한도를 초과합니다.`);
  const harEntries = request.har?.log?.entries;
  if (harEntries !== undefined && !Array.isArray(harEntries)) throw new Error('HAR log.entries는 배열이어야 합니다.');
  if ((harEntries?.length ?? 0) + (request.capturedResources?.length ?? 0) > limits.maxResources) {
    throw new Error(`HAR와 브라우저 캡처 입력 합계가 ${limits.maxResources}개 한도를 초과합니다.`);
  }
  return {
    request,
    page,
    limits,
    fetchMissing: request.fetchMissing === true,
    discoverDependencies: request.discoverDependencies !== false,
    rewriteOfflineLinks: request.rewriteOfflineLinks !== false,
    allowedHosts: normalizeAllowedHosts(request.allowedCrossOriginHosts, page.hostname.toLowerCase()),
  };
}

function normalizeLimits(raw: ResourceArchiveRequest['limits']): ArchiveLimits {
  const source = raw ?? {};
  return {
    maxResources: boundedInteger(source.maxResources, DEFAULT_ARCHIVE_LIMITS.maxResources, 1, 2_000, 'maxResources'),
    maxNetworkRequests: boundedInteger(source.maxNetworkRequests, DEFAULT_ARCHIVE_LIMITS.maxNetworkRequests, 0, 500, 'maxNetworkRequests'),
    maxResourceBytes: boundedInteger(source.maxResourceBytes, DEFAULT_ARCHIVE_LIMITS.maxResourceBytes, 1_024, 32 * MiB, 'maxResourceBytes'),
    maxTotalBytes: boundedInteger(source.maxTotalBytes, DEFAULT_ARCHIVE_LIMITS.maxTotalBytes, 1_024, 128 * MiB, 'maxTotalBytes'),
    maxDepth: boundedInteger(source.maxDepth, DEFAULT_ARCHIVE_LIMITS.maxDepth, 0, 4, 'maxDepth'),
    concurrency: boundedInteger(source.concurrency, DEFAULT_ARCHIVE_LIMITS.concurrency, 1, 8, 'concurrency'),
    timeoutMs: boundedInteger(source.timeoutMs, DEFAULT_ARCHIVE_LIMITS.timeoutMs, 1_000, 30_000, 'timeoutMs'),
    retries: boundedInteger(source.retries, DEFAULT_ARCHIVE_LIMITS.retries, 0, 2, 'retries'),
    maxRedirects: boundedInteger(source.maxRedirects, DEFAULT_ARCHIVE_LIMITS.maxRedirects, 0, 5, 'maxRedirects'),
    minRequestIntervalMs: boundedInteger(source.minRequestIntervalMs, DEFAULT_ARCHIVE_LIMITS.minRequestIntervalMs, 100, 2_000, 'minRequestIntervalMs'),
    overallTimeoutMs: boundedInteger(source.overallTimeoutMs, DEFAULT_ARCHIVE_LIMITS.overallTimeoutMs, 1_000, 300_000, 'overallTimeoutMs'),
  };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${name}은(는) ${min}~${max} 범위의 정수여야 합니다.`);
  return Number(value);
}

function harResources(har: ResourceArchiveRequest['har']): CapturedResourceInput[] {
  const result: CapturedResourceInput[] = [];
  for (const unknownEntry of har?.log?.entries ?? []) {
    const entry = asRecord(unknownEntry);
    const request = asRecord(entry.request);
    const response = asRecord(entry.response);
    const content = asRecord(response.content);
    const url = typeof request.url === 'string' ? request.url : '';
    if (!url) continue;
    const encoding = typeof content.encoding === 'string' ? content.encoding.toLowerCase() : '';
    const text = typeof content.text === 'string' ? content.text : undefined;
    if (encoding && encoding !== 'base64') continue;
    const headerMap: Record<string, unknown> = {};
    if (Array.isArray(response.headers)) {
      for (const rawHeader of response.headers) {
        const header = asRecord(rawHeader);
        if (typeof header.name === 'string' && typeof header.value === 'string') headerMap[header.name] = header.value;
      }
    }
    result.push({
      url,
      method: typeof request.method === 'string' ? request.method : 'GET',
      status: finiteStatus(response.status),
      mimeType: typeof content.mimeType === 'string' ? content.mimeType : undefined,
      bodyBase64: encoding === 'base64' ? text : undefined,
      bodyText: encoding ? undefined : text,
      responseHeaders: headerMap,
    });
  }
  return result;
}

function decodeInputBody(input: CapturedResourceInput, maxBytes: number): Uint8Array | undefined {
  if (input.bodyBase64 !== undefined && input.bodyText !== undefined) throw new Error('리소스 본문은 bodyBase64와 bodyText 중 하나만 사용할 수 있습니다.');
  let body: Buffer | undefined;
  if (input.bodyBase64 !== undefined) {
    const encoded = String(input.bodyBase64);
    if (encoded.length > Math.ceil(maxBytes / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('유효하지 않거나 너무 큰 base64 리소스 본문입니다.');
    }
    body = Buffer.from(encoded, 'base64');
  } else if (input.bodyText !== undefined) {
    body = Buffer.from(String(input.bodyText), 'utf8');
  }
  if (body && body.byteLength > maxBytes) throw new Error(`캡처 본문이 리소스당 ${maxBytes}바이트 한도를 초과합니다.`);
  return body;
}

function normalizeCapturedUrl(raw: unknown, page: URL, body?: Uint8Array): string {
  const value = String(raw ?? '').trim();
  if (!value || value.length > 8_192) throw new Error('캡처 리소스 URL 길이가 올바르지 않습니다.');
  if (/^https?:/i.test(value)) return canonicalResourceUrl(value);
  if (/^blob:/i.test(value)) {
    if (!body) throw new Error('blob: 리소스는 브라우저가 캡처한 본문이 필요합니다.');
    const blob = new URL(value);
    const inner = parseWebUrl(blob.pathname, 'blob 원본 URL');
    if (inner.origin !== page.origin) throw new Error('다른 출처의 blob: 리소스는 사용할 수 없습니다.');
    return blob.href;
  }
  if (/^data:/i.test(value)) {
    if (!body) throw new Error('data: 리소스는 분리된 캡처 본문이 필요합니다.');
    return `data:application/octet-stream;mr-robot-sha256,${sha256(value)}`;
  }
  throw new Error('캡처 리소스 URL은 HTTP(S), blob:, data: 중 하나여야 합니다.');
}

function normalizeMethod(value: unknown): string {
  const method = String(value ?? 'GET').trim().toUpperCase();
  return /^[A-Z]{1,16}$/.test(method) ? method : 'UNSAFE';
}

function normalizeMime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const mime = value.split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime.slice(0, 128) : undefined;
}

function finiteStatus(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number >= 100 && number <= 599 ? number : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function fetchWithRetries(
  url: string,
  policy: FetchPolicy,
  limits: ArchiveLimits,
  signal?: AbortSignal,
  sharedBudget?: SharedByteBudget,
  pacer?: RequestPacer,
  requestBudget?: SharedRequestBudget,
  resolutionCache?: ResolvedTargetCache,
): Promise<{ result: Awaited<ReturnType<typeof fetchPublicResource>>; attempts: number } | { error: string; attempts: number }> {
  let message = '가져오기 실패';
  for (let attempt = 1; attempt <= limits.retries + 1; attempt += 1) {
    try {
      return {
        result: await fetchPublicResource(url, policy, limits, signal, sharedBudget, () => pacer?.wait(signal) ?? Promise.resolve(), requestBudget, resolutionCache),
        attempts: attempt,
      };
    } catch (error) {
      signal?.throwIfAborted();
      message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof SafeFetchError) || !error.retryable || attempt > limits.retries) return { error: message, attempts: attempt };
      await abortableDelay(150 * attempt, signal);
    }
  }
  return { error: message, attempts: limits.retries + 1 };
}

export class RequestPacer {
  private nextStart = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly intervalMs: number) {}

  async wait(signal?: AbortSignal): Promise<void> {
    let release: () => void = () => {};
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      signal?.throwIfAborted();
      await abortableDelay(Math.max(0, this.nextStart - Date.now()), signal);
      this.nextStart = Date.now() + this.intervalMs;
    } finally {
      release();
    }
  }
}

async function mapConcurrent<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await worker(current);
    }
  }));
}

function assignArchivePaths(resources: ReadonlyArray<CollectedResource & { body: Uint8Array }>): Map<CollectedResource, string> {
  const used = new Set<string>();
  const result = new Map<CollectedResource, string>();
  for (const [index, resource] of resources.entries()) {
    let candidate = candidateArchivePath(resource, index);
    const key = candidate.toLowerCase();
    if (used.has(key)) candidate = addFilenameSuffix(candidate, sha256(resource.url).slice(0, 10));
    let serial = 1;
    while (used.has(candidate.toLowerCase())) {
      candidate = addFilenameSuffix(candidate, `${sha256(resource.url).slice(0, 8)}-${serial}`);
      serial += 1;
    }
    used.add(candidate.toLowerCase());
    result.set(resource, candidate);
  }
  return result;
}

function candidateArchivePath(resource: CollectedResource, index: number): string {
  const extension = MIME_EXTENSIONS[resource.mimeType ?? ''] ?? '';
  if (!isHttpUrl(resource.url)) return `resources/_inline/${String(index + 1).padStart(4, '0')}-${sha256(resource.url).slice(0, 12)}${extension || '.bin'}`;
  const url = new URL(resource.url);
  const rawSegments = url.pathname.split('/').filter(Boolean).slice(-16);
  const segments = rawSegments.map((segment) => sanitizeSegment(safeDecode(segment)));
  let file = segments.pop() || `index${extension || '.html'}`;
  if (!extname(file) && extension) file += extension;
  if (url.pathname.endsWith('/')) file = `index${extension || '.html'}`;
  const host = sanitizeSegment(url.hostname);
  const candidate = posix.join('resources', host, ...segments, file);
  return candidate.length <= 220
    ? candidate
    : posix.join('resources', host, '_long-path', `${sha256(resource.url).slice(0, 32)}${extname(file) || extension || '.bin'}`);
}

function sanitizeSegment(raw: string): string {
  let value = raw.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!value || value === '.' || value === '..') value = '_';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = `_${value}`;
  if (value.length > 80) value = `${value.slice(0, 65)}~${sha256(value).slice(0, 12)}`;
  return value;
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function addFilenameSuffix(path: string, suffix: string): string {
  const extension = posix.extname(path);
  return `${path.slice(0, path.length - extension.length)}~${suffix}${extension}`;
}

function deduplicateBinaryBodies(
  resources: ReadonlyArray<CollectedResource & { body: Uint8Array }>,
  paths: Map<CollectedResource, string>,
): Map<CollectedResource, CollectedResource & { body: Uint8Array }> {
  const firstByHash = new Map<string, CollectedResource & { body: Uint8Array }>();
  const duplicates = new Map<CollectedResource, CollectedResource & { body: Uint8Array }>();
  for (const resource of resources) {
    if (isHtml(resource.mimeType ?? '', resource.url) || isCss(resource.mimeType ?? '', resource.url)) continue;
    const hash = sha256(resource.body);
    const first = firstByHash.get(hash);
    if (!first) firstByHash.set(hash, resource);
    else {
      duplicates.set(resource, first);
      paths.set(resource, paths.get(first)!);
    }
  }
  return duplicates;
}

async function writeArchive(
  workspaceRoot: string,
  rawPath: unknown,
  hostname: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  const fallback = `resource-archives/${sanitizeSegment(hostname)}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  let requested = String(rawPath ?? fallback).trim();
  validateOutputPath(requested);
  if (!requested.toLowerCase().endsWith('.zip')) requested += '.zip';
  const output = resolveWorkspacePath(workspaceRoot, requested, { mustExist: false });
  const parent = dirname(output);
  signal?.throwIfAborted();
  await mkdir(parent, { recursive: true });
  signal?.throwIfAborted();
  resolveWorkspacePath(workspaceRoot, parent);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    signal?.throwIfAborted();
    handle = await open(output, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    created = true;
    const chunkSize = 1024 * 1024;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      signal?.throwIfAborted();
      const length = Math.min(chunkSize, bytes.byteLength - offset);
      let written = 0;
      while (written < length) {
        signal?.throwIfAborted();
        const result = await handle.write(bytes, offset + written, length - written, offset + written);
        if (result.bytesWritten <= 0) throw new Error('ZIP 파일 쓰기가 진행되지 않았습니다.');
        written += result.bytesWritten;
      }
    }
    signal?.throwIfAborted();
    await handle.sync();
    signal?.throwIfAborted();
    await handle.close();
    handle = undefined;
    signal?.throwIfAborted();
    return output;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await unlink(output).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`기존 파일을 덮어쓰지 않습니다: ${basename(output)}`);
    throw error;
  }
}

function validateOutputPath(requested: string): void {
  if (!requested) throw new Error('출력 경로가 비어 있습니다.');
  if (/[<>:"|?*\u0000-\u001f\u007f]/.test(requested)) {
    throw new Error('출력 경로에는 NTFS ADS 콜론이나 Windows 제어·금지 문자를 사용할 수 없습니다.');
  }
  for (const component of requested.split(/[\\/]/)) {
    if (!component) continue;
    if (component === '.' || component === '..') continue;
    if (/[. ]$/.test(component)) throw new Error('출력 경로 구성 요소는 점이나 공백으로 끝날 수 없습니다.');
    const deviceStem = component.normalize('NFKC').split('.', 1)[0].replace(/[. ]+$/g, '');
    if (/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])$/i.test(deviceStem)) {
      throw new Error(`Windows 예약 장치 이름은 출력 경로에 사용할 수 없습니다: ${component}`);
    }
  }
}

function sameUrl(left: unknown, right: string): boolean {
  try { return canonicalResourceUrl(String(left)) === canonicalResourceUrl(right); } catch { return false; }
}

function isHttpUrl(value: string): boolean {
  return /^https?:/i.test(value);
}

function manifestUrl(value: string): string {
  if (value.startsWith('data:application/octet-stream;mr-robot-sha256,')) return value;
  if (value.startsWith('blob:')) {
    try { return `blob:${new URL(value).origin}/[REDACTED-ID]`; } catch { return 'blob:[invalid-url]'; }
  }
  return redactUrl(value);
}

function trafficProfile(parsed: ParsedArchiveRequest, requestsUsed = 0): ResourceArchiveResult['trafficProfile'] {
  return {
    strategy: 'captured-bodies-first',
    directFetch: parsed.fetchMissing ? 'explicitly-enabled' : 'off-by-default',
    concurrency: parsed.limits.concurrency,
    minRequestIntervalMs: parsed.limits.minRequestIntervalMs,
    retries: parsed.limits.retries,
    maxDecodedBytes: parsed.limits.maxTotalBytes,
    networkRequestLimit: parsed.limits.maxNetworkRequests,
    requestsUsed,
    overallTimeoutMs: parsed.limits.overallTimeoutMs,
  };
}

function combinedDeadlineSignal(caller: AbortSignal | undefined, overallTimeoutMs: number): {
  signal: AbortSignal;
  throwIfExpired(): void;
  cleanup(): void;
} {
  const controller = new AbortController();
  const forwardCallerAbort = () => controller.abort(caller?.reason ?? new Error('작업이 취소되었습니다.'));
  if (caller?.aborted) forwardCallerAbort();
  else caller?.addEventListener('abort', forwardCallerAbort, { once: true });
  const expiresAt = Date.now() + overallTimeoutMs;
  const expire = () => {
    if (!controller.signal.aborted) controller.abort(new Error(`전체 리소스 보존 시간이 ${overallTimeoutMs}ms 한도를 초과했습니다.`));
  };
  const timer = controller.signal.aborted ? undefined : setTimeout(expire, overallTimeoutMs);
  timer?.unref();
  return {
    signal: controller.signal,
    throwIfExpired() {
      if (Date.now() >= expiresAt) expire();
      controller.signal.throwIfAborted();
    },
    cleanup() {
      if (timer) clearTimeout(timer);
      caller?.removeEventListener('abort', forwardCallerAbort);
    },
  };
}

function zipArchiveEntries(
  entries: Record<string, Uint8Array>,
  signal: AbortSignal | undefined,
  throwIfExpired: () => void,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminate: (() => void) | undefined;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminate?.();
      reject(error);
    };
    const abort = () => fail(signal?.reason ?? new Error('작업이 취소되었습니다.'));
    const succeed = (data: Uint8Array) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data);
    };

    signal?.addEventListener('abort', abort, { once: true });
    try {
      throwIfExpired();
      terminate = zip(entries, { level: 6 }, (error, data) => {
        if (error) {
          fail(error);
          return;
        }
        try {
          throwIfExpired();
          succeed(data);
        } catch (checkpointError) {
          fail(checkpointError);
        }
      });
      // fflate computes CRCs and may compress small entries before returning.
      // Enforce the wall-clock deadline after that bounded synchronous boundary.
      throwIfExpired();
    } catch (error) {
      fail(error);
    }
  });
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
