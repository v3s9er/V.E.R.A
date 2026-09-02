export interface CapturedResourceInput {
  url: string;
  method?: string;
  status?: number;
  mimeType?: string;
  bodyBase64?: string;
  bodyText?: string;
  responseHeaders?: Record<string, unknown>;
}

export interface HarLikeInput {
  log?: {
    entries?: unknown[];
  };
}

export interface ResourceArchiveLimitsInput {
  maxResources?: number;
  /** Hard cap for physical HTTP GET starts, including redirects and retries. */
  maxNetworkRequests?: number;
  maxResourceBytes?: number;
  maxTotalBytes?: number;
  maxDepth?: number;
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  maxRedirects?: number;
  /** Global spacing between physical network request starts. Minimum 100 ms. */
  minRequestIntervalMs?: number;
  /** Whole archive deadline, independent of the per-request timeout. */
  overallTimeoutMs?: number;
}

export interface ResourceArchiveRequest {
  /** Explicit acknowledgement that the caller may archive this page. */
  authorizationConfirmed: boolean;
  pageUrl: string;
  /** Relative to the host-selected workspace. Defaults to resource-archives/<host>-<time>.zip. */
  outputPath?: string;
  /** Response bodies supplied by a browser/CDP bridge. No request credentials are accepted. */
  capturedResources?: CapturedResourceInput[];
  /** HAR 1.2-shaped data. Only response URL/body/status/MIME and a safe header subset are consumed. */
  har?: HarLikeInput;
  /** Fetch bodies that were not supplied. Defaults to false and requires explicit opt-in. */
  fetchMissing?: boolean;
  /** Parse HTML/CSS references and include their dependency graph. Defaults to true. */
  discoverDependencies?: boolean;
  /** Rewrite saved HTML/CSS resource links to local archive paths. Defaults to true. */
  rewriteOfflineLinks?: boolean;
  /** Exact public DNS hosts that may be fetched in addition to the page host. */
  allowedCrossOriginHosts?: string[];
  limits?: ResourceArchiveLimitsInput;
}

export interface ArchiveLimits {
  maxResources: number;
  maxNetworkRequests: number;
  maxResourceBytes: number;
  maxTotalBytes: number;
  maxDepth: number;
  concurrency: number;
  timeoutMs: number;
  retries: number;
  maxRedirects: number;
  minRequestIntervalMs: number;
  overallTimeoutMs: number;
}

export interface SafeResponseMetadata {
  status?: number;
  mimeType?: string;
  headers?: Record<string, string>;
}

export interface CollectedResource extends SafeResponseMetadata {
  url: string;
  method: string;
  source: 'browser-capture' | 'har' | 'network' | 'discovered';
  depth: number;
  body?: Uint8Array;
  fetchEligible: boolean;
  graphScanned: boolean;
  error?: string;
  attempts?: number;
  finalUrl?: string;
}

export interface ArchiveFailure {
  url: string;
  stage: 'input' | 'discovery' | 'fetch' | 'limit' | 'rewrite';
  reason: string;
  attempts?: number;
}

export interface ResourceManifestEntry {
  url: string;
  urlSha256: string;
  finalUrl?: string;
  archivePath: string;
  mimeType: string;
  status?: number;
  bytes: number;
  sha256: string;
  source: CollectedResource['source'];
  duplicateOf?: string;
  headers?: Record<string, string>;
}

export interface ResourceArchiveManifest {
  format: 'mr-robot-resource-archive/v1';
  createdAt: string;
  pageUrl: string;
  authorization: string;
  options: {
    dependencyDiscovery: boolean;
    offlineLinksRewritten: boolean;
    allowedCrossOriginHosts: string[];
    limits: ArchiveLimits;
  };
  summary: {
    saved: number;
    uniqueBodies: number;
    deduplicated: number;
    failed: number;
    totalDecodedBytes: number;
    networkRequestsUsed: number;
  };
  resources: ResourceManifestEntry[];
  graph: Array<{ from: string; to: string }>;
  failures: ArchiveFailure[];
}

export interface ResourceArchiveResult {
  status: 'complete' | 'partial';
  outputPath: string;
  manifest: ResourceArchiveManifest['summary'];
  failures: ArchiveFailure[];
  warnings: string[];
  trafficProfile: {
    strategy: 'captured-bodies-first';
    directFetch: 'off-by-default' | 'explicitly-enabled';
    concurrency: number;
    minRequestIntervalMs: number;
    retries: number;
    maxDecodedBytes: number;
    networkRequestLimit: number;
    requestsUsed: number;
    overallTimeoutMs: number;
  };
}

export interface ResourceArchivePreview {
  dryRun: true;
  pageUrl: string;
  inputModes: Array<'browser-capture' | 'har' | 'direct-url'>;
  suppliedResources: number;
  suppliedBodies: number;
  uniqueSuppliedUrls: number;
  suppliedDecodedBytes: number;
  discoveredReferences: number;
  missingBodies: number;
  estimatedNetworkRequests: number;
  /** Enforced physical GET cap; estimate does not include unknown redirects/retries. */
  networkRequestLimit: number;
  networkOptIn: boolean;
  outputPath: string;
  limits: ArchiveLimits;
  allowedFetchHosts: string[];
  warnings: string[];
  trafficProfile: ResourceArchiveResult['trafficProfile'];
}

export interface ResourceArchiveProgress {
  phase: 'validating' | 'ingesting' | 'fetching' | 'rewriting' | 'packing' | 'writing' | 'complete';
  completed: number;
  total: number;
  detail?: string;
}
