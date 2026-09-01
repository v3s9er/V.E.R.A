/**
 * Wire protocol shared between the Mr.Robot agent (server) and every client
 * (desktop web UI, Electron shell, mobile app).
 *
 * Everything travels over a single WebSocket as JSON "RPC" messages plus
 * server-pushed events. A thin HTTP API (REST) mirrors the same methods for
 * clients that cannot hold a socket (e.g. a plain fetch ping).
 */

/**
 * Public WSS clients first obtain a short-lived, single-use admission ticket
 * over authenticated HTTPS.  The generic protocol is echoed by the server;
 * the ticket-bearing protocol is consumed during the HTTP upgrade and is
 * never echoed back to the client.
 */
export const WS_RPC_PROTOCOL = 'mr-robot-rpc-v1';
export const WS_UPGRADE_TICKET_PROTOCOL_PREFIX = 'mr-robot-ticket.';

export interface WsUpgradeTicketInfo {
  protocol: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// RPC envelope
// ---------------------------------------------------------------------------

export interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcOk {
  id: number;
  ok: true;
  result: unknown;
}

export interface RpcError {
  id: number;
  ok: false;
  error: { code: number; message: string };
}

/** Server -> client push (id is always 0). */
export interface RpcEvent {
  id: 0;
  event: string;
  data: unknown;
}

export type RpcMessage = RpcRequest | RpcOk | RpcError | RpcEvent;

export const RPC = {
  OK: 0,
  ERROR_INTERNAL: 1000,
  ERROR_UNAUTHORIZED: 1001,
  ERROR_NOT_FOUND: 1002,
  ERROR_VALIDATION: 1003,
  ERROR_TIMEOUT: 1004,
} as const;

// ---------------------------------------------------------------------------
// Provider / AI
// ---------------------------------------------------------------------------

export type ProviderType = 'openai-compatible' | 'anthropic' | 'ollama' | 'codex-cli' | 'claude-cli';
export type ProviderSource = 'api' | 'subscription' | 'local' | 'free';
export type ReasoningEffort = 'auto' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ProviderConfig {
  id: string;
  label: string;
  type: ProviderType;
  baseUrl: string;
  model: string;
  /** API key stored locally (never sent back to clients in full). */
  apiKey: string;
  isDefault: boolean;
  /** Extra HTTP headers, e.g. for gateways that need org/project ids. */
  headers?: Record<string, string>;
  /** How this model is paid for / reached. Used by the cost-aware router. */
  source?: ProviderSource;
  /** Optional executable override for official local CLI adapters. */
  command?: string;
  /** Extra CLI arguments. Never interpreted by a shell. */
  args?: string[];
  /** Relative routing cost. 0 is free/local, 1 is cheapest paid tier. */
  costTier?: number;
  /** Optional pricing used only for local cost estimates. */
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
}

/** What clients are allowed to see about a provider. */
export interface ProviderInfo {
  id: string;
  label: string;
  type: ProviderType;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  isDefault: boolean;
  reachable?: boolean;
  source: ProviderSource;
  costTier: number;
  supportedReasoning: ReasoningEffort[];
}

export interface ProviderAddInput {
  label: string;
  type: ProviderType;
  baseUrl?: string;
  model: string;
  apiKey?: string;
  source?: ProviderSource;
  command?: string;
  args?: string[];
  costTier?: number;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
}

export type ModelRole = 'router' | 'fast' | 'general' | 'reasoning' | 'coding' | 'vision' | 'critic' | 'summarizer';
export type RoutingMode = 'economy' | 'balanced' | 'quality' | 'manual';
export type RoutingExecutionMode = 'single' | 'pipeline' | 'vote' | 'hybrid' | 'swarm';

export interface RoutingPresetSettings {
  mode: RoutingMode;
  /** single chooses one node, pipeline passes work through nodes, vote gathers independent proposals. */
  executionMode?: RoutingExecutionMode;
  /** Number of opinion rounds in vote mode. Round 1 is independent; later rounds exchange views and cast ballots. */
  meetingRounds?: number;
  /** Number of representative exchanges after each group has completed its internal meeting. */
  crossGroupRounds?: number;
  /** Bounded retry ceiling for competitive swarms. They stop earlier as soon as the verifier accepts a solution. */
  maxIterations?: number;
  /** Ordered provider ids. The first available provider wins; later entries are fallbacks. */
  roles: Partial<Record<ModelRole, string[]>>;
  /** Maximum number of paid/high-cost calls in one user turn. */
  maxPremiumCalls: number;
  /** Escalate hard requests from a cheap model to the reasoning role. */
  escalationEnabled: boolean;
  /** Freely positioned workflow graph used by the router UI and role ordering. */
  graph?: RoutingGraph;
}

export interface RoutingSettings extends RoutingPresetSettings {
  /** Preset currently applied. Manual edits clear this value. */
  activePresetId?: string;
}

export interface RoutingPreset extends RoutingPresetSettings {
  id: string;
  name: string;
  description?: string;
  builtin: boolean;
  createdAt: number;
  updatedAt: number;
}

export type RoutingNodeKind = 'input' | 'classifier' | 'model' | 'executor' | 'critic' | 'memory' | 'output';
export interface RoutingNode {
  id: string;
  kind: RoutingNodeKind;
  label: string;
  x: number;
  y: number;
  role?: ModelRole;
  providerId?: string;
  /** Per-node model override; keeps role selection independent from provider defaults. */
  providerModel?: string;
  /** Nodes with the same group id discuss/vote together before final validation. */
  groupId?: string;
  /** Non-model execution backend such as the built-in Orca plugin. */
  integrationId?: string;
}
export type RoutingGroupMode = 'collaborative' | 'competitive' | 'review';
export interface RoutingGroup {
  id: string;
  name: string;
  /** Hex/accent color used by the editor and transcript status. */
  color?: string;
  /** Controls how members critique and merge one another's work. */
  discussionMode?: RoutingGroupMode;
  /** Persisted fallback bounds keep a newly-created empty group visible. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}
export interface RoutingEdge {
  id: string;
  from: string;
  to: string;
  /** Optional human-readable handoff/condition label. */
  label?: string;
}
export interface RoutingGraph { nodes: RoutingNode[]; edges: RoutingEdge[]; groups?: RoutingGroup[] }

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Tool calls the model requested (assistant) or results (tool). */
  toolCalls?: ToolCallRecord[];
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  error?: string;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  /** Input tokens served from a provider-side prompt cache. */
  cachedPromptTokens?: number;
  /** Input tokens written into a provider-side prompt cache. */
  cacheWritePromptTokens?: number;
  /** Output tokens reported specifically as hidden reasoning. */
  reasoningTokens?: number;
}

export type ConversationStatus = 'active' | 'archived';

export interface ConversationSummary {
  id: string;
  title: string;
  status: ConversationStatus;
  /** Pinned conversations sort before ordinary conversations on every device. */
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  reasoningEffort: ReasoningEffort;
  providerId?: string;
  /** Model selected for this conversation without changing the provider default. */
  providerModel?: string;
  /** Routing preset used only by this conversation. Missing means direct single-model mode. */
  routingPresetId?: string;
  /** Working directory exposed to the selected agent for this conversation. */
  workspaceId?: string;
  /** Per-conversation access level. The paired-device cap can only narrow it. */
  permissionMode: PermissionMode;
  compactedMessages: number;
}

export interface ConversationDetail extends ConversationSummary {
  messages: ChatMessage[];
  summary?: string;
  usage: ChatUsage;
}

export interface ConversationCreateInput {
  title?: string;
  reasoningEffort?: ReasoningEffort;
  providerId?: string;
  providerModel?: string;
  routingPresetId?: string;
  workspaceId?: string;
  permissionMode?: PermissionMode;
  pinned?: boolean;
}

export interface MemoryItem {
  id: string;
  text: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

/** A destructive tool is paused and the user must approve it. */
export interface ChatConfirmRequest {
  requestId: string;
  conversationId: string;
  conversationTitle: string;
  tool: string;
  input: unknown;
  summary: string;
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export type PluginKind = 'model-provider' | 'tool' | 'transport' | 'input' | 'workflow' | 'integration';
export type PluginPermission =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'process.execute'
  | 'network.client'
  | 'network.listen'
  | 'microphone'
  | 'calendar.read'
  | 'calendar.write'
  | 'container.execute'
  | 'mcp.connect';

export interface PluginDependency {
  id: string;
  name: string;
  required: boolean;
  installed?: boolean;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  status: 'loaded' | 'error';
  kind: PluginKind;
  builtin: boolean;
  enabled: boolean;
  capabilities: string[];
  permissions: PluginPermission[];
  dependencies: PluginDependency[];
  source: string;
  commands: string[];
  subscriptions: number;
  timers: number;
  error?: string;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
  createdAt: number;
}

export interface ChatRunState {
  conversationId: string;
  running: boolean;
  startedAt?: number;
  status?: string;
  steeringQueued: number;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  location?: string;
  source: 'local' | 'google';
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Computer / system
// ---------------------------------------------------------------------------

export interface SystemStatus {
  ok: boolean;
  hostname: string;
  platform: string;
  arch: string;
  version: string;
  startedAt: number;
  uptimeSec: number;
  capabilities: {
    shell: boolean;
    files: boolean;
    input: boolean;
    screen: boolean;
  };
  defaultProviderId: string | null;
  providers: number;
  plugins: number;
  network: {
    host: string;
    port: number;
    externalAccess: boolean;
  };
}

export interface ScreenSize {
  width: number;
  height: number;
}

export interface ScreenFrame {
  /** data URL: image/jpeg;base64,... */
  dataUrl: string;
  width: number;
  height: number;
  ts: number;
}

export interface ShellResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
}

export type DependencyId = 'node' | 'git' | 'speech-ko' | 'codex' | 'claude' | 'orca' | 'ollama' | 'cloudflared' | 'tailscale' | 'docker';

export interface DependencyInfo {
  id: DependencyId;
  name: string;
  description: string;
  installed: boolean;
  required: boolean;
  requiresLogin: boolean;
  canInstall: boolean;
  version?: string;
  path?: string;
}

export interface DependencyReport {
  completedAt: number | null;
  wizardVersion: number;
  packageManagerAvailable: boolean;
  items: DependencyInfo[];
}

export interface DependencyInstallResult {
  ok: boolean;
  item: DependencyInfo;
  output: string;
}

/** Result of merging one peer's conversation snapshot into this PC. */
export interface ConversationSyncMergeResult {
  added: number;
  updated: number;
  unchanged: number;
  /** Divergent edits are retained as visible conflict-copy conversations. */
  conflicts: number;
  conflictIds: string[];
}

export interface SyncMergeResult {
  conversations: ConversationSyncMergeResult;
  routingPresets: { added: number; updated: number; unchanged: number };
}

/** Pluggable remote transports. Account relay remains unavailable until its external control plane is configured. */
export type RemoteTransportProviderId = 'cloudflare-quick' | 'cloudflare-named' | 'google-relay';

export interface RemoteLinkConfig {
  provider: RemoteTransportProviderId;
  /** Only this Agent's HTTP loopback URL may be published. */
  localUrl: string;
  /** Fixed public hostname configured on the user's remotely-managed Cloudflare Tunnel. */
  hostname?: string;
  /** Exact sibling hostnames allowed to receive this Access credential for PC-to-PC pulls. */
  peerHostnames?: string[];
  /** Write-only input. Status/config responses never return this credential. */
  tunnelToken?: string;
  /** True when a DPAPI-protected token already exists on this Windows account. */
  hasTunnelToken?: boolean;
  /** Write-only input for deliberately removing the saved credential. */
  clearTunnelToken?: boolean;
  /** Write-only Cloudflare Access service-token client id used by native clients. */
  accessClientId?: string;
  /** Write-only Cloudflare Access service-token secret used by native clients. */
  accessClientSecret?: string;
  /** True when a matching DPAPI-protected Access service credential exists. */
  hasAccessCredentials?: boolean;
  /** Write-only input for deliberately removing the saved Access credential. */
  clearAccessCredentials?: boolean;
  /** Named tunnels may reconnect automatically when the enabled plugin starts. */
  autoStart: boolean;
}

export interface RemoteTransportProviderInfo {
  id: RemoteTransportProviderId;
  name: string;
  available: boolean;
  temporary: boolean;
  requiresAccount: boolean;
  reason?: string;
}

export interface RemoteLinkStatus {
  provider: RemoteTransportProviderId;
  config: RemoteLinkConfig;
  running: boolean;
  installed: boolean;
  executable?: string;
  processId?: number;
  publicUrl?: string;
  websocketUrl?: string;
  startedAt?: number;
  temporary: boolean;
  beta: boolean;
  reachable?: boolean;
  /** True only after an anonymous probe is denied and a service-token probe succeeds. */
  accessProtected?: boolean;
  verifiedAt?: number;
  warning: string;
  lastError?: string;
  diagnostics?: string;
  providers: RemoteTransportProviderInfo[];
}

// ---------------------------------------------------------------------------
// Scheduled tasks
// ---------------------------------------------------------------------------

export type ScheduleJobType = 'chat' | 'shell' | 'launch';

export interface ScheduleWhen {
  /** once: ISO local datetime (YYYY-MM-DDTHH:MM). daily: HH:MM + weekday mask. */
  kind: 'once' | 'daily';
  at: string;
  /** Weekdays 0(Sun)-6(Sat); empty = every day. */
  days?: number[];
}

export interface ScheduledJob {
  id: string;
  name: string;
  type: ScheduleJobType;
  /** chat */
  prompt?: string;
  /** shell */
  command?: string;
  shellKind?: 'powershell' | 'cmd';
  /** launch */
  target?: string;
  args?: string[];
  when: ScheduleWhen;
  /** For chat jobs: auto-approve destructive tools even in confirm mode. */
  allowDestructive: boolean;
  /** Effective permission ceiling captured when the job was created. */
  permissionMode?: PermissionMode;
  /** Only locally authenticated administrators may create privileged jobs. */
  createdByAdmin?: boolean;
  enabled: boolean;
  createdAt: number;
  lastRun?: number;
  lastResult?: string;
}

export interface ScheduledJobView extends ScheduledJob {
  /** Epoch ms of the next run, or null when disabled/invalid. */
  nextRun: number | null;
}

// ---------------------------------------------------------------------------
// Network / settings
// ---------------------------------------------------------------------------

export interface NetworkSettings {
  /** 'lan' = bind 0.0.0.0 on the LAN; 'localhost' = this machine only. */
  host: '0.0.0.0' | '127.0.0.1';
  port: number;
  /** Whether the pairing/token auth is enforced (always recommended). */
  externalAccess: boolean;
}

export type PermissionMode = 'read-only' | 'ask' | 'workspace' | 'full';

/** Narrow, independently revocable privileges granted to a paired device. */
export type DeviceCapability = 'work-sync' | 'private-calendar' | 'file-transfer';

export interface SafetySettings {
  /** read-only < ask < workspace < full. Legacy confirm is migrated to ask. */
  mode: PermissionMode;
  /** Writable roots for workspace mode. Other destructive actions still ask. */
  allowedRoots?: string[];
  /** Max chars read per file in one call. */
  maxReadBytes: number;
  /** Max shell output bytes returned to the model. */
  maxShellBytes: number;
}

export interface AppSettings {
  network: NetworkSettings;
  safety: SafetySettings;
  /** Human name shown on the pairing screen. */
  deviceName: string;
  setup: {
    /** Set after the user finishes the first-run dependency check. */
    dependencyWizardCompletedAt?: number;
    dependencyWizardVersion?: number;
  };
  voice?: {
    enabled: boolean;
    wakePhrase: string;
    language: string;
    /** Legacy compatibility value retained for existing desktop voice settings. */
    pcPriorityMs: number;
  };
}
