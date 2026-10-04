import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { terminateProcessTree } from '../computer/shell.js';
import type { PluginExecutionContext } from './commands.js';
import type { MrRobotPlugin } from './loader.js';

export const MANAGED_SANDBOX_IMAGE = 'python:3.12-slim';
export const MANAGED_SANDBOX_LIMITS = Object.freeze({
  containers: 4, cpu: 1, memoryMiB: 512, pids: 64,
  workspaceMiB: 128, temporaryMiB: 32, sharedMemoryMiB: 8, watchdogMiB: 1,
  outputBytes: 128 * 1024, commandBytes: 16 * 1024, timeoutSec: 120, lifetimeSec: 900,
});
const OWNER = 'io.vera.managed-sandbox.owner';
const SCOPE = 'io.vera.managed-sandbox.scope';
const NONCE = 'io.vera.managed-sandbox.nonce';
const ID = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const NO_ENGINE = 'Docker Linux 엔진을 사용할 수 없습니다. 엔진을 직접 준비해 주세요. WSL 또는 호스트 실행으로 대체하지 않습니다.';
const PROXIES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy', 'no_proxy'];
// PID1 is a different unprivileged UID from model code. Its private tmpfs
// deadline cannot be changed or its process signalled by the command UID.
// Exiting PID1 ends every process in this dedicated container, including code
// that escaped a shell process group. No daemon round trip is needed at expiry.
export const SANDBOX_WATCHDOG = `import math,time
limit=time.monotonic()+900
while True:
 try:
  with open('/guard/deadline') as f: deadline=float(f.read(64))
  if not math.isfinite(deadline): break
 except FileNotFoundError: deadline=limit
 except Exception: break
 if time.monotonic()>=min(limit,deadline): break
 time.sleep(0.05)
`;
export const SANDBOX_WATCHDOG_CONTROL = `import os,sys,time
busy=False
for pid in os.listdir('/proc'):
 if not pid.isdigit(): continue
 try:
  with open('/proc/'+pid+'/status') as f:
   for line in f:
    if line.startswith('Uid:') and int(line.split()[1])==65534: busy=True
 except FileNotFoundError: pass
 except ProcessLookupError: pass
if sys.argv[1]=='arm':
 if busy: sys.exit(75)
 with open('/guard/deadline.tmp','w') as f: f.write(str(time.monotonic()+int(sys.argv[2])))
 os.replace('/guard/deadline.tmp','/guard/deadline')
 print('armed')
elif sys.argv[1]=='finish':
 if not busy:
  try: os.unlink('/guard/deadline')
  except FileNotFoundError: pass
 print('background' if busy else 'idle')
else: sys.exit(76)
`;

export interface SandboxDockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  aborted?: boolean;
  overflow?: boolean;
}
export interface SandboxDockerOptions { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number }
export type SandboxDockerCommand = (args: string[], options?: SandboxDockerOptions) => Promise<SandboxDockerResult>;

/** Injecting a process launcher is test-only; callers never supply an executable or CLI flags. */
export function createSandboxDockerCommand(launch: typeof spawn = spawn): SandboxDockerCommand {
  return (args, options = {}) => new Promise((resolve) => {
    if (options.signal?.aborted) { resolve({ code: null, stdout: '', stderr: '', aborted: true }); return; }
    const env = { ...process.env };
    // Use the saved local context, then pin its local endpoint explicitly. Never
    // inherit a remote daemon/TLS selector or pass host environment to code.
    for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[name];
    let child: ChildProcess;
    try { child = launch('docker', args, { env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { resolve({ code: null, stdout: '', stderr: '' }); return; }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const maxBytes = Math.min(options.maxBytes ?? MANAGED_SANDBOX_LIMITS.outputBytes, MANAGED_SANDBOX_LIMITS.outputBytes);
    let bytes = 0, settled = false, stopping = false;
    let timedOut = false, aborted = false, overflow = false;
    let forceTimer: NodeJS.Timeout | undefined, settleTimer: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(settleTimer);
      options.signal?.removeEventListener('abort', abort);
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut, aborted, overflow });
    };
    const stop = (reason: 'timeout' | 'abort' | 'overflow') => {
      if (stopping || settled) return;
      stopping = true; timedOut = reason === 'timeout'; aborted = reason === 'abort'; overflow = reason === 'overflow';
      terminateProcessTree(child, true);
      forceTimer = setTimeout(() => terminateProcessTree(child, true, true), 250);
      // The CLI is not the container. The manager independently removes only
      // its labelled container after this bounded transport finishes.
      settleTimer = setTimeout(() => finish(null), 1500);
      forceTimer.unref(); settleTimer.unref();
    };
    const abort = () => stop('abort');
    const append = (target: Buffer[]) => (chunk: Buffer | string) => {
      if (settled || stopping) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxBytes - bytes);
      if (remaining) target.push(Buffer.from(data.subarray(0, remaining)));
      bytes += Math.min(data.length, remaining);
      if (data.length > remaining) stop('overflow');
    };
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? 10_000); timer.unref();
    child.stdout?.on('data', append(stdout)); child.stderr?.on('data', append(stderr));
    child.once('error', () => finish(null)); child.once('close', (code) => finish(code));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

function good(result: SandboxDockerResult): boolean {
  return result.code === 0 && !result.timedOut && !result.aborted && !result.overflow;
}
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Docker 응답 형식이 올바르지 않습니다.');
  return value as Record<string, any>;
}
function json(result: SandboxDockerResult): Record<string, any> {
  if (!good(result)) throw new Error(NO_ENGINE);
  try { return object(JSON.parse(result.stdout)); } catch { throw new Error('Docker 응답 형식이 올바르지 않습니다.'); }
}
function scopeOf(execution?: PluginExecutionContext): string {
  if (!execution?.scopeKey || execution.scopeKey.length > 512 || !execution.workspaceRoot || !isAbsolute(execution.workspaceRoot)) {
    throw new Error('호스트가 확인한 대화 범위와 선택된 작업 폴더가 필요합니다.');
  }
  let root: string;
  try {
    root = realpathSync(execution.workspaceRoot);
    if (!statSync(root).isDirectory()) throw new Error();
  } catch { throw new Error('선택된 작업 폴더를 확인할 수 없습니다.'); }
  return createHash('sha256').update(JSON.stringify([execution.scopeKey, root])).digest('hex');
}
function approve(execution?: PluginExecutionContext, discard = false): asserts execution is PluginExecutionContext {
  if (!execution || !execution.destructiveApproved || execution.permissionMode === 'read-only') throw new Error('샌드박스 변경 작업 승인이 필요합니다.');
  if (discard && execution.approvalSource !== 'prompt'
    && !(execution.approvalSource === 'policy' && (execution.isAdmin || execution.permissionMode === 'full'))) {
    throw new Error('임시 작업 공간을 폐기하려면 이 호출의 개별 승인이 필요합니다.');
  }
  execution.signal?.throwIfAborted();
}
function emptyParams(raw: unknown): void {
  if (raw === undefined || raw === null) return;
  if (Object.keys(object(raw)).length) throw new Error('이 작업은 추가 인자를 받지 않습니다.');
}

interface Engine { endpoint: string; image: string }
interface Session {
  scope: string; nonce: string; name: string; id?: string; engine?: Engine;
  busy: boolean; attempted: boolean; uncertain: boolean; createdAt: number;
  controller: AbortController;
}
type Inspection = { kind: 'owned'; data: Record<string, any> } | { kind: 'missing' | 'unavailable' | 'foreign' };
export interface ManagedSandboxStatus {
  cli: boolean; localContext: boolean; daemon: boolean; linux: boolean;
  resourceLimits: boolean; imageReady: boolean; imageName: string;
  state: 'unavailable' | 'unprepared' | 'ready' | 'busy' | 'cleanup-pending';
  backend: 'docker'; wslDockerSupported: true; plainWslSandbox: false;
  ephemeral: true; limits: typeof MANAGED_SANDBOX_LIMITS; reason?: string;
}

/** No resource selectors or host paths enter this service from model arguments. */
export class ManagedSandboxService {
  private readonly sessions = new Map<string, Session>();
  private closed = false;
  constructor(private readonly owner: string, private readonly command: SandboxDockerCommand = createSandboxDockerCommand(), private readonly now = Date.now) {
    if (!UUID.test(owner)) throw new Error('샌드박스 소유자 식별자가 올바르지 않습니다.');
  }

  private async discover(signal?: AbortSignal): Promise<{ status: ManagedSandboxStatus; engine?: Engine }> {
    const status: ManagedSandboxStatus = {
      cli: false, localContext: false, daemon: false, linux: false, resourceLimits: false, imageReady: false,
      imageName: MANAGED_SANDBOX_IMAGE, state: 'unavailable', backend: 'docker', wslDockerSupported: true,
      plainWslSandbox: false, ephemeral: true, limits: MANAGED_SANDBOX_LIMITS,
    };
    const current = await this.command(['context', 'show'], { signal });
    status.cli = good(current);
    if (!status.cli) return { status: { ...status, reason: 'Docker CLI를 사용할 수 없습니다.' } };
    const name = current.stdout.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) return { status: { ...status, reason: '로컬 Docker 컨텍스트를 확인할 수 없습니다.' } };
    const context = await this.command(['context', 'inspect', name, '--format', '{{json .Endpoints.docker.Host}}'], { signal });
    let endpoint: unknown;
    try { endpoint = good(context) ? JSON.parse(context.stdout) : undefined; } catch { /* fail closed */ }
    if (typeof endpoint !== 'string' || !(/^npipe:\/{4}\.\/pipe\/[a-zA-Z0-9_.-]+$/.test(endpoint) || /^unix:\/\/\/[^\0\r\n\s]+$/.test(endpoint))) {
      return { status: { ...status, reason: '로컬 Docker 소켓만 지원합니다. 원격 TCP/SSH 컨텍스트는 사용하지 않습니다.' } };
    }
    status.localContext = true;
    const info = await this.command(['--host', endpoint, 'info', '--format', '{{json .}}'], { signal });
    if (!good(info)) return { status: { ...status, reason: NO_ENGINE } };
    const details = json(info); status.daemon = true; status.linux = details.OSType === 'linux';
    status.resourceLimits = details.MemoryLimit === true && details.SwapLimit === true && details.CPUShares === true
      && details.CpuCfsQuota === true && details.PidsLimit === true
      && Array.isArray(details.SecurityOptions) && details.SecurityOptions.some((x: unknown) => typeof x === 'string' && x.startsWith('name=seccomp'));
    if (!status.linux || !status.resourceLimits) return { status: { ...status, reason: 'Linux 엔진의 메모리·CPU·PID·seccomp 제한 지원을 확인할 수 없습니다.' } };
    const imageResult = await this.command(['--host', endpoint, 'image', 'inspect', MANAGED_SANDBOX_IMAGE, '--format', '{{json .}}'], { signal });
    if (!good(imageResult)) return { status: { ...status, reason: `기존 ${MANAGED_SANDBOX_IMAGE} 이미지가 필요합니다. 자동 다운로드나 설치는 하지 않습니다.` } };
    const image = json(imageResult);
    status.imageReady = IMAGE_ID.test(String(image.Id)) && image.Os === 'linux'
      && Object.keys(object(image.Config ?? {})).length > 0 && Object.keys(image.Config.Volumes ?? {}).length === 0;
    if (!status.imageReady) return { status: { ...status, reason: '이미지 ID, Linux 형식 또는 숨은 볼륨 없음 조건을 확인할 수 없습니다.' } };
    return { status: { ...status, state: 'unprepared' }, engine: { endpoint, image: image.Id } };
  }

  private invoke(session: Session, args: string[], options?: SandboxDockerOptions) {
    if (!session.engine) throw new Error(NO_ENGINE);
    return this.command(['--host', session.engine.endpoint, ...args], options);
  }
  private async inspect(session: Session): Promise<Inspection> {
    if (!session.engine) return { kind: 'missing' };
    const result = await this.invoke(session, ['container', 'inspect', session.id ?? session.name, '--format', '{{json .}}'], { timeoutMs: 5000 });
    if (!good(result)) {
      const listing = await this.invoke(session, ['container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${session.name}$`, '--format', '{{.ID}}'], { timeoutMs: 5000 });
      return { kind: good(listing) && listing.stdout.trim() === '' ? 'missing' : 'unavailable' };
    }
    let data: Record<string, any>;
    try { data = json(result); } catch { return { kind: 'unavailable' }; }
    const labels = data.Config?.Labels;
    if (!ID.test(String(data.Id)) || (session.id && session.id !== data.Id)
      || data.Name !== `/${session.name}` || labels?.[OWNER] !== this.owner || labels?.[SCOPE] !== session.scope || labels?.[NONCE] !== session.nonce) return { kind: 'foreign' };
    return { kind: 'owned', data };
  }
  private policyMatches(data: Record<string, any>, session: Session): boolean {
    const host = data.HostConfig;
    return data.Image === session.engine?.image && data.Config?.User === '65533:65533' && data.Config?.WorkingDir === '/'
      && host?.ReadonlyRootfs === true && host.Privileged === false && host.NetworkMode === 'none'
      && host.Memory === 512 * 1024 * 1024 && host.MemorySwap === 512 * 1024 * 1024
      && host.NanoCpus === 1_000_000_000 && host.PidsLimit === 64 && host.ShmSize === 8 * 1024 * 1024
      && host.LogConfig?.Type === 'none' && host.AutoRemove === true
      && Array.isArray(host.CapDrop) && host.CapDrop.includes('ALL') && !(host.CapAdd?.length)
      && Array.isArray(host.SecurityOpt) && host.SecurityOpt.includes('no-new-privileges')
      && !(host.Binds?.length) && !(host.Mounts?.length) && !(host.Devices?.length)
      && (data.Mounts ?? []).every((m: any) => m.Type === 'tmpfs' && ['/work', '/tmp', '/guard'].includes(m.Destination))
      && host.Tmpfs?.['/work'] === 'rw,noexec,nosuid,nodev,size=128m,uid=65534,gid=65534,mode=700'
      && host.Tmpfs?.['/tmp'] === 'rw,noexec,nosuid,nodev,size=32m,mode=1777'
      && host.Tmpfs?.['/guard'] === 'rw,noexec,nosuid,nodev,size=1m,uid=65533,gid=65533,mode=700'
      && Object.keys(host.Tmpfs ?? {}).length === 3
      && JSON.stringify(data.Config?.Entrypoint) === JSON.stringify(['/usr/local/bin/python'])
      && JSON.stringify(data.Config?.Cmd) === JSON.stringify(['-I', '-B', '-c', SANDBOX_WATCHDOG]);
  }
  private release(session: Session) { if (this.sessions.get(session.scope) === session) this.sessions.delete(session.scope); }

  /** Missing labels are never interpreted as permission to kill by name. */
  private async cleanup(session: Session): Promise<boolean> {
    session.controller.abort();
    if (!session.engine || !session.attempted) { this.release(session); return true; }
    const inspected = await this.inspect(session);
    if (inspected.kind === 'owned') {
      const removed = await this.invoke(session, ['container', 'rm', '--force', inspected.data.Id], { timeoutMs: 5000 });
      if (!good(removed) && (await this.inspect(session)).kind !== 'missing') return false;
    } else if (inspected.kind !== 'missing') return false;
    // A timed-out create may still be registering at the daemon. Quarantine
    // its reserved slot/name for the whole lifetime instead of allowing an
    // unbounded retry stream. No user code is started after such a failure.
    if (session.uncertain && this.now() - session.createdAt < (MANAGED_SANDBOX_LIMITS.lifetimeSec + 30) * 1000) return false;
    this.release(session); return true;
  }

  async status(execution?: PluginExecutionContext): Promise<ManagedSandboxStatus> {
    const { status } = await this.discover(execution?.signal);
    if (!execution?.scopeKey || !execution.workspaceRoot) return status;
    const session = this.sessions.get(scopeOf(execution));
    if (!session) return status;
    if (session.busy) return { ...status, state: 'busy' };
    const found = await this.inspect(session);
    if (found.kind === 'missing' && !session.uncertain) { this.release(session); return status; }
    return { ...status, state: found.kind === 'owned' && found.data.State?.Running && !session.controller.signal.aborted && this.policyMatches(found.data, session) ? 'ready' : 'cleanup-pending' };
  }

  async prepare(execution: PluginExecutionContext): Promise<{ state: 'ready'; reused: boolean; ephemeral: true }> {
    approve(execution);
    if (this.closed) throw new Error('샌드박스 서비스가 종료되었습니다.');
    const scope = scopeOf(execution);
    const old = this.sessions.get(scope);
    if (old) {
      if (old.busy) throw new Error('이 범위의 샌드박스 작업이 진행 중입니다.');
      old.busy = true;
      try {
        const found = await this.inspect(old);
        if (!old.controller.signal.aborted && found.kind === 'owned' && found.data.State?.Running && this.policyMatches(found.data, old)) return { state: 'ready', reused: true, ephemeral: true };
        if (!await this.cleanup(old)) throw new Error('이전 샌드박스 정리를 확인하지 못했습니다. 추가 컨테이너를 만들지 않습니다.');
      } finally { old.busy = false; }
    }
    // Reserve synchronously, before any daemon call; concurrent scopes cannot
    // oversubscribe the fixed cap while image/context checks are in flight.
    if (this.sessions.size >= MANAGED_SANDBOX_LIMITS.containers) throw new Error('샌드박스 4개 한도에 도달했습니다. 기존 작업 공간을 먼저 제거해 주세요.');
    const nonce = randomUUID();
    const session: Session = { scope, nonce, name: `vera-sandbox-${nonce}`, busy: true, attempted: false, uncertain: false, createdAt: this.now(), controller: new AbortController() };
    this.sessions.set(scope, session);
    const signal = execution.signal ? AbortSignal.any([execution.signal, session.controller.signal]) : session.controller.signal;
    try {
      const discovered = await this.discover(signal);
      if (!discovered.engine) throw new Error(discovered.status.reason ?? NO_ENGINE);
      session.engine = discovered.engine; signal.throwIfAborted();
      // Count this installation's leftovers too; never adopt or prune them.
      const existing = await this.invoke(session, ['container', 'ls', '--all', '--no-trunc', '--filter', `label=${OWNER}=${this.owner}`, '--format', '{{.ID}}'], { signal });
      if (!good(existing) || existing.stdout.trim().split(/\s+/).filter(Boolean).length >= MANAGED_SANDBOX_LIMITS.containers) throw new Error('소유 컨테이너 수를 확인할 수 없거나 한도에 도달했습니다.');
      signal.throwIfAborted(); session.attempted = true; session.uncertain = true;
      const created = await this.invoke(session, sandboxCreateArgs(this.owner, session.scope, session.nonce, session.name, session.engine.image), { signal });
      if (!good(created) || !ID.test(created.stdout.trim())) throw new Error('샌드박스 컨테이너 생성에 실패했습니다.');
      session.id = created.stdout.trim(); session.uncertain = false; signal.throwIfAborted();
      const found = await this.inspect(session);
      if (found.kind !== 'owned' || !this.policyMatches(found.data, session)) throw new Error('샌드박스 소유권 또는 격리 제한 검증에 실패했습니다.');
      signal.throwIfAborted();
      const started = await this.invoke(session, ['container', 'start', session.id], { signal });
      if (!good(started)) throw new Error('샌드박스 시작에 실패했습니다.');
      signal.throwIfAborted();
      return { state: 'ready', reused: false, ephemeral: true };
    } catch (error) { await this.cleanup(session); throw error; }
    finally { session.busy = false; }
  }

  async execute(raw: unknown, execution: PluginExecutionContext) {
    approve(execution);
    const params = object(raw);
    if (Object.keys(params).some(key => !['command', 'timeoutSec'].includes(key)) || typeof params.command !== 'string'
      || !params.command.trim() || params.command.includes('\0') || Buffer.byteLength(params.command) > MANAGED_SANDBOX_LIMITS.commandBytes) throw new Error('명령은 16KiB 이하 문자열이어야 하며 추가 실행 옵션은 허용하지 않습니다.');
    const seconds = params.timeoutSec ?? 30;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MANAGED_SANDBOX_LIMITS.timeoutSec) throw new Error('실행 제한은 1~120초 정수여야 합니다.');
    const session = this.sessions.get(scopeOf(execution));
    if (!session || this.closed || session.controller.signal.aborted) throw new Error('sandbox.prepare로 이 범위의 작업 공간을 먼저 준비해 주세요.');
    if (session.busy) throw new Error('이 범위의 샌드박스 작업이 진행 중입니다.');
    session.busy = true;
    const signal = execution.signal ? AbortSignal.any([execution.signal, session.controller.signal]) : session.controller.signal;
    try {
      const found = await this.inspect(session);
      if (found.kind !== 'owned' || !found.data.State?.Running || !this.policyMatches(found.data, session)) throw new Error('샌드박스 소유권 또는 격리 상태를 확인할 수 없습니다.');
      signal.throwIfAborted();
      const control = (operation: 'arm' | 'finish') => this.invoke(session,
        ['exec', '--user=65533:65533', '--workdir=/guard', session.id!, '/usr/local/bin/python', '-I', '-B', '-c', SANDBOX_WATCHDOG_CONTROL, operation, String(seconds)],
        { signal, timeoutMs: 5000 });
      const armed = await control('arm');
      if (!good(armed) || armed.stdout.trim() !== 'armed') throw new Error('보호된 실행 제한을 설정할 수 없거나 이전 백그라운드 작업이 남아 있습니다. 작업 공간을 폐기합니다.');
      signal.throwIfAborted();
      const result = await this.invoke(session, ['exec', '--user=65534:65534', '--workdir=/work', session.id!,
        '/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/work', 'TMPDIR=/tmp', 'PYTHONDONTWRITEBYTECODE=1',
        '/bin/sh', '-c', params.command], { signal, timeoutMs: seconds * 1000 });
      if (result.timedOut || result.aborted || result.overflow || result.code === null) {
        const removed = await this.cleanup(session);
        return { ok: false, exitCode: result.code, stdout: result.stdout, stderr: result.stderr, timedOut: !!result.timedOut,
          aborted: !!result.aborted, outputTruncated: !!result.overflow, workspaceDiscarded: removed, cleanupPending: !removed };
      }
      signal.throwIfAborted();
      const finished = await control('finish');
      if (!good(finished) || !['idle', 'background'].includes(finished.stdout.trim())) {
        const removed = await this.cleanup(session);
        return { ok: false, exitCode: result.code, stdout: result.stdout, stderr: result.stderr, timedOut: false, aborted: false,
          outputTruncated: false, workspaceDiscarded: removed, cleanupPending: !removed, executionStateUnverified: true };
      }
      return { ok: result.code === 0, exitCode: result.code, stdout: result.stdout, stderr: result.stderr,
        timedOut: false, aborted: false, outputTruncated: false, workspaceDiscarded: false, cleanupPending: false,
        backgroundProcesses: finished.stdout.trim() === 'background' };
    } catch (error) { await this.cleanup(session); throw error; }
    finally { session.busy = false; }
  }

  async discard(execution: PluginExecutionContext) {
    approve(execution, true);
    const session = this.sessions.get(scopeOf(execution));
    if (!session) return { state: 'unprepared', removed: false, workspaceDiscarded: true };
    // Abort immediately even if exec is pending; its finally path also verifies
    // the same ID. Docker rm is idempotent, and no other scope can be touched.
    const removed = await this.cleanup(session);
    return { state: removed ? 'unprepared' : 'cleanup-pending', removed, workspaceDiscarded: removed };
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.sessions.values()].map(session => this.cleanup(session)));
  }
}

export function sandboxCreateArgs(owner: string, scope: string, nonce: string, name: string, image: string): string[] {
  return ['container', 'create', '--rm', '--pull=never', '--name', name,
    '--label', `${OWNER}=${owner}`, '--label', `${SCOPE}=${scope}`, '--label', `${NONCE}=${nonce}`,
    '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--user=65533:65533', '--memory=512m', '--memory-swap=512m', '--cpus=1', '--pids-limit=64',
    '--shm-size=8m', '--log-driver=none', '--no-healthcheck', '--ulimit', 'nofile=256:256', '--ulimit', 'core=0:0',
    '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777',
    '--tmpfs=/work:rw,noexec,nosuid,nodev,size=128m,uid=65534,gid=65534,mode=700', '--workdir=/',
    '--tmpfs=/guard:rw,noexec,nosuid,nodev,size=1m,uid=65533,gid=65533,mode=700',
    ...PROXIES.flatMap(name => ['--env', `${name}=`]),
    '--entrypoint=/usr/local/bin/python', image, '-I', '-B', '-c', SANDBOX_WATCHDOG];
}

export function createManagedSandboxPlugin(command?: SandboxDockerCommand): MrRobotPlugin {
  let service: ManagedSandboxService | undefined;
  return {
    manifest: {
      id: 'managed-sandbox', name: 'V.E.R.A Sandbox', version: '0.1.0', kind: 'tool', category: 'development', enabledByDefault: true,
      description: 'Docker Linux 엔진의 제한 컨테이너를 대화별로 준비·실행·폐기합니다. 호스트 파일과 네트워크는 연결하지 않습니다.',
      capabilities: ['sandbox.status', 'sandbox.prepare', 'sandbox.exec', 'sandbox.stop', 'sandbox.remove'],
      permissions: ['container.execute', 'process.execute'], dependencies: [{ id: 'docker', name: 'Docker Linux engine', required: true }],
    },
    activate(ctx) {
      const saved = ctx.storage.get<string>('owner');
      const owner = saved ?? randomUUID();
      service = new ManagedSandboxService(owner, command);
      if (!saved) ctx.storage.set('owner', owner);
      const toolWhen = (message: string) => /sandbox|docker|container|wsl|샌드박스|격리|컨테이너/i.test(message);
      const parameters = { type: 'object', properties: {}, additionalProperties: false };
      ctx.registerCommand('sandbox.status', (raw, execution) => { emptyParams(raw); return service!.status(execution); }, {
        tool: true, destructive: false, toolWhen, parameters, description: 'Docker/로컬 엔진/이미지 준비 상태와 현재 범위의 임시 샌드박스 상태를 확인합니다.',
      });
      ctx.registerCommand('sandbox.prepare', (raw, execution) => { emptyParams(raw); approve(execution); return service!.prepare(execution); }, {
        tool: true, destructive: true, toolWhen, parameters, description: '승인된 대화·작업 폴더 범위의 임시 Docker 샌드박스를 준비합니다. 호스트 파일 연결·이미지 다운로드 없음.',
      });
      ctx.registerCommand('sandbox.exec', (raw, execution) => { approve(execution); return service!.execute(raw, execution); }, {
        tool: true, destructive: true, toolWhen, description: '준비된 Docker 샌드박스 내부 /work에서 명령을 실행합니다. 네트워크 차단, 최대 120초/128KiB 출력. 시간 초과·취소 시 작업 공간 폐기.',
        parameters: { type: 'object', properties: { command: { type: 'string', maxLength: 16384 }, timeoutSec: { type: 'integer', minimum: 1, maximum: 120 } }, required: ['command'], additionalProperties: false },
      });
      for (const name of ['sandbox.stop', 'sandbox.remove']) ctx.registerCommand(name, (raw, execution) => {
        emptyParams(raw); approve(execution, true); return service!.discard(execution);
      }, { tool: true, destructive: true, toolWhen, parameters, description: '개별 승인 후 현재 범위의 샌드박스를 중지·제거하고 임시 파일을 폐기합니다. 다른 범위는 변경하지 않습니다.' });
    },
    async deactivate() { const current = service; service = undefined; await current?.close(); },
  };
}
