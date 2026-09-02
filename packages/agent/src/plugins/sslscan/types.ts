export type TlsProtocol = 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
export type ScanMode = 'quick' | 'standard' | 'deep';
export type ScanPhase = 'resolving' | 'protocols' | 'ciphers' | 'analyzing' | 'completed' | 'failed' | 'cancelled';

export interface SslScanRequest {
  /** A single DNS name or IP literal. URLs and target lists are rejected. */
  host: string;
  port?: number;
  sni?: string;
  /** The caller must affirm ownership or explicit authorization for every scan. */
  authorizationConfirmed: boolean;
  timeoutMs?: number;
  overallTimeoutMs?: number;
  /** quick (default): protocol/certificate only; standard: representative ciphers; deep: bounded broad enumeration. */
  scanMode?: ScanMode;
  /** Bounded TLS <=1.2 cipher probes. Zero performs protocol/certificate checks only. */
  maxCipherTests?: number;
  /** Ignore a recent result for the same pinned target and scan settings. */
  forceRefresh?: boolean;
}

export interface ResolvedTarget {
  host: string;
  displayHost: string;
  port: number;
  sni?: string;
  addresses: Array<{ address: string; family: 4 | 6 }>;
  timeoutMs: number;
  overallTimeoutMs: number;
  scanMode: ScanMode;
  maxCipherTests: number;
  forceRefresh: boolean;
}

export interface CertificateSummary {
  subject: string;
  issuer: string;
  serialNumber: string;
  fingerprint256: string;
  validFrom: string;
  validTo: string;
  subjectAltName?: string;
  signatureAlgorithm?: string;
  publicKeyType?: string;
  publicKeyBits?: number;
  publicKeyCurve?: string;
  selfSigned: boolean;
  hostnameValid: boolean;
  expired: boolean;
  notYetValid: boolean;
  pem: string;
}

export interface ProtocolProbe {
  requested: TlsProtocol;
  supported: boolean;
  /** Negative results may be inconclusive when the local TLS engine cannot offer the protocol. */
  conclusion: 'supported' | 'not-supported' | 'inconclusive';
  engineLimited?: boolean;
  negotiatedProtocol?: string;
  cipher?: {
    opensslName: string;
    standardName?: string;
    version?: string;
  };
  alpn?: string;
  ephemeralKey?: Record<string, unknown>;
  sharedSignatureAlgorithms?: string[];
  certificate?: CertificateSummary;
  certificateChain?: CertificateSummary[];
  ocspStapled?: boolean;
  authorizedBySystemTrust?: boolean;
  trustError?: string;
  elapsedMs: number;
  error?: string;
}

export interface CipherProbe {
  protocol: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2';
  name: string;
  supported: boolean;
  negotiatedName?: string;
  standardName?: string;
  elapsedMs: number;
  error?: string;
}

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface TlsFinding {
  id: string;
  severity: FindingSeverity;
  title: string;
  evidence: string;
  remediation?: string;
}

export interface SslScanResult {
  schemaVersion: 1;
  scanId: string;
  status: 'completed';
  scanMode: ScanMode;
  scanner: {
    id: 'mr-robot.sslscan';
    version: string;
    engine: string;
    limitations: string[];
  };
  target: {
    host: string;
    port: number;
    sni?: string;
    resolvedAddresses: string[];
    pinnedAddress: string;
  };
  authorization: {
    confirmed: true;
    scope: 'single-target';
    privateNetworksAllowed: boolean;
  };
  cache: {
    hit: boolean;
    createdAt: string;
    expiresAt: string;
    sourceScanId?: string;
  };
  startedAt: string;
  completedAt: string;
  durationMs: number;
  protocols: ProtocolProbe[];
  supportedCiphers: CipherProbe[];
  cipherProbe: {
    candidates: number;
    tested: number;
    truncated: boolean;
  };
  certificate?: CertificateSummary;
  certificateChain: CertificateSummary[];
  findings: TlsFinding[];
}

export interface SslScannerOptions {
  allowedPorts?: readonly number[];
  allowPrivateTargets?: boolean;
  maxConcurrentScans?: number;
  minTargetIntervalMs?: number;
  cacheTtlMs?: number;
}

export interface SslScanProgress {
  scanId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  phase: ScanPhase;
  completedSteps: number;
  totalSteps: number;
  percent: number;
  startedAt: string;
  updatedAt: string;
  target?: string;
  scanMode?: ScanMode;
  cacheHit?: boolean;
  message?: string;
}
