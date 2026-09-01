import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { delimiter, join } from 'node:path';
import type { RemoteLinkConfig, RemoteLinkStatus, RemoteTransportProviderInfo } from '@mr-robot/shared';
import { getDomain } from 'tldts';
import { SecretVault } from '../secrets.js';
import type { PluginContext } from './context.js';
import type { MrRobotPlugin } from './loader.js';
import { mrRobotHome } from '../config.js';
import { CLOUDFLARE_ACCESS_PAIR_PROBE, CLOUDFLARE_ACCESS_PAIR_PROBE_ERROR } from '../access-probe.js';

const PLUGIN_ID = 'remote-link';
const QUICK_TUNNEL_HOST = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;
const NAMED_TUNNEL_READY = /(?:registered tunnel connection|tunnel connection registered|connection[^\r\n]{0,160}registered)/i;
const MAX_DIAGNOSTIC_CHARS = 12_000;
const START_TIMEOUT_MS = 35_000;
const VERIFY_TIMEOUT_MS = 12_000;
const AUTHENTICODE_TIMEOUT_MS = 10_000;
const CLOUDFLARE_PUBLISHER = 'Cloudflare, Inc.';
const AUTHENTICODE_SCRIPT = [
  '$ErrorActionPreference="Stop"',
  'Import-Module (Join-Path $PSHOME "Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1") -Force -ErrorAction Stop',
  '$path=[Console]::In.ReadToEnd().Trim()',
  '$signature=Get-AuthenticodeSignature -LiteralPath $path -ErrorAction Stop',
  '$certificate=$signature.SignerCertificate',
  '$publisher=if($null -eq $certificate){""}else{$certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)}',
  '$thumbprint=if($null -eq $certificate){""}else{$certificate.Thumbprint}',
  '[pscustomobject]@{status=[string]$signature.Status;publisher=$publisher;thumbprint=$thumbprint}|ConvertTo-Json -Compress',
].join(';');
const AUTHENTICODE_COMMAND = Buffer.from(AUTHENTICODE_SCRIPT, 'utf16le').toString('base64');

const DEFAULT_CONFIG: RemoteLinkConfig = {
  provider: 'cloudflare-quick',
  localUrl: 'http://127.0.0.1:8787',
  autoStart: false,
};

interface StoredRemoteLinkConfig {
  provider?: RemoteLinkConfig['provider'];
  localUrl?: string;
  hostname?: string;
  peerHostnames?: string[];
  autoStart?: boolean;
  tunnelTokenProtected?: string;
  accessCredentialsProtected?: string;
}

interface CloudflareAccessServiceCredentials {
  clientId: string;
  clientSecret: string;
}

export interface RemoteLinkPlugin extends MrRobotPlugin {
  /**
   * Host-only credential bridge for direct PC-to-PC requests. This is not a
   * plugin command and therefore cannot be invoked through RPC or by an AI
   * tool. Headers are returned only for the exact saved named-Tunnel host.
   */
  peerRequestHeaders(url: URL): Record<string, string>;
}

function boundedAppend(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length > MAX_DIAGNOSTIC_CHARS ? next.slice(-MAX_DIAGNOSTIC_CHARS) : next;
}

/** Never expose connector credentials through status diagnostics or UI errors. */
export function redactRemoteLinkDiagnostics(value: string): string {
  return value
    .replace(/\beyJ[A-Za-z0-9_-]{40,}(?:\.[A-Za-z0-9_-]{10,}){0,2}\b/g, '[REDACTED_TUNNEL_TOKEN]')
    .replace(/"TunnelSecret"\s*:\s*"[^"]+"/gi, '"TunnelSecret":"[REDACTED]"')
    .replace(/\bcfast_[A-Za-z0-9]{48}\b/g, '[REDACTED_ACCESS_SECRET]')
    .replace(/\bTUNNEL_CRED_CONTENTS\s*[=:]\s*(?:\{[^\r\n]*\}|[^\s,;]+)/gi, 'TUNNEL_CRED_CONTENTS=[REDACTED]')
    .replace(/\b(?:token|tunnel_token|TUNNEL_TOKEN)\s*[=:]\s*[^\s,;]+/gi, 'token=[REDACTED]')
    .replace(/\bCF-Access-Client-(?:Id|Secret)\s*[=:]\s*[^\s,;]+/gi, 'CF-Access-Client-Credential=[REDACTED]')
    .replace(/"(?:accessClientId|accessClientSecret|clientId|clientSecret)"\s*:\s*"[^"]+"/gi, '"accessCredential":"[REDACTED]"');
}

function normalizeAccessCredentialPart(value: unknown, label: string): string {
  const normalized = String(value ?? '').trim();
  if (normalized.length < 20 || normalized.length > 512 || !/^[A-Za-z0-9._~-]+$/.test(normalized)) {
    throw new Error(`${label} 형식이 올바르지 않습니다.`);
  }
  return normalized;
}

function normalizeAccessCredentials(clientId: unknown, clientSecret: unknown): CloudflareAccessServiceCredentials {
  return {
    clientId: normalizeAccessCredentialPart(clientId, 'Cloudflare Access Client ID'),
    clientSecret: normalizeAccessCredentialPart(clientSecret, 'Cloudflare Access Client Secret'),
  };
}

function decodeAccessCredentials(protectedValue: string, unprotect: (value: string) => string): CloudflareAccessServiceCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unprotect(protectedValue));
  } catch {
    throw new Error('저장된 Cloudflare Access 자격증명을 읽을 수 없습니다. 다시 저장하세요.');
  }
  const value = parsed as Partial<CloudflareAccessServiceCredentials>;
  return normalizeAccessCredentials(value?.clientId, value?.clientSecret);
}

function normalizePeerHostnames(value: unknown, primaryHostname: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error('신뢰할 PC 호스트는 최대 8개까지 등록할 수 있습니다.');
  const primary = normalizeNamedTunnelHostname(primaryHostname);
  const normalized = [...new Set(value.map((item) => normalizeNamedTunnelHostname(item)))].filter((item) => item !== primary);
  if (normalized.length === 0) return [];

  // String suffix matching is not an ownership boundary: pc1.github.io and
  // pc2.github.io have different owners even though both end in github.io.
  // Resolve the registrable domain with both ICANN and private PSL sections,
  // then require every peer to be a true subdomain of the same owned zone.
  const ownedDomain = getDomain(primary, { allowPrivateDomains: true });
  if (!ownedDomain || normalized.some((item) => {
    const peerDomain = getDomain(item, { allowPrivateDomains: true });
    return peerDomain !== ownedDomain || item === ownedDomain;
  })) {
    throw new Error('신뢰할 PC 호스트는 같은 소유 도메인의 정확한 서브도메인이어야 합니다. 공유 공개 접미사는 허용되지 않습니다.');
  }
  return normalized;
}

async function readSmallJson(response: Response): Promise<{ ok?: unknown; app?: unknown; error?: unknown }> {
  const advertised = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(advertised) && advertised > 16 * 1024) throw new Error('외부 확인 응답이 너무 큽니다.');
  if (!response.body) throw new Error('외부 확인 응답 본문이 없습니다.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024) throw new Error('외부 확인 응답이 너무 큽니다.');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as { ok?: unknown; app?: unknown; error?: unknown };
  } catch {
    throw new Error('외부 주소가 올바른 Mr.Robot JSON 응답을 반환하지 않았습니다.');
  }
}

async function terminateChild(ctx: PluginContext, child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('close', finish);
    try { child.kill(); } catch { finish(); }
    const force = ctx.setTimeout(() => {
      if (child.exitCode === null) {
        try { child.kill('SIGKILL'); } catch { /* process already exited */ }
      }
      finish();
    }, 2_500);
    child.once('close', () => ctx.clearTimeout(force));
  });
}

function candidateExecutables(): string[] {
  const names = process.platform === 'win32' ? ['cloudflared.exe', 'cloudflared'] : ['cloudflared'];
  const fromPath = String(process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .flatMap((folder) => names.map((name) => join(folder, name)));
  if (process.platform !== 'win32') return [...fromPath, '/usr/local/bin/cloudflared', '/usr/bin/cloudflared'];
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  return [...new Set([
    join(localAppData, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
    join(localAppData, 'Microsoft', 'WinGet', 'Packages', 'Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe', 'cloudflared.exe'),
    join(programFiles, 'cloudflared', 'cloudflared.exe'),
    join(programFilesX86, 'cloudflared', 'cloudflared.exe'),
    ...fromPath,
  ].filter(Boolean))];
}

export interface CloudflaredExecutableTrust {
  trusted: boolean;
  executable?: string;
  diagnostic: string;
}

function canonicalExecutable(candidate: string): string | undefined {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return undefined;
    return realpathSync.native(candidate);
  } catch {
    return undefined;
  }
}

/**
 * A tunnel token is only given to an authentic Cloudflare binary. PATH entries
 * are treated as untrusted input; Windows must validate both Authenticode and
 * the exact publisher before the process is spawned.
 */
export function verifyCloudflaredExecutable(candidate: string): CloudflaredExecutableTrust {
  const executable = canonicalExecutable(candidate);
  if (!executable) return { trusted: false, diagnostic: '실행 파일이 없거나 일반 파일이 아닙니다.' };
  if (process.platform !== 'win32') {
    // This desktop release can authenticate the Cloudflare publisher only via
    // Windows Authenticode. Treating a PATH binary as trusted elsewhere would
    // hand an attacker both code execution and the decrypted Tunnel token.
    return { trusted: false, executable, diagnostic: '이 릴리스의 Cloudflare Remote Link는 Windows Authenticode 검증 환경에서만 실행할 수 있습니다.' };
  }

  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', AUTHENTICODE_COMMAND], {
      input: executable,
      encoding: 'utf8',
      windowsHide: true,
      timeout: AUTHENTICODE_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    if (result.error || result.status !== 0) {
      const stderr = String(result.stderr ?? '').trim().replace(/[\r\n]+/g, ' ').slice(0, 240);
      const reason = result.error?.message || stderr || `exit ${String(result.status)}`;
      return { trusted: false, executable, diagnostic: `Authenticode 검사 실패 (${reason.slice(0, 160)})` };
    }
    const raw = JSON.parse(result.stdout.trim()) as { status?: unknown; publisher?: unknown; thumbprint?: unknown };
    const status = String(raw.status ?? 'Unknown').replace(/[\r\n]/g, ' ').slice(0, 40);
    const publisher = String(raw.publisher ?? '').replace(/[\r\n]/g, ' ').slice(0, 160);
    const thumbprint = String(raw.thumbprint ?? '').replace(/[^A-Fa-f0-9]/g, '').slice(0, 40).toUpperCase();
    if (status !== 'Valid' || publisher !== CLOUDFLARE_PUBLISHER) {
      return {
        trusted: false,
        executable,
        diagnostic: `Authenticode 거부: status=${status}, publisher=${publisher || '없음'}`,
      };
    }
    return {
      trusted: true,
      executable,
      diagnostic: `Authenticode 확인: Valid, publisher=${CLOUDFLARE_PUBLISHER}${thumbprint ? `, certificate=${thumbprint}` : ''}`,
    };
  } catch (error) {
    return {
      trusted: false,
      executable,
      diagnostic: `Authenticode 결과 해석 실패 (${(error instanceof Error ? error.message : String(error)).slice(0, 160)})`,
    };
  }
}

export function findCloudflaredExecutable(): string | undefined {
  for (const candidate of candidateExecutables()) {
    const trust = verifyCloudflaredExecutable(candidate);
    if (trust.trusted) return trust.executable;
  }
  return undefined;
}

function findCloudflaredCandidate(): string | undefined {
  return candidateExecutables().find((candidate) => Boolean(canonicalExecutable(candidate)));
}

/** Quick links may only publish this agent's loopback listener, never an arbitrary local service. */
export function normalizeRemoteLinkLocalUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    throw new Error('로컬 Agent 주소가 올바른 URL이 아닙니다.');
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
    throw new Error('원격 링크는 보안을 위해 이 PC의 loopback HTTP 주소만 공개할 수 있습니다.');
  }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('로컬 Agent 주소에는 계정, 경로, 쿼리 또는 fragment를 넣을 수 없습니다.');
  }
  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('로컬 Agent 포트가 올바르지 않습니다.');
  return url.origin;
}

export function parseQuickTunnelUrl(output: string): string | undefined {
  return output.match(QUICK_TUNNEL_HOST)?.[0];
}

export function namedTunnelReady(output: string): boolean {
  return NAMED_TUNNEL_READY.test(output);
}

/** Accept a hostname or HTTPS origin, then reduce it to one public DNS hostname. */
export function normalizeNamedTunnelHostname(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('Cloudflare 고정 호스트명을 입력하세요.');
  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error('Cloudflare 고정 호스트명이 올바르지 않습니다.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('고정 주소는 경로·포트·계정 정보가 없는 HTTPS 호스트명이어야 합니다.');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname.length > 253 || !hostname.includes('.') || hostname === 'localhost'
    || isIP(hostname) !== 0
    || /(?:^|\.)(?:local|localhost|internal|lan|home\.arpa)$/.test(hostname)
    || !hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw new Error('예: pc1.example.com 형식의 공개 DNS 호스트명을 입력하세요.');
  }
  return hostname;
}

function normalizeTunnelToken(value: unknown): string {
  const token = String(value ?? '').trim();
  if (token.length < 80 || token.length > 4_096 || /\s/.test(token)) {
    throw new Error('Cloudflare Tunnel 토큰이 올바르지 않습니다. 대시보드의 Connector 토큰 전체를 붙여넣으세요.');
  }
  return token;
}

/**
 * Cheap identity used only to decide whether a prior Authenticode result can
 * be reused for status rendering. Starts never rely on this cache. Including
 * the resolved path catches link retargeting; dev/ino plus size and timestamps
 * catch replacement or in-place updates on ordinary Windows filesystems.
 */
function executableFileIdentity(candidate: string): string {
  try {
    const executable = realpathSync.native(candidate);
    const stats = statSync(executable);
    if (!stats.isFile()) return `not-file\0${executable}`;
    const normalizedPath = process.platform === 'win32' ? executable.toLowerCase() : executable;
    return [
      normalizedPath,
      stats.dev,
      stats.ino,
      stats.size,
      stats.mtimeMs,
      stats.ctimeMs,
      stats.birthtimeMs,
    ].join('\0');
  } catch {
    // Runtime-injected test candidates and a file racing with discovery still
    // get a stable fail-closed identity. Production discovery returns only an
    // existing canonical file.
    return `unresolved\0${candidate}`;
  }
}

export interface LocalTunnelCredentials {
  tunnelId: string;
  contents: string;
}

/** Convert a remotely-managed connector token into local credentials in memory. */
export function localTunnelCredentialsFromToken(value: unknown): LocalTunnelCredentials {
  const token = normalizeTunnelToken(value);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Tunnel 토큰을 로컬 최소 권한 자격증명으로 변환할 수 없습니다. Cloudflare Connector 토큰을 다시 복사하세요.');
  }
  const raw = decoded as { a?: unknown; t?: unknown; s?: unknown };
  const accountTag = String(raw.a ?? '');
  const tunnelId = String(raw.t ?? '').toLowerCase();
  const tunnelSecret = String(raw.s ?? '');
  if (!/^[a-z0-9_-]{8,128}$/i.test(accountTag)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tunnelId)
    || !/^[a-z0-9+/_=-]{20,512}$/i.test(tunnelSecret)) {
    throw new Error('Tunnel 토큰 필드가 Cloudflare Connector 형식과 일치하지 않습니다.');
  }
  return {
    tunnelId,
    contents: JSON.stringify({ AccountTag: accountTag, TunnelSecret: tunnelSecret, TunnelID: tunnelId }),
  };
}

export function localTunnelIngressConfig(tunnelId: string, hostname: string, localUrl: string): string {
  // All values have already passed strict hostname/UUID/loopback-origin
  // normalization. JSON string quoting is valid YAML and prevents injection.
  return [
    `tunnel: ${JSON.stringify(tunnelId)}`,
    'ingress:',
    `  - hostname: ${JSON.stringify(hostname)}`,
    `    service: ${JSON.stringify(localUrl)}`,
    '  - service: http_status:404',
    '',
  ].join('\n');
}

function cloudflaredEnvironment(credentialsContents?: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec',
    'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
    'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'LANG', 'LC_ALL',
  ];
  const entries = Object.entries(source);
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const found = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (found && typeof found[1] === 'string') env[name] = found[1];
  }
  if (credentialsContents) env.TUNNEL_CRED_CONTENTS = credentialsContents;
  return env;
}

export interface RemoteLinkRuntime {
  findExecutable?: () => string | undefined;
  verifyExecutable?: (candidate: string) => CloudflaredExecutableTrust;
  spawnProcess?: typeof spawn;
  protectSecret?: (value: string) => string;
  unprotectSecret?: (value: string) => string;
  fetchUrl?: typeof fetch;
  runtimeDirectory?: string;
}

function providerInventory(cloudflaredPath?: string, trustDiagnostic?: string): RemoteTransportProviderInfo[] {
  const unavailableReason = trustDiagnostic?.startsWith('Authenticode')
    ? `신뢰 검증된 cloudflared가 필요합니다. (${trustDiagnostic})`
    : 'cloudflared 설치가 필요합니다.';
  return [
    {
      id: 'cloudflare-quick',
      name: 'Cloudflare Quick Tunnel',
      available: Boolean(cloudflaredPath),
      temporary: true,
      requiresAccount: false,
      reason: cloudflaredPath ? undefined : unavailableReason,
    },
    {
      id: 'cloudflare-named',
      name: 'Cloudflare 고정 Tunnel',
      available: Boolean(cloudflaredPath),
      temporary: false,
      requiresAccount: true,
      reason: cloudflaredPath ? 'Cloudflare 계정, 도메인, Tunnel 토큰이 필요합니다.' : unavailableReason,
    },
    {
      id: 'google-relay',
      name: 'Google 계정 Relay',
      available: false,
      temporary: false,
      requiresAccount: true,
      reason: 'Firebase 프로젝트, OAuth 클라이언트와 E2EE relay 배포가 아직 구성되지 않았습니다.',
    },
  ];
}

function storedConfig(ctx: PluginContext): RemoteLinkConfig {
  const stored = ctx.storage.get<StoredRemoteLinkConfig>('config');
  const provider = stored?.provider === 'cloudflare-named'
    ? 'cloudflare-named'
    : stored?.provider === 'google-relay'
      ? 'google-relay'
      : 'cloudflare-quick';
  let localUrl = DEFAULT_CONFIG.localUrl;
  try {
    localUrl = normalizeRemoteLinkLocalUrl(stored?.localUrl ?? DEFAULT_CONFIG.localUrl);
  } catch {
    // Invalid values from an older version are deliberately ignored.
  }
  let hostname: string | undefined;
  try {
    if (stored?.hostname) hostname = normalizeNamedTunnelHostname(stored.hostname);
  } catch {
    // Invalid values from an older version are deliberately ignored.
  }
  let peerHostnames: string[] = [];
  try {
    if (hostname) peerHostnames = normalizePeerHostnames(stored?.peerHostnames, hostname);
  } catch {
    // Invalid legacy peer entries are ignored rather than widening trust.
  }
  return {
    provider,
    localUrl,
    ...(hostname ? { hostname } : {}),
    ...(peerHostnames.length ? { peerHostnames } : {}),
    hasTunnelToken: Boolean(stored?.tunnelTokenProtected),
    hasAccessCredentials: Boolean(stored?.accessCredentialsProtected),
    autoStart: provider === 'cloudflare-named' && stored?.autoStart === true,
  };
}

export function createRemoteLinkPlugin(runtime: RemoteLinkRuntime = {}): RemoteLinkPlugin {
  const detectExecutable = runtime.findExecutable ?? findCloudflaredCandidate;
  const inspectExecutable = runtime.verifyExecutable ?? verifyCloudflaredExecutable;
  const spawnProcess = runtime.spawnProcess ?? spawn;
  const vault = new SecretVault();
  const protectSecret = runtime.protectSecret ?? ((value: string) => vault.protect(value));
  const unprotectSecret = runtime.unprotectSecret ?? ((value: string) => vault.unprotect(value));
  const fetchUrl = runtime.fetchUrl ?? fetch;
  const runtimeDirectory = runtime.runtimeDirectory ?? join(mrRobotHome(), 'runtime');
  let processHandle: ChildProcess | null = null;
  const liveChildren = new Set<ChildProcess>();
  let operationGeneration = 0;
  let pendingStart: { generation: number; child: ChildProcess; cancel: (reason: Error) => void } | null = null;
  let publicUrl: string | undefined;
  let startedAt: number | undefined;
  let lastError: string | undefined;
  let diagnostics = '';
  let executableTrustDiagnostic = '';
  let reachable: boolean | undefined;
  let accessProtected: boolean | undefined;
  let verifiedAt: number | undefined;
  // The saved provider configuration and the process currently serving traffic
  // are deliberately separate. A temporary Quick Tunnel must never overwrite a
  // named tunnel hostname, auto-start preference, or DPAPI-protected token.
  let activeConfig: RemoteLinkConfig | null = null;
  let activeCloudflaredConfigPath: string | null = null;
  let activeTransientQuick = false;
  let activeContext: PluginContext | undefined;
  let accessCredentialCache: { protectedValue: string; credentials: CloudflareAccessServiceCredentials } | undefined;
  let executableTrustCache: { identity: string; trust: CloudflaredExecutableTrust } | undefined;

  const accessCredentials = (ctx: PluginContext): CloudflareAccessServiceCredentials | undefined => {
    const protectedValue = ctx.storage.get<StoredRemoteLinkConfig>('config')?.accessCredentialsProtected;
    if (!protectedValue) {
      accessCredentialCache = undefined;
      return undefined;
    }
    if (accessCredentialCache?.protectedValue === protectedValue) return accessCredentialCache.credentials;
    const credentials = decodeAccessCredentials(protectedValue, unprotectSecret);
    accessCredentialCache = { protectedValue, credentials };
    return credentials;
  };

  return {
    peerRequestHeaders(url): Record<string, string> {
      const ctx = activeContext;
      if (!ctx || url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password) return {};
      const config = storedConfig(ctx);
      const allowedHostnames = config.hostname ? new Set([config.hostname, ...(config.peerHostnames ?? [])]) : new Set<string>();
      if (config.provider !== 'cloudflare-named' || !allowedHostnames.has(url.hostname.toLowerCase())) return {};
      const access = accessCredentials(ctx);
      return access ? {
        'CF-Access-Client-Id': access.clientId,
        'CF-Access-Client-Secret': access.clientSecret,
      } : {};
    },
    manifest: {
      id: PLUGIN_ID,
      name: 'Cloudflare Remote Link',
      version: '0.3.9',
      kind: 'transport',
      enabledByDefault: false,
      description: 'VPN 없이 임시 Quick Link 또는 사용자 도메인의 고정 HTTPS/WSS Tunnel을 연결합니다.',
      capabilities: ['transport.remote-link', 'transport.cloudflare-quick', 'transport.cloudflare-named', 'transport.provider-contract'],
      permissions: ['network.client', 'process.execute'],
      dependencies: [{ id: 'cloudflared', name: 'Cloudflare cloudflared', required: true }],
    },
    activate(ctx) {
      const executableTrust = (forceVerification = false): CloudflaredExecutableTrust => {
        const candidate = detectExecutable();
        if (!candidate) {
          executableTrustCache = undefined;
          executableTrustDiagnostic = 'cloudflared 실행 파일을 찾지 못했습니다.';
          return { trusted: false, diagnostic: executableTrustDiagnostic };
        }
        const identityBefore = executableFileIdentity(candidate);
        if (!forceVerification && executableTrustCache?.identity === identityBefore) {
          executableTrustDiagnostic = executableTrustCache.trust.diagnostic;
          return executableTrustCache.trust;
        }
        let trust = inspectExecutable(candidate);
        if (trust.trusted && !trust.executable) trust = { ...trust, executable: candidate };
        const identityAfter = executableFileIdentity(trust.executable ?? candidate);
        if (identityBefore !== identityAfter) {
          trust = {
            trusted: false,
            executable: trust.executable,
            diagnostic: 'cloudflared 실행 파일이 신뢰 검증 도중 변경되었습니다. 다시 시도하세요.',
          };
        }
        executableTrustCache = { identity: identityAfter, trust };
        executableTrustDiagnostic = trust.diagnostic;
        return trust;
      };

      const trustedExecutable = (forceVerification = false): string | undefined => {
        const trust = executableTrust(forceVerification);
        return trust.trusted ? trust.executable : undefined;
      };

      const status = (): RemoteLinkStatus => {
        const executable = trustedExecutable();
        const running = Boolean(processHandle && processHandle.exitCode === null && !processHandle.killed);
        const config = storedConfig(ctx);
        const activeProvider = running && activeConfig ? activeConfig.provider : config.provider;
        const temporary = activeProvider !== 'cloudflare-named';
        return {
          provider: activeProvider,
          config,
          running,
          installed: Boolean(executable),
          executable,
          processId: running ? processHandle?.pid : undefined,
          publicUrl: running ? publicUrl : undefined,
          websocketUrl: running && publicUrl ? `${publicUrl.replace(/^https:/, 'wss:')}/ws` : undefined,
          startedAt: running ? startedAt : undefined,
          temporary,
          beta: temporary,
          reachable: running ? reachable : undefined,
          accessProtected: running && activeProvider === 'cloudflare-named' ? accessProtected : undefined,
          verifiedAt: running ? verifiedAt : undefined,
          warning: temporary
            ? 'Quick Tunnel은 테스트·개발용 임시 주소이며 재시작하면 주소가 바뀝니다. trycloudflare.com 경로에는 사용자 도메인의 Cloudflare WAF·레이트리밋 규칙이 적용되지 않습니다.'
            : '고정 Tunnel은 주소가 유지되지만 PC, Mr.Robot, cloudflared가 실행 중이어야 접속할 수 있습니다.',
          lastError,
          diagnostics: [executableTrustDiagnostic, diagnostics].filter(Boolean).join('\n') || undefined,
          providers: providerInventory(executable, executableTrustDiagnostic),
        };
      };

      const emitStatus = (): void => ctx.emit(`${PLUGIN_ID}.changed`, status());

      const stop = async (restoreSavedNamedTunnel = false): Promise<RemoteLinkStatus> => {
        const operation = ++operationGeneration;
        const active = processHandle;
        const pending = pendingStart;
        const wasTransientQuick = activeTransientQuick;
        const stoppedConfigPath = activeCloudflaredConfigPath;
        pendingStart = null;
        processHandle = null;
        activeConfig = null;
        activeCloudflaredConfigPath = null;
        activeTransientQuick = false;
        publicUrl = undefined;
        startedAt = undefined;
        reachable = undefined;
        accessProtected = undefined;
        verifiedAt = undefined;
        pending?.cancel(new Error('Cloudflare 원격 링크 시작이 취소되었습니다.'));
        if (active) {
          await terminateChild(ctx, active);
          liveChildren.delete(active);
        }
        if (stoppedConfigPath) {
          try { unlinkSync(stoppedConfigPath); } catch { /* already removed with the child */ }
        }
        // A newer start may have taken ownership while this old process was
        // shutting down. Its state must never be overwritten by stop(A).
        if (operation === operationGeneration) emitStatus();
        const saved = storedConfig(ctx);
        if (restoreSavedNamedTunnel && wasTransientQuick && saved.provider === 'cloudflare-named' && saved.autoStart) {
          try {
            // Restoring a saved public endpoint has the same security boundary
            // as an explicit/automatic named start: it must prove that an
            // anonymous request is blocked and the service token is accepted.
            return await startConfigured();
          } catch (error) {
            lastError = `Quick Link는 중지했지만 저장된 고정 Tunnel 복원에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`;
            emitStatus();
          }
        }
        return status();
      };

      const start = async (runtimeConfig?: RemoteLinkConfig, transientQuick = false): Promise<RemoteLinkStatus> => {
        if (processHandle && processHandle.exitCode === null && !processHandle.killed) return status();
        const config = runtimeConfig ?? storedConfig(ctx);
        if (config.provider === 'google-relay') {
          throw new Error('Google 계정 Relay는 Firebase/OAuth/relay 서버가 구성되기 전에는 활성화할 수 없습니다.');
        }
        // Never authorize a process launch from the status cache. This also
        // refreshes Authenticode for every named-tunnel restoration/start.
        const trust = executableTrust(true);
        if (!trust.trusted) {
          if (trust.diagnostic === 'cloudflared 실행 파일을 찾지 못했습니다.') {
            throw new Error('cloudflared가 없습니다. 플러그인 화면에서 의존성을 먼저 설치하세요.');
          }
          throw new Error(`cloudflared 실행 파일 신뢰 검증 실패: ${trust.diagnostic}`);
        }
        const executable = trust.executable!;

        const operation = ++operationGeneration;
        diagnostics = '';
        lastError = undefined;
        publicUrl = undefined;
        startedAt = undefined;
        reachable = undefined;
        accessProtected = undefined;
        verifiedAt = undefined;

        const stored = ctx.storage.get<StoredRemoteLinkConfig>('config');
        let tunnelToken = '';
        let localCredentials: LocalTunnelCredentials | undefined;
        let cloudflaredConfigPath: string | undefined;
        if (config.provider === 'cloudflare-named') {
          if (!config.hostname) throw new Error('Cloudflare 고정 호스트명을 먼저 저장하세요.');
          if (!stored?.tunnelTokenProtected) throw new Error('Cloudflare Tunnel 토큰을 먼저 저장하세요.');
          try {
            tunnelToken = normalizeTunnelToken(unprotectSecret(stored.tunnelTokenProtected));
            localCredentials = localTunnelCredentialsFromToken(tunnelToken);
            mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
            cloudflaredConfigPath = join(runtimeDirectory, `cloudflared-${randomUUID()}.yml`);
            writeFileSync(
              cloudflaredConfigPath,
              localTunnelIngressConfig(localCredentials.tunnelId, config.hostname, config.localUrl),
              { encoding: 'utf8', mode: 0o600, flag: 'wx' },
            );
          } catch (error) {
            if (cloudflaredConfigPath) {
              try { unlinkSync(cloudflaredConfigPath); } catch { /* no file was committed */ }
            }
            throw new Error(`저장된 Tunnel 토큰을 읽을 수 없습니다. 이 Windows 계정에서 토큰을 다시 저장하세요. (${error instanceof Error ? error.message : String(error)})`);
          }
        }

        return new Promise<RemoteLinkStatus>((resolve, reject) => {
          let settled = false;
          let childDiagnostics = '';
          let timer: NodeJS.Timeout | undefined;
          let child: ChildProcess;
          try {
            const args = config.provider === 'cloudflare-named'
              ? ['tunnel', '--config', cloudflaredConfigPath!, '--no-autoupdate', 'run', localCredentials!.tunnelId]
              : ['tunnel', '--no-autoupdate', '--url', config.localUrl];
            const childEnv = config.provider === 'cloudflare-named'
              ? cloudflaredEnvironment(localCredentials!.contents)
              : cloudflaredEnvironment();
            child = spawnProcess(executable, args, {
              shell: false,
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: childEnv,
            });
            if (config.provider === 'cloudflare-named') delete childEnv.TUNNEL_CRED_CONTENTS;
            tunnelToken = '';
            if (localCredentials) localCredentials.contents = '';
          } catch (error) {
            if (cloudflaredConfigPath) {
              try { unlinkSync(cloudflaredConfigPath); } catch { /* file may not have been created */ }
            }
            const message = error instanceof Error ? error.message : String(error);
            if (operation === operationGeneration) {
              lastError = message;
              emitStatus();
            }
            reject(new Error(message));
            return;
          }
          processHandle = child;
          activeConfig = config;
          activeCloudflaredConfigPath = cloudflaredConfigPath ?? null;
          activeTransientQuick = transientQuick;
          liveChildren.add(child);
          child.once('close', () => liveChildren.delete(child));
          const ownsCurrentProcess = (): boolean => operation === operationGeneration && processHandle === child;
          const clearStartTimer = (): void => {
            if (timer) ctx.clearTimeout(timer);
            timer = undefined;
          };
          const clearPending = (): void => {
            if (pendingStart?.generation === operation && pendingStart.child === child) pendingStart = null;
          };
          const cleanupChildConfig = (): void => {
            if (!cloudflaredConfigPath) return;
            try { unlinkSync(cloudflaredConfigPath); } catch { /* already removed by stop */ }
            if (activeCloudflaredConfigPath === cloudflaredConfigPath) activeCloudflaredConfigPath = null;
          };

          const cancel = (reason: Error): void => {
            if (settled) return;
            settled = true;
            clearStartTimer();
            clearPending();
            cleanupChildConfig();
            reject(reason);
          };
          pendingStart = { generation: operation, child, cancel };

          const fail = (message: string): void => {
            if (settled) return;
            settled = true;
            clearStartTimer();
            clearPending();
            const safeMessage = redactRemoteLinkDiagnostics(message);
            const detail = config.provider === 'cloudflare-quick' && /config\.ya?ml/i.test(safeMessage)
              ? `${safeMessage}\nCloudflare Quick Tunnel은 사용자 .cloudflared/config.yml이 있으면 시작되지 않을 수 있습니다.`
              : safeMessage;
            if (ownsCurrentProcess()) {
              diagnostics = redactRemoteLinkDiagnostics(childDiagnostics);
              lastError = detail;
              processHandle = null;
              activeConfig = null;
              activeTransientQuick = false;
              publicUrl = undefined;
              startedAt = undefined;
              emitStatus();
            }
            void terminateChild(ctx, child);
            cleanupChildConfig();
            reject(new Error(detail));
          };

          const onData = (chunk: Buffer): void => {
            childDiagnostics = boundedAppend(childDiagnostics, chunk);
            if (!ownsCurrentProcess() || settled) return;
            diagnostics = redactRemoteLinkDiagnostics(childDiagnostics);
            const found = config.provider === 'cloudflare-named'
              ? (namedTunnelReady(childDiagnostics) ? `https://${config.hostname}` : undefined)
              : parseQuickTunnelUrl(childDiagnostics);
            if (!found) return;
            settled = true;
            clearStartTimer();
            clearPending();
            publicUrl = found;
            startedAt = Date.now();
            emitStatus();
            resolve(status());
          };
          child.stdout?.on('data', onData);
          child.stderr?.on('data', onData);
          child.once('error', (error) => fail(error.message));
          child.once('close', (code, signal) => {
            cleanupChildConfig();
            if (!ownsCurrentProcess()) return;
            diagnostics = redactRemoteLinkDiagnostics(childDiagnostics);
            if (!settled) {
              fail(childDiagnostics || `cloudflared가 링크를 만들기 전에 종료되었습니다. (code=${String(code)}, signal=${String(signal)})`);
              return;
            }
            processHandle = null;
            activeConfig = null;
            activeCloudflaredConfigPath = null;
            activeTransientQuick = false;
            publicUrl = undefined;
            startedAt = undefined;
            reachable = undefined;
            accessProtected = undefined;
            verifiedAt = undefined;
            if (code && code !== 0) lastError = `cloudflared가 종료되었습니다. (code=${code})`;
            emitStatus();
          });
          timer = ctx.setTimeout(() => fail(config.provider === 'cloudflare-named'
            ? 'Cloudflare 고정 Tunnel 연결 시간이 초과되었습니다. 토큰과 Connector 상태를 확인하세요.'
            : 'Cloudflare 임시 링크 생성 시간이 초과되었습니다.'), START_TIMEOUT_MS);
        });
      };

      const verify = async (): Promise<{ ok: boolean; url: string; checkedAt: number; message: string }> => {
        const current = status();
        if (!current.running || !current.publicUrl) throw new Error('먼저 원격 링크를 시작하세요.');
        const checkedAt = Date.now();
        try {
          const access = current.provider === 'cloudflare-named' ? accessCredentials(ctx) : undefined;
          if (current.provider === 'cloudflare-named') {
            if (!access) throw new Error('Cloudflare Access Service Token을 먼저 저장하세요.');
            // A successful authenticated probe proves reachability, but does
            // not prove that Access is enforced. First require the exact
            // Agent response to be unavailable without edge credentials.
            const anonymousResponse = await fetchUrl(new URL('/api/ping', current.publicUrl), {
              redirect: 'manual',
              signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
              headers: { accept: 'application/json' },
            });
            let anonymousReachedAgent = false;
            if (anonymousResponse.ok) {
              try {
                const anonymousBody = await readSmallJson(anonymousResponse);
                anonymousReachedAgent = anonymousBody.ok === true && anonymousBody.app === 'mr-robot';
              } catch {
                // An Access login/challenge body is not the protected Agent.
              }
            } else {
              try { await anonymousResponse.body?.cancel(); } catch { /* best-effort cleanup */ }
            }
            if (anonymousReachedAgent) {
              accessProtected = false;
              throw new Error('외부 주소가 Cloudflare Access 없이 공개되어 있습니다. Access 앱과 정책을 먼저 적용하세요.');
            }

            // Hostname-level Access should cover every path, but a mistaken
            // path-scoped/nested application can protect /api/ping while
            // leaving enrollment or WebSocket admission reachable. Probe one
            // sensitive authenticated route without the inner Mr.Robot token:
            // the exact Agent response is a small 401 JSON body. It must be
            // invisible anonymously and visible with the Service Token.
            const ticketUrl = new URL('/api/ws-ticket', current.publicUrl);
            const anonymousTicket = await fetchUrl(ticketUrl, {
              method: 'POST',
              redirect: 'manual',
              signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
              headers: { accept: 'application/json' },
            });
            let anonymousReachedTicket = false;
            if (anonymousTicket.status === 401) {
              try {
                const anonymousTicketBody = await readSmallJson(anonymousTicket);
                anonymousReachedTicket = anonymousTicketBody.error === 'unauthorized';
              } catch {
                // Access's own 401/challenge is not the exact Agent response.
              }
            } else {
              try { await anonymousTicket.body?.cancel(); } catch { /* best-effort cleanup */ }
            }
            if (anonymousReachedTicket) {
              accessProtected = false;
              throw new Error('Cloudflare Access가 /api/ws-ticket 경로를 보호하지 않습니다. 호스트 전체를 보호하는 앱으로 수정하세요.');
            }

            const authenticatedTicket = await fetchUrl(ticketUrl, {
              method: 'POST',
              redirect: 'error',
              signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
              headers: {
                accept: 'application/json',
                'CF-Access-Client-Id': access.clientId,
                'CF-Access-Client-Secret': access.clientSecret,
              },
            });
            const authenticatedTicketBody = await readSmallJson(authenticatedTicket);
            if (authenticatedTicket.status !== 401 || authenticatedTicketBody.error !== 'unauthorized') {
              throw new Error(`Access 인증 후 WebSocket 티켓 경로가 정확한 Mr.Robot Agent를 반환하지 않았습니다. (HTTP ${authenticatedTicket.status})`);
            }

            // Enrollment is intentionally public behind the edge, so verify
            // it independently from ping and WebSocket admission. The fixed
            // invalid body is rejected by the Agent before rate limiting or
            // PIN exchange and therefore cannot register or mutate a device.
            const pairUrl = new URL('/api/pair', current.publicUrl);
            const pairProbeBody = JSON.stringify({ probe: CLOUDFLARE_ACCESS_PAIR_PROBE });
            const anonymousPair = await fetchUrl(pairUrl, {
              method: 'POST',
              body: pairProbeBody,
              redirect: 'manual',
              signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
              headers: { accept: 'application/json', 'content-type': 'application/json' },
            });
            let anonymousReachedPair = false;
            if (anonymousPair.status === 400) {
              try {
                const anonymousPairBody = await readSmallJson(anonymousPair);
                anonymousReachedPair = anonymousPairBody.app === 'mr-robot'
                  && anonymousPairBody.error === CLOUDFLARE_ACCESS_PAIR_PROBE_ERROR;
              } catch {
                // Access's own error response is not the exact Agent marker.
              }
            } else {
              try { await anonymousPair.body?.cancel(); } catch { /* best-effort cleanup */ }
            }
            if (anonymousReachedPair) {
              accessProtected = false;
              throw new Error('Cloudflare Access가 /api/pair 경로를 보호하지 않습니다. 호스트 전체를 보호하는 앱으로 수정하세요.');
            }

            const authenticatedPair = await fetchUrl(pairUrl, {
              method: 'POST',
              body: pairProbeBody,
              redirect: 'error',
              signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
              headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                'CF-Access-Client-Id': access.clientId,
                'CF-Access-Client-Secret': access.clientSecret,
              },
            });
            const authenticatedPairBody = await readSmallJson(authenticatedPair);
            if (authenticatedPair.status !== 400
              || authenticatedPairBody.app !== 'mr-robot'
              || authenticatedPairBody.error !== CLOUDFLARE_ACCESS_PAIR_PROBE_ERROR) {
              throw new Error(`Access 인증 후 페어링 경로가 정확한 Mr.Robot Agent를 반환하지 않았습니다. (HTTP ${authenticatedPair.status})`);
            }
          }
          const response = await fetchUrl(new URL('/api/ping', current.publicUrl), {
            redirect: 'error',
            signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
            headers: {
              accept: 'application/json',
              ...(access ? {
                'CF-Access-Client-Id': access.clientId,
                'CF-Access-Client-Secret': access.clientSecret,
              } : {}),
            },
          });
          const body = await readSmallJson(response);
          if (!response.ok || body.ok !== true || body.app !== 'mr-robot') {
            throw new Error(`공개 주소가 Mr.Robot Agent를 반환하지 않았습니다. (HTTP ${response.status})`);
          }
          reachable = true;
          accessProtected = current.provider === 'cloudflare-named' ? true : undefined;
          verifiedAt = checkedAt;
          lastError = undefined;
          emitStatus();
          return {
            ok: true,
            url: current.publicUrl,
            checkedAt,
            message: current.provider === 'cloudflare-named'
              ? 'Cloudflare Access의 익명 차단과 Service Token 인증을 모두 확인했습니다.'
              : '외부 HTTPS 주소에서 Mr.Robot Agent 응답을 확인했습니다.',
          };
        } catch (error) {
          reachable = false;
          if (current.provider === 'cloudflare-named') accessProtected = false;
          verifiedAt = checkedAt;
          lastError = `외부 주소 확인 실패: ${error instanceof Error ? error.message : String(error)}`;
          emitStatus();
          throw new Error(lastError);
        }
      };

      const verifyFailClosed = async (): ReturnType<typeof verify> => {
        try {
          return await verify();
        } catch (error) {
          const current = status();
          if (current.running && current.provider === 'cloudflare-named') {
            await stop();
            // stop() resets volatile verification state but deliberately keeps
            // the reason visible for the administrator.
            lastError = error instanceof Error ? error.message : String(error);
            emitStatus();
          }
          throw error;
        }
      };

      const startConfigured = async (): Promise<RemoteLinkStatus> => {
        const started = await start();
        if (started.provider === 'cloudflare-named') await verifyFailClosed();
        return status();
      };

      ctx.registerCommand('remote-link.status', () => status(), { destructive: false, adminOnly: true });
      ctx.registerCommand('remote-link.config.get', () => storedConfig(ctx), { destructive: false, adminOnly: true });
      ctx.registerCommand('remote-link.config.set', (raw) => {
        const body = (raw ?? {}) as Partial<RemoteLinkConfig>;
        const provider = body.provider === 'cloudflare-named'
          ? 'cloudflare-named'
          : body.provider === 'google-relay'
            ? 'google-relay'
            : 'cloudflare-quick';
        if (provider === 'google-relay') {
          throw new Error('Google 계정 Relay는 외부 Firebase/OAuth/relay 구성이 완료된 뒤 사용할 수 있습니다.');
        }
        if (processHandle && processHandle.exitCode === null) throw new Error('실행 중인 링크를 중지한 뒤 설정을 바꾸세요.');
        const previous = ctx.storage.get<StoredRemoteLinkConfig>('config');
        let tunnelTokenProtected = body.clearTunnelToken === true ? undefined : previous?.tunnelTokenProtected;
        if (typeof body.tunnelToken === 'string' && body.tunnelToken.trim()) {
          tunnelTokenProtected = protectSecret(normalizeTunnelToken(body.tunnelToken));
        }
        let accessCredentialsProtected = body.clearAccessCredentials === true
          ? undefined
          : previous?.accessCredentialsProtected;
        const accessIdSupplied = typeof body.accessClientId === 'string' && Boolean(body.accessClientId.trim());
        const accessSecretSupplied = typeof body.accessClientSecret === 'string' && Boolean(body.accessClientSecret.trim());
        if (accessIdSupplied !== accessSecretSupplied) {
          throw new Error('Cloudflare Access Client ID와 Secret을 함께 입력하세요.');
        }
        if (accessIdSupplied && accessSecretSupplied) {
          const access = normalizeAccessCredentials(body.accessClientId, body.accessClientSecret);
          accessCredentialsProtected = protectSecret(JSON.stringify(access));
        }
        const hostname = provider === 'cloudflare-named' ? normalizeNamedTunnelHostname(body.hostname) : undefined;
        const peerHostnames = hostname ? normalizePeerHostnames(body.peerHostnames, hostname) : [];
        const stored: StoredRemoteLinkConfig = {
          provider,
          localUrl: normalizeRemoteLinkLocalUrl(body.localUrl ?? DEFAULT_CONFIG.localUrl),
          ...(hostname ? { hostname } : {}),
          ...(peerHostnames.length ? { peerHostnames } : {}),
          ...(tunnelTokenProtected ? { tunnelTokenProtected } : {}),
          ...(accessCredentialsProtected ? { accessCredentialsProtected } : {}),
          autoStart: provider === 'cloudflare-named' && body.autoStart === true,
        };
        ctx.storage.set('config', stored);
        // Drop any plaintext credential reference immediately on replace or
        // clear. The next exact-host request may repopulate it from DPAPI.
        accessCredentialCache = undefined;
        emitStatus();
        return storedConfig(ctx);
      }, { destructive: true, adminOnly: true });
      ctx.registerCommand('remote-link.pairing.payload', async (raw) => {
        const body = (raw ?? {}) as { host?: unknown; pin?: unknown; expiresAt?: unknown };
        const current = status();
        const config = current.config;
        if (!current.running || current.provider !== 'cloudflare-named' || !current.publicUrl || !config.hostname) {
          throw new Error('실행 중인 Cloudflare 고정 Tunnel에서만 Access 보호 QR을 만들 수 있습니다.');
        }
        const requestedHost = normalizeNamedTunnelHostname(body.host);
        if (requestedHost !== config.hostname || current.publicUrl !== `https://${requestedHost}`) {
          throw new Error('실행 중인 Tunnel 호스트와 저장된 호스트가 일치하지 않습니다.');
        }
        const pin = String(body.pin ?? '').trim();
        if (!/^\d{12}$/.test(pin)) throw new Error('외출용 12자리 일회용 코드가 필요합니다.');
        const expiresAt = Number(body.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 25 * 60 * 60_000) {
          throw new Error('외출 코드 만료 시간이 올바르지 않습니다.');
        }
        await verifyFailClosed();
        if (status().accessProtected !== true) throw new Error('Cloudflare Access 보호 검증이 끝나지 않았습니다.');
        if (!accessCredentials(ctx)) throw new Error('Cloudflare Access Service Token을 먼저 저장하세요.');
        return JSON.stringify({
          app: 'mr-robot',
          version: 3,
          host: `https://${requestedHost}`,
          hosts: [`https://${requestedHost}`],
          protocol: 'https',
          port: 443,
          pin,
          expiresAt,
          // The long-lived Cloudflare machine credential never crosses into
          // the renderer or QR. Native clients enter it directly and keep it
          // in their OS credential vault, while this QR remains one-use.
          requiresCloudflareAccess: true,
        });
      }, { destructive: false, adminOnly: true });
      ctx.registerCommand('remote-link.start', () => startConfigured(), { destructive: true, adminOnly: true });
      ctx.registerCommand('remote-link.stop', () => stop(activeTransientQuick), { destructive: true, adminOnly: true });
      ctx.registerCommand('remote-link.quick.start', (raw) => {
        const current = status();
        // Never interrupt or downgrade an already healthy named tunnel. Its
        // stable hostname and zone security controls are strictly stronger.
        if (current.running && current.provider === 'cloudflare-named') return current;
        if (current.running) return current;
        const body = (raw ?? {}) as { localUrl?: unknown };
        const quickConfig: RemoteLinkConfig = {
          provider: 'cloudflare-quick',
          localUrl: normalizeRemoteLinkLocalUrl(body.localUrl ?? storedConfig(ctx).localUrl),
          autoStart: false,
        };
        return start(quickConfig, true);
      }, { destructive: true, adminOnly: true });
      ctx.registerCommand('remote-link.quick.stop', () => {
        if (!activeTransientQuick) return status();
        return stop(true);
      }, { destructive: true, adminOnly: true });
      ctx.registerCommand('remote-link.verify', () => verifyFailClosed(), { destructive: false, adminOnly: true });

      ctx.on('plugins.changed', (raw) => {
        const list = Array.isArray(raw) ? raw as Array<{ id?: string; enabled?: boolean }> : [];
        const self = list.find((item) => item.id === PLUGIN_ID);
        if (self?.enabled === false) {
          void stop();
        } else if (self?.enabled === true && storedConfig(ctx).autoStart && !processHandle && !pendingStart) {
          void startConfigured().catch((error) => {
            lastError = `자동 연결 실패: ${error instanceof Error ? error.message : String(error)}`;
            emitStatus();
          });
        }
      });
      activeContext = ctx;
    },
    async deactivate(ctx) {
      if (activeContext === ctx) activeContext = undefined;
      accessCredentialCache = undefined;
      executableTrustCache = undefined;
      ++operationGeneration;
      const active = processHandle;
      const pending = pendingStart;
      pendingStart = null;
      processHandle = null;
      activeConfig = null;
      activeTransientQuick = false;
      publicUrl = undefined;
      startedAt = undefined;
      pending?.cancel(new Error('원격 링크 플러그인이 비활성화되어 시작이 취소되었습니다.'));
      const retiring = [...new Set([...(active ? [active] : []), ...liveChildren])];
      await Promise.all(retiring.map((child) => terminateChild(ctx, child)));
      liveChildren.clear();
    },
  };
}
