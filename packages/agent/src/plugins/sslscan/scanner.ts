import { randomUUID, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import {
  connect as tlsConnect,
  getCiphers,
  type ConnectionOptions,
  type DetailedPeerCertificate,
  type PeerCertificate,
  type SecureVersion,
  type TLSSocket,
} from 'node:tls';
import { DEFAULT_SSL_PORTS, validateAndResolveTarget } from './policy.js';
import type {
  CertificateSummary,
  CipherProbe,
  ProtocolProbe,
  ResolvedTarget,
  SslScannerOptions,
  SslScanProgress,
  SslScanResult,
  TlsFinding,
  TlsProtocol,
} from './types.js';

const SCANNER_VERSION = '1.0.0';
const PROTOCOLS: readonly TlsProtocol[] = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];
const MAX_CERTIFICATE_CHAIN = 8;
const MAX_ERROR_LENGTH = 300;
const MAX_CACHE_ENTRIES = 32;
const MAX_STATUS_ENTRIES = 64;

const STANDARD_CIPHER_ORDER = Object.freeze([
  'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
  'DHE-RSA-AES128-GCM-SHA256', 'DHE-RSA-AES256-GCM-SHA384', 'DHE-RSA-CHACHA20-POLY1305',
  'AES128-GCM-SHA256', 'AES256-GCM-SHA384',
  'ECDHE-ECDSA-AES128-SHA256', 'ECDHE-RSA-AES128-SHA256',
  'ECDHE-ECDSA-AES256-SHA384', 'ECDHE-RSA-AES256-SHA384',
  'AES128-SHA256', 'AES256-SHA256', 'AES128-SHA', 'AES256-SHA', 'DES-CBC3-SHA',
]);

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_ERROR_LENGTH);
}

function numberDetail(value: unknown, name: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>)[name];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

function stringDetail(value: unknown, name: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>)[name];
  return typeof candidate === 'string' && candidate ? candidate : undefined;
}

function summarizeCertificate(peer: PeerCertificate, targetHost: string, checkHostname: boolean): CertificateSummary | undefined {
  if (!peer.raw?.length) return undefined;
  try {
    const certificate = new X509Certificate(peer.raw);
    const now = Date.now();
    const validFromMs = Date.parse(certificate.validFrom);
    const validToMs = Date.parse(certificate.validTo);
    const publicKeyType = certificate.publicKey.asymmetricKeyType;
    const keyDetails = certificate.publicKey.asymmetricKeyDetails;
    const publicKeyBits = numberDetail(keyDetails, 'modulusLength');
    const extended = certificate as X509Certificate & { signatureAlgorithm?: string };
    let selfSigned = certificate.subject === certificate.issuer;
    if (selfSigned) {
      try { selfSigned = certificate.verify(certificate.publicKey); } catch { /* subject/issuer match remains useful evidence */ }
    }
    let hostnameValid = true;
    if (checkHostname) {
      try {
        hostnameValid = isIP(targetHost)
          ? certificate.checkIP(targetHost) !== undefined
          : certificate.checkHost(targetHost) !== undefined;
      } catch {
        hostnameValid = false;
      }
    }
    return {
      subject: certificate.subject,
      issuer: certificate.issuer,
      serialNumber: certificate.serialNumber,
      fingerprint256: certificate.fingerprint256,
      validFrom: certificate.validFrom,
      validTo: certificate.validTo,
      subjectAltName: certificate.subjectAltName,
      signatureAlgorithm: extended.signatureAlgorithm,
      publicKeyType,
      publicKeyBits,
      publicKeyCurve: stringDetail(keyDetails, 'namedCurve'),
      selfSigned,
      hostnameValid,
      expired: Number.isFinite(validToMs) && validToMs < now,
      notYetValid: Number.isFinite(validFromMs) && validFromMs > now,
      pem: certificate.toString(),
    };
  } catch {
    return undefined;
  }
}

function certificateChain(peer: DetailedPeerCertificate, targetHost: string): CertificateSummary[] {
  const result: CertificateSummary[] = [];
  const seen = new Set<string>();
  let current: DetailedPeerCertificate | undefined = peer;
  for (let index = 0; current?.raw?.length && index < MAX_CERTIFICATE_CHAIN; index += 1) {
    const identity = current.raw.toString('base64');
    if (seen.has(identity)) break;
    seen.add(identity);
    const summary = summarizeCertificate(current, targetHost, index === 0);
    if (summary) result.push(summary);
    const issuer: DetailedPeerCertificate | undefined = current.issuerCertificate;
    if (!issuer || issuer === current) break;
    current = issuer;
  }
  return result;
}

interface HandshakeResult {
  supported: boolean;
  negotiatedProtocol?: string;
  cipher?: ProtocolProbe['cipher'];
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

/** Connect to one already-resolved address. DNS is deliberately not used here. */
export function probeTlsEndpoint(
  target: ResolvedTarget,
  address: { address: string; family: 4 | 6 },
  protocol: TlsProtocol,
  signal?: AbortSignal,
  cipherName?: string,
): Promise<HandshakeResult> {
  signal?.throwIfAborted();
  const started = performance.now();
  return new Promise((resolve) => {
    let socket: TLSSocket | undefined;
    let settled = false;
    let ocspStapled = false;
    const finish = (result: Omit<HandshakeResult, 'elapsedMs'>): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      socket?.destroy();
      resolve({ ...result, elapsedMs: Math.max(0, Math.round(performance.now() - started)) });
    };
    const abort = (): void => finish({ supported: false, error: 'Scan cancelled.' });
    const collectEvidence = cipherName === undefined;
    const options: ConnectionOptions = {
      host: address.address,
      port: target.port,
      servername: target.sni,
      minVersion: protocol as SecureVersion,
      maxVersion: protocol as SecureVersion,
      rejectUnauthorized: false,
      requestOCSP: collectEvidence,
      ...(collectEvidence ? { ALPNProtocols: ['h2', 'http/1.1'] } : {}),
      ...(cipherName ? { ciphers: cipherName } : {}),
    };
    try {
      socket = tlsConnect(options);
    } catch (error) {
      finish({ supported: false, error: safeError(error) });
      return;
    }
    socket.once('OCSPResponse', (response) => { ocspStapled = Buffer.isBuffer(response) && response.length > 0; });
    socket.setTimeout(target.timeoutMs, () => finish({ supported: false, error: `TLS handshake timed out after ${target.timeoutMs}ms.` }));
    socket.once('error', (error) => finish({ supported: false, error: safeError(error) }));
    socket.once('secureConnect', () => {
      try {
        const cipher = socket!.getCipher();
        const peer = collectEvidence ? socket!.getPeerCertificate(true) as DetailedPeerCertificate : undefined;
        // Certificate identity follows the TLS SNI identity when explicitly
        // provided; the pinned IP remains the network destination only.
        const chain = peer ? certificateChain(peer, target.sni ?? target.host) : [];
        const ephemeral = collectEvidence ? socket!.getEphemeralKeyInfo() : undefined;
        finish({
          supported: true,
          negotiatedProtocol: socket!.getProtocol() ?? undefined,
          cipher: cipher ? {
            opensslName: cipher.name,
            standardName: cipher.standardName,
            version: cipher.version,
          } : undefined,
          alpn: socket!.alpnProtocol || undefined,
          ephemeralKey: ephemeral && Object.keys(ephemeral).length > 0 ? ephemeral as Record<string, unknown> : undefined,
          sharedSignatureAlgorithms: collectEvidence ? socket!.getSharedSigalgs() : undefined,
          certificate: chain[0],
          certificateChain: chain,
          ocspStapled,
          authorizedBySystemTrust: socket!.authorized,
          trustError: socket!.authorizationError ? String(socket!.authorizationError) : undefined,
        });
      } catch (error) {
        finish({ supported: false, error: safeError(error) });
      }
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

async function probeProtocol(target: ResolvedTarget, protocol: TlsProtocol, signal: AbortSignal): Promise<ProtocolProbe> {
  signal.throwIfAborted();
  const result = await probeTlsEndpoint(target, target.addresses[0], protocol, signal);
  if (result.supported) return { requested: protocol, conclusion: 'supported', ...result };
  const error = result.error ?? 'The pinned address did not accept the handshake.';
  const engineLimited = /no protocols available|unsupported protocol|legacy sigalg disallowed/i.test(error);
  const explicitlyRejected = /alert protocol version|wrong version number/i.test(error);
  return {
    requested: protocol,
    supported: false,
    conclusion: explicitlyRejected ? 'not-supported' : 'inconclusive',
    engineLimited: engineLimited || undefined,
    elapsedMs: result.elapsedMs,
    error,
  };
}

function cipherCandidates(scanMode: ResolvedTarget['scanMode']): string[] {
  if (scanMode === 'quick') return [];
  const available = [...new Set(getCiphers().map((name) => name.toUpperCase()))]
    .filter((name) => !name.startsWith('TLS_AES_') && !name.startsWith('TLS_CHACHA20_') && !name.includes('SCSV'))
    // This scanner intentionally has no PSK/SRP credential inputs, so probing
    // those suites would add traffic without producing a meaningful result.
    .filter((name) => !/(?:PSK|SRP)/.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (scanMode === 'deep') return available;
  const availableSet = new Set(available);
  const preferred = STANDARD_CIPHER_ORDER.filter((name) => availableSet.has(name));
  return [...preferred, ...available.filter((name) => !preferred.includes(name))];
}

async function probeCipher(target: ResolvedTarget, name: string, signal: AbortSignal): Promise<CipherProbe> {
  signal.throwIfAborted();
  const result = await probeTlsEndpoint(target, target.addresses[0], 'TLSv1.2', signal, name);
  if (result.supported) {
    return {
      protocol: 'TLSv1.2', name, supported: true,
      negotiatedName: result.cipher?.opensslName,
      standardName: result.cipher?.standardName,
      elapsedMs: result.elapsedMs,
    };
  }
  return { protocol: 'TLSv1.2', name, supported: false, elapsedMs: result.elapsedMs, error: result.error };
}

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, signal: AbortSignal, fn: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      signal.throwIfAborted();
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, worker));
  return output;
}

function analyze(protocols: ProtocolProbe[], supportedCiphers: CipherProbe[], certificate?: CertificateSummary): TlsFinding[] {
  const findings: TlsFinding[] = [];
  const supportedProtocols = protocols.filter((probe) => probe.supported).map((probe) => probe.requested);
  if (supportedProtocols.length === 0) {
    findings.push({ id: 'tls.inconclusive', severity: 'info', title: 'No successful TLS handshake', evidence: 'TLS 1.0 through TLS 1.3 probes did not complete; negative results may reflect reachability or local engine limits.', remediation: 'Verify the service and use an independent scanner before treating a protocol as disabled.' });
  }
  for (const legacy of ['TLSv1', 'TLSv1.1'] as const) {
    if (supportedProtocols.includes(legacy)) {
      findings.push({ id: `protocol.${legacy.toLowerCase()}`, severity: 'high', title: `${legacy} is enabled`, evidence: `The server completed a ${legacy} handshake.`, remediation: 'Disable TLS 1.0 and TLS 1.1; require TLS 1.2 or newer.' });
    }
  }
  const modernConclusive = protocols.filter((probe) => probe.requested === 'TLSv1.2' || probe.requested === 'TLSv1.3').every((probe) => probe.conclusion === 'not-supported');
  if (supportedProtocols.length > 0 && !supportedProtocols.some((protocol) => protocol === 'TLSv1.2' || protocol === 'TLSv1.3') && modernConclusive) {
    findings.push({ id: 'protocol.no-modern-tls', severity: 'critical', title: 'No modern TLS version', evidence: 'Neither TLS 1.2 nor TLS 1.3 completed a handshake.', remediation: 'Enable TLS 1.2 or TLS 1.3.' });
  } else if (supportedProtocols.includes('TLSv1.2') && !supportedProtocols.includes('TLSv1.3')) {
    findings.push({ id: 'protocol.no-tls13', severity: 'low', title: 'TLS 1.3 is not enabled', evidence: 'TLS 1.2 worked, but the TLS 1.3 probe did not.', remediation: 'Consider enabling TLS 1.3 after compatibility testing.' });
  }
  if (certificate) {
    if (certificate.expired) findings.push({ id: 'certificate.expired', severity: 'critical', title: 'Certificate has expired', evidence: `Certificate validity ended at ${certificate.validTo}.`, remediation: 'Renew and deploy the certificate.' });
    if (certificate.notYetValid) findings.push({ id: 'certificate.not-yet-valid', severity: 'high', title: 'Certificate is not yet valid', evidence: `Certificate validity begins at ${certificate.validFrom}.`, remediation: 'Deploy a currently valid certificate and verify system clocks.' });
    if (!certificate.hostnameValid) findings.push({ id: 'certificate.hostname-mismatch', severity: 'high', title: 'Certificate hostname mismatch', evidence: 'The leaf certificate does not match the requested host.', remediation: 'Use a certificate whose SAN covers the service hostname.' });
    if (certificate.selfSigned) findings.push({ id: 'certificate.self-signed', severity: 'medium', title: 'Self-signed leaf certificate', evidence: 'The leaf subject and issuer match and its signature verifies with its own key.', remediation: 'For public services, use a certificate chained to an appropriate trusted CA.' });
    if (certificate.signatureAlgorithm && /(?:md5|sha1)/i.test(certificate.signatureAlgorithm)) {
      findings.push({ id: 'certificate.weak-signature', severity: 'high', title: 'Weak certificate signature algorithm', evidence: certificate.signatureAlgorithm, remediation: 'Replace the certificate with one signed using SHA-256 or stronger.' });
    }
    if (certificate.publicKeyType === 'rsa' && certificate.publicKeyBits !== undefined && certificate.publicKeyBits < 2048) {
      findings.push({ id: 'certificate.short-rsa-key', severity: 'high', title: 'Short RSA certificate key', evidence: `${certificate.publicKeyBits}-bit RSA key.`, remediation: 'Use an RSA key of at least 2048 bits or an appropriate modern EC key.' });
    }
    const remainingMs = Date.parse(certificate.validTo) - Date.now();
    if (!certificate.expired && Number.isFinite(remainingMs) && remainingMs < 30 * 24 * 60 * 60_000) {
      findings.push({ id: 'certificate.expiring-soon', severity: 'medium', title: 'Certificate expires within 30 days', evidence: `Certificate validity ends at ${certificate.validTo}.`, remediation: 'Renew the certificate before expiry.' });
    }
  }
  const weak = supportedCiphers.filter((probe) => /(?:NULL|EXPORT|RC4|RC2|DES-CBC|3DES|MD5|ADH|AECDH|ANON)/i.test(probe.negotiatedName ?? probe.name));
  if (weak.length > 0) {
    findings.push({ id: 'cipher.weak', severity: 'high', title: 'Weak cipher suites accepted', evidence: weak.map((probe) => probe.negotiatedName ?? probe.name).join(', '), remediation: 'Disable NULL, anonymous, export, RC4, DES/3DES, and MD5-based suites.' });
  }
  findings.push({ id: 'scan.scope', severity: 'info', title: 'Bounded authorized scan', evidence: `Checked one target; protocols: ${supportedProtocols.join(', ') || 'none'}; accepted bounded TLS 1.2 cipher probes: ${supportedCiphers.length}.` });
  const rank: Record<TlsFinding['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return findings.sort((left, right) => rank[left.severity] - rank[right.severity] || left.id.localeCompare(right.id));
}

interface CachedScan {
  result: SslScanResult;
  createdAtMs: number;
}

type ProgressCallback = (progress: SslScanProgress) => void;

export class SslTlsScanner {
  readonly allowedPorts: readonly number[];
  readonly allowPrivateTargets: boolean;
  readonly maxConcurrentScans: number;
  readonly minTargetIntervalMs: number;
  readonly cacheTtlMs: number;
  private activeScans = 0;
  private readonly lastTargetStart = new Map<string, number>();
  private readonly cache = new Map<string, CachedScan>();
  private readonly scanStatuses = new Map<string, SslScanProgress>();

  constructor(options: SslScannerOptions = {}) {
    this.allowedPorts = Object.freeze([...(options.allowedPorts ?? DEFAULT_SSL_PORTS)]);
    if (this.allowedPorts.length === 0 || this.allowedPorts.length > 64 || this.allowedPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
      throw new Error('allowedPorts must contain between 1 and 64 valid TCP ports.');
    }
    this.allowPrivateTargets = options.allowPrivateTargets === true;
    this.maxConcurrentScans = Math.max(1, Math.min(2, Math.trunc(options.maxConcurrentScans ?? 1)));
    this.minTargetIntervalMs = Math.max(0, Math.min(60_000, Math.trunc(options.minTargetIntervalMs ?? 2_000)));
    this.cacheTtlMs = Math.max(0, Math.min(60 * 60_000, Math.trunc(options.cacheTtlMs ?? 5 * 60_000)));
  }

  status(scanId?: string): Record<string, unknown> {
    return {
      ok: true,
      engine: `Node ${process.version} / OpenSSL ${process.versions.openssl}`,
      activeScans: this.activeScans,
      limits: {
        targetsPerCall: 1,
        allowedPorts: this.allowedPorts,
        maxConcurrentScans: this.maxConcurrentScans,
        minTargetIntervalMs: this.minTargetIntervalMs,
        privateNetworksAllowed: this.allowPrivateTargets,
        cacheTtlMs: this.cacheTtlMs,
      },
      cacheEntries: this.cache.size,
      scan: scanId ? this.scanStatuses.get(scanId) : undefined,
    };
  }

  private updateProgress(progress: SslScanProgress, callback?: ProgressCallback): void {
    this.scanStatuses.delete(progress.scanId);
    this.scanStatuses.set(progress.scanId, progress);
    while (this.scanStatuses.size > MAX_STATUS_ENTRIES) {
      const oldest = this.scanStatuses.keys().next().value as string | undefined;
      if (!oldest) break;
      this.scanStatuses.delete(oldest);
    }
    try { callback?.({ ...progress }); } catch { /* A UI progress listener must not fail a scan. */ }
  }

  private advanceProgress(scanId: string, patch: Partial<SslScanProgress>, callback?: ProgressCallback): void {
    const previous = this.scanStatuses.get(scanId);
    if (!previous) return;
    const completedSteps = patch.completedSteps ?? previous.completedSteps;
    const totalSteps = patch.totalSteps ?? previous.totalSteps;
    this.updateProgress({
      ...previous,
      ...patch,
      completedSteps,
      totalSteps,
      percent: totalSteps > 0 ? Math.max(0, Math.min(100, Math.round(completedSteps / totalSteps * 100))) : 0,
      updatedAt: new Date().toISOString(),
    }, callback);
  }

  private cacheKey(target: ResolvedTarget): string {
    return JSON.stringify({
      host: target.host,
      port: target.port,
      sni: target.sni,
      addresses: target.addresses.map((entry) => `${entry.family}:${entry.address}`).sort(),
      scanMode: target.scanMode,
      maxCipherTests: target.maxCipherTests,
      timeoutMs: target.timeoutMs,
      overallTimeoutMs: target.overallTimeoutMs,
    });
  }

  async scan(raw: unknown, externalSignal?: AbortSignal, onProgress?: ProgressCallback): Promise<SslScanResult> {
    if (this.activeScans >= this.maxConcurrentScans) throw new Error(`At most ${this.maxConcurrentScans} TLS scans may run concurrently.`);
    const scanId = randomUUID();
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    this.updateProgress({
      scanId, status: 'running', phase: 'resolving', completedSteps: 0, totalSteps: 1, percent: 0,
      startedAt, updatedAt: startedAt, message: 'Validating authorization and resolving a single pinned target.',
    }, onProgress);
    // Reserve the slot before asynchronous DNS resolution so simultaneous
    // requests cannot race past the concurrency limit.
    this.activeScans += 1;
    try {
      const target = await validateAndResolveTarget(raw, {
        allowedPorts: this.allowedPorts,
        allowPrivateTargets: this.allowPrivateTargets,
        signal: externalSignal,
      });
      if (Date.now() - startedAtMs >= target.overallTimeoutMs) {
        throw new Error(`Overall scan timed out after ${target.overallTimeoutMs}ms.`);
      }
      const targetLabel = `${target.displayHost}:${target.port}`;
      const totalSteps = PROTOCOLS.length + target.maxCipherTests + 2;
      this.advanceProgress(scanId, {
        target: targetLabel, scanMode: target.scanMode, completedSteps: 1, totalSteps,
        message: `Target resolved and pinned; starting ${target.scanMode} TLS checks.`,
      }, onProgress);

      const key = this.cacheKey(target);
      const cached = this.cache.get(key);
      const now = Date.now();
      if (!target.forceRefresh && cached && now - cached.createdAtMs < this.cacheTtlMs) {
        const completedAt = new Date(now).toISOString();
        const cachedTotalSteps = PROTOCOLS.length + cached.result.cipherProbe.tested + 2;
        const result: SslScanResult = {
          ...cached.result,
          scanId,
          target: { ...cached.result.target, host: target.displayHost },
          startedAt,
          completedAt,
          durationMs: now - startedAtMs,
          cache: {
            hit: true,
            createdAt: new Date(cached.createdAtMs).toISOString(),
            expiresAt: new Date(cached.createdAtMs + this.cacheTtlMs).toISOString(),
            sourceScanId: cached.result.scanId,
          },
        };
        this.advanceProgress(scanId, {
          status: 'completed', phase: 'completed', completedSteps: cachedTotalSteps, totalSteps: cachedTotalSteps, cacheHit: true,
          message: 'Returned a recent result for the same pinned target and scan settings.',
        }, onProgress);
        return result;
      }
      if (cached) this.cache.delete(key);
      const result = await this.scanTarget(target, scanId, startedAtMs, onProgress, externalSignal);
      if (this.cacheTtlMs > 0) {
        this.cache.delete(key);
        this.cache.set(key, { result, createdAtMs: Date.parse(result.completedAt) });
        while (this.cache.size > MAX_CACHE_ENTRIES) {
          const oldest = this.cache.keys().next().value as string | undefined;
          if (!oldest) break;
          this.cache.delete(oldest);
        }
      }
      return result;
    } catch (error) {
      const cancelled = externalSignal?.aborted === true;
      this.advanceProgress(scanId, {
        status: cancelled ? 'cancelled' : 'failed',
        phase: cancelled ? 'cancelled' : 'failed',
        message: safeError(error),
      }, onProgress);
      throw error;
    } finally {
      this.activeScans -= 1;
    }
  }

  private async scanTarget(
    target: ResolvedTarget,
    scanId: string,
    startedAtMs: number,
    onProgress?: ProgressCallback,
    externalSignal?: AbortSignal,
  ): Promise<SslScanResult> {
    const key = `${target.host}:${target.port}`;
    const sinceLastStart = Date.now() - (this.lastTargetStart.get(key) ?? 0);
    if (sinceLastStart < this.minTargetIntervalMs) throw new Error(`Wait ${this.minTargetIntervalMs - sinceLastStart}ms before scanning this target again.`);
    this.lastTargetStart.delete(key);
    this.lastTargetStart.set(key, Date.now());
    while (this.lastTargetStart.size > 256) {
      const oldest = this.lastTargetStart.keys().next().value as string | undefined;
      if (!oldest) break;
      this.lastTargetStart.delete(oldest);
    }
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(externalSignal?.reason ?? new Error('Scan cancelled.'));
    if (externalSignal?.aborted) forwardAbort();
    else externalSignal?.addEventListener('abort', forwardAbort, { once: true });
    const remainingOverallMs = Math.max(1, target.overallTimeoutMs - (Date.now() - startedAtMs));
    const timer = setTimeout(() => controller.abort(new Error(`Overall scan timed out after ${target.overallTimeoutMs}ms.`)), remainingOverallMs);
    timer.unref?.();
    try {
      const candidates = cipherCandidates(target.scanMode);
      const selected = candidates.slice(0, target.maxCipherTests);
      this.advanceProgress(scanId, { totalSteps: PROTOCOLS.length + selected.length + 2 }, onProgress);
      const protocols: ProtocolProbe[] = [];
      for (const [index, protocol] of PROTOCOLS.entries()) {
        controller.signal.throwIfAborted();
        protocols.push(await probeProtocol(target, protocol, controller.signal));
        this.advanceProgress(scanId, {
          phase: 'protocols', completedSteps: index + 2,
          message: `Protocol check ${index + 1}/${PROTOCOLS.length}: ${protocol}.`,
        }, onProgress);
      }
      controller.signal.throwIfAborted();
      let completedCiphers = 0;
      const cipherResults = await mapConcurrent(selected, target.scanMode === 'deep' ? 2 : 1, controller.signal, async (name) => {
        const result = await probeCipher(target, name, controller.signal);
        completedCiphers += 1;
        this.advanceProgress(scanId, {
          phase: 'ciphers', completedSteps: PROTOCOLS.length + 1 + completedCiphers,
          message: `Bounded TLS 1.2 cipher check ${completedCiphers}/${selected.length}.`,
        }, onProgress);
        return result;
      });
      controller.signal.throwIfAborted();
      const supportedCiphers = cipherResults.filter((probe) => probe.supported);
      const evidenceProbe = [...protocols].reverse().find((probe) => probe.supported && probe.certificate);
      const certificate = evidenceProbe?.certificate;
      const certificateChainResult = evidenceProbe?.certificateChain ?? [];
      const completedAtMs = Date.now();
      this.advanceProgress(scanId, {
        phase: 'analyzing', completedSteps: PROTOCOLS.length + selected.length + 2,
        message: 'Normalizing certificate evidence and policy findings.',
      }, onProgress);
      const result: SslScanResult = {
        schemaVersion: 1,
        scanId,
        status: 'completed',
        scanMode: target.scanMode,
        scanner: {
          id: 'mr-robot.sslscan',
          version: SCANNER_VERSION,
          engine: `Node ${process.version} / OpenSSL ${process.versions.openssl}`,
          limitations: [
            'Uses the TLS algorithms exposed by the bundled Node/OpenSSL runtime; SSLv2 and SSLv3 are intentionally not implemented.',
            'Direct TLS only; STARTTLS, RDP, MySQL, and PostgreSQL protocol preambles are not implemented.',
            'Does not send Heartbleed, fallback-SCSV, renegotiation, or other exploit-oriented probes.',
            'Quick mode sends no individual cipher probes; standard/deep enumeration is bounded and covers TLS 1.2-and-earlier OpenSSL cipher names.',
            'TLS 1.3 reports negotiated evidence rather than exhaustive ciphersuite/group enumeration.',
          ],
        },
        target: {
          host: target.displayHost,
          port: target.port,
          sni: target.sni,
          resolvedAddresses: target.addresses.map((entry) => entry.address),
          pinnedAddress: target.addresses[0].address,
        },
        authorization: { confirmed: true, scope: 'single-target', privateNetworksAllowed: this.allowPrivateTargets },
        cache: {
          hit: false,
          createdAt: new Date(completedAtMs).toISOString(),
          expiresAt: new Date(completedAtMs + this.cacheTtlMs).toISOString(),
        },
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: completedAtMs - startedAtMs,
        protocols,
        supportedCiphers,
        cipherProbe: { candidates: candidates.length, tested: selected.length, truncated: selected.length < candidates.length },
        certificate,
        certificateChain: certificateChainResult,
        findings: analyze(protocols, supportedCiphers, certificate),
      };
      this.advanceProgress(scanId, {
        status: 'completed', phase: 'completed', cacheHit: false,
        message: 'TLS scan completed.',
      }, onProgress);
      return result;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', forwardAbort);
    }
  }
}
