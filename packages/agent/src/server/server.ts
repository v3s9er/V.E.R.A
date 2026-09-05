import { createServer, type Server as HttpServer } from 'node:http';
import { networkInterfaces, hostname as osHostname, platform } from 'node:os';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type {
  AppSettings,
  DeviceCapability,
  PermissionMode,
  ConversationCreateInput,
  ConversationDetail,
  ConversationStatus,
  ConversationTokenPolicy,
  MemoryItem,
  ReasoningEffort,
  RoutingSettings,
  RoutingPreset,
  PluginCategory,
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
  ChatUsage,
  SyncMergeResult,
} from '@mr-robot/shared';
import { hashToken, safeEqual, maskSecret, pairingPayload } from '../auth.js';
import { ConfigStore, type ToolPortalConfigureInput } from '../config.js';
import { EventBus } from '../eventbus.js';
import { Logger } from '../logger.js';
import { ProviderRegistry } from '../ai/registry.js';
import { MAX_PROVIDER_RECORDED_TOKENS, type ProviderUsage } from '../ai/provider.js';
import { effectiveMode, ToolExecutor } from '../ai/executor.js';
import { AgentLoop, ModelBudgetExceededError, type ModelBudgetProfile, type ModelProgressKind } from '../ai/loop.js';
import { ModelRouter } from '../ai/router.js';
import { ConversationStore } from '../conversations.js';
import { MemoryStore } from '../memory.js';
import { TelemetryStore } from '../telemetry.js';
import { PluginManager } from '../plugins/manager.js';
import { createOrcaPlugin } from '../plugins/orca.js';
import { createCalendarPlugin } from '../plugins/calendar.js';
import { createTailscalePlugin } from '../plugins/tailscale.js';
import { createDiscordPlugin } from '../plugins/discord.js';
import { createDockerPlugin } from '../plugins/docker.js';
import { createCtfPlugin } from '../plugins/ctf.js';
import { createMcpPlugin } from '../plugins/mcp.js';
import { createVoicePlugin } from '../plugins/voice.js';
import { createRemoteLinkPlugin } from '../plugins/remote-link.js';
import { createResourceArchiverPlugin } from '../plugins/resource-archiver/index.js';
import { createSslScanPlugin } from '../plugins/sslscan/index.js';
import { createWebCryptoObserverPlugin } from '../plugins/webcrypto-observer/index.js';
import { computer } from '../computer/index.js';
import { Scheduler, SchedulerStore } from '../scheduler.js';
import { DependencyManager } from '../dependencies.js';
import { ChatSession } from './chat.js';
import { ScreenStreamController } from './stream.js';
import { WsHub, WsClient, WsUpgradeTickets, canUseAuditOnly, type AuthContext, type RpcHandler } from './ws.js';
import { createHttpApi, type PairingInfo } from './http.js';
import { ContextBroker } from '../context-broker.js';
import { resolveRegisteredWorkspacePath } from '../path-security.js';
import {
  ToolPortalArtifactStore,
  ToolPortalError,
  ToolPortalSessionManager,
  normalizeToolPortalMaxCipherTests,
  normalizeToolPortalResourceLimits,
  normalizeToolPortalSslScanMode,
  normalizeToolPortalTargetHost,
  toolPortalResourceFetchMissing,
  type ToolPortalAction,
  type ToolPortalArtifactFile,
  type ToolPortalSession,
  type ToolPortalToolId,
} from '../tool-portal.js';

export const VERSION = '0.4.5';
const PAIRING_PIN_TTL_MS = 5 * 60_000;
const REMOTE_HANDOFF_TTL_MINUTES = 5;
const REMOTE_HANDOFF_TTL_MAX_MINUTES = 24 * 60;
const PIN_GLOBAL_WINDOW_MS = 5 * 60_000;
const PIN_GLOBAL_MAX_FAILURES = 50;
const DESKTOP_AUDIT_PROOF_TTL_MS = 10_000;
const DESKTOP_AUDIT_PROOF_MAX_PENDING = 32;

export type ServerEventAudience = 'paired' | 'private-calendar' | 'admin' | 'none';

// Event visibility is an authorization boundary, not just a UI concern.
// Unknown/new events default to no network broadcast until explicitly reviewed.
const PAIRED_EVENT_ALLOWLIST = new Set([
  'routing.changed', 'routing.presets.changed', 'conversations.changed',
  'workspaces.changed', 'calendar.changed',
]);
const PRIVATE_CALENDAR_EVENT_ALLOWLIST = new Set(['calendar.work.changed']);
const ADMIN_EVENT_ALLOWLIST = new Set([
  'log', 'plugins.changed', 'providers.changed', 'settings.changed',
  'dependencies.changed', 'memory.changed', 'scheduler.changed', 'scheduler.ran',
  'voice.wake', 'voice.command', 'voice.command.ready', 'voice.command.timeout',
  'voice.status', 'pairing.changed', 'remote-link.changed',
  'resource-archiver.progress', 'sslscan-auditor.progress',
  'sslscan-auditor.completed',
  'webcrypto-observer.changed',
]);

export function serverEventAudience(event: string): ServerEventAudience {
  if (PAIRED_EVENT_ALLOWLIST.has(event)) return 'paired';
  if (PRIVATE_CALENDAR_EVENT_ALLOWLIST.has(event)) return 'private-calendar';
  if (ADMIN_EVENT_ALLOWLIST.has(event)) return 'admin';
  return 'none';
}

function portalObject(value: unknown, label = '도구 요청'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ToolPortalError(`${label} 형식이 올바르지 않습니다.`, 400, 'INVALID_REQUEST');
  return value as Record<string, unknown>;
}

function portalInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum) throw new ToolPortalError(`${label} 값이 올바르지 않습니다.`, 400, 'INVALID_REQUEST');
  return Math.min(Number(value), maximum);
}

function portalTargetFromUrl(value: unknown): { url: string; host: string } {
  let parsed: URL;
  try { parsed = new URL(String(value ?? '')); }
  catch { throw new ToolPortalError('대상 URL이 올바르지 않습니다.', 400, 'INVALID_TARGET'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ToolPortalError('자격증명이 없는 HTTP(S) 대상 URL만 허용됩니다.', 400, 'INVALID_TARGET');
  }
  const host = normalizeToolPortalTargetHost(parsed.hostname.replace(/^\[/, '').replace(/\]$/, ''));
  return { url: parsed.href, host };
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

export interface ChatRunAdmissionOptions {
  globalActive: number;
  linkedActive: number;
  adminActive: number;
  globalProviderCallsInFlight: number;
  linkedProviderCallsInFlight: number;
  adminProviderCallsInFlight: number;
  startWindowMs: number;
  globalStartsPerWindow: number;
  linkedStartsPerWindow: number;
  adminStartsPerWindow: number;
  /** Retention window for diagnostics only; it is never an admission ceiling. */
  auditWindowMs: number;
  adaptiveSimpleCallTokens: number;
  adaptiveStandardCallTokens: number;
  adaptiveComplexCallTokens: number;
  adaptiveAbsoluteMaxTokens: number;
  adaptiveToolProgressCalls: number;
  maxRecordedTokens: number;
  maxPrincipals: number;
  now: () => number;
}

interface ChatRunPrincipalState {
  kind: 'admin' | 'linked';
  active: number;
  providerCallsInFlight: number;
  /** Sum of active adaptive hard ceilings, exposed only for bounded diagnostics. */
  reserved: number;
  starts: number[];
  /** Adaptive-mode usage, retained for diagnostics but never used as a fixed window cap. */
  tokens: Array<{ at: number; count: number }>;
  /** Audit-only usage is deliberately separate from adaptive accounting. */
  auditTokens: Array<{ at: number; count: number }>;
  lastSeen: number;
}

export interface ChatModelCallLease {
  /** Conservative debit chosen during the first settlement. */
  readonly accountedTokens: number;
  /**
   * Settle one provider invocation. Every call retains at least its host-owned
   * pre-call reservation; a larger valid provider report raises the debit.
   * Returns false only when settled calls exceed the whole run allowance or a
   * report is malformed. A provider may legitimately report more than our
   * pre-call estimate because subscription CLIs add hidden prompt context.
   */
  finish(usage?: Pick<ProviderUsage, 'promptTokens' | 'completionTokens' | 'reportStatus'>): boolean;
}

export interface ChatRunAdmissionLease {
  /** Adaptive hard ceiling, or Number.MAX_SAFE_INTEGER in audit-only mode. */
  readonly tokenBudget: number;
  readonly tokenPolicy: ConversationTokenPolicy;
  /** Must be called before the first provider invocation. */
  configureModelBudget(profile: ModelBudgetProfile): void;
  /** Bounded expansion after a real tool round or a new human instruction. */
  noteModelProgress(kind: ModelProgressKind): void;
  /**
   * Atomically reserve a model invocation inside this run. Parallel routing
   * nodes share the same allowance; they are not counted as separate jobs.
   */
  reserveModelCall(kind: 'api' | 'native', maximumTokens: number): ChatModelCallLease;
  /** Idempotently release the active slot and convert reservations to debt. */
  finish(usage?: Pick<ChatUsage, 'promptTokens' | 'completionTokens'>): void;
}

const DEFAULT_CHAT_RUN_ADMISSION: ChatRunAdmissionOptions = {
  // One admitted run may fan out to several routing nodes internally. These
  // limits count user jobs, not individual models in a vote/hybrid pipeline.
  globalActive: 12,
  linkedActive: 2,
  adminActive: 8,
  // A single top-level job may intentionally fan out, but the aggregate
  // provider pressure remains bounded across jobs and identities.
  globalProviderCallsInFlight: 48,
  linkedProviderCallsInFlight: 8,
  adminProviderCallsInFlight: 32,
  startWindowMs: 60_000,
  globalStartsPerWindow: 160,
  linkedStartsPerWindow: 12,
  adminStartsPerWindow: 120,
  auditWindowMs: 15 * 60_000,
  // These are per-call planning units, not rolling-window quotas. Complexity,
  // requested reasoning, configured workflow and input size select the unit.
  adaptiveSimpleCallTokens: 64_000,
  adaptiveStandardCallTokens: 192_000,
  adaptiveComplexCallTokens: 512_000,
  // A malformed report in the ten-million-token range still fails closed.
  adaptiveAbsoluteMaxTokens: 8_000_000,
  adaptiveToolProgressCalls: 8,
  maxRecordedTokens: 1_000_000_000_000,
  maxPrincipals: 512,
  now: () => Date.now(),
};
const CHAT_RUN_MAX_HISTORY_SAMPLES = 8_192;

function accumulateProviderUsage(current: ChatUsage | undefined, next: ProviderUsage): ChatUsage {
  const token = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(MAX_PROVIDER_RECORDED_TOKENS, Math.floor(value))
    : 0;
  const add = (left: unknown, right: unknown): number => Math.min(
    MAX_PROVIDER_RECORDED_TOKENS,
    token(left) + token(right),
  );
  return {
    promptTokens: add(current?.promptTokens, next.promptTokens),
    completionTokens: add(current?.completionTokens, next.completionTokens),
    accountedTokens: add(current?.accountedTokens, next.accountedTokens),
    cachedPromptTokens: add(current?.cachedPromptTokens, next.cachedPromptTokens),
    cacheWritePromptTokens: add(current?.cacheWritePromptTokens, next.cacheWritePromptTokens),
    reasoningTokens: add(current?.reasoningTokens, next.reasoningTokens),
  };
}

function hasRecordedUsage(usage: ChatUsage | undefined): usage is ChatUsage {
  return Boolean(usage && [
    usage.promptTokens,
    usage.completionTokens,
    usage.accountedTokens,
    usage.cachedPromptTokens,
    usage.cacheWritePromptTokens,
    usage.reasoningTokens,
  ].some((value) => typeof value === 'number' && value > 0));
}

interface AdaptiveRunBudget {
  initial: number;
  ceiling: number;
  progressStep: number;
  plannedCalls: number;
}

/**
 * Shared, memory-only admission policy for every interactive model run.
 *
 * REST and WebSocket callers use the same instance. Concurrency and start-rate
 * ceilings prevent client abuse. Token policy is per run: adaptive mode sizes
 * a bounded allowance from the task shape and unlocks more only after progress,
 * while administrator-only audit mode records normalized usage without a token
 * stop. There is intentionally no fixed rolling token cap that can penalize a
 * later legitimate task merely because an earlier hard task used its budget.
 */
export class ChatRunAdmissionPolicy {
  private readonly options: ChatRunAdmissionOptions;
  private readonly principals = new Map<string, ChatRunPrincipalState>();
  private globalActive = 0;
  private globalProviderCallsInFlight = 0;
  private globalReserved = 0;
  private globalStarts: number[] = [];
  private globalTokens: Array<{ at: number; count: number }> = [];
  private globalAuditTokens: Array<{ at: number; count: number }> = [];
  private epoch = 0;

  constructor(options: Partial<ChatRunAdmissionOptions> = {}) {
    const merged = { ...DEFAULT_CHAT_RUN_ADMISSION, ...options };
    const positive = (value: number, fallback: number): number => (
      Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback
    );
    this.options = {
      globalActive: positive(merged.globalActive, DEFAULT_CHAT_RUN_ADMISSION.globalActive),
      linkedActive: positive(merged.linkedActive, DEFAULT_CHAT_RUN_ADMISSION.linkedActive),
      adminActive: positive(merged.adminActive, DEFAULT_CHAT_RUN_ADMISSION.adminActive),
      globalProviderCallsInFlight: positive(merged.globalProviderCallsInFlight, DEFAULT_CHAT_RUN_ADMISSION.globalProviderCallsInFlight),
      linkedProviderCallsInFlight: positive(merged.linkedProviderCallsInFlight, DEFAULT_CHAT_RUN_ADMISSION.linkedProviderCallsInFlight),
      adminProviderCallsInFlight: positive(merged.adminProviderCallsInFlight, DEFAULT_CHAT_RUN_ADMISSION.adminProviderCallsInFlight),
      startWindowMs: positive(merged.startWindowMs, DEFAULT_CHAT_RUN_ADMISSION.startWindowMs),
      globalStartsPerWindow: Math.min(CHAT_RUN_MAX_HISTORY_SAMPLES, positive(merged.globalStartsPerWindow, DEFAULT_CHAT_RUN_ADMISSION.globalStartsPerWindow)),
      linkedStartsPerWindow: Math.min(CHAT_RUN_MAX_HISTORY_SAMPLES, positive(merged.linkedStartsPerWindow, DEFAULT_CHAT_RUN_ADMISSION.linkedStartsPerWindow)),
      adminStartsPerWindow: Math.min(CHAT_RUN_MAX_HISTORY_SAMPLES, positive(merged.adminStartsPerWindow, DEFAULT_CHAT_RUN_ADMISSION.adminStartsPerWindow)),
      auditWindowMs: positive(merged.auditWindowMs, DEFAULT_CHAT_RUN_ADMISSION.auditWindowMs),
      adaptiveSimpleCallTokens: positive(merged.adaptiveSimpleCallTokens, DEFAULT_CHAT_RUN_ADMISSION.adaptiveSimpleCallTokens),
      adaptiveStandardCallTokens: positive(merged.adaptiveStandardCallTokens, DEFAULT_CHAT_RUN_ADMISSION.adaptiveStandardCallTokens),
      adaptiveComplexCallTokens: positive(merged.adaptiveComplexCallTokens, DEFAULT_CHAT_RUN_ADMISSION.adaptiveComplexCallTokens),
      adaptiveAbsoluteMaxTokens: positive(merged.adaptiveAbsoluteMaxTokens, DEFAULT_CHAT_RUN_ADMISSION.adaptiveAbsoluteMaxTokens),
      adaptiveToolProgressCalls: Math.min(16, positive(merged.adaptiveToolProgressCalls, DEFAULT_CHAT_RUN_ADMISSION.adaptiveToolProgressCalls)),
      maxRecordedTokens: Math.min(Number.MAX_SAFE_INTEGER, positive(merged.maxRecordedTokens, DEFAULT_CHAT_RUN_ADMISSION.maxRecordedTokens)),
      maxPrincipals: Math.min(4_096, positive(merged.maxPrincipals, DEFAULT_CHAT_RUN_ADMISSION.maxPrincipals)),
      now: typeof merged.now === 'function' ? merged.now : DEFAULT_CHAT_RUN_ADMISSION.now,
    };
  }

  acquire(auth: AuthContext, capabilities: { allowAuditOnly?: boolean } = {}): ChatRunAdmissionLease {
    const now = this.options.now();
    this.prune(now);
    const kind = auth.isAdmin ? 'admin' : 'linked';
    const key = auth.isAdmin ? 'administrator' : auth.linkId ? `device:${auth.linkId}` : '';
    if (!key) throw new Error('모델 실행의 인증 주체를 확인할 수 없습니다. 다시 연결해 주세요.');
    if (this.globalActive >= this.options.globalActive) throw new Error('동시에 실행 중인 작업이 많습니다. 잠시 후 다시 시도하세요.');
    if (this.globalStarts.length >= this.options.globalStartsPerWindow) throw new Error('전체 작업 시작 한도에 도달했습니다. 잠시 후 다시 시도하세요.');

    let state = this.principals.get(key);
    let created = false;
    if (!state) {
      if (this.principals.size >= this.options.maxPrincipals) {
        throw new Error('활성 기기별 작업 예산이 가득 찼습니다. 잠시 후 다시 시도하세요.');
      }
      state = { kind, active: 0, providerCallsInFlight: 0, reserved: 0, starts: [], tokens: [], auditTokens: [], lastSeen: now };
      this.principals.set(key, state);
      created = true;
    }
    state.lastSeen = now;
    const activeLimit = kind === 'admin' ? this.options.adminActive : this.options.linkedActive;
    const startLimit = kind === 'admin' ? this.options.adminStartsPerWindow : this.options.linkedStartsPerWindow;
    const reject = (message: string): never => {
      if (created && state?.active === 0 && state.starts.length === 0 && state.tokens.length === 0 && state.auditTokens.length === 0) this.principals.delete(key);
      throw new Error(message);
    };
    if (state.active >= activeLimit) reject('이 기기에서 동시에 실행 중인 작업이 많습니다. 기존 작업을 완료하거나 중지해 주세요.');
    if (state.starts.length >= startLimit) reject('이 기기의 작업 시작 한도에 도달했습니다. 잠시 후 다시 시도하세요.');
    let tokenPolicy: ConversationTokenPolicy = 'adaptive';
    let budget = this.adaptiveBudget({
      tokenPolicy: 'adaptive', complexity: 0, executionMode: 'single', reasoningEffort: 'auto',
      plannedModelCalls: 1, hasTools: false, inputBytes: 0,
    });
    let granted = budget.initial;
    let reservedCeiling = budget.ceiling;
    this.globalActive += 1;
    this.globalReserved += reservedCeiling;
    state.active += 1;
    state.reserved += reservedCeiling;
    this.globalStarts.push(now);
    state.starts.push(now);
    const leaseEpoch = this.epoch;
    let finished = false;
    let callStarted = false;
    let callsReserved = 0;
    let callSpent = 0;
    let callPending = 0;
    return {
      get tokenBudget() { return tokenPolicy === 'audit-only' ? Number.MAX_SAFE_INTEGER : budget.ceiling; },
      get tokenPolicy() { return tokenPolicy; },
      configureModelBudget: (profile) => {
        if (finished || leaseEpoch !== this.epoch) throw new Error('종료된 모델 실행 예산은 다시 구성할 수 없습니다.');
        if (callStarted) throw new Error('모델 호출이 시작된 뒤에는 실행 예산을 바꿀 수 없습니다.');
        // UI gating is convenience only. The policy itself makes remote
        // attempts fail safe even if an RPC validation is accidentally missed.
        tokenPolicy = profile.tokenPolicy === 'audit-only' && auth.isAdmin && capabilities.allowAuditOnly === true
          ? 'audit-only'
          : 'adaptive';
        budget = this.adaptiveBudget({ ...profile, tokenPolicy });
        granted = budget.initial;
        const nextReserved = tokenPolicy === 'adaptive' ? budget.ceiling : 0;
        const delta = nextReserved - reservedCeiling;
        this.globalReserved = Math.max(0, this.globalReserved + delta);
        state!.reserved = Math.max(0, state!.reserved + delta);
        reservedCeiling = nextReserved;
      },
      noteModelProgress: (_kind) => {
        if (finished || leaseEpoch !== this.epoch || tokenPolicy === 'audit-only') return;
        granted = Math.min(budget.ceiling, granted + budget.progressStep);
      },
      reserveModelCall: (kind, maximumTokens) => {
        if (finished || leaseEpoch !== this.epoch) throw new Error('종료된 모델 실행 예산은 다시 사용할 수 없습니다.');
        const requested = Number.isFinite(maximumTokens)
          ? Math.max(1, Math.min(this.options.maxRecordedTokens, Math.floor(maximumTokens)))
          : budget.progressStep;
        let reservation: number;
        if (tokenPolicy === 'audit-only') {
          // Native CLIs often omit usage. Record a finite task-shaped fallback
          // rather than Number.MAX_SAFE_INTEGER, but never stop for token use.
          reservation = kind === 'native' ? budget.initial : requested;
        } else {
          reservation = kind === 'native'
            ? Math.max(0, granted - callSpent - callPending)
            : requested;
          const desired = Math.min(this.options.maxRecordedTokens, callSpent + callPending + reservation);
          // Configured multi-model workflows may consume their planned calls
          // without fake progress events. A single tool loop grows only after
          // noteModelProgress() observes a completed tool round or steering.
          if (desired > granted && callsReserved < budget.plannedCalls) granted = Math.min(budget.ceiling, desired);
          if (reservation <= 0 || desired > granted || desired > budget.ceiling) {
            throw new ModelBudgetExceededError('적응형 AI 예산이 소진되었습니다. 반복 없이 실제 작업 진전이 있어야 계속 확장할 수 있습니다.');
          }
        }
        const principalProviderLimit = state!.kind === 'admin'
          ? this.options.adminProviderCallsInFlight
          : this.options.linkedProviderCallsInFlight;
        if (this.globalProviderCallsInFlight >= this.options.globalProviderCallsInFlight) {
          throw new ModelBudgetExceededError('동시에 실행 중인 전체 AI 제공자 호출이 많습니다. 기존 호출이 끝난 뒤 다시 시도하세요.');
        }
        if (state!.providerCallsInFlight >= principalProviderLimit) {
          throw new ModelBudgetExceededError('이 기기에서 동시에 실행 중인 AI 제공자 호출이 많습니다. 기존 호출이 끝난 뒤 다시 시도하세요.');
        }
        callStarted = true;
        callsReserved += 1;
        callPending = Math.min(this.options.maxRecordedTokens, callPending + reservation);
        this.globalProviderCallsInFlight += 1;
        state!.providerCallsInFlight += 1;
        let providerCallReleased = false;
        const releaseProviderCall = () => {
          if (providerCallReleased) return;
          providerCallReleased = true;
          // Global in-flight accounting spans clear()/restart epochs: an old
          // request remains real outbound work until its own promise settles.
          this.globalProviderCallsInFlight = Math.max(0, this.globalProviderCallsInFlight - 1);
          if (leaseEpoch !== this.epoch) return;
          const current = this.principals.get(key);
          if (current === state) current.providerCallsInFlight = Math.max(0, current.providerCallsInFlight - 1);
        };
        let callFinished = false;
        let settlementAccepted = true;
        let accountedTokens = 0;
        return {
          get accountedTokens() { return accountedTokens; },
          finish: (usage) => {
            if (callFinished) return settlementAccepted;
            callFinished = true;
            releaseProviderCall();
            callPending = Math.max(0, callPending - reservation);
            const report = this.usageReport(usage);
            // Metering from arbitrary compatible endpoints is untrusted even
            // when syntactically valid. Never release the host-owned pre-call
            // reservation; a larger valid report still raises the debit.
            const charged = report.valid ? Math.max(reservation, report.tokens) : reservation;
            accountedTokens = charged;
            callSpent = Math.min(this.options.maxRecordedTokens, callSpent + charged);
            if (tokenPolicy === 'audit-only') return settlementAccepted;
            // An invalid or truly excessive provider report fails closed. A
            // legitimate hidden CLI prompt may exceed the call estimate as long
            // as aggregate run use remains inside the adaptive ceiling.
            // Parallel calls have already passed atomic reservation. Judge
            // their conservative aggregate as each settles; a pending
            // estimate must not create another hidden-context false positive.
            settlementAccepted = report.valid && callSpent <= budget.ceiling;
            return settlementAccepted;
          },
        };
      },
      finish: (usage) => {
        if (finished) return;
        finished = true;
        // A top-level workflow ending is not evidence that every parallel
        // provider request ended. Call leases alone own provider slots and
        // release them only after their provider promise settles or rejects.
        // stop()/clear() begins a new accounting epoch. A late provider
        // completion from the stopped epoch must not repopulate cleared maps.
        if (leaseEpoch !== this.epoch) return;
        const current = this.principals.get(key);
        if (!current) return;
        const finishedAt = this.options.now();
        this.prune(finishedAt);
        this.globalActive = Math.max(0, this.globalActive - 1);
        this.globalReserved = Math.max(0, this.globalReserved - reservedCeiling);
        current.active = Math.max(0, current.active - 1);
        current.reserved = Math.max(0, current.reserved - reservedCeiling);
        current.lastSeen = finishedAt;
        const reportedTotal = this.usageReport(usage).tokens;
        // Real AgentLoop calls settle every provider invocation incrementally.
        // If an alternate loop throws without doing so, keep the top-level
        // reservation as a fail-closed debit because provider use is unknown.
        const tokens = Math.max(
          reportedTotal,
          callSpent + callPending,
          !usage && !callStarted ? granted : 0,
        );
        if (tokens > 0) {
          if (tokenPolicy === 'audit-only') {
            this.pushUsage(this.globalAuditTokens, finishedAt, tokens);
            this.pushUsage(current.auditTokens, finishedAt, tokens);
          } else {
            this.pushUsage(this.globalTokens, finishedAt, tokens);
            this.pushUsage(current.tokens, finishedAt, tokens);
          }
        }
      },
    };
  }

  clear(): void {
    this.epoch += 1;
    this.principals.clear();
    this.globalActive = 0;
    // Do not erase live provider calls. Their idempotent call leases decrement
    // this counter after the underlying request actually settles, even when it
    // belongs to the prior accounting epoch.
    this.globalReserved = 0;
    this.globalStarts = [];
    this.globalTokens = [];
    this.globalAuditTokens = [];
  }

  /** Narrow diagnostics for regression tests; never includes link IDs. */
  snapshot(): { principalCount: number; globalActive: number; globalProviderCallsInFlight: number; globalReserved: number; globalStarts: number; globalTokens: number; globalAuditTokens: number } {
    this.prune(this.options.now());
    return {
      principalCount: this.principals.size,
      globalActive: this.globalActive,
      globalProviderCallsInFlight: this.globalProviderCallsInFlight,
      globalReserved: this.globalReserved,
      globalStarts: this.globalStarts.length,
      globalTokens: this.tokenTotal(this.globalTokens),
      globalAuditTokens: this.tokenTotal(this.globalAuditTokens),
    };
  }

  private adaptiveBudget(profile: ModelBudgetProfile): AdaptiveRunBudget {
    const complexity = Number.isFinite(profile.complexity) ? Math.max(0, Math.min(8, Math.floor(profile.complexity))) : 0;
    const base = complexity <= 1
      ? this.options.adaptiveSimpleCallTokens
      : complexity <= 4
        ? this.options.adaptiveStandardCallTokens
        : this.options.adaptiveComplexCallTokens;
    const effortPercent: Record<ReasoningEffort, number> = {
      none: 80, low: 80, auto: 100, medium: 125, high: 160, xhigh: 220, max: 300,
    };
    const effort = effortPercent[profile.reasoningEffort] ?? 100;
    const inputBytes = Number.isFinite(profile.inputBytes) ? Math.max(0, Math.floor(profile.inputBytes)) : 0;
    const contextFloor = Math.min(this.options.adaptiveAbsoluteMaxTokens, inputBytes + 16_384);
    const progressStep = Math.min(
      this.options.adaptiveAbsoluteMaxTokens,
      Math.max(contextFloor, Math.ceil(base * effort / 100)),
    );
    const plannedCalls = Math.max(1, Math.min(64, Math.floor(profile.plannedModelCalls) || 1));
    const initial = Math.min(this.options.adaptiveAbsoluteMaxTokens, progressStep * plannedCalls);
    const progressCalls = profile.hasTools
      ? this.options.adaptiveToolProgressCalls
      : profile.executionMode === 'single' ? 0 : 2;
    const ceiling = Math.min(
      this.options.adaptiveAbsoluteMaxTokens,
      Math.max(initial, progressStep * (plannedCalls + progressCalls)),
    );
    return { initial: Math.max(1, initial), ceiling: Math.max(1, ceiling), progressStep: Math.max(1, progressStep), plannedCalls };
  }

  private usageReport(
    usage?: Pick<ProviderUsage, 'promptTokens' | 'completionTokens' | 'reportStatus'>,
  ): { tokens: number; valid: boolean } {
    if (!usage) return { tokens: 0, valid: true };
    // Provider adapters normalize malformed counters to zero so storage stays
    // finite. Preserve their trust signal here: an invalid report must not be
    // mistaken for a legitimate zero-token call. Missing metering remains a
    // supported case and is charged at the conservative reservation instead.
    if (usage.reportStatus === 'invalid') return { tokens: 0, valid: false };
    const values = [usage.promptTokens, usage.completionTokens];
    const valid = values.every((value) => value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0));
    const tokens = values.reduce<number>((total, value) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return total;
      return Math.min(this.options.maxRecordedTokens, total + Math.floor(value));
    }, 0);
    return { tokens, valid };
  }

  private pushUsage(samples: Array<{ at: number; count: number }>, at: number, count: number): void {
    samples.push({ at, count: Math.min(this.options.maxRecordedTokens, Math.max(0, Math.floor(count))) });
    if (samples.length > CHAT_RUN_MAX_HISTORY_SAMPLES) samples.splice(0, samples.length - CHAT_RUN_MAX_HISTORY_SAMPLES);
  }

  private tokenTotal(samples: Array<{ at: number; count: number }>): number {
    return samples.reduce((total, sample) => Math.min(Number.MAX_SAFE_INTEGER, total + sample.count), 0);
  }

  private prune(now: number): void {
    this.globalStarts = this.globalStarts.filter((at) => now - at < this.options.startWindowMs);
    this.globalTokens = this.globalTokens.filter((sample) => now - sample.at < this.options.auditWindowMs);
    this.globalAuditTokens = this.globalAuditTokens.filter((sample) => now - sample.at < this.options.auditWindowMs);
    for (const [key, state] of this.principals) {
      state.starts = state.starts.filter((at) => now - at < this.options.startWindowMs);
      state.tokens = state.tokens.filter((sample) => now - sample.at < this.options.auditWindowMs);
      state.auditTokens = state.auditTokens.filter((sample) => now - sample.at < this.options.auditWindowMs);
      if (state.active === 0 && state.providerCallsInFlight === 0 && state.reserved === 0 && state.starts.length === 0 && state.tokens.length === 0 && state.auditTokens.length === 0) this.principals.delete(key);
    }
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
  readonly toolPortalSessions = new ToolPortalSessionManager(
    () => this.config.toolPortalStatus(),
    (password) => this.config.verifyToolPortalPassword(password),
  );
  private readonly toolPortalArtifacts = new ToolPortalArtifactStore();
  private readonly activeToolPortalRuns = new Map<AbortController, string>();
  private readonly toolPortalObserverSessions = new Map<string, { owner: string; timer: NodeJS.Timeout }>();
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
  readonly chatRunAdmission = new ChatRunAdmissionPolicy();
  private readonly remoteLinkPlugin = createRemoteLinkPlugin();
  private readonly discordPlugin = createDiscordPlugin({
    port: () => this.boundPort,
    enabled: () => this.plugins.list().some((item) => item.id === 'discord-agent' && item.enabled),
    issue: () => {
      const grant = this.config.createDeviceLink('Discord Agent', 'ask', []);
      return { token: grant.token, id: grant.link.id };
    },
    revoke: (id) => { try { this.config.revokeDeviceLink(id); } finally { this.invalidateDeviceLink(id); } },
    models: () => this.config.providers.map((provider) => ({ providerId: provider.id, name: provider.label, model: provider.model })),
  });
  private readonly webCryptoObserverPlugin = createWebCryptoObserverPlugin({
    policyProvider: {
      getPolicy: () => {
        const status = this.config.toolPortalStatus();
        return {
          enabled: status.allowedTargetHosts.length > 0,
          allowedDomains: status.allowedTargetHosts,
        };
      },
    },
  });

  private httpServer: HttpServer | null = null;
  private readonly activeHttpTransfers = new Set<AbortController>();
  private readonly wsUpgradeTickets = new WsUpgradeTickets();
  /** Hash-only, memory-only proofs issued directly to the embedded Electron main process. */
  private readonly desktopAuditProofs = new Map<string, number>();
  private hub: WsHub | null = null;
  private pinLimiter = new PinLimiter();
  /** Explicitly-created, memory-only enrollment code for an unattended handoff. */
  private remoteHandoff: {
    pin: string;
    expiresAt: number;
    bootstrap?: { assertionHash: string; origin: string; expiresAt: number };
  } | null = null;
  private remoteHandoffTombstone: {
    pinHash: string;
    code: 'PAIRING_CONSUMED' | 'PAIRING_EXPIRED';
    expiresAt: number;
  } | null = null;
  private readonly remoteBootstrapChallenges = new Map<string, {
    origin: string;
    clientIdHash: string;
    expiresAt: number;
  }>();
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
    if (!auth.isAdmin) {
      const link = this.config.deviceLinks.find((item) => item.id === auth.linkId && !item.revokedAt);
      if (!link?.capabilities.includes('file-transfer')) return false;
    }
    if (!write) return true;
    const cap = effectiveMode(this.config.settings.safety.mode, auth.permissionCap);
    return cap === 'workspace' || cap === 'full';
  }

  /** Shared inbox/outbox writes are isolated to ~/.mr-robot/shared and need ask-or-higher. */
  sharedFileAccess(candidate: string, write: boolean): boolean {
    const auth = this.authenticate(candidate);
    if (!auth) return false;
    if (!auth.isAdmin) {
      const link = this.config.deviceLinks.find((item) => item.id === auth.linkId && !item.revokedAt);
      if (!link?.capabilities.includes('file-transfer')) return false;
    }
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

  /**
   * In-process desktop bootstrap only. This method is not reachable through
   * HTTP, WebSocket RPC or preload IPC; Electron main attaches the returned
   * one-use value to its private auth frame and then discards it.
   */
  issueDesktopAuditProof(): string {
    if (!this.httpServer) throw new Error('로컬 에이전트가 실행 중일 때만 네이티브 감사 권한을 발급할 수 있습니다.');
    const now = Date.now();
    this.pruneDesktopAuditProofs(now);
    if (this.desktopAuditProofs.size >= DESKTOP_AUDIT_PROOF_MAX_PENDING) {
      throw new Error('미사용 네이티브 감사 권한이 너무 많습니다. 잠시 후 다시 연결해 주세요.');
    }
    const proof = randomBytes(32).toString('base64url');
    this.desktopAuditProofs.set(hashToken(proof), now + DESKTOP_AUDIT_PROOF_TTL_MS);
    return proof;
  }

  private authenticateWebSocket(candidate: string, desktopAuditProof?: string): AuthContext | null {
    // Consume before authenticating the bearer so a proof presented with the
    // wrong secret cannot be recovered and replayed with the right one.
    const nativeAuditOnly = this.consumeDesktopAuditProof(desktopAuditProof);
    const auth = this.authenticate(candidate);
    if (!auth) return null;
    return nativeAuditOnly && auth.isAdmin ? { ...auth, nativeAuditOnly: true } : auth;
  }

  private consumeDesktopAuditProof(proof: string | undefined, now = Date.now()): boolean {
    this.pruneDesktopAuditProofs(now);
    if (typeof proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(proof)) return false;
    const digest = hashToken(proof);
    const expiresAt = this.desktopAuditProofs.get(digest);
    this.desktopAuditProofs.delete(digest);
    return typeof expiresAt === 'number' && expiresAt > now;
  }

  private pruneDesktopAuditProofs(now = Date.now()): void {
    for (const [digest, expiresAt] of this.desktopAuditProofs) {
      if (expiresAt <= now) this.desktopAuditProofs.delete(digest);
    }
  }

  private bindRemoteHandoffBootstrap(value: unknown): boolean {
    const body = value as { pinHash?: unknown; assertionHash?: unknown; origin?: unknown; expiresAt?: unknown };
    const handoff = this.remoteHandoff;
    const now = Date.now();
    if (!handoff || handoff.expiresAt <= now
      || typeof body?.pinHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.pinHash)
      || typeof body?.assertionHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.assertionHash)
      || !safeEqual(body.pinHash, hashToken(handoff.pin))) return false;
    const expiresAt = Number(body.expiresAt);
    let origin: string;
    try {
      const parsed = new URL(String(body.origin ?? ''));
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password
        || (parsed.port && parsed.port !== '443') || parsed.pathname !== '/'
        || parsed.search || parsed.hash || parsed.origin !== String(body.origin)) return false;
      origin = parsed.origin;
    } catch {
      return false;
    }
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now + 30_000
      || expiresAt > handoff.expiresAt || expiresAt > now + 10 * 60_000) return false;
    handoff.bootstrap = { assertionHash: body.assertionHash, origin, expiresAt };
    this.bus.emit('pairing.changed', { at: now });
    return true;
  }

  private registerRemoteBootstrapChallenge(value: unknown): boolean {
    const body = value as {
      pinHash?: unknown;
      challengeHash?: unknown;
      clientIdHash?: unknown;
      origin?: unknown;
      expiresAt?: unknown;
    };
    const handoff = this.remoteHandoff;
    const now = Date.now();
    if (!handoff || handoff.expiresAt <= now
      || typeof body?.pinHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.pinHash)
      || !safeEqual(body.pinHash, hashToken(handoff.pin))
      || typeof body?.challengeHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.challengeHash)
      || typeof body?.clientIdHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.clientIdHash)) return false;
    const expiresAt = Number(body.expiresAt);
    let origin = '';
    try {
      const parsed = new URL(String(body.origin ?? ''));
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password
        || (parsed.port && parsed.port !== '443') || parsed.pathname !== '/'
        || parsed.search || parsed.hash || parsed.origin !== body.origin) return false;
      origin = parsed.origin;
    } catch {
      return false;
    }
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 30_000) return false;
    for (const [key, challenge] of this.remoteBootstrapChallenges) {
      if (challenge.expiresAt <= now) this.remoteBootstrapChallenges.delete(key);
    }
    if (this.remoteBootstrapChallenges.size >= 8) this.remoteBootstrapChallenges.delete(this.remoteBootstrapChallenges.keys().next().value!);
    this.remoteBootstrapChallenges.set(body.challengeHash, { origin, clientIdHash: body.clientIdHash, expiresAt });
    return true;
  }

  consumeRemoteBootstrapChallenge(challenge: string, assertion: string, origin: string): boolean {
    const now = Date.now();
    const key = hashToken(challenge);
    const pending = this.remoteBootstrapChallenges.get(key);
    // Delete before parsing so simultaneous requests cannot replay a challenge.
    this.remoteBootstrapChallenges.delete(key);
    if (!pending || pending.expiresAt <= now || pending.origin !== origin
      || !/^[A-Za-z0-9_-]{43}$/.test(challenge)
      || assertion.length < 64 || assertion.length > 4_096
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(assertion)) return false;
    try {
      const raw = Buffer.from(assertion.split('.')[1]!, 'base64url');
      if (raw.length === 0 || raw.length > 8 * 1024) return false;
      const payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      const issuer = new URL(String(payload.iss ?? ''));
      const expiresAt = Number(payload.exp) * 1_000;
      const commonName = String(payload.common_name ?? '');
      return payload.type === 'app'
        && payload.sub === ''
        && Number.isSafeInteger(expiresAt)
        && expiresAt > now + 30_000
        && issuer.protocol === 'https:'
        && issuer.hostname.toLowerCase().endsWith('.cloudflareaccess.com')
        && safeEqual(hashToken(commonName), pending.clientIdHash);
    } catch {
      return false;
    }
  }

  exchangePin(
    pin: string,
    deviceName = '연결된 기기',
    permissionCap: PermissionMode = 'ask',
    clientKey = 'unknown',
    remoteProof?: { assertion: string; origin: string },
  ): {
    ok: boolean;
    secret?: string;
    linkId?: string;
    cloudflareAccess?: { clientId: string; clientSecret: string };
    code?: 'PAIRING_CONSUMED' | 'PAIRING_EXPIRED';
    error?: string;
  } {
    const check = this.pinLimiter.check(clientKey);
    if (!check.allowed) return { ok: false, error: `too many attempts, retry in ${Math.ceil((check.retryAfterMs ?? 0) / 1000)}s` };
    const now = Date.now();
    if (this.remoteHandoffTombstone && now > this.remoteHandoffTombstone.expiresAt) this.remoteHandoffTombstone = null;
    if (this.remoteHandoff && now > this.remoteHandoff.expiresAt) {
      this.remoteHandoffTombstone = {
        pinHash: hashToken(this.remoteHandoff.pin),
        code: 'PAIRING_EXPIRED',
        expiresAt: now + 10 * 60_000,
      };
      this.remoteHandoff = null;
      this.remoteBootstrapChallenges.clear();
    }
    const tombstone = this.remoteHandoffTombstone;
    if (/^\d{12}$/.test(pin) && tombstone && safeEqual(hashToken(pin), tombstone.pinHash)) {
      return {
        ok: false,
        code: tombstone.code,
        error: tombstone.code === 'PAIRING_CONSUMED'
          ? '이 외출용 등록 코드는 이미 사용되었습니다. PC에서 새 코드를 만드세요.'
          : '이 외출용 등록 코드가 만료되었습니다. PC에서 새 코드를 만드세요.',
      };
    }
    const handoff = this.remoteHandoff;
    const remoteHandoffMatch = Boolean(
      handoff
      && now <= handoff.expiresAt
      && safeEqual(pin, handoff.pin),
    );
    if (!remoteHandoffMatch && now - this.config.pinCreatedAt > PAIRING_PIN_TTL_MS) {
      this.config.regeneratePin();
      this.pinLimiter.reset();
      this.bus.emit('pairing.changed', { at: Date.now() });
      return { ok: false, error: 'pairing pin expired; refresh the PC pairing screen' };
    }
    if (!remoteHandoffMatch && !safeEqual(pin, this.config.pin)) {
      this.pinLimiter.recordFailure(clientKey);
      return { ok: false, error: 'invalid pin' };
    }
    let cloudflareAccess: { clientId: string; clientSecret: string } | undefined;
    if (remoteHandoffMatch && handoff?.bootstrap) {
      const proof = remoteProof;
      const assertion = String(proof?.assertion ?? '').trim();
      let origin = '';
      try {
        const parsed = new URL(String(proof?.origin ?? ''));
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password
          || (parsed.port && parsed.port !== '443') || parsed.pathname !== '/'
          || parsed.search || parsed.hash || parsed.origin !== proof?.origin) throw new Error('invalid origin');
        origin = parsed.origin;
      } catch {
        this.pinLimiter.recordFailure(clientKey);
        return { ok: false, error: '자동 보안 등록 요청의 원격 주소가 올바르지 않습니다.' };
      }
      if (handoff.bootstrap.expiresAt <= now
        || origin !== handoff.bootstrap.origin
        || assertion.length < 64 || assertion.length > 4_096
        || !safeEqual(hashToken(assertion), handoff.bootstrap.assertionHash)) {
        this.pinLimiter.recordFailure(clientKey);
        return { ok: false, error: '자동 보안 등록 세션이 만료되었거나 이 QR과 일치하지 않습니다.' };
      }
      // This bridge is not an RPC/plugin command. It returns credentials only
      // for the exact DPAPI-configured named host after the one-time assertion
      // and PIN have both matched, before either credential is consumed.
      const headers = this.remoteLinkPlugin.peerRequestHeaders(new URL(origin));
      const clientId = String(headers['CF-Access-Client-Id'] ?? '');
      const clientSecret = String(headers['CF-Access-Client-Secret'] ?? '');
      if (clientId.length < 20 || clientId.length > 512 || clientSecret.length < 20 || clientSecret.length > 512
        || !/^[A-Za-z0-9._~-]+$/.test(clientId) || !/^[A-Za-z0-9._~-]+$/.test(clientSecret)) {
        return { ok: false, error: 'PC의 Cloudflare Access 보안 저장소를 읽지 못했습니다. 원격 연결 설정을 다시 확인하세요.' };
      }
      cloudflareAccess = { clientId, clientSecret };
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
    // Every displayed enrollment code is single-use. Consuming either the
    // short QR PIN or the explicit remote handoff code invalidates both.
    if (remoteHandoffMatch && handoff) {
      this.remoteHandoffTombstone = {
        pinHash: hashToken(handoff.pin),
        code: 'PAIRING_CONSUMED',
        expiresAt: now + 10 * 60_000,
      };
    }
    this.remoteHandoff = null;
    this.remoteBootstrapChallenges.clear();
    this.config.regeneratePin();
    this.pinLimiter.reset();
    this.bus.emit('pairing.changed', { at: Date.now() });
    return {
      ok: true,
      secret: created.token,
      linkId: created.link.id,
      ...(cloudflareAccess ? { cloudflareAccess } : {}),
    };
  }

  /**
   * Create a stronger unattended enrollment credential without extending the
   * ordinary six-digit QR PIN. It is never persisted, dies with the agent,
   * and is consumed together with the normal pairing epoch after one success.
   */
  createRemoteHandoff(ttlMinutes = REMOTE_HANDOFF_TTL_MAX_MINUTES): { pin: string; expiresAt: number } {
    const requested = Number.isFinite(ttlMinutes) ? Math.floor(ttlMinutes) : REMOTE_HANDOFF_TTL_MAX_MINUTES;
    const boundedMinutes = Math.max(REMOTE_HANDOFF_TTL_MINUTES, Math.min(REMOTE_HANDOFF_TTL_MAX_MINUTES, requested));
    let pin = '';
    do pin = String(randomInt(100_000_000_000, 1_000_000_000_000));
    while (pin === this.config.pin || pin === this.remoteHandoff?.pin);
    const expiresAt = Date.now() + boundedMinutes * 60_000;
    this.remoteHandoff = { pin, expiresAt };
    this.remoteBootstrapChallenges.clear();
    this.pinLimiter.reset();
    this.bus.emit('pairing.changed', { at: Date.now() });
    this.logger.info(`remote handoff code created (expires in ${boundedMinutes} minutes; memory-only)`);
    return { pin, expiresAt };
  }

  revokeRemoteHandoff(reason = 'administrator request'): boolean {
    if (!this.remoteHandoff) return false;
    this.remoteHandoffTombstone = {
      pinHash: hashToken(this.remoteHandoff.pin),
      code: 'PAIRING_EXPIRED',
      expiresAt: Date.now() + 10 * 60_000,
    };
    this.remoteHandoff = null;
    this.remoteBootstrapChallenges.clear();
    this.bus.emit('pairing.changed', { at: Date.now() });
    this.logger.info(`remote handoff code revoked (${reason})`);
    return true;
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

  pairingInfo(includeLocalSecret = false, includePairingCode = false): PairingInfo {
    const now = Date.now();
    if (includePairingCode && now - this.config.pinCreatedAt > PAIRING_PIN_TTL_MS) {
      this.config.regeneratePin();
      this.pinLimiter.reset();
    }
    if (this.remoteHandoff && now > this.remoteHandoff.expiresAt) {
      this.remoteHandoffTombstone = {
        pinHash: hashToken(this.remoteHandoff.pin),
        code: 'PAIRING_EXPIRED',
        expiresAt: now + 10 * 60_000,
      };
      this.remoteHandoff = null;
      this.remoteBootstrapChallenges.clear();
    }
    const port = this.boundPort || this.config.settings.network.port;
    // The generic pairing response is local-controller metadata only. Never
    // advertise a raw 100.64/10 HTTP address: the client cannot prove that its
    // active route is the Tailscale adapter. Remote Link and Tailscale Serve
    // publish their own HTTPS origin through the plugin UI.
    const host = '127.0.0.1';
    const hosts = [host];
    return {
      deviceName: this.config.settings.deviceName,
      host,
      hosts,
      port,
      ...(includeLocalSecret || includePairingCode ? { maskedSecret: maskSecret(this.secret) } : {}),
      ...(includePairingCode ? {
        pin: this.config.pin,
        pinExpiresAt: this.config.pinCreatedAt + PAIRING_PIN_TTL_MS,
        qrPayload: pairingPayload(host, port, this.config.pin, hosts),
        ...(this.remoteHandoff ? { remoteHandoff: { pin: this.remoteHandoff.pin, expiresAt: this.remoteHandoff.expiresAt } } : {}),
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

  pluginsSetCategory(id: string, category: PluginCategory): PluginInfo {
    return this.plugins.setCategory(id, category);
  }

  async pluginsLoad(source: string): Promise<PluginInfo> {
    return this.plugins.load(source);
  }

  async pluginsUnload(id: string): Promise<boolean> {
    return this.plugins.unload(id);
  }

  async pluginsCall(name: string, params: unknown, auth?: AuthContext, workspaceId?: string): Promise<unknown> {
    const permissionMode = effectiveMode(this.config.settings.safety.mode, auth?.permissionCap);
    const deviceCapabilities = auth?.isAdmin
      ? ['work-sync', 'private-calendar', 'file-transfer']
      : this.config.deviceLinks.find((link) => link.id === auth?.linkId && !link.revokedAt)?.capabilities ?? [];
    const requiredCapability = this.plugins.requiredCapability(name);
    if (this.plugins.isAdminOnly(name) && !auth?.isAdmin) throw new Error('이 플러그인 설정은 관리자 권한이 필요합니다.');
    const narrowCapabilityAllowsWrite = permissionMode !== 'read-only'
      && Boolean(requiredCapability && deviceCapabilities.includes(requiredCapability as DeviceCapability));
    if (this.plugins.isDestructive(name) && !auth?.isAdmin && permissionMode !== 'full' && !narrowCapabilityAllowsWrite) {
      throw new Error('직접 변경형 플러그인 호출은 전체 허용 모드가 필요합니다. 대화에서 위임하면 현재 권한 정책에 따라 승인됩니다.');
    }
    let workspaceRoot: string | undefined;
    if (workspaceId !== undefined) {
      if (!auth?.isAdmin) throw new Error('플러그인 작업 폴더 선택은 관리자 권한이 필요합니다.');
      const workspace = this.config.workspaces.find((item) => item.id === workspaceId);
      if (!workspace) throw new Error('등록된 작업 폴더를 찾을 수 없습니다.');
      workspaceRoot = workspace.path;
    }
    return this.plugins.call(name, params, {
      permissionMode,
      isAdmin: auth?.isAdmin === true,
      deviceCapabilities,
      workspaceRoot,
      destructiveApproved: auth?.isAdmin === true || !this.plugins.isDestructive(name) || permissionMode === 'full' || narrowCapabilityAllowsWrite,
      approvalSource: this.plugins.isDestructive(name) ? 'policy' : 'not-required',
    });
  }

  toolPortalSession(token: unknown, requestProof: unknown): { enabled: boolean; authenticated: boolean; expiresAt?: number; hookMutationEnabled?: boolean } {
    const status = this.config.toolPortalStatus();
    const session = this.toolPortalSessions.authenticate(token, requestProof);
    return {
      enabled: status.enabled,
      authenticated: Boolean(session),
      ...(session ? { expiresAt: session.expiresAt, hookMutationEnabled: status.hookMutationEnabled } : {}),
    };
  }

  async toolPortalLogin(password: unknown, clientKey: string): Promise<{ token: string; requestProof: string; session: ToolPortalSession }> {
    return this.toolPortalSessions.login(password, clientKey);
  }

  async toolPortalLogout(token: unknown, requestProof: unknown): Promise<boolean> {
    const session = this.toolPortalSessions.authenticate(token, requestProof);
    const loggedOut = this.toolPortalSessions.logout(token, requestProof);
    if (!session) return loggedOut;
    for (const [controller, owner] of this.activeToolPortalRuns) {
      if (owner === session.key && !controller.signal.aborted) controller.abort(new Error('도구 포털에서 로그아웃했습니다.'));
    }
    this.toolPortalArtifacts.clearSession(session.key);
    await this.stopToolPortalObservers(session.key);
    return loggedOut;
  }

  toolPortalAdminStatus(): {
    enabled: boolean;
    passwordConfigured: boolean;
    allowedDomains: string[];
    workspaceId: string | null;
    workspaceName?: string;
    hookMutationEnabled: boolean;
  } {
    const status = this.config.toolPortalStatus();
    const workspace = this.config.toolPortalWorkspace();
    return {
      enabled: status.enabled,
      passwordConfigured: status.enabled,
      allowedDomains: status.allowedTargetHosts,
      workspaceId: status.portalWorkspaceId ?? null,
      ...(workspace ? { workspaceName: workspace.name } : {}),
      hookMutationEnabled: status.hookMutationEnabled,
    };
  }

  async configureToolPortal(input: ToolPortalConfigureInput): Promise<ReturnType<AgentServer['toolPortalAdminStatus']>> {
    await this.config.configureToolPortal(input);
    await this.revokeToolPortalAuthority('도구 포털 설정이 변경되었습니다.');
    return this.toolPortalAdminStatus();
  }

  async disableToolPortal(): Promise<ReturnType<AgentServer['toolPortalAdminStatus']>> {
    await this.config.disableToolPortal();
    await this.revokeToolPortalAuthority('도구 포털이 비활성화되었습니다.');
    return this.toolPortalAdminStatus();
  }

  /** Only the exact currently verified named Remote Link origin may expose the portal publicly. */
  toolPortalOriginAllowed(origin: URL): boolean {
    return this.remoteLinkPlugin.portalOriginAllowed(origin);
  }

  async toolPortalCall(
    token: unknown,
    requestProof: unknown,
    tool: ToolPortalToolId,
    action: ToolPortalAction,
    raw: unknown,
    requestSignal?: AbortSignal,
  ): Promise<unknown> {
    const session = this.toolPortalSessions.authenticate(token, requestProof);
    if (!session) throw new ToolPortalError('도구 포털 로그인이 필요합니다.', 401, 'PORTAL_UNAUTHORIZED');
    if (this.activeToolPortalRuns.size >= 8
      || [...this.activeToolPortalRuns.values()].filter((owner) => owner === session.key).length >= 2) {
      throw new ToolPortalError('동시에 실행 중인 포털 작업이 너무 많습니다.', 429, 'PORTAL_RUN_LIMIT_REACHED', 5);
    }
    const controller = new AbortController();
    const actionTimeout = tool === 'resource-archiver' && action === 'archive' ? 70_000
      : tool === 'runtime-hook' && action === 'observe' ? 15_000
        : 65_000;
    const signals = [controller.signal, AbortSignal.timeout(actionTimeout), ...(requestSignal ? [requestSignal] : [])];
    const signal = AbortSignal.any(signals);
    this.activeToolPortalRuns.set(controller, session.key);
    try {
      if (tool === 'resource-archiver') return await this.callPortalResource(session, action, raw, signal);
      if (tool === 'sslscan') return await this.callPortalSsl(session, action, raw, signal);
      if (tool === 'runtime-hook') return await this.callPortalRuntime(session, action, raw, signal);
      throw new ToolPortalError('지원하지 않는 포털 도구입니다.', 404, 'TOOL_NOT_FOUND');
    } finally {
      this.activeToolPortalRuns.delete(controller);
    }
  }

  toolPortalArtifact(token: unknown, requestProof: unknown, capability: unknown): ToolPortalArtifactFile {
    const session = this.toolPortalSessions.authenticate(token, requestProof);
    if (!session) throw new ToolPortalError('도구 포털 로그인이 필요합니다.', 401, 'PORTAL_UNAUTHORIZED');
    const workspace = this.config.toolPortalWorkspace();
    if (!workspace) throw new ToolPortalError('포털 작업 폴더가 설정되지 않았습니다.', 409, 'PORTAL_WORKSPACE_REQUIRED');
    return this.toolPortalArtifacts.consume(capability, session.key, workspace.path);
  }

  private assertPortalTargetAllowed(host: string, status = this.config.toolPortalStatus()): void {
    if (!status.allowedTargetHosts.includes(normalizeToolPortalTargetHost(host))) {
      throw new ToolPortalError('이 대상은 네이티브 앱의 정확한 허가 도메인 목록에 없습니다.', 403, 'TARGET_NOT_ALLOWED');
    }
  }

  private portalExecution(signal: AbortSignal, destructive: boolean, workspaceRoot?: string) {
    return {
      signal,
      permissionMode: workspaceRoot ? 'workspace' as const : 'ask' as const,
      isAdmin: false,
      deviceCapabilities: [] as const,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      destructiveApproved: destructive,
      approvalSource: destructive ? 'prompt' as const : 'not-required' as const,
    };
  }

  private portalRuntimeExecution(signal: AbortSignal, destructive: boolean) {
    return { ...this.portalExecution(signal, destructive), portalCapability: 'webcrypto-observer' as const };
  }

  private async callPortalResource(session: ToolPortalSession, action: ToolPortalAction, raw: unknown, signal: AbortSignal): Promise<unknown> {
    if (action !== 'validate' && action !== 'preview' && action !== 'archive') {
      throw new ToolPortalError('지원하지 않는 Resource Archiver 작업입니다.', 404, 'ACTION_NOT_FOUND');
    }
    const body = portalObject(raw);
    if (body.authorizationConfirmed !== true) throw new ToolPortalError('대상 보존 권한을 실행마다 확인해야 합니다.', 400, 'AUTHORIZATION_REQUIRED');
    const target = portalTargetFromUrl(body.pageUrl);
    const status = this.config.toolPortalStatus();
    this.assertPortalTargetAllowed(target.host, status);
    const rawCrossOrigins = body.allowedCrossOriginHosts ?? [];
    if (!Array.isArray(rawCrossOrigins) || rawCrossOrigins.length > 32) throw new ToolPortalError('교차 출처 허가 목록이 올바르지 않습니다.', 400, 'INVALID_REQUEST');
    const allowedCrossOriginHosts = [...new Set(rawCrossOrigins.map(normalizeToolPortalTargetHost))];
    for (const host of allowedCrossOriginHosts) this.assertPortalTargetAllowed(host, status);
    const fetchMissing = toolPortalResourceFetchMissing(action, body.fetchMissing);
    const limits = normalizeToolPortalResourceLimits(body.limits, fetchMissing);
    const archiveHost = target.host.replace(/[^a-z0-9.-]/gi, '-').slice(0, 80) || 'site';
    const outputPath = action === 'archive'
      ? `resource-archives/portal-${archiveHost}-${Date.now()}-${randomUUID().slice(0, 8)}.zip`
      : 'resource-archives/portal-preview.zip';
    const request = {
      authorizationConfirmed: true,
      pageUrl: target.url,
      outputPath,
      ...(body.capturedResources !== undefined ? { capturedResources: body.capturedResources } : {}),
      ...(body.har !== undefined ? { har: body.har } : {}),
      fetchMissing,
      discoverDependencies: body.discoverDependencies !== false,
      rewriteOfflineLinks: body.rewriteOfflineLinks !== false,
      allowedCrossOriginHosts,
      limits,
    };
    const command = `resource-archiver.${action}`;
    if (action !== 'archive') {
      const result = await this.plugins.call(command, request, this.portalExecution(signal, false));
      if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
      const { outputPath: _outputPath, ...safeResult } = result as Record<string, unknown>;
      return safeResult;
    }
    const workspace = this.config.toolPortalWorkspace();
    if (!workspace || !status.workspaceConfigured) throw new ToolPortalError('네이티브 앱에서 포털 작업 폴더를 먼저 선택하세요.', 409, 'PORTAL_WORKSPACE_REQUIRED');
    const result = await this.plugins.call(command, request, this.portalExecution(signal, true, workspace.path));
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof (result as { outputPath?: unknown }).outputPath !== 'string') {
      throw new ToolPortalError('아카이브 결과 파일을 확인할 수 없습니다.', 500, 'INVALID_PLUGIN_RESULT');
    }
    const { outputPath: absoluteOutputPath, ...summary } = result as Record<string, unknown> & { outputPath: string };
    const artifact = this.toolPortalArtifacts.issue(session.key, absoluteOutputPath, workspace.path);
    return { artifactToken: artifact.capability, fileName: artifact.name, summary };
  }

  private async callPortalSsl(_session: ToolPortalSession, action: ToolPortalAction, raw: unknown, signal: AbortSignal): Promise<unknown> {
    if (action === 'status') return this.plugins.call('sslscan.status', {}, this.portalExecution(signal, false));
    if (action !== 'scan') throw new ToolPortalError('지원하지 않는 TLS 점검 작업입니다.', 404, 'ACTION_NOT_FOUND');
    const body = portalObject(raw);
    if (body.authorizationConfirmed !== true) throw new ToolPortalError('TLS 점검 권한을 실행마다 확인해야 합니다.', 400, 'AUTHORIZATION_REQUIRED');
    const host = normalizeToolPortalTargetHost(body.host);
    const status = this.config.toolPortalStatus();
    this.assertPortalTargetAllowed(host, status);
    const scanMode = normalizeToolPortalSslScanMode(body.scanMode);
    let sni: string | undefined;
    if (body.sni !== undefined) {
      sni = normalizeToolPortalTargetHost(body.sni);
      this.assertPortalTargetAllowed(sni, status);
    }
    const maxCipherTests = normalizeToolPortalMaxCipherTests(scanMode, body.maxCipherTests);
    const request = {
      host,
      ...(body.port !== undefined ? { port: body.port } : {}),
      ...(sni ? { sni } : {}),
      authorizationConfirmed: true,
      scanMode,
      timeoutMs: portalInteger(body.timeoutMs, 2_500, 500, 4_000, 'timeoutMs'),
      overallTimeoutMs: portalInteger(body.overallTimeoutMs, 30_000, 3_000, 50_000, 'overallTimeoutMs'),
      maxCipherTests,
      forceRefresh: body.forceRefresh === true,
    };
    return this.plugins.call('sslscan.scan', request, this.portalExecution(signal, true));
  }

  private portalObserverOwner(sessionId: unknown, session: ToolPortalSession): string {
    if (typeof sessionId !== 'string' || sessionId.length < 8 || sessionId.length > 160) {
      throw new ToolPortalError('관찰 세션 ID가 올바르지 않습니다.', 400, 'INVALID_REQUEST');
    }
    if (this.toolPortalObserverSessions.get(sessionId)?.owner !== session.key) {
      throw new ToolPortalError('이 포털 로그인에서 시작한 관찰 세션이 아닙니다.', 404, 'SESSION_NOT_FOUND');
    }
    return sessionId;
  }

  private async callPortalRuntime(session: ToolPortalSession, action: ToolPortalAction, raw: unknown, signal: AbortSignal): Promise<unknown> {
    const body = portalObject(raw);
    if (action === 'analyze') {
      if (body.authorizationConfirmed !== true || typeof body.sourceText !== 'string'
        || Buffer.byteLength(body.sourceText, 'utf8') > 256 * 1024) {
        throw new ToolPortalError('오프라인 분석 권한 또는 256KiB 이하 소스를 확인하세요.', 400, 'INVALID_REQUEST');
      }
      return this.plugins.call('webcrypto-observer.analyze', {
        authorizationConfirmed: true,
        sourceText: body.sourceText,
      }, this.portalRuntimeExecution(signal, false));
    }
    if (action === 'observe') {
      if (body.authorizationConfirmed !== true || body.sessionEnabled !== true) {
        throw new ToolPortalError('관찰 권한과 세션 시작을 실행마다 확인해야 합니다.', 400, 'AUTHORIZATION_REQUIRED');
      }
      const target = portalTargetFromUrl(body.targetUrl);
      const targetUrl = new URL(target.url);
      if (targetUrl.protocol !== 'https:' || (targetUrl.port && targetUrl.port !== '443')) {
        throw new ToolPortalError('Runtime Hook 대상은 표준 443 포트의 HTTPS URL이어야 합니다.', 400, 'INVALID_TARGET');
      }
      const status = this.config.toolPortalStatus();
      this.assertPortalTargetAllowed(target.host, status);
      const plaintext = body.plaintextPreview === undefined ? undefined : portalObject(body.plaintextPreview, '평문 미리보기');
      if (plaintext && (plaintext.enabled !== true || plaintext.previewConfirmed !== true)) {
        throw new ToolPortalError('평문 미리보기 위험을 명시적으로 확인해야 합니다.', 400, 'PLAINTEXT_CONFIRMATION_REQUIRED');
      }
      const stateChanging = body.allowStateChangingRequests === true;
      if (stateChanging && (body.stateChangingRequestsConfirmed !== true || !status.hookMutationEnabled)) {
        throw new ToolPortalError('상태 변경 요청은 네이티브 opt-in과 실행별 확인이 모두 필요합니다.', 403, 'HOOK_MUTATION_DISABLED');
      }
      const rawLimits = body.limits === undefined ? {} : portalObject(body.limits, '관찰 한도');
      const request = {
        authorizationConfirmed: true,
        sessionEnabled: true,
        targetUrl: target.url,
        ...(plaintext ? { plaintextPreview: {
          enabled: true,
          previewConfirmed: true,
          maxBytes: portalInteger(plaintext.maxBytes, 64, 1, 128, 'plaintext maxBytes'),
        } } : {}),
        allowStateChangingRequests: stateChanging,
        stateChangingRequestsConfirmed: stateChanging,
        limits: {
          durationMs: portalInteger(rawLimits.durationMs, 10_000, 1_000, 30_000, 'durationMs'),
          maxRequests: portalInteger(rawLimits.maxRequests, 20, 1, 40, 'maxRequests'),
          maxResponseBytes: portalInteger(rawLimits.maxResponseBytes, 4 * 1024 * 1024, 1_024, 8 * 1024 * 1024, 'maxResponseBytes'),
          maxConcurrentRequests: portalInteger(rawLimits.maxConcurrentRequests, 4, 1, 8, 'maxConcurrentRequests'),
          maxRingEvents: portalInteger(rawLimits.maxRingEvents, 64, 1, 128, 'maxRingEvents'),
          maxRequestBodyBytes: portalInteger(rawLimits.maxRequestBodyBytes, 64 * 1024, 0, 256 * 1024, 'maxRequestBodyBytes'),
          maxUploadBytes: portalInteger(rawLimits.maxUploadBytes, 128 * 1024, 0, 512 * 1024, 'maxUploadBytes'),
        },
      };
      const result = await this.plugins.call('webcrypto-observer.observe', request, this.portalRuntimeExecution(signal, true));
      const record = portalObject(result, '관찰 시작 결과');
      if (typeof record.sessionId !== 'string' || record.sessionId.length < 8 || record.sessionId.length > 160) {
        throw new ToolPortalError('관찰 세션 ID를 확인할 수 없습니다.', 500, 'INVALID_PLUGIN_RESULT');
      }
      if (this.toolPortalObserverSessions.size >= 32) {
        await this.plugins.call('webcrypto-observer.stop', { sessionId: record.sessionId }, this.portalRuntimeExecution(AbortSignal.timeout(10_000), true)).catch(() => undefined);
        throw new ToolPortalError('활성 포털 관찰 세션 한도에 도달했습니다.', 429, 'SESSION_LIMIT_REACHED', 60);
      }
      const expiresAt = typeof record.expiresAt === 'string' ? Date.parse(record.expiresAt) : NaN;
      const stopAt = Math.min(session.expiresAt, Number.isFinite(expiresAt) ? expiresAt : Date.now() + 60_000);
      const timer = setTimeout(() => {
        // A timeout/failure intentionally retains ownership for a later retry;
        // do not turn that bounded background failure into an unhandled rejection.
        void this.stopToolPortalObserver(String(record.sessionId)).catch(() => undefined);
      }, Math.max(1, stopAt - Date.now()));
      timer.unref?.();
      this.toolPortalObserverSessions.set(record.sessionId, { owner: session.key, timer });
      return result;
    }
    if (action === 'status') {
      const ownedSessionId = body.sessionId === undefined
        ? [...this.toolPortalObserverSessions].reverse().find(([, record]) => record.owner === session.key)?.[0]
        : this.portalObserverOwner(body.sessionId, session);
      // The plugin's unscoped status includes its global active-session
      // summary. Never let one portal login discover or adopt a native-admin or
      // another login's observer session.
      if (!ownedSessionId) return { ok: true, activeSessions: 0 };
      const sessionId = this.portalObserverOwner(ownedSessionId, session);
      return this.plugins.call('webcrypto-observer.status', { sessionId }, this.portalRuntimeExecution(signal, false));
    }
    if (action === 'events') {
      const sessionId = this.portalObserverOwner(body.sessionId, session);
      const afterSequence = portalInteger(body.afterSequence, 0, 0, Number.MAX_SAFE_INTEGER, 'afterSequence');
      return this.plugins.call('webcrypto-observer.events', { sessionId, afterSequence }, this.portalRuntimeExecution(signal, false));
    }
    if (action === 'mutation.set') {
      const status = this.config.toolPortalStatus();
      if (!status.hookMutationEnabled || body.mutationConfirmed !== true) {
        throw new ToolPortalError('일회성 Hook 변경은 네이티브 opt-in과 실행별 확인이 모두 필요합니다.', 403, 'HOOK_MUTATION_DISABLED');
      }
      const sessionId = this.portalObserverOwner(body.sessionId, session);
      return this.plugins.call('webcrypto-observer.mutation.set', {
        sessionId,
        phase: body.phase,
        matchLiteral: body.matchLiteral,
        replacementLiteral: body.replacementLiteral,
        mutationConfirmed: true,
      }, this.portalRuntimeExecution(signal, true));
    }
    if (action === 'stop') {
      const sessionId = this.portalObserverOwner(body.sessionId, session);
      // Once an authenticated owner asks to stop, finish that bounded cleanup
      // independently of the HTTP connection. A dropped response must not
      // strand a still-running observer or erase its retry authority.
      return this.stopToolPortalObserver(sessionId);
    }
    throw new ToolPortalError('지원하지 않는 Runtime Hook 작업입니다.', 404, 'ACTION_NOT_FOUND');
  }

  private async stopToolPortalObserver(sessionId: string): Promise<unknown> {
    const tracked = this.toolPortalObserverSessions.get(sessionId);
    const result = await this.plugins.call(
      'webcrypto-observer.stop',
      { sessionId },
      this.portalRuntimeExecution(AbortSignal.timeout(10_000), true),
    );
    const record = result && typeof result === 'object' && !Array.isArray(result)
      ? result as Record<string, unknown>
      : {};
    const terminal = record.stopped === true
      || ['completed', 'stopped', 'limit-reached', 'failed'].includes(String(record.status ?? ''));
    if (terminal && tracked && this.toolPortalObserverSessions.get(sessionId) === tracked) {
      clearTimeout(tracked.timer);
      this.toolPortalObserverSessions.delete(sessionId);
    }
    return result;
  }

  private async stopToolPortalObservers(owner?: string): Promise<void> {
    const ids = [...this.toolPortalObserverSessions]
      .filter(([, record]) => owner === undefined || record.owner === owner)
      .map(([id]) => id);
    await Promise.allSettled(ids.map((id) => this.stopToolPortalObserver(id)));
  }

  private async revokeToolPortalAuthority(reason: string): Promise<void> {
    this.toolPortalSessions.clear();
    this.toolPortalArtifacts.clear();
    for (const controller of this.activeToolPortalRuns.keys()) if (!controller.signal.aborted) controller.abort(new Error(reason));
    await this.stopToolPortalObservers();
  }

  /**
   * Internal-only bridge used by the HTTP peer client. The remote-link plugin
   * enforces exact HTTPS hostname matching before decrypting or returning its
   * locally stored service credential.
   */
  peerRequestHeaders(url: URL): Record<string, string> {
    return this.remoteLinkPlugin.peerRequestHeaders(url);
  }

  // -- chat (non-streaming, REST) ----------------------------------------

  async chatOnce(text: string, auth: AuthContext): Promise<{ text: string }> {
    const permissionMode = effectiveMode(this.config.settings.safety.mode, auth.permissionCap);
    if (permissionMode === 'read-only') throw new Error('이 기기는 읽기 전용입니다. AI 작업을 시작할 수 없습니다.');
    const admission = this.chatRunAdmission.acquire(auth);
    let usage: ChatUsage | undefined;
    let estimatedCost = 0;
    let costObservedByCall = false;
    let observedRoute: { providerId: string; providerLabel: string; model: string } | undefined;
    let mixedObservedRoutes = false;
    let telemetryRecorded = false;
    const recordTelemetryOnce = (trace: Parameters<TelemetryStore['record']>[0]): void => {
      if (telemetryRecorded) return;
      telemetryRecorded = true;
      try { this.telemetry.record(trace); }
      catch (error) {
        this.logger.error(`failed to persist REST chat telemetry: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const startedAt = Date.now();
    try {
      const result = await this.loop.run([], text, {
        configureModelBudget: (profile) => admission.configureModelBudget(profile),
        noteModelProgress: (kind) => admission.noteModelProgress(kind),
        reserveModelCall: (kind, maximumTokens) => admission.reserveModelCall(kind, maximumTokens),
        onModelUsage: (delta, source) => {
          usage = accumulateProviderUsage(usage, delta);
          if (!source) return;
          if (observedRoute && (observedRoute.providerId !== source.providerId || observedRoute.model !== source.model)) {
            mixedObservedRoutes = true;
          } else if (!observedRoute) {
            observedRoute = source;
          }
          const providerConfig = this.config.providers.find((provider) => provider.id === source.providerId);
          estimatedCost += ((delta.promptTokens * (providerConfig?.inputCostPerMillion ?? 0))
            + (delta.completionTokens * (providerConfig?.outputCostPerMillion ?? 0))) / 1_000_000;
          costObservedByCall = true;
        },
      }, this.plugins.aiTools(text), { permissionMode, tokenPolicy: 'adaptive' });
      usage ??= result.usage;
      if (!costObservedByCall) {
        const providerConfig = result.route
          ? this.config.providers.find((provider) => provider.id === result.route?.providerId)
          : undefined;
        estimatedCost = ((usage.promptTokens * (providerConfig?.inputCostPerMillion ?? 0))
          + (usage.completionTokens * (providerConfig?.outputCostPerMillion ?? 0))) / 1_000_000;
      }
      recordTelemetryOnce({
        id: randomUUID(), at: Date.now(),
        providerId: result.route?.providerId,
        providerLabel: result.route?.providerLabel,
        model: result.route?.model,
        role: result.route?.role,
        effort: result.route?.effort,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        accountedTokens: usage.accountedTokens,
        cachedPromptTokens: usage.cachedPromptTokens,
        cacheWritePromptTokens: usage.cacheWritePromptTokens,
        reasoningTokens: usage.reasoningTokens,
        toolCalls: result.turns.reduce((sum, turn) => sum + (turn.toolCalls?.length ?? 0), 0),
        latencyMs: Date.now() - startedAt,
        estimatedCost,
        ok: true,
      });
      return { text: result.text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordTelemetryOnce({
        id: randomUUID(), at: Date.now(),
        ...(!mixedObservedRoutes && observedRoute ? observedRoute : {}),
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        accountedTokens: usage?.accountedTokens,
        cachedPromptTokens: usage?.cachedPromptTokens,
        cacheWritePromptTokens: usage?.cacheWritePromptTokens,
        reasoningTokens: usage?.reasoningTokens,
        toolCalls: 0,
        latencyMs: Date.now() - startedAt,
        // Only normalized provider-reported prompt/completion deltas enter
        // this total; conservative accountedTokens never affect cost.
        estimatedCost,
        ok: false,
        error: message.slice(0, 500),
      });
      throw error;
    } finally {
      admission.finish(usage);
    }
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
    await this.plugins.loadBuiltin(this.remoteLinkPlugin);
    await this.plugins.loadBuiltin(createTailscalePlugin());
    await this.plugins.loadBuiltin(createDockerPlugin());
    await this.plugins.loadBuiltin(createCtfPlugin());
    await this.plugins.loadBuiltin(createMcpPlugin());
    await this.plugins.loadBuiltin(createVoicePlugin());
    await this.plugins.loadBuiltin(createResourceArchiverPlugin());
    await this.plugins.loadBuiltin(createSslScanPlugin());
    await this.plugins.loadBuiltin(this.webCryptoObserverPlugin);
    await this.plugins.loadBuiltin(this.discordPlugin);
    const settings = this.config.settings.network;
    // A persisted 0.0.0.0 value never opens the LAN unless the separate
    // externalAccess consent is also enabled. Explicit StartOptions remain
    // available to tests and advanced self-hosted launchers.
    const host = opts.host ?? (settings.externalAccess && settings.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1');
    const port = opts.port ?? settings.port;

    const app = createHttpApi(this, opts.webDir, this.activeHttpTransfers, this.wsUpgradeTickets);
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

    this.hub = new WsHub(
      this.httpServer,
      this.handlers(),
      (secret, desktopAuditProof) => this.authenticateWebSocket(secret, desktopAuditProof),
      this.logger,
      this.wsUpgradeTickets,
    );
    this.scheduler.start();

    // Server-wide pushes (only to authenticated clients). Keep every disposer
    // so start -> stop -> start cannot multiply broadcast listeners.
    for (const unsubscribe of this.busSubscriptions.splice(0)) unsubscribe();
    const forward = (event: string): void => {
      const audience = serverEventAudience(event);
      if (audience === 'none') return;
      this.busSubscriptions.push(this.bus.on(event, (data) => {
        if (audience === 'admin') this.hub?.broadcastAdmin(event, data);
        else if (audience === 'private-calendar') {
          this.hub?.broadcastWhere(event, data, (auth) => auth.isAdmin
            || Boolean(this.config.deviceLinks.find((link) => link.id === auth.linkId && !link.revokedAt)?.capabilities.includes('private-calendar')));
        }
        else this.hub?.broadcast(event, data);
      }));
    };
    [
      'log', 'plugins.changed', 'providers.changed', 'settings.changed',
      'dependencies.changed',
      'routing.changed', 'routing.presets.changed', 'conversations.changed',
      'memory.changed', 'scheduler.changed', 'scheduler.ran', 'workspaces.changed',
      'calendar.changed', 'calendar.work.changed', 'voice.wake', 'voice.command', 'voice.command.ready',
      'voice.command.timeout', 'voice.status', 'pairing.changed', 'remote-link.changed',
      'resource-archiver.progress', 'sslscan-auditor.progress', 'sslscan-auditor.completed',
      'webcrypto-observer.changed',
    ].forEach(forward);
    this.busSubscriptions.push(this.bus.on('remote-link.changed', (data) => {
      const status = data as { running?: unknown };
      if (status?.running === false) this.revokeRemoteHandoff('remote link stopped');
    }));
    // Internal-only event: the plugin publishes hashes and an exact origin,
    // never the Access assertion or service credential. It is intentionally
    // absent from the network event allowlists.
    this.busSubscriptions.push(this.bus.on('remote-link.bootstrap.created', (data) => {
      this.bindRemoteHandoffBootstrap(data);
    }));
    this.busSubscriptions.push(this.bus.on('remote-link.bootstrap.challenge', (data) => {
      this.registerRemoteBootstrapChallenge(data);
    }));

    this.logger.info(`listening on http://${this.boundHost}:${this.boundPort}`);
    return { host: this.boundHost, port: this.boundPort };
  }

  async stop(): Promise<void> {
    this.revokeRemoteHandoff('agent stopped');
    this.scheduler.stop();
    await this.revokeToolPortalAuthority('Mr.Robot Agent가 종료되었습니다.');
    for (const run of this.activeRuns.values()) run.session.cancel();
    for (const transfer of this.activeHttpTransfers) {
      if (!transfer.signal.aborted) transfer.abort(new Error('Mr.Robot Agent가 종료되어 전송을 중단했습니다.'));
    }
    this.activeHttpTransfers.clear();
    this.wsUpgradeTickets.clear();
    this.desktopAuditProofs.clear();
    this.chatRunAdmission.clear();
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
    const requestedTokenPolicy = (value: unknown): ConversationTokenPolicy | undefined => {
      if (value === undefined) return undefined;
      if (value === 'adaptive' || value === 'audit-only') return value;
      throw new Error('대화 토큰 정책이 올바르지 않습니다.');
    };
    const clientTokenPolicy = (
      client: WsClient,
      requested?: ConversationTokenPolicy,
      fallback: ConversationTokenPolicy = 'adaptive',
    ): ConversationTokenPolicy => (
      canUseAuditOnly(client) && (requested ?? fallback) === 'audit-only' ? 'audit-only' : 'adaptive'
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
        ? body.capabilities.filter((item): item is DeviceCapability => item === 'work-sync' || item === 'private-calendar' || item === 'file-transfer')
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
    h.set('pairing.link.capability.set', (params, client) => {
      assertAdmin(client);
      const body = p(params);
      const id = str(body.id);
      const capability = str(body.capability);
      if (capability !== 'work-sync' && capability !== 'private-calendar' && capability !== 'file-transfer') {
        throw new Error('지원하지 않는 기기 권한입니다.');
      }
      if (typeof body.enabled !== 'boolean') throw new Error('기기 권한 상태가 올바르지 않습니다.');
      const current = this.config.deviceLinks.find((link) => link.id === id && !link.revokedAt);
      if (!current) return undefined;
      const capabilities = new Set(current.capabilities);
      const wasEnabled = capabilities.has(capability);
      if (body.enabled) capabilities.add(capability);
      else capabilities.delete(capability);
      const updated = this.config.patchDeviceLink(id, { capabilities: [...capabilities] });
      if (updated && wasEnabled !== body.enabled) this.invalidateDeviceLink(updated.id);
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
      this.remoteHandoff = null;
      this.remoteBootstrapChallenges.clear();
      this.desktopAuditProofs.clear();
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
      this.remoteHandoff = null;
      this.remoteBootstrapChallenges.clear();
      const pin = this.config.regeneratePin();
      this.pinLimiter.reset();
      this.bus.emit('pairing.changed', { at: Date.now() });
      this.logger.info('pairing pin rotated');
      return { pin };
    });
    h.set('pairing.createRemoteHandoff', (params, client) => {
      assertAdmin(client);
      const ttlMinutes = Number(p(params).ttlMinutes);
      return this.createRemoteHandoff(ttlMinutes);
    });
    h.set('pairing.revokeRemoteHandoff', (_params, client) => {
      assertAdmin(client);
      return { ok: this.revokeRemoteHandoff() };
    });

    h.set('settings.get', () => this.getSettings());
    h.set('settings.set', (params, client) => { assertAdmin(client); return this.updateSettings(p(params) as Partial<AppSettings>); });
    h.set('toolPortal.status', (_params, client) => {
      assertAdmin(client);
      return this.toolPortalAdminStatus();
    });
    h.set('toolPortal.configure', async (params, client) => {
      assertAdmin(client);
      const body = p(params);
      const input: ToolPortalConfigureInput = {
        ...(Object.prototype.hasOwnProperty.call(body, 'password') ? { password: body.password } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'workspaceId') ? { portalWorkspaceId: body.workspaceId } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'allowedDomains') ? { allowedTargetHosts: body.allowedDomains } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'hookMutationEnabled') ? { hookMutationEnabled: body.hookMutationEnabled } : {}),
      };
      return this.configureToolPortal(input);
    });
    h.set('toolPortal.disable', async (_params, client) => {
      assertAdmin(client);
      return this.disableToolPortal();
    });
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
      return this.updateSettings({ setup: { dependencyWizardCompletedAt: Date.now(), dependencyWizardVersion: 5 } });
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
    h.set('plugins.setCategory', (params, client) => {
      assertAdmin(client);
      return this.pluginsSetCategory(str(p(params).id), str(p(params).category) as PluginCategory);
    });
    h.set('plugins.call', (params, client) => {
      const body = p(params);
      return this.pluginsCall(
        str(body.name),
        body.params,
        client.state.auth ?? undefined,
        typeof body.workspaceId === 'string' ? body.workspaceId : undefined,
      );
    });

    // ---- persistent conversations and retained memory ----
    h.set('conversations.list', (params) => {
      const status = str(p(params).status) as ConversationStatus;
      return this.conversations.list(status === 'active' || status === 'archived' ? status : undefined);
    });
    h.set('conversations.create', (params, client) => {
      assertContentWrite(client);
      const input = p(params) as ConversationCreateInput;
      const requested = ['read-only', 'ask', 'workspace', 'full'].includes(String(input.permissionMode)) ? input.permissionMode : undefined;
      const created = this.conversations.create({
        ...input,
        permissionMode: clientPermission(client, requested),
        tokenPolicy: clientTokenPolicy(client, requestedTokenPolicy(input.tokenPolicy)),
      });
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
        tokenPolicy: requestedTokenPolicy(body.tokenPolicy) === undefined
          ? undefined
          : clientTokenPolicy(client, requestedTokenPolicy(body.tokenPolicy)),
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
    h.set('chat.start', (params, client) => {
      // Read-only is a content boundary, not merely a tool-execution mode.
      // Reject before creating a conversation, starting a provider, or
      // consuming an admission-window start.
      assertContentWrite(client);
      const auth = client.state.auth;
      if (!auth) throw new Error('인증되지 않은 연결입니다.');
      const body = p(params);
      // Validate attacker-controlled policy input and cheap busy conditions
      // before consuming an admission-window start.
      requestedTokenPolicy(body.tokenPolicy);
      const session = client.state.chat;
      if (session.busy) throw new Error('chat already running');
      const requestedConversationId = str(body.conversationId) || session.conversationId;
      if (requestedConversationId && this.busyConversations.has(requestedConversationId)) {
        throw new Error('conversation is already running on another client');
      }
      const admission = this.chatRunAdmission.acquire(auth, { allowAuditOnly: canUseAuditOnly(client) });
      let chargedUsage: ChatUsage | undefined;
      let usagePersisted = false;
      return (async () => {
      const text = str(body.text);
      let conversationId = requestedConversationId;
      if (!conversationId || !this.conversations.get(conversationId)) {
        const requestedPermission = ['read-only', 'ask', 'workspace', 'full'].includes(String(body.permissionMode)) ? body.permissionMode as PermissionMode : undefined;
        conversationId = this.conversations.create({
          reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort as ReasoningEffort : 'auto',
          providerId: typeof body.providerId === 'string' ? body.providerId : undefined,
          providerModel: typeof body.providerModel === 'string' ? body.providerModel : undefined,
          routingPresetId: typeof body.routingPresetId === 'string' ? body.routingPresetId : undefined,
          permissionMode: clientPermission(client, requestedPermission),
          tokenPolicy: clientTokenPolicy(client, requestedTokenPolicy(body.tokenPolicy)),
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
      // `audit-only` requires the destination's embedded native-main
      // capability. Browsers, linked clients and remote administrators always
      // run adaptively even when opening a conversation previously marked so.
      const effectiveTokenPolicy = clientTokenPolicy(
        client,
        requestedTokenPolicy(body.tokenPolicy),
        conversation.tokenPolicy,
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
            configureModelBudget: (profile) => admission.configureModelBudget(profile),
            noteModelProgress: (kind) => admission.noteModelProgress(kind),
            reserveModelCall: (kind, maximumTokens) => admission.reserveModelCall(kind, maximumTokens),
            onModelUsage: (delta) => { chargedUsage = accumulateProviderUsage(chargedUsage, delta); },
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
            tokenPolicy: effectiveTokenPolicy,
          },
        );
        chargedUsage ??= result.usage;
        session.turns = result.turns;
        const updated = this.conversations.appendResult(conversationId, result.turns, result.usage);
        usagePersisted = true;
        const providerConfig = result.route ? this.config.providers.find((provider) => provider.id === result.route?.providerId) : undefined;
        const estimatedCost = ((result.usage.promptTokens * (providerConfig?.inputCostPerMillion ?? 0)) + (result.usage.completionTokens * (providerConfig?.outputCostPerMillion ?? 0))) / 1_000_000;
        this.telemetry.record({
          id: randomUUID(), at: Date.now(), conversationId, providerId: result.route?.providerId, providerLabel: result.route?.providerLabel,
          model: result.route?.model, role: result.route?.role, effort: result.route?.effort,
          promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens,
          accountedTokens: result.usage.accountedTokens,
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
        if (!usagePersisted && hasRecordedUsage(chargedUsage)) {
          try {
            this.conversations.appendUsage(conversationId, chargedUsage);
            usagePersisted = true;
            this.bus.emit('conversations.changed', this.conversations.list());
          } catch (usageError) {
            this.logger.error(`failed to persist partial provider usage: ${usageError instanceof Error ? usageError.message : String(usageError)}`);
          }
        }
        this.telemetry.record({
          id: randomUUID(), at: Date.now(), conversationId,
          promptTokens: chargedUsage?.promptTokens ?? 0,
          completionTokens: chargedUsage?.completionTokens ?? 0,
          accountedTokens: chargedUsage?.accountedTokens,
          cachedPromptTokens: chargedUsage?.cachedPromptTokens,
          cacheWritePromptTokens: chargedUsage?.cacheWritePromptTokens,
          reasoningTokens: chargedUsage?.reasoningTokens,
          toolCalls: 0, latencyMs: Date.now() - runStartedAt, estimatedCost: 0,
          ok: false, error: message.slice(0, 500),
        });
        sendRunEvent('chat.error', { conversationId, message });
        return { ok: false, error: message };
      } finally {
        session.end();
        this.busyConversations.delete(conversationId);
        this.activeRuns.delete(conversationId);
      }
      })().finally(() => admission.finish(chargedUsage));
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
