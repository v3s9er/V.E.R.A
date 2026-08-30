import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { RemoteLinkConfig, RemoteLinkStatus, RemoteTransportProviderInfo } from '@mr-robot/shared';
import type { PluginContext } from './context.js';
import type { MrRobotPlugin } from './loader.js';

const PLUGIN_ID = 'remote-link';
const QUICK_TUNNEL_HOST = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;
const MAX_DIAGNOSTIC_CHARS = 12_000;
const START_TIMEOUT_MS = 35_000;

const DEFAULT_CONFIG: RemoteLinkConfig = {
  provider: 'cloudflare-quick',
  localUrl: 'http://127.0.0.1:8787',
  autoStart: false,
};

function boundedAppend(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length > MAX_DIAGNOSTIC_CHARS ? next.slice(-MAX_DIAGNOSTIC_CHARS) : next;
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

export interface RemoteLinkRuntime {
  findExecutable?: () => string | undefined;
  spawnProcess?: typeof spawn;
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
  const stored = ctx.storage.get<Partial<RemoteLinkConfig>>('config');
  const provider = stored?.provider === 'google-relay' ? 'google-relay' : 'cloudflare-quick';
  let localUrl = DEFAULT_CONFIG.localUrl;
  try {
    localUrl = normalizeRemoteLinkLocalUrl(stored?.localUrl ?? DEFAULT_CONFIG.localUrl);
  } catch {
    // Invalid values from an older version are deliberately ignored.
  }
  return { provider, localUrl, autoStart: false };
}

export function createRemoteLinkPlugin(runtime: RemoteLinkRuntime = {}): MrRobotPlugin {
  const detectExecutable = runtime.findExecutable ?? findCloudflaredExecutable;
  const spawnProcess = runtime.spawnProcess ?? spawn;
  let processHandle: ChildProcess | null = null;
  const liveChildren = new Set<ChildProcess>();
  let operationGeneration = 0;
  let pendingStart: { generation: number; child: ChildProcess; cancel: (reason: Error) => void } | null = null;
  let publicUrl: string | undefined;
  let startedAt: number | undefined;
  let lastError: string | undefined;
  let diagnostics = '';

  return {
    manifest: {
      id: PLUGIN_ID,
      name: 'Cloudflare Quick Link',
      version: '0.1.0',
      kind: 'transport',
      enabledByDefault: false,
      description: 'VPN 없이 임시 HTTPS/WSS 주소를 만들 때만 켜는 선택형 원격 연결입니다.',
      capabilities: ['transport.remote-link', 'transport.cloudflare-quick', 'transport.provider-contract'],
      permissions: ['network.client', 'process.execute'],
      dependencies: [{ id: 'cloudflared', name: 'Cloudflare cloudflared', required: true }],
    },
    activate(ctx) {
      const status = (): RemoteLinkStatus => {
        const executable = detectExecutable();
        const running = Boolean(processHandle && processHandle.exitCode === null && !processHandle.killed);
        const config = storedConfig(ctx);
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
          temporary: true,
          beta: true,
          warning: 'Quick Tunnel은 Cloudflare가 테스트·개발용으로 제공하는 임시 주소입니다. 재시작하면 주소가 바뀌며 상시 서비스나 무인 운영용이 아닙니다.',
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
        pending?.cancel(new Error('Cloudflare 임시 링크 시작이 취소되었습니다.'));
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
        if (config.provider !== 'cloudflare-quick') {
          throw new Error('Google 계정 Relay는 Firebase/OAuth/relay 서버가 구성되기 전에는 활성화할 수 없습니다.');
        }
        const executable = detectExecutable();
        if (!executable) throw new Error('cloudflared가 없습니다. 플러그인 화면에서 의존성을 먼저 설치하세요.');

        const operation = ++operationGeneration;
        diagnostics = '';
        lastError = undefined;
        publicUrl = undefined;
        startedAt = undefined;

        return new Promise<RemoteLinkStatus>((resolve, reject) => {
          let settled = false;
          let childDiagnostics = '';
          let timer: NodeJS.Timeout | undefined;
          let child: ChildProcess;
          try {
            child = spawnProcess(executable, ['tunnel', '--no-autoupdate', '--url', config.localUrl], {
              shell: false,
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: process.env,
            });
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
            const detail = /config\.ya?ml/i.test(message)
              ? `${message}\nCloudflare Quick Tunnel은 사용자 .cloudflared/config.yml이 있으면 시작되지 않을 수 있습니다.`
              : message;
            if (ownsCurrentProcess()) {
              diagnostics = childDiagnostics;
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
            diagnostics = childDiagnostics;
            const found = parseQuickTunnelUrl(childDiagnostics);
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
            diagnostics = childDiagnostics;
            if (!settled) {
              fail(childDiagnostics || `cloudflared가 링크를 만들기 전에 종료되었습니다. (code=${String(code)}, signal=${String(signal)})`);
              return;
            }
            processHandle = null;
            publicUrl = undefined;
            startedAt = undefined;
            if (code && code !== 0) lastError = `cloudflared가 종료되었습니다. (code=${code})`;
            emitStatus();
          });
          timer = ctx.setTimeout(() => fail('Cloudflare 임시 링크 생성 시간이 초과되었습니다.'), START_TIMEOUT_MS);
        });
      };

      ctx.registerCommand('remote-link.status', () => status(), { destructive: false, adminOnly: true });
      ctx.registerCommand('remote-link.config.get', () => storedConfig(ctx), { destructive: false, adminOnly: true });
      ctx.registerCommand('remote-link.config.set', (raw) => {
        const body = (raw ?? {}) as Partial<RemoteLinkConfig>;
        const provider = body.provider === 'google-relay' ? 'google-relay' : 'cloudflare-quick';
        if (provider === 'google-relay') {
          throw new Error('Google 계정 Relay는 외부 Firebase/OAuth/relay 구성이 완료된 뒤 사용할 수 있습니다.');
        }
        if (processHandle && processHandle.exitCode === null) throw new Error('실행 중인 링크를 중지한 뒤 설정을 바꾸세요.');
        const config: RemoteLinkConfig = {
          provider,
          localUrl: normalizeRemoteLinkLocalUrl(body.localUrl ?? DEFAULT_CONFIG.localUrl),
          autoStart: false,
        };
        ctx.storage.set('config', config);
        emitStatus();
        return config;
      }, { destructive: true, adminOnly: true });
      ctx.registerCommand('remote-link.start', () => start(), { destructive: true, adminOnly: true });
      ctx.registerCommand('remote-link.stop', () => stop(), { destructive: true, adminOnly: true });

      ctx.on('plugins.changed', (raw) => {
        const list = Array.isArray(raw) ? raw as Array<{ id?: string; enabled?: boolean }> : [];
        if (list.some((item) => item.id === PLUGIN_ID && item.enabled === false)) void stop();
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
