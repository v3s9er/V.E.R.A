import { createServer, type Server as HttpServer } from 'node:http';
import { networkInterfaces, hostname as osHostname, platform } from 'node:os';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type {
  AppSettings,
  DeviceCapability,
  PermissionMode,
  ConversationCreateInput,
  ConversationDetail,
  ConversationStatus,
  MemoryItem,
  ReasoningEffort,
  RoutingSettings,
  RoutingPreset,
  PluginInfo,
  ProviderAddInput,
  ProviderInfo,
  ScreenSize,
  ShellResult,
  SystemStatus,
  DependencyId,
  DependencyReport,
  DependencyInstallResult,
  WorkspaceInfo,
  ChatRunState,
  SyncMergeResult,
} from '@mr-robot/shared';
import { safeEqual, maskSecret, pairingPayload } from '../auth.js';
import { ConfigStore } from '../config.js';
import { EventBus } from '../eventbus.js';
import { Logger } from '../logger.js';
import { ProviderRegistry } from '../ai/registry.js';
import { effectiveMode, ToolExecutor } from '../ai/executor.js';
import { AgentLoop } from '../ai/loop.js';
import { ModelRouter } from '../ai/router.js';
import { ConversationStore } from '../conversations.js';
import { MemoryStore } from '../memory.js';
import { TelemetryStore } from '../telemetry.js';
import { PluginManager } from '../plugins/manager.js';
import { createOrcaPlugin } from '../plugins/orca.js';
import { createCalendarPlugin } from '../plugins/calendar.js';
import { createTailscalePlugin } from '../plugins/tailscale.js';
import { createDockerPlugin } from '../plugins/docker.js';
import { createCtfPlugin } from '../plugins/ctf.js';
import { createMcpPlugin } from '../plugins/mcp.js';
import { createVoicePlugin } from '../plugins/voice.js';
import { createRemoteLinkPlugin } from '../plugins/remote-link.js';
import { computer } from '../computer/index.js';
import { Scheduler, SchedulerStore } from '../scheduler.js';
import { DependencyManager } from '../dependencies.js';
import { ChatSession } from './chat.js';
import { ScreenStreamController } from './stream.js';
import { WsHub, WsClient, type AuthContext, type RpcHandler } from './ws.js';
import { createHttpApi, type PairingInfo } from './http.js';
import { ContextBroker } from '../context-broker.js';
import { resolveRegisteredWorkspacePath } from '../path-security.js';

export const VERSION = '0.3.2';
const PAIRING_PIN_TTL_MS = 5 * 60_000;
const PIN_GLOBAL_WINDOW_MS = 5 * 60_000;
const PIN_GLOBAL_MAX_FAILURES = 50;

export type ServerEventAudience = 'paired' | 'admin' | 'none';

// Event visibility is an authorization boundary, not just a UI concern.
// Unknown/new events default to no network broadcast until explicitly reviewed.
const PAIRED_EVENT_ALLOWLIST = new Set([
  'routing.changed', 'routing.presets.changed', 'conversations.changed',
  'workspaces.changed', 'calendar.changed',
]);
const ADMIN_EVENT_ALLOWLIST = new Set([
  'log', 'plugins.changed', 'providers.changed', 'settings.changed',
  'dependencies.changed', 'memory.changed', 'scheduler.changed', 'scheduler.ran',
  'voice.wake', 'voice.command', 'voice.command.ready', 'voice.command.timeout',
  'voice.status', 'pairing.changed',
]);

export function serverEventAudience(event: string): ServerEventAudience {
  if (PAIRED_EVENT_ALLOWLIST.has(event)) return 'paired';
  if (ADMIN_EVENT_ALLOWLIST.has(event)) return 'admin';
  return 'none';
}

/** Rate limit for the PIN -> secret exchange (brute-force protection). */
class PinLimiter {
  private readonly attempts = new Map<string, { failures: number; windowStart: number; lockedUntil: number; lastSeen: number }>();
  private globalFailures: number[] = [];

  private pruneGlobal(now: number): void {
    this.globalFailures = this.globalFailures.filter((at) => now - at < PIN_GLOBAL_WINDOW_MS);
  }

  check(rawKey: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    this.pruneGlobal(now);
    if (this.globalFailures.length >= PIN_GLOBAL_MAX_FAILURES) {
      return { allowed: false, retryAfterMs: Math.max(1, this.globalFailures[0] + PIN_GLOBAL_WINDOW_MS - now) };
    }
    const key = String(rawKey || 'unknown').slice(0, 256);
    const state = this.attempts.get(key);
    if (!state) return { allowed: true };
    state.lastSeen = now;
    if (state.lockedUntil > now) return { allowed: false, retryAfterMs: state.lockedUntil - now };
    if (now - state.windowStart > 60_000) {
      this.attempts.delete(key);
      return { allowed: true };
    }
    if (state.failures >= 5) {
      state.lockedUntil = now + 300_000;
      return { allowed: false, retryAfterMs: 300_000 };
    }
    return { allowed: true };
  }

  recordFailure(rawKey: string): void {
    const now = Date.now();
    this.pruneGlobal(now);
    this.globalFailures.push(now);
    const key = String(rawKey || 'unknown').slice(0, 256);
    const previous = this.attempts.get(key);
    const state = !previous || now - previous.windowStart > 60_000
      ? { failures: 0, windowStart: now, lockedUntil: 0, lastSeen: now }
      : previous;
    state.failures += 1;
    state.lastSeen = now;
    this.attempts.set(key, state);
    if (this.attempts.size > 4_096) {
      const oldest = [...this.attempts.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen).slice(0, 2_048);
      for (const [oldKey] of oldest) this.attempts.delete(oldKey);
    }
  }

  recordSuccess(rawKey: string): void {
    this.attempts.delete(String(rawKey || 'unknown').slice(0, 256));
  }

  /** A locally initiated PIN rotation starts a new enrollment epoch. */
  reset(): void {
    this.attempts.clear();
    this.globalFailures = [];
  }
}

export interface StartOptions {
  port?: number;
  host?: string;
  /** Path to the built web UI (packages/web/dist) to serve. */
  webDir?: string;
}

export class AgentServer {
  readonly bus = new EventBus();
  readonly logger = new Logger(this.bus, 'mr-robot');
  readonly config = new ConfigStore();
  readonly registry = new ProviderRegistry(this.config);
  readonly plugins: PluginManager;
  readonly executor: ToolExecutor;
  readonly loop: AgentLoop;
  readonly router: ModelRouter;
  readonly conversations: ConversationStore;
  readonly memory: MemoryStore;
  readonly telemetry: TelemetryStore;
  readonly scheduler: Scheduler;
  readonly dependencies = new DependencyManager();
  readonly contextBroker: ContextBroker;

  private httpServer: HttpServer | null = null;
  private readonly activeHttpTransfers = new Set<AbortController>();
  private hub: WsHub | null = null;
  private pinLimiter = new PinLimiter();
  private startedAt = 0;
  private boundHost = '127.0.0.1';
  private boundPort = 0;
  private busyConversations = new Set<string>();
  private activeRuns = new Map<string, {
    session: ChatSession;
    startedAt: number;
    status: string;
    ownerClientId: string;
    ownerLinkId?: string;
    permissionMode: PermissionMode;
  }>();
  private busSubscriptions: Array<() => void> = [];

  constructor() {
    this.conversations = new ConversationStore(this.config.dir);
    this.memory = new MemoryStore(this.config.dir);
    this.telemetry = new TelemetryStore(this.config.dir);
    this.contextBroker = new ContextBroker(this.config.dir);
    this.plugins = new PluginManager(this.bus, computer, this.registry, this.config, this.logger);
    this.executor = new ToolExecutor({
      computer,
      safety: () => this.config.settings.safety,
      runPluginTool: (name, params, execution) => this.plugins.call(name, params, execution),
      pluginToolDestructive: (name) => this.plugins.isDestructive(name),
      contextBroker: this.contextBroker,
    });
    this.router = new ModelRouter(this.registry, this.config);
    this.loop = new AgentLoop(this.registry, this.executor, this.router, this.contextBroker);
    this.scheduler = new Scheduler(new SchedulerStore(this.config), this.bus, computer, this.loop, this.logger, () => this.config.settings.safety.mode);
  }

  // -- auth ---------------------------------------------------------------

  get secret(): string {
    return this.config.pairing.secret;
  }

  verifySecret(candidate: string): boolean {
    return this.authenticate(candidate) !== null;
  }

  fileAccess(candidate: string, write: boolean): boolean {
    const auth = this.authenticate(candidate);
    if (!auth) return false;
    if (!write) return true;
    const cap = effectiveMode(this.config.settings.safety.mode, auth.permissionCap);
    return cap === 'workspace' || cap === 'full';
  }

  /** Shared inbox/outbox writes are isolated to ~/.mr-robot/shared and need ask-or-higher. */
  sharedFileAccess(candidate: string, write: boolean): boolean {
    const auth = this.authenticate(candidate);
    if (!auth) return false;
    if (!write) return true;
    return effectiveMode(this.config.settings.safety.mode, auth.permissionCap) !== 'read-only';
  }

  syncSnapshot(): { version: number; deviceName: string; exportedAt: number; conversations: unknown[]; routingPresets: unknown[] } {
    return {
      version: 1,
      deviceName: this.config.settings.deviceName,
      exportedAt: Date.now(),
      conversations: this.conversations.exportSnapshot(),
      routingPresets: this.config.exportUserRoutingPresets(),
    };
  }

  mergeSyncSnapshot(value: unknown): SyncMergeResult {
    const snapshot = value as { version?: number; conversations?: unknown; routingPresets?: unknown };
    if (!snapshot || snapshot.version !== 1) throw new Error('지원하지 않는 동기화 형식입니다.');
    // Validate both stores before touching either one. This prevents a malformed
    // second half from leaving a partially-applied cross-PC sync.
    this.conversations.validateSnapshot(snapshot.conversations);
    this.config.validateRoutingPresets(snapshot.routingPresets);
    const previousConversations = this.conversations.exportSnapshot();
    const previousPresets = this.config.exportUserRoutingPresets();
    try {
      const routingPresets = this.config.mergeRoutingPresets(snapshot.routingPresets);
      // New conversations arrive at ask-or-lower; existing destination-local
      // permissions/workspace bindings are preserved by ConversationStore.
      const conversations = this.conversations.mergeSnapshot(snapshot.conversations, 'ask');
      this.bus.emit('conversations.changed', this.conversations.list());
      this.bus.emit('routing.changed', this.config.routing);
      return { conversations, routingPresets };
    } catch (error) {
      const rollbackErrors: string[] = [];
      try { this.config.restoreUserRoutingPresets(previousPresets); }
      catch (rollbackError) { rollbackErrors.push(`presets: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
      try { this.conversations.restoreSnapshot(previousConversations); }
      catch (rollbackError) { rollbackErrors.push(`conversations: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
      if (rollbackErrors.length) this.logger.error(`sync rollback failed: ${rollbackErrors.join('; ')}`);
      throw error;
    }
  }

  isAdminSecret(candidate: string): boolean {
    return this.authenticate(candidate)?.isAdmin === true;
  }

  /** Work sync is a narrow paired-device capability, independent of shell/file/admin access. */
  isSyncSecret(candidate: string): boolean {
    const auth = this.authenticate(candidate);
    if (!auth) return false;
    if (auth.isAdmin) return true;
    const link = this.config.findDeviceLink(candidate);
    if (!link?.capabilities.includes('work-sync')) return false;
    // Keep both the global and per-device read-only ceilings authoritative.
    return effectiveMode(this.config.settings.safety.mode, link.permissionCap) !== 'read-only';
  }

  authenticate(candidate: string): AuthContext | null {
    if (!candidate) return null;
    if (safeEqual(candidate, this.secret)) return { isAdmin: true, permissionCap: 'full' };
    const link = this.config.findDeviceLink(candidate);
    if (!link) return null;
    // Tool/file capability and control-plane administration are deliberately
    // separate. Even a full device link cannot edit providers, plugins or
    // global settings unless it uses the local administrator secret.
    return { isAdmin: false, linkId: link.id, permissionCap: link.permissionCap };
  }

  exchangePin(pin: string, deviceName = '연결된 기기', permissionCap: PermissionMode = 'ask', clientKey = 'unknown'): { ok: boolean; secret?: string; linkId?: string; error?: string } {
    const check = this.pinLimiter.check(clientKey);
    if (!check.allowed) return { ok: false, error: `too many attempts, retry in ${Math.ceil((check.retryAfterMs ?? 0) / 1000)}s` };
    if (Date.now() - this.config.pinCreatedAt > PAIRING_PIN_TTL_MS) {
      this.config.regeneratePin();
      this.pinLimiter.reset();
      this.bus.emit('pairing.changed', { at: Date.now() });
      return { ok: false, error: 'pairing pin expired; refresh the PC pairing screen' };
    }
    if (pin !== this.config.pin) {
      this.pinLimiter.recordFailure(clientKey);
      return { ok: false, error: 'invalid pin' };
    }
    this.pinLimiter.recordSuccess(clientKey);
    const allowed: PermissionMode[] = ['read-only', 'ask', 'workspace', 'full'];
    const requested = allowed.includes(permissionCap) ? permissionCap : 'ask';
    // Possession of a short PIN/QR proves proximity, not authorization for
    // unattended writes or administration. Higher access is granted later in
    // the local PC's connected-device settings.
    // A PIN proves possession of the short-lived enrollment code only. Never
    // let a modified client bootstrap workspace/full access, even when the
    // PC's global ceiling is permissive. The local administrator can elevate
    // this device explicitly after reviewing it in Connected devices.
    const cap = effectiveMode(this.config.settings.safety.mode, effectiveMode(requested, 'ask'));
    const created = this.config.createDeviceLink(deviceName, cap);
    // A displayed PIN enrolls exactly one device. Rotate after successful
    // exchange so screenshots and shoulder-surfed codes cannot be replayed.
    this.config.regeneratePin();
    this.pinLimiter.reset();
    this.bus.emit('pairing.changed', { at: Date.now() });
    return { ok: true, secret: created.token, linkId: created.link.id };
  }

  // -- network info -------------------------------------------------------

  /** Best-effort LAN IPv4 (what phones should dial). Prefers physical adapters. */
  lanAddress(): string {
    const preferred: string[] = [];
    const fallback: string[] = [];
    for (const [name, infos] of Object.entries(networkInterfaces())) {
      const n = name.toLowerCase();
      // Skip virtual adapters: WSL/Hyper-V/Docker/VPN etc. would mislead the phone.
      if (/vethernet|virtual|wsl|loopback|bluetooth|hamachi|radmin|tailscale|zerotier|wireguard|vpn|vmware|hyper-v|docker|pseudo/i.test(n)) {
        continue;
      }
      for (const info of infos ?? []) {
        if (info.family === 'IPv4' && !info.internal) {
          if (/wi-?fi|wlan|ethernet|en\d|wireless|lan/i.test(n)) preferred.push(info.address);
          else fallback.push(info.address);
        }
      }
    }
    return preferred[0] ?? fallback[0] ?? osHostname();
  }

  /** Tailscale's CGNAT IPv4 addresses become the automatic off-LAN fallback. */
  tailnetAddresses(): string[] {
    const addresses: string[] = [];
    for (const [name, infos] of Object.entries(networkInterfaces())) {
      if (!/tailscale/i.test(name)) continue;
      for (const info of infos ?? []) {
        if (info.family !== 'IPv4' || info.internal) continue;
        const octets = info.address.split('.').map(Number);
        const isTailscaleCgnat = octets.length === 4
          && octets[0] === 100
          && octets[1] >= 64
          && octets[1] <= 127
          && octets.every(Number.isInteger);
        if (isTailscaleCgnat) addresses.push(info.address);
      }
    }
    return [...new Set(addresses)];
  }

  pairingInfo(includeLocalSecret = false, includePairingCode = false): PairingInfo {
    if (includePairingCode && Date.now() - this.config.pinCreatedAt > PAIRING_PIN_TTL_MS) {
      this.config.regeneratePin();
      this.pinLimiter.reset();
    }
    const port = this.boundPort || this.config.settings.network.port;
    const lanShared = this.boundHost === '0.0.0.0' || this.boundHost === '::';
    // Plain LAN credentials are intentionally disabled. The generic pairing
    // QR advertises only loopback or an encrypted Tailscale address; Quick
    // Link displays its temporary HTTPS address in the plugin panel.
    const tailnet = lanShared ? this.tailnetAddresses() : [];
    const host = tailnet[0] ?? '127.0.0.1';
    const hosts = tailnet.length > 0 ? tailnet : [host];
    return {
      deviceName: this.config.settings.deviceName,
      host,
      hosts,
      port,
      maskedSecret: maskSecret(this.secret),
      ...(includePairingCode ? {
        pin: this.config.pin,
        pinExpiresAt: this.config.pinCreatedAt + PAIRING_PIN_TTL_MS,
        qrPayload: pairingPayload(host, port, this.config.pin, hosts),
      } : {}),
      ...(includeLocalSecret ? { localSecret: this.secret } : {}),
    };
  }

  // -- status -------------------------------------------------------------

  status(): SystemStatus {
    const win = platform() === 'win32';
    return {
      ok: true,
      hostname: osHostname(),
      platform: platform(),
      arch: process.arch,
      version: VERSION,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      capabilities: { shell: true, files: true, input: win, screen: win },
      defaultProviderId: this.registry.default()?.id ?? null,
      providers: this.registry.list().length,
      plugins: this.plugins.list().length,
      network: { ...this.config.settings.network, host: this.boundHost || this.config.settings.network.host, port: this.boundPort || this.config.settings.network.port },
    };
  }

  // -- settings -----------------------------------------------------------

  getSettings(): AppSettings {
    return this.config.settings;
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const updated = this.config.updateSettings(patch);
    this.bus.emit('settings.changed', updated);
    return updated;
  }

  workspacesList(): WorkspaceInfo[] {
    return this.config.workspaces;
  }

  workspaceAdd(path: string, name?: string): WorkspaceInfo {
    const info = this.config.addWorkspace(path, name);
    this.bus.emit('workspaces.changed', this.config.workspaces);
    return info;
  }

  async dependencyStatus(): Promise<DependencyReport> {
    return {
      completedAt: this.config.settings.setup.dependencyWizardCompletedAt ?? null,
      wizardVersion: this.config.settings.setup.dependencyWizardVersion ?? 0,
      packageManagerAvailable: await this.dependencies.packageManagerAvailable(),
      items: await this.dependencies.status(),
    };
  }

  async installDependency(id: DependencyId): Promise<DependencyInstallResult> {
    return this.dependencies.install(id);
  }

  // -- providers ----------------------------------------------------------

  providersList(): ProviderInfo[] {
    return this.registry.list();
  }

  providersAdd(input: ProviderAddInput): ProviderInfo {
    const info = this.registry.add(input);
    this.bus.emit('providers.changed', this.registry.list());
    return info;
  }

  providersRemove(id: string): void {
    this.registry.remove(id);
    this.bus.emit('providers.changed', this.registry.list());
  }

  providersSetDefault(id: string): void {
    this.registry.setDefault(id);
    this.bus.emit('providers.changed', this.registry.list());
  }

  async providersTest(id: string): Promise<{ ok: boolean; error?: string }> {
    return this.registry.test(id);
  }

  async providersModels(id: string): Promise<string[]> {
    return this.registry.models(id);
  }

  providersUpdateModel(id: string, model: string): ProviderInfo {
    const info = this.registry.updateModel(id, model);
    this.bus.emit('providers.changed', this.registry.list());
    return info;
  }

  // -- plugins ------------------------------------------------------------

  pluginsList(): PluginInfo[] {
    return this.plugins.list();
  }

  async pluginsLoad(source: string): Promise<PluginInfo> {
    return this.plugins.load(source);
  }

  async pluginsUnload(id: string): Promise<boolean> {
    return this.plugins.unload(id);
  }

  async pluginsCall(name: string, params: unknown, auth?: AuthContext): Promise<unknown> {
    const permissionMode = effectiveMode(this.config.settings.safety.mode, auth?.permissionCap);
    if (this.plugins.isAdminOnly(name) && !auth?.isAdmin) throw new Error('이 플러그인 설정은 관리자 권한이 필요합니다.');
    if (this.plugins.isDestructive(name) && !auth?.isAdmin && permissionMode !== 'full') {
      throw new Error('직접 변경형 플러그인 호출은 전체 허용 모드가 필요합니다. 대화에서 위임하면 현재 권한 정책에 따라 승인됩니다.');
    }
    return this.plugins.call(name, params, {
      permissionMode,
      destructiveApproved: auth?.isAdmin === true || !this.plugins.isDestructive(name) || permissionMode === 'full',
      approvalSource: this.plugins.isDestructive(name) ? 'policy' : 'not-required',
    });
  }

  // -- chat (non-streaming, REST) ----------------------------------------

  async chatOnce(text: string, auth: AuthContext): Promise<{ text: string }> {
    const permissionMode = effectiveMode(this.config.settings.safety.mode, auth.permissionCap);
    const result = await this.loop.run([], text, {}, this.plugins.aiTools(text), { permissionMode });
    return { text: result.text };
  }

  getRouting(): RoutingSettings {
    return this.config.routing;
  }

  updateRouting(patch: Partial<RoutingSettings>): RoutingSettings {
    const updated = this.config.updateRouting(patch);
    this.bus.emit('routing.changed', updated);
    return updated;
  }

  routingPresetsList(): RoutingPreset[] {
    return this.config.routingPresets;
  }

  saveRoutingPreset(name: string, description = '', id?: string): RoutingPreset {
    const preset = this.config.saveRoutingPreset(name, description, id);
    this.bus.emit('routing.presets.changed', this.config.routingPresets);
    this.bus.emit('routing.changed', this.config.routing);
    return preset;
  }

  applyRoutingPreset(id: string): RoutingSettings {
    const routing = this.config.applyRoutingPreset(id);
    this.bus.emit('routing.changed', routing);
    return routing;
  }

  deleteRoutingPreset(id: string): boolean {
    const deleted = this.config.deleteRoutingPreset(id);
    if (deleted) {
      this.bus.emit('routing.presets.changed', this.config.routingPresets);
      this.bus.emit('routing.changed', this.config.routing);
    }
    return deleted;
  }

  // -- lifecycle ----------------------------------------------------------

  async start(opts: StartOptions = {}): Promise<{ host: string; port: number }> {
    if (this.httpServer) return { host: this.boundHost, port: this.boundPort };
    await this.plugins.loadBuiltin(createOrcaPlugin());
    await this.plugins.loadBuiltin(createCalendarPlugin());
    await this.plugins.loadBuiltin(createRemoteLinkPlugin());
    await this.plugins.loadBuiltin(createTailscalePlugin());
    await this.plugins.loadBuiltin(createDockerPlugin());
    await this.plugins.loadBuiltin(createCtfPlugin());
    await this.plugins.loadBuiltin(createMcpPlugin());
    await this.plugins.loadBuiltin(createVoicePlugin());
    const settings = this.config.settings.network;
    // A persisted 0.0.0.0 value never opens the LAN unless the separate
    // externalAccess consent is also enabled. Explicit StartOptions remain
    // available to tests and advanced self-hosted launchers.
    const host = opts.host ?? (settings.externalAccess && settings.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1');
    const port = opts.port ?? settings.port;

    const app = createHttpApi(this, opts.webDir, this.activeHttpTransfers);
    this.httpServer = createServer(app);

    try {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.once('error', reject);
        this.httpServer!.listen(port, host, () => resolve());
      });
    } catch (error) {
      try { this.httpServer.close(); } catch { /* never started */ }
      this.httpServer = null;
      await this.plugins.unloadAll();
      throw error;
    }

    const addr = this.httpServer.address() as AddressInfo;
    this.boundHost = addr.address;
    this.boundPort = addr.port;
    this.startedAt = Date.now();

    this.hub = new WsHub(this.httpServer, this.handlers(), (s) => this.authenticate(s), this.logger);
    this.scheduler.start();

    // Server-wide pushes (only to authenticated clients). Keep every disposer
    // so start -> stop -> start cannot multiply broadcast listeners.
    for (const unsubscribe of this.busSubscriptions.splice(0)) unsubscribe();
    const forward = (event: string): void => {
      const audience = serverEventAudience(event);
      if (audience === 'none') return;
      this.busSubscriptions.push(this.bus.on(event, (data) => {
        if (audience === 'admin') this.hub?.broadcastAdmin(event, data);
        else this.hub?.broadcast(event, data);
      }));
    };
    [
      'log', 'plugins.changed', 'providers.changed', 'settings.changed',
      'dependencies.changed',
      'routing.changed', 'routing.presets.changed', 'conversations.changed',
      'memory.changed', 'scheduler.changed', 'scheduler.ran', 'workspaces.changed',
      'calendar.changed', 'voice.wake', 'voice.command', 'voice.command.ready',
      'voice.command.timeout', 'voice.status', 'pairing.changed',
    ].forEach(forward);

    this.logger.info(`listening on http://${this.boundHost}:${this.boundPort}`);
    return { host: this.boundHost, port: this.boundPort };
  }

  async stop(): Promise<void> {
    this.scheduler.stop();
    for (const run of this.activeRuns.values()) run.session.cancel();
    for (const transfer of this.activeHttpTransfers) {
      if (!transfer.signal.aborted) transfer.abort(new Error('Mr.Robot Agent가 종료되어 전송을 중단했습니다.'));
    }
    this.activeHttpTransfers.clear();
    this.hub?.close();
    this.hub = null;
    for (const unsubscribe of this.busSubscriptions.splice(0)) unsubscribe();

    const server = this.httpServer;
    this.httpServer = null;
    const serverClosed = server
      ? new Promise<void>((resolve) => server.close(() => resolve()))
      : Promise.resolve();
    const deadline = Date.now() + 5_000;
    while (this.activeRuns.size > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 25);
        timer.unref?.();
      });
    }
    // Runs are cancelled and reaped before plugin code is deactivated.
    await this.plugins.unloadAll();
    await serverClosed;
    this.busyConversations.clear();
    this.activeRuns.clear();
    this.startedAt = 0;
    this.boundPort = 0;
    this.logger.info('stopped');
  }

  /** Cancel every interactive run without shutting down the local agent. */
  cancelAllRuns(): number {
    const runs = [...this.activeRuns.values()];
    for (const run of runs) run.session.cancel();
    return runs.length;
  }

  /** Permission/revocation changes take effect for already-open sockets too. */
  private invalidateDeviceLink(linkId: string): void {
    for (const run of this.activeRuns.values()) {
      if (run.ownerLinkId === linkId) run.session.cancel();
    }
    this.hub?.disconnectLink(linkId);
  }

  // -- RPC handlers -------------------------------------------------------

  private handlers(): Map<string, RpcHandler> {
    const h = new Map<string, RpcHandler>();
    const p = (params: unknown) => (params ?? {}) as Record<string, unknown>;
    const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
    const assertAdmin = (client: WsClient): void => {
      if (!client.state.auth?.isAdmin) throw new Error('관리자 권한이 필요한 설정입니다.');
    };
    const assertDirectWrite = (client: WsClient): void => {
      if (effectiveMode(this.config.settings.safety.mode, client.state.auth?.permissionCap) !== 'full') {
        throw new Error('직접 PC 조작은 전체 허용 모드에서만 사용할 수 있습니다. 에이전트 대화를 사용하면 권한 정책에 따라 승인됩니다.');
      }
    };
    const directReadPath = (client: WsClient, value: unknown): string => {
      const mode = effectiveMode(this.config.settings.safety.mode, client.state.auth?.permissionCap);
      if (mode === 'full') return str(value);
      if (mode !== 'workspace') {
        throw new Error('직접 파일 조회는 작업 폴더 허용 또는 전체 허용 모드에서만 사용할 수 있습니다.');
      }
      return resolveRegisteredWorkspacePath(this.config.workspaces.map((workspace) => workspace.path), value);
    };
    const assertScreenView = (client: WsClient): void => {
      if (effectiveMode(this.config.settings.safety.mode, client.state.auth?.permissionCap) !== 'full') {
        throw new Error('화면 보기와 스트리밍은 전체 허용 모드에서만 사용할 수 있습니다.');
      }
    };
    const clientPermission = (client: WsClient, requested?: PermissionMode, fallback: PermissionMode = 'ask'): PermissionMode => (
      effectiveMode(
        this.config.settings.safety.mode,
        effectiveMode(requested ?? fallback, client.state.auth?.permissionCap),
      )
    );
    const assertContentWrite = (client: WsClient): void => {
      if (clientPermission(client) === 'read-only') {
        throw new Error('이 기기는 읽기 전용입니다. 대화·기억·예약 데이터를 변경할 수 없습니다.');
      }
    };
    const canControlRun = (client: WsClient, run: { ownerClientId: string; ownerLinkId?: string }): boolean => (
      client.state.auth?.isAdmin === true
      || run.ownerClientId === client.id
      || (Boolean(run.ownerLinkId) && run.ownerLinkId === client.state.auth?.linkId)
    );
    const assertRunControl = (client: WsClient, run: { ownerClientId: string; ownerLinkId?: string }): void => {
      if (!canControlRun(client, run)) {
        throw new Error('이 작업을 시작한 기기 또는 관리자만 작업을 제어할 수 있습니다.');
      }
    };

    h.set('status', () => this.status());
    h.set('pairing.info', (_params, client) => this.pairingInfo(false, client.state.auth?.isAdmin === true));
    h.set('pairing.links', (_params, client) => {
      assertAdmin(client);
      return this.config.deviceLinks.map(({ tokenHash: _tokenHash, ...link }) => link);
    });
    h.set('pairing.link.update', (params, client) => {
      assertAdmin(client);
      const body = p(params);
      const capabilities = Array.isArray(body.capabilities)
        ? body.capabilities.filter((item): item is DeviceCapability => item === 'work-sync')
        : undefined;
      const updated = this.config.patchDeviceLink(str(body.id), {
        name: typeof body.name === 'string' ? body.name : undefined,
        permissionCap: typeof body.permissionCap === 'string' ? body.permissionCap as PermissionMode : undefined,
        capabilities,
      });
      if (updated && (body.permissionCap !== undefined || body.capabilities !== undefined)) {
        this.invalidateDeviceLink(updated.id);
      }
      return updated;
    });
    h.set('pairing.link.revoke', (params, client) => {
      assertAdmin(client);
      const id = str(p(params).id);
      const ok = this.config.revokeDeviceLink(id);
      if (ok) this.invalidateDeviceLink(id);
      return { ok };
    });
    h.set('pairing.regenerate', (_params, client) => {
      assertAdmin(client);
      const secret = this.config.regenerateSecret();
      const pin = this.config.regeneratePin();
      this.pinLimiter.reset();
      this.bus.emit('pairing.changed', { at: Date.now() });
      this.logger.info('pairing credentials rotated (all clients must re-authenticate)');
      // Let the direct RPC response flush, then invalidate even the calling
      // local Electron socket. It will obtain the new bootstrap secret over
      // isolated IPC when its connection gate comes back.
      const invalidateTimer = setTimeout(() => {
        this.cancelAllRuns();
        this.hub?.disconnectAuthenticated();
      }, 0);
      invalidateTimer.unref?.();
      return { secret, pin };
    });
    h.set('pairing.regeneratePin', (_params, client) => {
      assertAdmin(client);
      const pin = this.config.regeneratePin();
      this.pinLimiter.reset();
      this.bus.emit('pairing.changed', { at: Date.now() });
      this.logger.info('pairing pin rotated');
      return { pin };
    });

    h.set('settings.get', () => this.getSettings());
    h.set('settings.set', (params, client) => { assertAdmin(client); return this.updateSettings(p(params) as Partial<AppSettings>); });
    h.set('workspaces.list', () => this.workspacesList());
    h.set('workspaces.add', (params, client) => {
      assertAdmin(client);
      const body = p(params);
      return this.workspaceAdd(str(body.path), typeof body.name === 'string' ? body.name : undefined);
    });
    h.set('workspaces.remove', (params, client) => {
      assertAdmin(client);
      const ok = this.config.removeWorkspace(str(p(params).id));
      if (ok) this.bus.emit('workspaces.changed', this.config.workspaces);
      return { ok };
    });
    h.set('workspaces.setDefault', (params, client) => {
      assertAdmin(client);
      const selected = this.config.setDefaultWorkspace(str(p(params).id));
      this.bus.emit('workspaces.changed', this.config.workspaces);
      return selected;
    });
    h.set('context.cache.stats', () => this.contextBroker.stats());
    h.set('context.cache.clear', (_params, client) => { assertAdmin(client); this.contextBroker.invalidate(); return { ok: true }; });
    h.set('dependencies.status', () => this.dependencyStatus());
    h.set('dependencies.install', async (params, client) => {
      assertAdmin(client);
      const id = str(p(params).id);
      if (!this.dependencies.has(id)) throw new Error('지원하지 않는 의존성입니다.');
      return this.installDependency(id);
    });
    h.set('dependencies.complete', (_params, client) => {
      assertAdmin(client);
      return this.updateSettings({ setup: { dependencyWizardCompletedAt: Date.now(), dependencyWizardVersion: 4 } });
    });
    h.set('routing.get', () => this.getRouting());
    h.set('routing.set', (params, client) => { assertAdmin(client); return this.updateRouting(p(params) as Partial<RoutingSettings>); });
    h.set('routing.presets.list', () => this.routingPresetsList());
    h.set('routing.presets.save', (params, client) => {
      assertAdmin(client);
      const body = p(params);
      return this.saveRoutingPreset(str(body.name), str(body.description), typeof body.id === 'string' ? body.id : undefined);
    });
    h.set('routing.presets.apply', (params, client) => { assertAdmin(client); return this.applyRoutingPreset(str(p(params).id)); });
    h.set('routing.presets.delete', (params, client) => { assertAdmin(client); return { ok: this.deleteRoutingPreset(str(p(params).id)) }; });

    h.set('providers.list', () => this.providersList());
    h.set('providers.add', (params, client) => { assertAdmin(client); return this.providersAdd(p(params) as unknown as ProviderAddInput); });
    h.set('providers.remove', (params, client) => { assertAdmin(client); return this.providersRemove(str(p(params).id)); });
    h.set('providers.setDefault', (params, client) => { assertAdmin(client); return this.providersSetDefault(str(p(params).id)); });
    h.set('providers.test', async (params, client) => { assertAdmin(client); return this.providersTest(str(p(params).id)); });
    h.set('providers.models', async (params, client) => { assertAdmin(client); return this.providersModels(str(p(params).id)); });
    h.set('providers.updateModel', (params, client) => { assertAdmin(client); return this.providersUpdateModel(str(p(params).id), str(p(params).model)); });

    h.set('plugins.list', () => this.pluginsList());
    h.set('plugins.load', async (params, client) => { assertAdmin(client); return this.plugins.load(str(p(params).path)); });
    h.set('plugins.unload', async (params, client) => { assertAdmin(client); return this.plugins.unload(str(p(params).id)); });
    h.set('plugins.setEnabled', (params, client) => { assertAdmin(client); return this.plugins.setEnabled(str(p(params).id), p(params).enabled === true); });
    h.set('plugins.call', (params, client) => this.pluginsCall(str(p(params).name), p(params).params, client.state.auth ?? undefined));

    // ---- persistent conversations and retained memory ----
    h.set('conversations.list', (params) => {
      const status = str(p(params).status) as ConversationStatus;
      return this.conversations.list(status === 'active' || status === 'archived' ? status : undefined);
    });
    h.set('conversations.create', (params, client) => {
      assertContentWrite(client);
      const input = p(params) as ConversationCreateInput;
      const requested = ['read-only', 'ask', 'workspace', 'full'].includes(String(input.permissionMode)) ? input.permissionMode : undefined;
      const created = this.conversations.create({ ...input, permissionMode: clientPermission(client, requested) });
      this.bus.emit('conversations.changed', this.conversations.list());
      return created;
    });
    h.set('conversations.get', (params) => {
      const item = this.conversations.get(str(p(params).id));
      if (!item) throw new Error('conversation not found');
      return item;
    });
    h.set('conversations.update', (params, client) => {
      assertContentWrite(client);
      const body = p(params);
      const requestedPermission = ['read-only', 'ask', 'workspace', 'full'].includes(String(body.permissionMode)) ? body.permissionMode as PermissionMode : undefined;
      const item = this.conversations.update(str(body.id), {
        title: typeof body.title === 'string' ? body.title : undefined,
        status: body.status === 'archived' ? 'archived' : body.status === 'active' ? 'active' : undefined,
        pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
        reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort as ReasoningEffort : undefined,
        providerId: body.providerId === null || typeof body.providerId === 'string' ? body.providerId : undefined,
        providerModel: body.providerModel === null || typeof body.providerModel === 'string' ? body.providerModel : undefined,
        routingPresetId: body.routingPresetId === null || typeof body.routingPresetId === 'string' ? body.routingPresetId : undefined,
        workspaceId: body.workspaceId === null || typeof body.workspaceId === 'string' ? body.workspaceId : undefined,
        permissionMode: requestedPermission ? clientPermission(client, requestedPermission) : undefined,
      });
      this.bus.emit('conversations.changed', this.conversations.list());
      return item;
    });
    h.set('conversations.delete', (params, client) => {
      assertContentWrite(client);
      const ok = this.conversations.delete(str(p(params).id));
      this.bus.emit('conversations.changed', this.conversations.list());
      return { ok };
    });
    h.set('memory.list', () => this.memory.list());
    h.set('memory.add', (params, client): MemoryItem => {
      assertContentWrite(client);
      const body = p(params);
      const item = this.memory.add(str(body.text), Array.isArray(body.tags) ? body.tags.map(String) : []);
      this.bus.emit('memory.changed', this.memory.list());
      return item;
    });
    h.set('memory.remove', (params, client) => {
      assertContentWrite(client);
      const ok = this.memory.remove(str(p(params).id));
      this.bus.emit('memory.changed', this.memory.list());
      return { ok };
    });
    h.set('telemetry.summary', () => this.telemetry.summary());
    h.set('telemetry.list', (params) => this.telemetry.list(Math.min(500, Number(p(params).limit) || 100)));

    // ---- scheduler ----
    h.set('scheduler.list', (_params, client) => {
      assertAdmin(client);
      return this.scheduler.list();
    });
    h.set('scheduler.add', (params, client) => {
      assertAdmin(client);
      const b = p(params);
      return this.scheduler.add({
        name: str(b.name, '예약 작업'),
        type: (b.type as 'chat' | 'shell' | 'launch') ?? 'chat',
        prompt: typeof b.prompt === 'string' ? b.prompt : undefined,
        command: typeof b.command === 'string' ? b.command : undefined,
        shellKind: b.shellKind === 'cmd' ? 'cmd' : 'powershell',
        target: typeof b.target === 'string' ? b.target : undefined,
        args: Array.isArray(b.args) ? (b.args as unknown[]).map(String) : undefined,
        when: {
          kind: b.whenKind === 'once' ? 'once' : 'daily',
          at: str(b.at),
          days: Array.isArray(b.days) ? (b.days as unknown[]).map(Number) : undefined,
        },
        allowDestructive: b.allowDestructive === true,
        permissionMode: 'full',
        createdByAdmin: true,
      });
    });
    h.set('scheduler.remove', (params, client) => {
      assertAdmin(client);
      return this.scheduler.remove(str(p(params).id));
    });
    h.set('scheduler.setEnabled', (params, client) => {
      assertAdmin(client);
      return this.scheduler.setEnabled(str(p(params).id), p(params).enabled === true);
    });

    // ---- chat (streaming over events) ----
    h.set('chat.start', async (params, client) => {
      const body = p(params);
      const text = str(body.text);
      const session = client.state.chat;
      if (session.busy) throw new Error('chat already running');
      let conversationId = str(body.conversationId) || session.conversationId;
      if (!conversationId || !this.conversations.get(conversationId)) {
        const requestedPermission = ['read-only', 'ask', 'workspace', 'full'].includes(String(body.permissionMode)) ? body.permissionMode as PermissionMode : undefined;
        conversationId = this.conversations.create({
          reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort as ReasoningEffort : 'auto',
          providerId: typeof body.providerId === 'string' ? body.providerId : undefined,
          providerModel: typeof body.providerModel === 'string' ? body.providerModel : undefined,
          routingPresetId: typeof body.routingPresetId === 'string' ? body.routingPresetId : undefined,
          permissionMode: clientPermission(client, requestedPermission),
        }).id;
      }
      if (this.busyConversations.has(conversationId)) throw new Error('conversation is already running on another client');
      session.conversationId = conversationId;
      const conversation = this.conversations.get(conversationId) as ConversationDetail;
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : conversation.workspaceId;
      const workspace = this.config.workspaces.find((item) => item.id === workspaceId)
        ?? this.config.workspaces.find((item) => item.isDefault);
      const routingPresetId = typeof body.routingPresetId === 'string' ? body.routingPresetId : conversation.routingPresetId;
      const conversationRouting = routingPresetId ? this.config.routingForPreset(routingPresetId) : null;
      if (routingPresetId && !conversationRouting) throw new Error('이 대화의 모델 시나리오가 삭제되었습니다. 다른 시나리오를 선택하세요.');
      const effectivePermissionMode = effectiveMode(
        this.config.settings.safety.mode,
        effectiveMode(
          ['read-only', 'ask', 'workspace', 'full'].includes(String(body.permissionMode)) ? body.permissionMode as PermissionMode : conversation.permissionMode,
          client.state.auth?.permissionCap,
        ),
      );
      this.busyConversations.add(conversationId);
      session.begin();
      const runStartedAt = Date.now();
      this.activeRuns.set(conversationId, {
        session,
        startedAt: runStartedAt,
        status: '시작 중',
        ownerClientId: client.id,
        ownerLinkId: client.state.auth?.linkId,
        permissionMode: effectivePermissionMode,
      });
      const sendRunEvent = (event: string, data: unknown): void => {
        const run = this.activeRuns.get(conversationId);
        if (!run) return;
        for (const target of this.hub?.clients ?? []) {
          if (target.state.authed && canControlRun(target, run)) target.sendEvent(event, data);
        }
      };
      try {
        const extraTools = this.plugins.aiTools(text);
        const retained = [
          conversation.summary ? `이전 대화 압축 요약:\n${conversation.summary}` : '',
          this.memory.context(text) ? `사용자가 저장한 장기 기억:\n${this.memory.context(text)}` : '',
        ].filter(Boolean).join('\n\n');
        const result = await this.loop.run(
          this.conversations.turns(conversationId),
          text,
          {
            signal: session.signal(),
            onText: (delta) => sendRunEvent('chat.delta', { conversationId, text: delta }),
            onTool: (info) => sendRunEvent('chat.tool', { conversationId, ...info }),
            onStatus: (status) => {
              const active = this.activeRuns.get(conversationId);
              if (active) active.status = status;
              sendRunEvent('chat.status', { conversationId, status });
            },
            takeSteering: () => session.takeSteering(),
            confirm: (req) => session.askConfirm(sendRunEvent, {
              ...req,
              conversationId,
              conversationTitle: conversation.title,
            }),
          },
          extraTools,
          {
            providerId: routingPresetId ? undefined : typeof body.providerId === 'string' ? body.providerId : conversation.providerId,
            providerModel: routingPresetId ? undefined : typeof body.providerModel === 'string' ? body.providerModel : conversation.providerModel,
            reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort as ReasoningEffort : conversation.reasoningEffort,
            context: retained,
            permissionMode: effectivePermissionMode,
            routing: conversationRouting,
            workspacePath: workspace?.path,
            cacheKey: `mrrobot:${conversationId}`,
          },
        );
        session.turns = result.turns;
        const updated = this.conversations.appendResult(conversationId, result.turns, result.usage);
        const providerConfig = result.route ? this.config.providers.find((provider) => provider.id === result.route?.providerId) : undefined;
        const estimatedCost = ((result.usage.promptTokens * (providerConfig?.inputCostPerMillion ?? 0)) + (result.usage.completionTokens * (providerConfig?.outputCostPerMillion ?? 0))) / 1_000_000;
        this.telemetry.record({
          id: randomUUID(), at: Date.now(), conversationId, providerId: result.route?.providerId, providerLabel: result.route?.providerLabel,
          model: result.route?.model, role: result.route?.role, effort: result.route?.effort,
          promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens,
          cachedPromptTokens: result.usage.cachedPromptTokens,
          cacheWritePromptTokens: result.usage.cacheWritePromptTokens,
          reasoningTokens: result.usage.reasoningTokens,
          toolCalls: result.turns.reduce((sum, turn) => sum + (turn.toolCalls?.length ?? 0), 0), latencyMs: Date.now() - runStartedAt,
          estimatedCost, ok: true,
        });
        this.bus.emit('conversations.changed', this.conversations.list());
        sendRunEvent('chat.done', { conversationId, text: result.text, usage: result.usage, route: result.route, conversation: updated });
        return { ok: true, conversationId, text: result.text, route: result.route };
      } catch (err) {
        const rawMessage = err instanceof Error ? err.message : String(err);
        // Only label an error as a user cancellation when this run's abort
        // signal was actually triggered. Provider/network errors containing
        // the word "aborted" must remain visible for diagnosis and retry.
        const message = session.signal()?.aborted || /^작업이 중지되었습니다\.?$/i.test(rawMessage.trim())
          ? '작업이 중지되었습니다.'
          : rawMessage;
        this.telemetry.record({ id: randomUUID(), at: Date.now(), conversationId, promptTokens: 0, completionTokens: 0, toolCalls: 0, latencyMs: Date.now() - runStartedAt, estimatedCost: 0, ok: false, error: message.slice(0, 500) });
        sendRunEvent('chat.error', { conversationId, message });
        return { ok: false, error: message };
      } finally {
        session.end();
        this.busyConversations.delete(conversationId);
        this.activeRuns.delete(conversationId);
      }
    });
    h.set('chat.cancel', (params, client) => {
      const conversationId = str(p(params).conversationId) || client.state.chat.conversationId || '';
      const run = conversationId ? this.activeRuns.get(conversationId) : undefined;
      if (run) {
        assertRunControl(client, run);
        run.session.cancel();
      } else if (!conversationId || conversationId === client.state.chat.conversationId) {
        client.state.chat.cancel();
      }
      return { ok: true };
    });
    h.set('chat.steer', (params, client) => {
      const body = p(params);
      const conversationId = str(body.conversationId);
      const run = this.activeRuns.get(conversationId);
      if (!run) throw new Error('이 대화에서 실행 중인 작업이 없습니다.');
      assertRunControl(client, run);
      const queued = run.session.steer(str(body.text));
      return { ok: true, queued };
    });
    h.set('chat.runs', (_params, client): ChatRunState[] => [...this.activeRuns.entries()]
      .filter(([, run]) => canControlRun(client, run))
      .map(([conversationId, run]) => ({
        conversationId, running: true, startedAt: run.startedAt, status: run.status, steeringQueued: run.session.steeringQueued,
      })));
    h.set('chat.pendingConfirm', (params, client) => {
      const conversationId = str(p(params).conversationId);
      const run = this.activeRuns.get(conversationId);
      if (!run) return null;
      // Approval summaries can contain commands and paths. Never return one
      // until the same paired-device identity (or the local admin) is proven.
      assertRunControl(client, run);
      return run.session.pendingConfirmForOwner() ?? null;
    });
    h.set('chat.confirmResponse', (params, client) => {
      const body = p(params);
      const conversationId = str(body.conversationId);
      const run = this.activeRuns.get(conversationId);
      if (!run) return { ok: false };
      assertRunControl(client, run);
      const handled = run.session.respondConfirm(str(body.requestId), conversationId, body.approve === true);
      return { ok: handled };
    });
    h.set('chat.clear', (_params, client) => {
      client.state.chat.turns = [];
      client.state.chat.conversationId = null;
      return { ok: true };
    });

    // ---- computer (remote-control mode runs directly; the human is the approval) ----
    h.set('computer.shell', async (params, client) => {
      assertDirectWrite(client);
      const b = p(params);
      const res: ShellResult = await computer.shell(str(b.command), {
        shell: b.shell === 'cmd' ? 'cmd' : 'powershell',
        cwd: b.cwd ? str(b.cwd) : undefined,
        timeoutMs: typeof b.timeoutMs === 'number' ? b.timeoutMs : 30000,
      });
      return res;
    });
    h.set('computer.fs.list', (params, client) => {
      const b = p(params);
      return computer.fs.list(directReadPath(client, b.path));
    });
    h.set('computer.fs.read', (params, client) => {
      const b = p(params);
      return computer.fs.read(directReadPath(client, b.path), typeof b.maxBytes === 'number' ? b.maxBytes : 20000);
    });
    h.set('computer.fs.write', (params, client) => {
      assertDirectWrite(client);
      const b = p(params);
      return computer.fs.write(str(b.path), str(b.content), b.append === true);
    });
    h.set('computer.fs.delete', (params, client) => {
      assertDirectWrite(client);
      const b = p(params);
      return computer.fs.delete(str(b.path), b.recursive === true);
    });
    h.set('computer.fs.move', (params, client) => {
      assertDirectWrite(client);
      const b = p(params);
      return computer.fs.move(str(b.from), str(b.to));
    });
    h.set('computer.app.launch', (params, client) => {
      assertDirectWrite(client);
      const b = p(params);
      return computer.app.launch(str(b.target), Array.isArray(b.args) ? (b.args as unknown[]).map(String) : []);
    });
    h.set('computer.input.move', (params, client) => {
      assertDirectWrite(client);
      const b = p(params);
      return computer.input.move(Number(b.x), Number(b.y));
    });
    h.set('computer.input.click', (params, client) => {
      assertDirectWrite(client);
      const b = p(params);
      return computer.input.click(
        (b.button as 'left' | 'right' | 'middle') ?? 'left',
        b.x !== undefined ? Number(b.x) : undefined,
        b.y !== undefined ? Number(b.y) : undefined,
        typeof b.clicks === 'number' ? b.clicks : 1,
      );
    });
    h.set('computer.input.scroll', (params, client) => {
      assertDirectWrite(client);
      const b = p(params);
      return computer.input.scroll(Number(b.delta ?? 0));
    });
    h.set('computer.input.type', (params, client) => {
      assertDirectWrite(client);
      const b = p(params);
      return computer.input.type(str(b.text));
    });
    h.set('computer.input.key', (params, client) => {
      assertDirectWrite(client);
      const b = p(params);
      return computer.input.key(str(b.key), Array.isArray(b.modifiers) ? (b.modifiers as unknown[]).map(String) : []);
    });
    h.set('computer.screen.capture', (params, client) => {
      assertScreenView(client);
      const b = p(params);
      return computer.screen.capture(typeof b.quality === 'number' ? b.quality : 60);
    });
    h.set('computer.screen.size', async (): Promise<ScreenSize> => computer.screen.size());

    // ---- screen streaming (remote-control) ----
    h.set('computer.stream.start', (params, client) => {
      assertScreenView(client);
      const b = p(params);
      if (!client.state.stream) {
        client.state.stream = new ScreenStreamController((frame) => client.sendEvent('computer.stream.frame', frame));
      }
      client.state.stream.start(typeof b.fps === 'number' ? b.fps : 2, typeof b.quality === 'number' ? b.quality : 55);
      return { ok: true };
    });
    h.set('computer.stream.stop', (_params, client) => {
      client.state.stream?.stop();
      return { ok: true };
    });

    return h;
  }
}

export type { WsClient };
