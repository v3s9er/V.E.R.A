import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { delimiter, join } from 'node:path';
import type { RemoteLinkConfig, RemoteLinkStatus, RemoteTransportProviderInfo } from '@mr-robot/shared';
import { SecretVault } from '../secrets.js';
import type { PluginContext } from './context.js';
import type { MrRobotPlugin } from './loader.js';

const PLUGIN_ID = 'remote-link';
const QUICK_TUNNEL_HOST = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;
const NAMED_TUNNEL_READY = /(?:registered tunnel connection|tunnel connection registered|connection[^\r\n]{0,160}registered)/i;
const MAX_DIAGNOSTIC_CHARS = 12_000;
const START_TIMEOUT_MS = 35_000;
const VERIFY_TIMEOUT_MS = 12_000;

const DEFAULT_CONFIG: RemoteLinkConfig = {
  provider: 'cloudflare-quick',
  localUrl: 'http://127.0.0.1:8787',
  autoStart: false,
};

interface StoredRemoteLinkConfig {
  provider?: RemoteLinkConfig['provider'];
  localUrl?: string;
  hostname?: string;
  autoStart?: boolean;
  tunnelTokenProtected?: string;
}

function boundedAppend(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length > MAX_DIAGNOSTIC_CHARS ? next.slice(-MAX_DIAGNOSTIC_CHARS) : next;
}

/** Never expose connector credentials through status diagnostics or UI errors. */
export function redactRemoteLinkDiagnostics(value: string): string {
  return value
    .replace(/\beyJ[A-Za-z0-9_-]{40,}(?:\.[A-Za-z0-9_-]{10,}){0,2}\b/g, '[REDACTED_TUNNEL_TOKEN]')
    .replace(/\b(?:token|tunnel_token|TUNNEL_TOKEN)\s*[=:]\s*[^\s,;]+/gi, 'token=[REDACTED]');
}

async function readSmallJson(response: Response): Promise<{ ok?: unknown; app?: unknown }> {
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
    return JSON.parse(new TextDecoder().decode(body)) as { ok?: unknown; app?: unknown };
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
  return [
    ...fromPath,
    join(localAppData, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
    join(programFiles, 'cloudflared', 'cloudflared.exe'),
    join(programFilesX86, 'cloudflared', 'cloudflared.exe'),
  ];
}

export function findCloudflaredExecutable(): string | undefined {
  return candidateExecutables().find((candidate) => candidate && existsSync(candidate));
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

export interface RemoteLinkRuntime {
  findExecutable?: () => string | undefined;
  spawnProcess?: typeof spawn;
  protectSecret?: (value: string) => string;
  unprotectSecret?: (value: string) => string;
  fetchUrl?: typeof fetch;
}

function providerInventory(cloudflaredPath?: string): RemoteTransportProviderInfo[] {
  return [
    {
      id: 'cloudflare-quick',
      name: 'Cloudflare Quick Tunnel',
      available: Boolean(cloudflaredPath),
      temporary: true,
      requiresAccount: false,
      reason: cloudflaredPath ? undefined : 'cloudflared 설치가 필요합니다.',
    },
    {
      id: 'cloudflare-named',
      name: 'Cloudflare 고정 Tunnel',
      available: Boolean(cloudflaredPath),
      temporary: false,
      requiresAccount: true,
      reason: cloudflaredPath ? 'Cloudflare 계정, 도메인, Tunnel 토큰이 필요합니다.' : 'cloudflared 설치가 필요합니다.',
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
  return {
    provider,
    localUrl,
    ...(hostname ? { hostname } : {}),
    hasTunnelToken: Boolean(stored?.tunnelTokenProtected),
    autoStart: provider === 'cloudflare-named' && stored?.autoStart === true,
  };
}

export function createRemoteLinkPlugin(runtime: RemoteLinkRuntime = {}): MrRobotPlugin {
  const detectExecutable = runtime.findExecutable ?? findCloudflaredExecutable;
  const spawnProcess = runtime.spawnProcess ?? spawn;
  const vault = new SecretVault();
  const protectSecret = runtime.protectSecret ?? ((value: string) => vault.protect(value));
  const unprotectSecret = runtime.unprotectSecret ?? ((value: string) => vault.unprotect(value));
  const fetchUrl = runtime.fetchUrl ?? fetch;
  let processHandle: ChildProcess | null = null;
  const liveChildren = new Set<ChildProcess>();
  let operationGeneration = 0;
  let pendingStart: { generation: number; child: ChildProcess; cancel: (reason: Error) => void } | null = null;
  let publicUrl: string | undefined;
  let startedAt: number | undefined;
  let lastError: string | undefined;
  let diagnostics = '';
  let reachable: boolean | undefined;
  let verifiedAt: number | undefined;

  return {
    manifest: {
      id: PLUGIN_ID,
      name: 'Cloudflare Remote Link',
      version: '0.3.4',
      kind: 'transport',
      enabledByDefault: false,
      description: 'VPN 없이 임시 Quick Link 또는 사용자 도메인의 고정 HTTPS/WSS Tunnel을 연결합니다.',
      capabilities: ['transport.remote-link', 'transport.cloudflare-quick', 'transport.cloudflare-named', 'transport.provider-contract'],
      permissions: ['network.client', 'process.execute'],
      dependencies: [{ id: 'cloudflared', name: 'Cloudflare cloudflared', required: true }],
    },
    activate(ctx) {
      const status = (): RemoteLinkStatus => {
        const executable = detectExecutable();
        const running = Boolean(processHandle && processHandle.exitCode === null && !processHandle.killed);
        const config = storedConfig(ctx);
        const temporary = config.provider !== 'cloudflare-named';
        return {
          provider: config.provider,
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
          verifiedAt: running ? verifiedAt : undefined,
          warning: temporary
            ? 'Quick Tunnel은 테스트·개발용 임시 주소입니다. 재시작하면 주소가 바뀝니다.'
            : '고정 Tunnel은 주소가 유지되지만 PC, Mr.Robot, cloudflared가 실행 중이어야 접속할 수 있습니다.',
          lastError,
          diagnostics: diagnostics || undefined,
          providers: providerInventory(executable),
        };
      };

      const emitStatus = (): void => ctx.emit(`${PLUGIN_ID}.changed`, status());

      const stop = async (): Promise<RemoteLinkStatus> => {
        const operation = ++operationGeneration;
        const active = processHandle;
        const pending = pendingStart;
        pendingStart = null;
        processHandle = null;
        publicUrl = undefined;
        startedAt = undefined;
        reachable = undefined;
        verifiedAt = undefined;
        pending?.cancel(new Error('Cloudflare 원격 링크 시작이 취소되었습니다.'));
        if (active) {
          await terminateChild(ctx, active);
          liveChildren.delete(active);
        }
        // A newer start may have taken ownership while this old process was
        // shutting down. Its state must never be overwritten by stop(A).
        if (operation === operationGeneration) emitStatus();
        return status();
      };

      const start = async (): Promise<RemoteLinkStatus> => {
        if (processHandle && processHandle.exitCode === null && !processHandle.killed) return status();
        const config = storedConfig(ctx);
        if (config.provider === 'google-relay') {
          throw new Error('Google 계정 Relay는 Firebase/OAuth/relay 서버가 구성되기 전에는 활성화할 수 없습니다.');
        }
        const executable = detectExecutable();
        if (!executable) throw new Error('cloudflared가 없습니다. 플러그인 화면에서 의존성을 먼저 설치하세요.');

        const operation = ++operationGeneration;
        diagnostics = '';
        lastError = undefined;
        publicUrl = undefined;
        startedAt = undefined;
        reachable = undefined;
        verifiedAt = undefined;

        const stored = ctx.storage.get<StoredRemoteLinkConfig>('config');
        let tunnelToken = '';
        if (config.provider === 'cloudflare-named') {
          if (!config.hostname) throw new Error('Cloudflare 고정 호스트명을 먼저 저장하세요.');
          if (!stored?.tunnelTokenProtected) throw new Error('Cloudflare Tunnel 토큰을 먼저 저장하세요.');
          try {
            tunnelToken = normalizeTunnelToken(unprotectSecret(stored.tunnelTokenProtected));
          } catch (error) {
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
              ? ['tunnel', '--no-autoupdate', 'run']
              : ['tunnel', '--no-autoupdate', '--url', config.localUrl];
            const childEnv = config.provider === 'cloudflare-named'
              ? { ...process.env, TUNNEL_TOKEN: tunnelToken }
              : process.env;
            child = spawnProcess(executable, args, {
              shell: false,
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: childEnv,
            });
            if (config.provider === 'cloudflare-named') delete childEnv.TUNNEL_TOKEN;
            tunnelToken = '';
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (operation === operationGeneration) {
              lastError = message;
              emitStatus();
            }
            reject(new Error(message));
            return;
          }
          processHandle = child;
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

          const cancel = (reason: Error): void => {
            if (settled) return;
            settled = true;
            clearStartTimer();
            clearPending();
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
              publicUrl = undefined;
              startedAt = undefined;
              emitStatus();
            }
            void terminateChild(ctx, child);
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
            if (!ownsCurrentProcess()) return;
            diagnostics = redactRemoteLinkDiagnostics(childDiagnostics);
            if (!settled) {
              fail(childDiagnostics || `cloudflared가 링크를 만들기 전에 종료되었습니다. (code=${String(code)}, signal=${String(signal)})`);
              return;
            }
            processHandle = null;
            publicUrl = undefined;
            startedAt = undefined;
            reachable = undefined;
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
          const response = await fetchUrl(new URL('/api/ping', current.publicUrl), {
            redirect: 'error',
            signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
            headers: { accept: 'application/json' },
          });
          const body = await readSmallJson(response);
          if (!response.ok || body.ok !== true || body.app !== 'mr-robot') {
            throw new Error(`공개 주소가 Mr.Robot Agent를 반환하지 않았습니다. (HTTP ${response.status})`);
          }
          reachable = true;
          verifiedAt = checkedAt;
          lastError = undefined;
          emitStatus();
          return { ok: true, url: current.publicUrl, checkedAt, message: '외부 HTTPS 주소에서 Mr.Robot Agent 응답을 확인했습니다.' };
        } catch (error) {
          reachable = false;
          verifiedAt = checkedAt;
          lastError = `외부 주소 확인 실패: ${error instanceof Error ? error.message : String(error)}`;
          emitStatus();
          throw new Error(lastError);
        }
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
        const stored: StoredRemoteLinkConfig = {
          provider,
          localUrl: normalizeRemoteLinkLocalUrl(body.localUrl ?? DEFAULT_CONFIG.localUrl),
          ...(provider === 'cloudflare-named' ? { hostname: normalizeNamedTunnelHostname(body.hostname) } : {}),
          ...(tunnelTokenProtected ? { tunnelTokenProtected } : {}),
          autoStart: provider === 'cloudflare-named' && body.autoStart === true,
        };
        ctx.storage.set('config', stored);
        emitStatus();
        return storedConfig(ctx);
      }, { destructive: true, adminOnly: true });
      ctx.registerCommand('remote-link.start', () => start(), { destructive: true, adminOnly: true });
      ctx.registerCommand('remote-link.stop', () => stop(), { destructive: true, adminOnly: true });
      ctx.registerCommand('remote-link.verify', () => verify(), { destructive: false, adminOnly: true });

      ctx.on('plugins.changed', (raw) => {
        const list = Array.isArray(raw) ? raw as Array<{ id?: string; enabled?: boolean }> : [];
        const self = list.find((item) => item.id === PLUGIN_ID);
        if (self?.enabled === false) {
          void stop();
        } else if (self?.enabled === true && storedConfig(ctx).autoStart && !processHandle && !pendingStart) {
          void start().then(() => verify().catch(() => undefined)).catch((error) => {
            lastError = `자동 연결 실패: ${error instanceof Error ? error.message : String(error)}`;
            emitStatus();
          });
        }
      });
    },
    async deactivate(ctx) {
      ++operationGeneration;
      const active = processHandle;
      const pending = pendingStart;
      pendingStart = null;
      processHandle = null;
      publicUrl = undefined;
      startedAt = undefined;
      pending?.cancel(new Error('원격 링크 플러그인이 비활성화되어 시작이 취소되었습니다.'));
      const retiring = [...new Set([...(active ? [active] : []), ...liveChildren])];
      await Promise.all(retiring.map((child) => terminateChild(ctx, child)));
      liveChildren.clear();
    },
  };
}
