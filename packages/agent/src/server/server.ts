import { createServer, type Server as HttpServer } from 'node:http';
import { networkInterfaces, hostname as osHostname, platform } from 'node:os';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type {
  AppSettings,
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
import { computer } from '../computer/index.js';
import { Scheduler, SchedulerStore } from '../scheduler.js';
import { DependencyManager } from '../dependencies.js';
import { ChatSession } from './chat.js';
import { ScreenStreamController } from './stream.js';
import { WsHub, WsClient, type AuthContext, type RpcHandler } from './ws.js';
import { createHttpApi, type PairingInfo } from './http.js';
import { ContextBroker } from '../context-broker.js';

export const VERSION = '0.2.0';

/** Rate limit for the PIN -> secret exchange (brute-force protection). */
class PinLimiter {
  private failures = 0;
  private windowStart = 0;
  private lockedUntil = 0;

  check(): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    if (this.lockedUntil > now) return { allowed: false, retryAfterMs: this.lockedUntil - now };
    if (now - this.windowStart > 60_000) {
      this.windowStart = now;
      this.failures = 0;
    }
    if (this.failures >= 5) {
      this.lockedUntil = now + 300_000;
      return { allowed: false, retryAfterMs: 300_000 };
    }
    return { allowed: true };
  }

  recordFailure(): void {
    this.failures++;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.windowStart = 0;
    this.lockedUntil = 0;
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
  private hub: WsHub | null = null;
  private pinLimiter = new PinLimiter();
  private startedAt = 0;
  private boundHost = '127.0.0.1';
  private boundPort = 0;
  private busyConversations = new Set<string>();
  private activeRuns = new Map<string, { session: ChatSession; startedAt: number; status: string }>();

  constructor() {
    this.conversations = new ConversationStore(this.config.dir);
    this.memory = new MemoryStore(this.config.dir);
    this.telemetry = new TelemetryStore(this.config.dir);
    this.contextBroker = new ContextBroker(this.config.dir);
    this.plugins = new PluginManager(this.bus, computer, this.registry, this.config, this.logger);
    this.executor = new ToolExecutor({
      computer,
      safety: () => this.config.settings.safety,
      runPluginTool: (name, params) => this.plugins.call(name, params),
      pluginToolDestructive: (name) => this.plugins.isDestructive(name),
      contextBroker: this.contextBroker,
    });
    this.router = new ModelRouter(this.registry, this.config);
    this.loop = new AgentLoop(this.registry, this.executor, this.router, this.contextBroker);
    this.scheduler = new Scheduler(new SchedulerStore(this.config), this.bus, computer, this.loop, this.logger);
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
    return auth.permissionCap === 'workspace' || auth.permissionCap === 'full';
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

  mergeSyncSnapshot(value: unknown): { conversations: { added: number; updated: number; unchanged: number }; routingPresets: { added: number; updated: number; unchanged: number } } {
    const snapshot = value as { version?: number; conversations?: unknown; routingPresets?: unknown };
    if (!snapshot || snapshot.version !== 1) throw new Error('지원하지 않는 동기화 형식입니다.');
    const conversations = this.conversations.mergeSnapshot(snapshot.conversations);
    const routingPresets = this.config.mergeRoutingPresets(snapshot.routingPresets);
    this.bus.emit('conversations.changed', this.conversations.list());
    this.bus.emit('routing.changed', this.config.routing);
    return { conversations, routingPresets };
  }

  isAdminSecret(candidate: string): boolean {
    return this.authenticate(candidate)?.isAdmin === true;
  }

  authenticate(candidate: string): AuthContext | null {
    if (!candidate) return null;
    if (safeEqual(candidate, this.secret)) return { isAdmin: true, permissionCap: 'full' };
    const link = this.config.findDeviceLink(candidate);
    if (!link) return null;
    return { isAdmin: link.permissionCap === 'full', linkId: link.id, permissionCap: link.permissionCap };
  }

  exchangePin(pin: string, deviceName = '연결된 기기', permissionCap: PermissionMode = 'ask'): { ok: boolean; secret?: string; linkId?: string; error?: string } {
    const check = this.pinLimiter.check();
    if (!check.allowed) return { ok: false, error: `too many attempts, retry in ${Math.ceil((check.retryAfterMs ?? 0) / 1000)}s` };
    if (pin !== this.config.pin) {
      this.pinLimiter.recordFailure();
      return { ok: false, error: 'invalid pin' };
    }
    this.pinLimiter.recordSuccess();
    const allowed: PermissionMode[] = ['read-only', 'ask', 'workspace', 'full'];
    const requested = allowed.includes(permissionCap) ? permissionCap : 'ask';
    const cap = effectiveMode(this.config.settings.safety.mode, requested);
    const created = this.config.createDeviceLink(deviceName, cap);
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

  pairingInfo(includeLocalSecret = false): PairingInfo {
    const port = this.boundPort || this.config.settings.network.port;
    const host = this.lanAddress();
    const hosts = [host, ...this.tailnetAddresses()];
    return {
      deviceName: this.config.settings.deviceName,
      host,
      hosts,
      port,
      pin: this.config.pin,
      maskedSecret: maskSecret(this.secret),
      qrPayload: pairingPayload(host, port, this.config.pin, hosts),
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

  async pluginsCall(name: string, params: unknown, auth?: { isAdmin: boolean; permissionCap: PermissionMode }): Promise<unknown> {
    if (this.plugins.isAdminOnly(name) && !auth?.isAdmin) throw new Error('이 플러그인 설정은 관리자 권한이 필요합니다.');
    if (this.plugins.isDestructive(name) && !auth?.isAdmin && effectiveMode(this.config.settings.safety.mode, auth?.permissionCap) !== 'full') {
      throw new Error('직접 변경형 플러그인 호출은 전체 허용 모드가 필요합니다. 대화에서 위임하면 현재 권한 정책에 따라 승인됩니다.');
    }
    return this.plugins.call(name, params);
  }

  // -- chat (non-streaming, REST) ----------------------------------------

  async chatOnce(text: string): Promise<{ text: string }> {
    const result = await this.loop.run([], text, {}, this.plugins.aiTools(text));
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
    await this.plugins.loadBuiltin(createTailscalePlugin());
    await this.plugins.loadBuiltin(createDockerPlugin());
    await this.plugins.loadBuiltin(createCtfPlugin());
    await this.plugins.loadBuiltin(createMcpPlugin());
    await this.plugins.loadBuiltin(createVoicePlugin());
    const settings = this.config.settings.network;
    const host = opts.host ?? settings.host;
    const port = opts.port ?? settings.port;

    const app = createHttpApi(this, opts.webDir);
    this.httpServer = createServer(app);

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(port, host, () => resolve());
    });

    const addr = this.httpServer.address() as AddressInfo;
    this.boundHost = addr.address;
    this.boundPort = addr.port;
    this.startedAt = Date.now();

    this.hub = new WsHub(this.httpServer, this.handlers(), (s) => this.authenticate(s), this.logger);
    this.scheduler.start();

    // Server-wide pushes (only to authenticated clients).
    this.bus.on('log', (entry) => this.hub?.broadcast('log', entry));
    this.bus.on('plugins.changed', (list) => this.hub?.broadcast('plugins.changed', list));
    this.bus.on('providers.changed', (list) => this.hub?.broadcast('providers.changed', list));
    this.bus.on('settings.changed', (settings) => this.hub?.broadcast('settings.changed', settings));
    this.bus.on('routing.changed', (routing) => this.hub?.broadcast('routing.changed', routing));
    this.bus.on('routing.presets.changed', (presets) => this.hub?.broadcast('routing.presets.changed', presets));
    this.bus.on('conversations.changed', (list) => this.hub?.broadcast('conversations.changed', list));
    this.bus.on('memory.changed', (list) => this.hub?.broadcast('memory.changed', list));
    this.bus.on('scheduler.changed', (list) => this.hub?.broadcast('scheduler.changed', list));
    this.bus.on('scheduler.ran', (list) => this.hub?.broadcast('scheduler.ran', list));
    this.bus.on('workspaces.changed', (list) => this.hub?.broadcast('workspaces.changed', list));
    this.bus.on('calendar.changed', (list) => this.hub?.broadcast('calendar.changed', list));
    this.bus.on('voice.wake', (data) => this.hub?.broadcast('voice.wake', data));
    this.bus.on('voice.command', (data) => this.hub?.broadcast('voice.command', data));
    this.bus.on('voice.command.ready', (data) => this.hub?.broadcast('voice.command.ready', data));
    this.bus.on('voice.command.timeout', (data) => this.hub?.broadcast('voice.command.timeout', data));
    this.bus.on('voice.status', (data) => this.hub?.broadcast('voice.status', data));

    this.logger.info(`listening on http://${this.boundHost}:${this.boundPort}`);
    return { host: this.boundHost, port: this.boundPort };
  }

  async stop(): Promise<void> {
    // Unload every plugin cleanly (no dangling listeners/timers at exit).
    await this.plugins.unloadAll();
    this.scheduler.stop();
    this.hub?.close();
    this.hub = null;
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
    this.logger.info('stopped');
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

    h.set('status', () => this.status());
    h.set('pairing.info', () => this.pairingInfo(false));
    h.set('pairing.links', (_params, client) => {
      assertAdmin(client);
      return this.config.deviceLinks.map(({ tokenHash: _tokenHash, ...link }) => link);
    });
    h.set('pairing.link.update', (params, client) => {
      assertAdmin(client);
      const body = p(params);
      return this.config.patchDeviceLink(str(body.id), { name: typeof body.name === 'string' ? body.name : undefined, permissionCap: typeof body.permissionCap === 'string' ? body.permissionCap as PermissionMode : undefined });
    });
    h.set('pairing.link.revoke', (params, client) => {
      assertAdmin(client);
      return { ok: this.config.revokeDeviceLink(str(p(params).id)) };
    });
    h.set('pairing.regenerate', (_params, client) => {
      assertAdmin(client);
      const secret = this.config.regenerateSecret();
      const pin = this.config.regeneratePin();
      this.logger.info('pairing credentials rotated (all clients must re-authenticate)');
      return { secret, pin };
    });
    h.set('pairing.regeneratePin', (_params, client) => {
      assertAdmin(client);
      const pin = this.config.regeneratePin();
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
    h.set('providers.test', async (params) => this.providersTest(str(p(params).id)));
    h.set('providers.models', async (params) => this.providersModels(str(p(params).id)));
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
    h.set('conversations.create', (params) => {
      const input = p(params) as ConversationCreateInput;
      const created = this.conversations.create({ ...input, permissionMode: ['read-only', 'ask', 'workspace', 'full'].includes(String(input.permissionMode)) ? input.permissionMode : this.config.settings.safety.mode });
      this.bus.emit('conversations.changed', this.conversations.list());
      return created;
    });
    h.set('conversations.get', (params) => {
      const item = this.conversations.get(str(p(params).id));
      if (!item) throw new Error('conversation not found');
      return item;
    });
    h.set('conversations.update', (params) => {
      const body = p(params);
      const item = this.conversations.update(str(body.id), {
        title: typeof body.title === 'string' ? body.title : undefined,
        status: body.status === 'archived' ? 'archived' : body.status === 'active' ? 'active' : undefined,
        pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
        reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort as ReasoningEffort : undefined,
        providerId: body.providerId === null || typeof body.providerId === 'string' ? body.providerId : undefined,
        providerModel: body.providerModel === null || typeof body.providerModel === 'string' ? body.providerModel : undefined,
        routingPresetId: body.routingPresetId === null || typeof body.routingPresetId === 'string' ? body.routingPresetId : undefined,
        workspaceId: body.workspaceId === null || typeof body.workspaceId === 'string' ? body.workspaceId : undefined,
        permissionMode: ['read-only', 'ask', 'workspace', 'full'].includes(String(body.permissionMode)) ? body.permissionMode as PermissionMode : undefined,
      });
      this.bus.emit('conversations.changed', this.conversations.list());
      return item;
    });
    h.set('conversations.delete', (params) => {
      const ok = this.conversations.delete(str(p(params).id));
      this.bus.emit('conversations.changed', this.conversations.list());
      return { ok };
    });
    h.set('memory.list', () => this.memory.list());
    h.set('memory.add', (params): MemoryItem => {
      const body = p(params);
      const item = this.memory.add(str(body.text), Array.isArray(body.tags) ? body.tags.map(String) : []);
      this.bus.emit('memory.changed', this.memory.list());
      return item;
    });
    h.set('memory.remove', (params) => {
      const ok = this.memory.remove(str(p(params).id));
      this.bus.emit('memory.changed', this.memory.list());
      return { ok };
    });
    h.set('telemetry.summary', () => this.telemetry.summary());
    h.set('telemetry.list', (params) => this.telemetry.list(Math.min(500, Number(p(params).limit) || 100)));

    // ---- scheduler ----
    h.set('scheduler.list', () => this.scheduler.list());
    h.set('scheduler.add', (params) => {
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
      });
    });
    h.set('scheduler.remove', (params) => this.scheduler.remove(str(p(params).id)));
    h.set('scheduler.setEnabled', (params) => this.scheduler.setEnabled(str(p(params).id), p(params).enabled === true));

    // ---- chat (streaming over events) ----
    h.set('chat.start', async (params, client) => {
      const body = p(params);
      const text = str(body.text);
      const session = client.state.chat;
      if (session.busy) throw new Error('chat already running');
      let conversationId = str(body.conversationId) || session.conversationId;
      if (!conversationId || !this.conversations.get(conversationId)) {
        conversationId = this.conversations.create({
          reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort as ReasoningEffort : 'auto',
          providerId: typeof body.providerId === 'string' ? body.providerId : undefined,
          providerModel: typeof body.providerModel === 'string' ? body.providerModel : undefined,
          routingPresetId: typeof body.routingPresetId === 'string' ? body.routingPresetId : undefined,
          permissionMode: ['read-only', 'ask', 'workspace', 'full'].includes(String(body.permissionMode)) ? body.permissionMode as PermissionMode : this.config.settings.safety.mode,
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
      this.busyConversations.add(conversationId);
      session.begin();
      const runStartedAt = Date.now();
      this.activeRuns.set(conversationId, { session, startedAt: runStartedAt, status: '시작 중' });
      const extraTools = this.plugins.aiTools(text);
      try {
        const retained = [
          conversation.summary ? `이전 대화 압축 요약:\n${conversation.summary}` : '',
          this.memory.context(text) ? `사용자가 저장한 장기 기억:\n${this.memory.context(text)}` : '',
        ].filter(Boolean).join('\n\n');
        const result = await this.loop.run(
          this.conversations.turns(conversationId),
          text,
          {
            signal: session.signal(),
            onText: (delta) => client.sendEvent('chat.delta', { conversationId, text: delta }),
            onTool: (info) => client.sendEvent('chat.tool', { conversationId, ...info }),
            onStatus: (status) => {
              const active = this.activeRuns.get(conversationId);
              if (active) active.status = status;
              client.sendEvent('chat.status', { conversationId, status });
            },
            takeSteering: () => session.takeSteering(),
            confirm: (req) => session.askConfirm((e, d) => client.sendEvent(e, d), req),
          },
          extraTools,
          {
            providerId: routingPresetId ? undefined : typeof body.providerId === 'string' ? body.providerId : conversation.providerId,
            providerModel: routingPresetId ? undefined : typeof body.providerModel === 'string' ? body.providerModel : conversation.providerModel,
            reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort as ReasoningEffort : conversation.reasoningEffort,
            context: retained,
            permissionMode: effectiveMode(
              ['read-only', 'ask', 'workspace', 'full'].includes(String(body.permissionMode)) ? body.permissionMode as PermissionMode : conversation.permissionMode,
              client.state.auth?.permissionCap,
            ),
            routing: conversationRouting,
            workspacePath: workspace?.path,
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
          toolCalls: result.turns.reduce((sum, turn) => sum + (turn.toolCalls?.length ?? 0), 0), latencyMs: Date.now() - runStartedAt,
          estimatedCost, ok: true,
        });
        this.bus.emit('conversations.changed', this.conversations.list());
        client.sendEvent('chat.done', { conversationId, text: result.text, usage: result.usage, route: result.route, conversation: updated });
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
        client.sendEvent('chat.error', { conversationId, message });
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
      (run?.session ?? client.state.chat).cancel();
      return { ok: true };
    });
    h.set('chat.steer', (params) => {
      const body = p(params);
      const conversationId = str(body.conversationId);
      const run = this.activeRuns.get(conversationId);
      if (!run) throw new Error('이 대화에서 실행 중인 작업이 없습니다.');
      const queued = run.session.steer(str(body.text));
      return { ok: true, queued };
    });
    h.set('chat.runs', (): ChatRunState[] => [...this.activeRuns.entries()].map(([conversationId, run]) => ({
      conversationId, running: true, startedAt: run.startedAt, status: run.status, steeringQueued: run.session.steeringQueued,
    })));
    h.set('chat.confirmResponse', (params, client) => {
      const body = p(params);
      const handled = client.state.chat.respondConfirm(str(body.requestId), body.approve === true);
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
    h.set('computer.fs.list', (params) => {
      const b = p(params);
      return computer.fs.list(str(b.path));
    });
    h.set('computer.fs.read', (params) => {
      const b = p(params);
      return computer.fs.read(str(b.path), typeof b.maxBytes === 'number' ? b.maxBytes : 20000);
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
    h.set('computer.screen.capture', (params) => {
      const b = p(params);
      return computer.screen.capture(typeof b.quality === 'number' ? b.quality : 60);
    });
    h.set('computer.screen.size', async (): Promise<ScreenSize> => computer.screen.size());

    // ---- screen streaming (remote-control) ----
    h.set('computer.stream.start', (params, client) => {
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
