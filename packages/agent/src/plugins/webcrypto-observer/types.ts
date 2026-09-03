export type CryptoOperation = 'encrypt' | 'decrypt';
export type CryptoPhase = 'encrypt-input' | 'decrypt-output';
export type ObservationSessionStatus = 'starting' | 'running' | 'completed' | 'stopping' | 'stopped' | 'limit-reached' | 'failed';

export interface RuntimeObservationHostPolicy {
  /** Native-admin controlled switch. Request parameters can never enable it. */
  enabled: boolean;
  /** Exact ASCII/Unicode DNS names only. Wildcards and URL patterns are rejected. */
  allowedDomains: readonly string[];
  /** Optional native-admin selected Chrome/Edge executable. Never accepted from a command request. */
  browserExecutable?: string;
}

/**
 * The host must inject this provider when constructing the built-in plugin.
 * Returning undefined, disabled, or an empty/invalid exact-domain allowlist
 * makes active observation fail closed.
 */
export interface WebCryptoObserverHostPolicyProvider {
  getPolicy(): RuntimeObservationHostPolicy | undefined | Promise<RuntimeObservationHostPolicy | undefined>;
}

export interface ObservationLimitsInput {
  durationMs?: number;
  maxRequests?: number;
  maxResponseBytes?: number;
  maxConcurrentRequests?: number;
  maxRingEvents?: number;
  maxRequestBodyBytes?: number;
  maxUploadBytes?: number;
}

export interface ObservationLimits {
  durationMs: number;
  maxRequests: number;
  maxResponseBytes: number;
  maxConcurrentRequests: number;
  maxRingEvents: number;
  maxRequestBodyBytes: number;
  maxUploadBytes: number;
}

export interface PlaintextPreviewRequest {
  enabled: true;
  previewConfirmed: true;
  maxBytes?: number;
}

export interface ObserveRequest {
  authorizationConfirmed: boolean;
  sessionEnabled: boolean;
  targetUrl: string;
  plaintextPreview?: PlaintextPreviewRequest;
  /** POST/PUT/PATCH require both booleans. DELETE is always blocked. */
  allowStateChangingRequests?: boolean;
  stateChangingRequestsConfirmed?: boolean;
  limits?: ObservationLimitsInput;
}

export interface OfflineAnalyzeRequest {
  authorizationConfirmed: boolean;
  sourceText: string;
}

export interface MutationRuleRequest {
  sessionId: string;
  phase: CryptoPhase;
  matchLiteral: string;
  replacementLiteral: string;
  mutationConfirmed: boolean;
}

export interface ResolvedObservationTarget {
  /** Kept in memory only and never returned or logged without query redaction. */
  url: string;
  redactedUrl: string;
  origin: string;
  host: string;
  pinnedAddress: string;
  family: 4 | 6;
  resolvedAddressCount: number;
}

export interface NormalizedObserveRequest {
  target: ResolvedObservationTarget;
  limits: ObservationLimits;
  preview: { enabled: boolean; maxBytes: number };
  allowStateChangingRequests: boolean;
  browserExecutable?: string;
}

export interface RuntimeCryptoEvent {
  sequence: number;
  elapsedMs: number;
  operation: CryptoOperation;
  phase: CryptoPhase;
  algorithm: string;
  byteLength: number;
  preview?: string;
  previewTruncated?: boolean;
  mutationApplied: boolean;
  recommendation: string;
}

export interface RawRuntimeCryptoEvent {
  token: string;
  operation: CryptoOperation;
  phase: CryptoPhase;
  algorithm: string;
  byteLength: number;
  preview?: string;
  previewTruncated?: boolean;
  mutationApplied?: boolean;
}

export interface TrafficSnapshot {
  requestsStarted: number;
  requestsBlocked: number;
  responseBytesObserved: number;
  requestBytesAllowed: number;
  peakConcurrentRequests: number;
}

export interface DriverCompletion {
  outcome: 'completed' | 'stopped' | 'limit-reached' | 'failed';
  reasonCode?: string;
  traffic: TrafficSnapshot;
}

export interface BrowserObservationCallbacks {
  onCryptoEvent(event: RawRuntimeCryptoEvent): void;
}

export interface BrowserObservationHandle {
  readonly completion: Promise<DriverCompletion>;
  getTraffic(): TrafficSnapshot;
  setMutation(rule: Omit<MutationRuleRequest, 'sessionId' | 'mutationConfirmed'>): Promise<void>;
  stop(): Promise<void>;
}

export interface BrowserObservationDriver {
  start(request: NormalizedObserveRequest, callbacks: BrowserObservationCallbacks, signal: AbortSignal): Promise<BrowserObservationHandle>;
}

export interface WebCryptoObserverOptions {
  policyProvider?: WebCryptoObserverHostPolicyProvider;
  browserDriver?: BrowserObservationDriver;
  dnsLookup?: DnsLookup;
  now?: () => number;
  randomId?: () => string;
}

export type DnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

export interface ObservationStartResult {
  sessionId: string;
  status: 'running';
  startedAt: string;
  expiresAt: string;
  target: { url: string; origin: string; resolvedAddressCount: number };
  metadataOnly: boolean;
  limits: ObservationLimits;
}

export interface ObservationEventsResult {
  sessionId: string;
  status: ObservationSessionStatus;
  afterSequence: number;
  nextSequence: number;
  truncated: boolean;
  events: RuntimeCryptoEvent[];
  traffic: TrafficSnapshot;
  mutation: { armed: boolean; applied: boolean; phase?: CryptoPhase };
  reasonCode?: string;
}

export interface OfflineCandidate {
  operation: CryptoOperation | 'encode' | 'decode';
  api: 'crypto.subtle.encrypt' | 'crypto.subtle.decrypt' | 'TextEncoder.encode' | 'TextDecoder.decode';
  line: number;
  column: number;
  confidence: 'high' | 'medium';
}

export interface OfflineAnalysisResult {
  truncated: boolean;
  candidates: OfflineCandidate[];
}
