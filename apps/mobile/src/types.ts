/**
 * Local copies of the wire types the mobile app needs (the app is a
 * standalone Expo project, not part of the npm workspaces).
 */

export interface CloudflareAccessCredentials {
  clientId: string;
  clientSecret: string;
}

export interface CloudflareAccessBootstrap {
  type: 'cf-authorization';
  /** Short-lived Access session JWT. Never persisted after enrollment. */
  token: string;
  expiresAt: number;
}

export interface SavedPc {
  id: string;
  name: string;
  host: string;
  hosts?: string[];
  activeHost?: string;
  protocol?: 'http' | 'https';
  origins?: string[];
  activeOrigin?: string;
  /** Exact HTTPS origin that issued and may receive this device bearer. */
  credentialOrigin?: string;
  credentialStatus?: 'ok' | 'missing' | 'unavailable';
  /** Runtime-only. Persisted separately in expo-secure-store, never AsyncStorage. */
  cloudflareAccess?: CloudflareAccessCredentials;
  /** Non-secret marker used to detect an unavailable SecureStore entry safely. */
  cloudflareAccessConfigured?: boolean;
  /** Exact HTTPS origin allowed to receive the SecureStore-held Access credential. */
  cloudflareAccessOrigin?: string;
  port: number;
  secret: string;
  addedAt: number;
}

export interface PairingPayload {
  app: 'mr-robot';
  host: string;
  hosts?: string[];
  protocol?: 'http' | 'https';
  port: number;
  version: 3 | 5;
  pin: string;
  /** Present on unattended QR handoffs; rejected when expired or over 25 hours ahead. */
  expiresAt?: number;
  /** Version 5 only: one-use, short-lived edge admission without the long-lived Service Token. */
  cloudflareBootstrap?: CloudflareAccessBootstrap;
  /** Runtime-derived exact origin allowed to receive the short-lived application-token header. */
  cloudflareBootstrapOrigin?: string;
}

export interface SystemStatus {
  ok: boolean;
  hostname: string;
  platform: string;
  version: string;
  defaultProviderId: string | null;
  providers: number;
  plugins: number;
}

export interface ScreenFrame {
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

export type ProviderType = 'openai-compatible' | 'anthropic' | 'ollama' | 'codex-cli' | 'claude-cli';
export type ReasoningEffort = 'auto' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PermissionMode = 'read-only' | 'ask' | 'workspace' | 'full';

export interface ConversationSyncMergeResult {
  added: number;
  updated: number;
  unchanged: number;
  conflicts: number;
  conflictIds: string[];
}

export interface SyncMergeResult {
  conversations: ConversationSyncMergeResult;
  routingPresets: { added: number; updated: number; unchanged: number };
}

export interface ProviderInfo {
  id: string;
  label: string;
  type: ProviderType;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  isDefault: boolean;
  source: 'api' | 'subscription' | 'local' | 'free';
  costTier: number;
  supportedReasoning: ReasoningEffort[];
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  status: 'loaded' | 'error';
  commands: string[];
  subscriptions: number;
  timers: number;
  kind?: string;
  builtin?: boolean;
  enabled?: boolean;
  capabilities?: string[];
  permissions?: string[];
}

export interface AppSettings {
  deviceName: string;
  safety: { mode: 'read-only' | 'ask' | 'workspace' | 'full'; allowedRoots?: string[] };
  network: { host: string; port: number; externalAccess: boolean };
}

export interface ScheduledJobView {
  id: string;
  name: string;
  type: 'chat' | 'shell' | 'launch';
  when: { kind: 'once' | 'daily'; at: string; days?: number[] };
  enabled: boolean;
  allowDestructive: boolean;
  lastRun?: number;
  lastResult?: string;
  nextRun: number | null;
}

export interface CalendarEvent {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  source: 'local' | 'google';
}

export interface ChatConfirmRequest {
  requestId: string;
  conversationId: string;
  conversationTitle: string;
  tool: string;
  summary: string;
}

export interface ToolEvent {
  name: string;
  input: unknown;
  status: 'start' | 'done' | 'error';
  detail?: string;
}

export interface ChatRunState {
  conversationId: string;
  running: boolean;
  startedAt?: number;
  status?: string;
  steeringQueued: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  status: 'active' | 'archived';
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  reasoningEffort: ReasoningEffort;
  providerId?: string;
  providerModel?: string;
  routingPresetId?: string;
  workspaceId?: string;
  permissionMode: PermissionMode;
  compactedMessages: number;
}

export interface RoutingPreset {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  executionMode?: 'single' | 'pipeline' | 'vote' | 'hybrid';
  meetingRounds?: number;
  graph?: { nodes: Array<{ id: string; label: string; role?: string; groupId?: string }> };
}

export interface SharedFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
  createdAt: number;
}

export interface ConversationDetail extends ConversationSummary {
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>;
  summary?: string;
  usage: { promptTokens: number; completionTokens: number };
}
