import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import type { AppSettings, DeviceCapability, PermissionMode, ProviderConfig, RoutingPreset, RoutingPresetSettings, RoutingSettings, WorkspaceInfo } from '@mr-robot/shared';
import { hashToken } from './auth.js';
import { SecretVault } from './secrets.js';

export interface PairingConfig {
  /** Long-lived random secret the mobile/remote client authenticates with. */
  secret: string;
  /** Short 6-digit code exchanged for the secret (rate-limited). */
  pin: string;
  createdAt: number;
  /** When the current short pairing PIN was minted. Used for expiry. */
  pinCreatedAt: number;
}

export interface ConfigRecoveryDiagnostic {
  code: 'config-corrupt-quarantined' | 'config-backup-recovered' | 'config-fresh-recovery' | 'provider-secret-unavailable' | 'config-persistence-blocked';
  message: string;
  at: number;
  path?: string;
  providerId?: string;
}

export interface ConfigRecoveryState {
  degraded: boolean;
  writesBlocked: boolean;
  diagnostics: ConfigRecoveryDiagnostic[];
}

export interface DeviceLinkConfig {
  id: string;
  name: string;
  tokenHash: string;
  permissionCap: PermissionMode;
  /** Privileges that do not imply shell, file, or control-plane access. */
  capabilities: DeviceCapability[];
  createdAt: number;
  revokedAt?: number;
}

export interface MrRobotConfigData {
  settings: AppSettings;
  providers: ProviderConfig[];
  routing: RoutingSettings;
  routingPresets: RoutingPreset[];
  workspaces: WorkspaceInfo[];
  pairing: PairingConfig;
  deviceLinks: DeviceLinkConfig[];
}

export function defaultRouting(): RoutingSettings {
  return {
    mode: 'balanced',
    executionMode: 'single',
    meetingRounds: 2,
    crossGroupRounds: 1,
    maxIterations: 6,
    roles: {},
    maxPremiumCalls: 1,
    escalationEnabled: true,
    graph: {
      nodes: [
        { id: 'router', kind: 'model', label: '요청 분석 및 분배', role: 'router', x: 30, y: 150 },
        { id: 'fast', kind: 'model', label: '빠른 처리', role: 'fast', x: 330, y: 30 },
        { id: 'general', kind: 'model', label: '일반 실행', role: 'general', x: 330, y: 150 },
        { id: 'reasoning', kind: 'model', label: '심층 사고', role: 'reasoning', x: 330, y: 270 },
        { id: 'critic', kind: 'model', label: '최종 검토', role: 'critic', x: 630, y: 150 },
      ],
      edges: [
        { id: 'e1', from: 'router', to: 'fast' }, { id: 'e2', from: 'router', to: 'general' },
        { id: 'e3', from: 'router', to: 'reasoning' }, { id: 'e4', from: 'fast', to: 'critic' },
        { id: 'e5', from: 'general', to: 'critic' }, { id: 'e6', from: 'reasoning', to: 'critic' },
      ],
    },
  };
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

const supportedDeviceCapabilities = new Set<DeviceCapability>(['work-sync']);
const supportedDevicePermissions = new Set<PermissionMode>(['read-only', 'ask', 'workspace', 'full']);

function normalizeDevicePermission(value: unknown): PermissionMode {
  return typeof value === 'string' && supportedDevicePermissions.has(value as PermissionMode) ? value as PermissionMode : 'read-only';
}

function normalizeDeviceCapabilities(value: unknown, permissionCap: PermissionMode): DeviceCapability[] {
  // Existing ask/workspace/full links previously had no capability field. Give
  // those links the same product feature without restoring broad `full` access.
  if (value === undefined) return permissionCap === 'read-only' ? [] : ['work-sync'];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is DeviceCapability => typeof item === 'string' && supportedDeviceCapabilities.has(item as DeviceCapability)))];
}

const routingModes = new Set(['economy', 'balanced', 'quality', 'manual']);
const executionModes = new Set(['single', 'pipeline', 'vote', 'hybrid', 'swarm']);
const modelRoles = new Set(['router', 'fast', 'general', 'reasoning', 'coding', 'vision', 'critic', 'summarizer']);
// The current execution engine treats every visual node as a model role.
// Legacy decorative node kinds are normalized by the editor, but must not be
// accepted from remote sync because their edges cannot be executed safely.
const nodeKinds = new Set(['model']);
const discussionModes = new Set(['collaborative', 'competitive', 'review']);
const MAX_SYNC_ROUTING_PRESETS = 500;
const MAX_SYNC_ROUTING_PRESET_BYTES = 8 * 1024 * 1024;

function syncString(value: unknown, label: string, max: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max) throw new Error(`${label}이(가) 올바르지 않습니다.`);
  return value;
}

function syncNumber(value: unknown, label: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label}이(가) 올바르지 않습니다.`);
  return value;
}

function normalizeRoutingPresetSnapshot(value: unknown): RoutingPreset[] {
  if (!Array.isArray(value)) throw new Error('프리셋 동기화 데이터가 올바르지 않습니다.');
  assertRoutingPresetSnapshotBudget(value);
  const nowLimit = Date.now() + 5 * 60_000;
  const result = value.map((raw, index): RoutingPreset => {
    if (!raw || typeof raw !== 'object') throw new Error(`프리셋 ${index + 1} 데이터가 올바르지 않습니다.`);
    const source = raw as Partial<RoutingPreset>;
    const id = syncString(source.id, '프리셋 ID', 160) as string;
    if (id.startsWith('builtin:') || !/^[A-Za-z0-9:_-]+$/.test(id)) throw new Error('프리셋 ID 형식이 올바르지 않습니다.');
    if (!routingModes.has(String(source.mode))) throw new Error('프리셋 라우팅 모드가 올바르지 않습니다.');
    const executionMode = source.executionMode ?? 'single';
    if (!executionModes.has(String(executionMode))) throw new Error('프리셋 실행 모드가 올바르지 않습니다.');
    const roles: RoutingPreset['roles'] = {};
    if (!source.roles || typeof source.roles !== 'object' || Array.isArray(source.roles)) throw new Error('프리셋 역할 구성이 올바르지 않습니다.');
    for (const [role, providers] of Object.entries(source.roles)) {
      if (!modelRoles.has(role) || !Array.isArray(providers) || providers.length > 16) throw new Error('프리셋 역할 공급자 목록이 올바르지 않습니다.');
      roles[role as keyof RoutingPreset['roles']] = providers.map((provider) => syncString(provider, '공급자 ID', 256) as string);
    }
    let graph: RoutingPreset['graph'];
    if (source.graph !== undefined) {
      const rawGraph = source.graph as RoutingPreset['graph'];
      if (!rawGraph || !Array.isArray(rawGraph.nodes) || !Array.isArray(rawGraph.edges) || rawGraph.nodes.length > 64 || rawGraph.edges.length > 256) {
        throw new Error('프리셋 그래프 크기나 형식이 올바르지 않습니다.');
      }
      const groups = rawGraph.groups === undefined ? [] : rawGraph.groups;
      if (!Array.isArray(groups) || groups.length > 32) throw new Error('프리셋 회의 그룹 구성이 올바르지 않습니다.');
      const normalizedGroups = groups.map((group) => {
        if (!group || typeof group !== 'object') throw new Error('프리셋 회의 그룹이 올바르지 않습니다.');
        const discussionMode = group.discussionMode ?? 'collaborative';
        if (!discussionModes.has(String(discussionMode))) throw new Error('회의 그룹 방식이 올바르지 않습니다.');
        const color = syncString(group.color, '회의 그룹 색상', 32, true);
        if (color && !/^#[0-9a-fA-F]{3,8}$/.test(color)) throw new Error('회의 그룹 색상이 올바르지 않습니다.');
        return {
          id: syncString(group.id, '회의 그룹 ID', 160) as string,
          name: (syncString(group.name, '회의 그룹 이름', 256) as string).trim().slice(0, 80) || '회의 그룹',
          ...(color ? { color } : {}),
          discussionMode: discussionMode as NonNullable<typeof group.discussionMode>,
          x: syncNumber(group.x, '회의 그룹 X', -100_000, 100_000, 0),
          y: syncNumber(group.y, '회의 그룹 Y', -100_000, 100_000, 0),
          width: syncNumber(group.width, '회의 그룹 너비', 80, 100_000, 320),
          height: syncNumber(group.height, '회의 그룹 높이', 60, 100_000, 220),
        };
      });
      const groupIds = new Set(normalizedGroups.map((group) => group.id));
      if (groupIds.size !== normalizedGroups.length) throw new Error('중복된 회의 그룹 ID가 있습니다.');
      const nodes = rawGraph.nodes.map((node) => {
        if (!node || typeof node !== 'object' || !nodeKinds.has(String(node.kind))) throw new Error('프리셋 노드가 올바르지 않습니다.');
        const role = node.role === undefined ? undefined : String(node.role);
        if (role && !modelRoles.has(role)) throw new Error('프리셋 노드 역할이 올바르지 않습니다.');
        const groupId = syncString(node.groupId, '회의 그룹 참조', 160, true);
        if (groupId && !groupIds.has(groupId)) throw new Error('존재하지 않는 회의 그룹을 참조하는 노드가 있습니다.');
        return {
          id: syncString(node.id, '노드 ID', 160) as string,
          kind: node.kind,
          label: (syncString(node.label, '노드 이름', 512) as string).trim().slice(0, 120) || '모델 노드',
          x: syncNumber(node.x, '노드 X', -100_000, 100_000),
          y: syncNumber(node.y, '노드 Y', -100_000, 100_000),
          ...(role ? { role: role as NonNullable<typeof node.role> } : {}),
          ...(syncString(node.providerId, '노드 공급자 ID', 256, true) ? { providerId: node.providerId } : {}),
          ...(syncString(node.providerModel, '노드 모델 ID', 512, true) ? { providerModel: node.providerModel } : {}),
          ...(groupId ? { groupId } : {}),
          ...(syncString(node.integrationId, '노드 통합 ID', 256, true) ? { integrationId: node.integrationId } : {}),
        };
      });
      const nodeIds = new Set(nodes.map((node) => node.id));
      if (nodeIds.size !== nodes.length) throw new Error('중복된 프리셋 노드 ID가 있습니다.');
      const edges = rawGraph.edges.map((edge) => {
        if (!edge || typeof edge !== 'object') throw new Error('프리셋 연결선이 올바르지 않습니다.');
        const from = syncString(edge.from, '연결 시작 노드', 160) as string;
        const to = syncString(edge.to, '연결 대상 노드', 160) as string;
        if (from === to || !nodeIds.has(from) || !nodeIds.has(to)) throw new Error('존재하지 않거나 자기 자신을 잇는 연결선이 있습니다.');
        return {
          id: syncString(edge.id, '연결선 ID', 160) as string,
          from,
          to,
          ...(syncString(edge.label, '연결선 이름', 256, true) ? { label: edge.label } : {}),
        };
      });
      if (new Set(edges.map((edge) => edge.id)).size !== edges.length) throw new Error('중복된 연결선 ID가 있습니다.');
      const indegree = new Map(nodes.map((node) => [node.id, 0]));
      const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
      for (const edge of edges) {
        indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
        outgoing.get(edge.from)?.push(edge.to);
      }
      const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
      let visited = 0;
      while (queue.length) {
        const id = queue.shift() as string;
        visited++;
        for (const next of outgoing.get(id) ?? []) {
          const degree = (indegree.get(next) ?? 1) - 1;
          indegree.set(next, degree);
          if (degree === 0) queue.push(next);
        }
      }
      if (visited !== nodes.length) throw new Error('순환 연결이 있는 프리셋 그래프는 실행할 수 없습니다.');
      graph = { nodes, edges, ...(normalizedGroups.length ? { groups: normalizedGroups } : {}) };
    }
    const updatedAt = Math.min(syncNumber(source.updatedAt, '프리셋 수정 시각', 0, 9_007_199_254_740_991), nowLimit);
    const createdAt = Math.min(syncNumber(source.createdAt, '프리셋 생성 시각', 0, 9_007_199_254_740_991), updatedAt);
    return {
      id,
      name: (syncString(source.name, '프리셋 이름', 512) as string).trim().slice(0, 80) || '동기화 프리셋',
      description: syncString(source.description, '프리셋 설명', 2048, true)?.trim().slice(0, 240) || undefined,
      builtin: false,
      createdAt,
      updatedAt,
      mode: source.mode as RoutingPreset['mode'],
      executionMode: executionMode as RoutingPreset['executionMode'],
      meetingRounds: Math.floor(syncNumber(source.meetingRounds, '회의 라운드', 1, 3, 2)),
      crossGroupRounds: Math.floor(syncNumber(source.crossGroupRounds, '그룹 교환 라운드', 0, 3, 1)),
      maxIterations: Math.floor(syncNumber(source.maxIterations, '최대 반복', 1, 12, 6)),
      roles,
      maxPremiumCalls: Math.floor(syncNumber(source.maxPremiumCalls, '프리미엄 호출 제한', 0, 64)),
      escalationEnabled: source.escalationEnabled === true,
      ...(graph ? { graph } : {}),
    };
  });
  if (new Set(result.map((preset) => preset.id)).size !== result.length) throw new Error('중복된 프리셋 ID가 있습니다.');
  return result;
}

function assertRoutingPresetSnapshotBudget(value: unknown[]): void {
  if (value.length > MAX_SYNC_ROUTING_PRESETS) throw new Error('동기화할 프리셋 수가 500개를 초과했습니다.');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_SYNC_ROUTING_PRESET_BYTES) throw new Error('프리셋 동기화 데이터가 8MB를 초과했습니다.');
}

function efficientModel(provider: ProviderConfig, role: string): string {
  if (provider.type === 'codex-cli') {
    if (role === 'reasoning' || role === 'coding') return 'gpt-5.6-sol';
    if (role === 'general' || role === 'vision' || role === 'critic') return 'gpt-5.6-terra';
    return 'gpt-5.6-luna';
  }
  if (provider.type === 'claude-cli' || provider.type === 'anthropic') {
    if (role === 'reasoning') return provider.type === 'claude-cli' ? 'fable' : 'claude-fable-5';
    if (role === 'fast' || role === 'router' || role === 'summarizer') return provider.type === 'claude-cli' ? 'haiku' : 'claude-haiku-4-5';
    return provider.type === 'claude-cli' ? 'sonnet' : 'claude-sonnet-5';
  }
  return provider.model;
}

export function builtInRoutingPresets(): RoutingPreset[] {
  const balanced = defaultRouting();
  const presets: RoutingPreset[] = [
    {
      id: 'builtin:economy', name: '절약 우선', description: '무료·저비용 모델을 먼저 사용하는 짧은 의사결정 트리', builtin: true, createdAt: 0, updatedAt: 0,
      mode: 'economy', executionMode: 'single', roles: {}, maxPremiumCalls: 0, escalationEnabled: false,
        graph: {
          nodes: [
            { id: 'router', kind: 'model', label: '요청 분석', role: 'router', x: 30, y: 120 },
            { id: 'fast', kind: 'model', label: '무료·빠른 처리', role: 'fast', x: 350, y: 120 },
          ],
          edges: [{ id: 'e1', from: 'router', to: 'fast' }],
      },
    },
      {
        id: 'builtin:balanced', name: '균형 (권장)', description: '난이도에 따라 빠른·일반·추론 모델을 고르는 기본 트리', builtin: true, createdAt: 0, updatedAt: 0,
        mode: balanced.mode, executionMode: 'single', roles: balanced.roles, maxPremiumCalls: balanced.maxPremiumCalls, escalationEnabled: balanced.escalationEnabled, graph: balanced.graph,
      },
      {
        id: 'builtin:efficient-quality', name: '효율·고품질 (추천)', description: '간단한 요청은 초경량 모델, 일반 작업은 균형 모델, 어려운 추론·코딩만 최상위 모델로 올리는 1회 호출 구조',
        builtin: true, createdAt: 0, updatedAt: 0, mode: 'balanced', executionMode: 'single', roles: {}, maxPremiumCalls: 1, escalationEnabled: true,
        graph: {
          nodes: [
            { id: 'router', kind: 'model', label: '요청 난이도 판별', role: 'router', x: 20, y: 220 },
            { id: 'fast', kind: 'model', label: '초경량 빠른 처리', role: 'fast', x: 330, y: 18 },
            { id: 'general', kind: 'model', label: '균형형 일반 작업', role: 'general', x: 330, y: 220 },
            { id: 'reasoning', kind: 'model', label: '최상위 심층 추론', role: 'reasoning', x: 330, y: 422 },
            { id: 'coding', kind: 'model', label: '최상위 코딩', role: 'coding', x: 640, y: 118 },
            { id: 'vision', kind: 'model', label: '균형형 시각 분석', role: 'vision', x: 640, y: 320 },
          ],
          edges: [
            { id: 'e1', from: 'router', to: 'fast' }, { id: 'e2', from: 'router', to: 'general' },
            { id: 'e3', from: 'router', to: 'reasoning' }, { id: 'e4', from: 'router', to: 'coding' },
            { id: 'e5', from: 'router', to: 'vision' },
          ],
        },
      },
    {
      id: 'builtin:quality', name: '품질 우선', description: '심층 추론 뒤 비평 단계를 거치는 품질 중심 트리', builtin: true, createdAt: 0, updatedAt: 0,
      mode: 'quality', executionMode: 'pipeline', roles: {}, maxPremiumCalls: 3, escalationEnabled: true,
        graph: {
          nodes: [
            { id: 'router', kind: 'model', label: '요청 분석', role: 'router', x: 30, y: 120 },
            { id: 'reasoning', kind: 'model', label: '심층 추론', role: 'reasoning', x: 330, y: 120 },
            { id: 'critic', kind: 'model', label: '결과 검증', role: 'critic', x: 630, y: 120 },
          ],
          edges: [{ id: 'e1', from: 'router', to: 'reasoning' }, { id: 'e2', from: 'reasoning', to: 'critic' }],
      },
    },
    {
      id: 'builtin:coding', name: '코딩 작업', description: '코딩 모델의 결과를 비평 모델이 검토하는 개발용 트리', builtin: true, createdAt: 0, updatedAt: 0,
      mode: 'manual', executionMode: 'pipeline', roles: {}, maxPremiumCalls: 2, escalationEnabled: true,
        graph: {
          nodes: [
            { id: 'router', kind: 'model', label: '개발 요청 분석', role: 'router', x: 30, y: 120 },
            { id: 'coding', kind: 'model', label: '구현 담당', role: 'coding', x: 330, y: 120 },
            { id: 'critic', kind: 'model', label: '코드 검토', role: 'critic', x: 630, y: 120 },
          ],
          edges: [{ id: 'e1', from: 'router', to: 'coding' }, { id: 'e2', from: 'coding', to: 'critic' }],
      },
    },
    {
      id: 'builtin:debate', name: '전문가 회의·투표', description: '서로 다른 모델 노드가 독립 제안 후 의견을 교환·반박하고 투표하면 집계 노드가 최종 결정을 내리는 회의 시나리오',
      builtin: true, createdAt: 0, updatedAt: 0, mode: 'quality', executionMode: 'vote', meetingRounds: 2, roles: {}, maxPremiumCalls: 8, escalationEnabled: true,
      graph: {
        nodes: [
          { id: 'general', kind: 'model', label: '실용안 제안', role: 'general', groupId: '전문가 회의', x: 40, y: 35 },
          { id: 'reasoning', kind: 'model', label: '심층안 제안', role: 'reasoning', groupId: '전문가 회의', x: 40, y: 160 },
          { id: 'fast', kind: 'model', label: '경량 반론·대안', role: 'fast', groupId: '전문가 회의', x: 40, y: 285 },
          { id: 'chair', kind: 'model', label: '최종 검증·투표 판정', role: 'critic', x: 420, y: 160 },
        ],
        groups: [{ id: '전문가 회의', name: '전문가 회의', color: '#8b74ff', discussionMode: 'collaborative' }],
        edges: [
          { id: 'e1', from: 'general', to: 'chair' }, { id: 'e2', from: 'reasoning', to: 'chair' },
          { id: 'e3', from: 'fast', to: 'chair' },
        ],
      },
    },
    {
      id: 'builtin:efficient-vote', name: '저비용·고효율 투표', description: '경량 모델과 균형 모델이 2라운드로 의견을 교환하고 균형형 검증 모델이 최종 판정하는 비용 절약 회의',
      builtin: true, createdAt: 0, updatedAt: 0, mode: 'balanced', executionMode: 'vote', meetingRounds: 2, roles: {}, maxPremiumCalls: 2, escalationEnabled: true,
      graph: {
        nodes: [
          { id: 'fast-a', kind: 'model', label: '경량 실용안', role: 'fast', groupId: '핵심 회의', x: 45, y: 70 },
          { id: 'general-a', kind: 'model', label: '균형 대안', role: 'general', groupId: '핵심 회의', x: 45, y: 210 },
          { id: 'judge', kind: 'model', label: '비용 대비 품질 검증', role: 'critic', x: 430, y: 140 },
        ],
        groups: [{ id: '핵심 회의', name: '핵심 회의', color: '#22d3ee', discussionMode: 'collaborative' }],
        edges: [{ id: 'e1', from: 'fast-a', to: 'judge' }, { id: 'e2', from: 'general-a', to: 'judge' }],
      },
    },
    {
      id: 'builtin:sequential-validation', name: '순차 실행·검증', description: '경량 계획을 일반 실행 모델에 넘기고 마지막 검증 모델이 오류를 확인하는 안정적인 3단계 구조',
      builtin: true, createdAt: 0, updatedAt: 0, mode: 'balanced', executionMode: 'pipeline', meetingRounds: 1, roles: {}, maxPremiumCalls: 2, escalationEnabled: true,
      graph: {
        nodes: [
          { id: 'plan', kind: 'model', label: '경량 계획 수립', role: 'fast', x: 35, y: 150 },
          { id: 'execute', kind: 'model', label: '균형형 실행', role: 'general', x: 330, y: 150 },
          { id: 'validate', kind: 'model', label: '최종 결과 검증', role: 'critic', x: 625, y: 150 },
        ],
        edges: [{ id: 'e1', from: 'plan', to: 'execute' }, { id: 'e2', from: 'execute', to: 'validate' }],
      },
    },
    {
      id: 'builtin:hybrid-council', name: '분류·회의·검증 혼합', description: '경량 분류가 안건을 정리하고 일반·심층·코딩 모델이 토론·투표한 뒤 검증 모델이 최종 판정하는 고품질 혼합형',
      builtin: true, createdAt: 0, updatedAt: 0, mode: 'balanced', executionMode: 'hybrid', meetingRounds: 2, roles: {}, maxPremiumCalls: 4, escalationEnabled: true,
      graph: {
        nodes: [
          { id: 'router', kind: 'model', label: '경량 안건 분류', role: 'router', x: 25, y: 175 },
          { id: 'general', kind: 'model', label: '실용 담당', role: 'general', groupId: '전문가 회의', x: 280, y: 35 },
          { id: 'reasoning', kind: 'model', label: '심층 담당', role: 'reasoning', groupId: '전문가 회의', x: 280, y: 175 },
          { id: 'coding', kind: 'model', label: '구현 담당', role: 'coding', groupId: '전문가 회의', x: 280, y: 315 },
          { id: 'judge', kind: 'model', label: '최종 검증 판정', role: 'critic', x: 650, y: 175 },
        ],
        groups: [{ id: '전문가 회의', name: '전문가 회의', color: '#8b74ff', discussionMode: 'review' }],
        edges: [
          { id: 'e1', from: 'router', to: 'general' }, { id: 'e2', from: 'router', to: 'reasoning' }, { id: 'e3', from: 'router', to: 'coding' },
          { id: 'e4', from: 'general', to: 'judge' }, { id: 'e5', from: 'reasoning', to: 'judge' }, { id: 'e6', from: 'coding', to: 'judge' },
        ],
      },
    },
    {
      id: 'builtin:smart-cascade', name: 'Mr.Robot 스마트 캐스케이드 (기본)',
      description: '한 번의 저비용 난이도 판정으로 쉬운 일은 단일 경량 모델, 일반 작업은 균형 모델, 어려운 코딩·추론만 강한 모델에 올립니다. 검증은 실행 결과가 불확실할 때만 추가합니다.',
      builtin: true, createdAt: 0, updatedAt: 0, mode: 'balanced', executionMode: 'single', meetingRounds: 1,
      roles: {}, maxPremiumCalls: 1, escalationEnabled: true,
      graph: {
        nodes: [
          { id: 'classify', kind: 'model', label: '로컬 난이도·의도 판정', role: 'router', x: 25, y: 170 },
          { id: 'cheap', kind: 'model', label: '저비용 빠른 처리', role: 'fast', x: 340, y: 40 },
          { id: 'normal', kind: 'model', label: '균형형 실행', role: 'general', x: 340, y: 170 },
          { id: 'hard', kind: 'model', label: '심층·코딩 승급', role: 'reasoning', x: 340, y: 300 },
        ],
        edges: [
          { id: 'e1', from: 'classify', to: 'cheap' }, { id: 'e2', from: 'classify', to: 'normal' }, { id: 'e3', from: 'classify', to: 'hard' },
        ],
      },
    },
    {
      id: 'builtin:ctf-autopilot', name: 'CTF 경쟁 스웜 (격리 실행)',
      description: '문제 증거를 한 번 수집한 뒤 서로 다른 모델들이 Docker 샌드박스에서 동시에 전체 풀이에 도전합니다. 매 라운드의 명령·실패·발견을 공유 보드로 교환하고, 검증 모델이 재현 가능한 플래그를 승인할 때까지 경쟁·재시도합니다. 허가된 워게임 대상 전용입니다.',
      builtin: true, createdAt: 0, updatedAt: 0, mode: 'quality', executionMode: 'swarm', meetingRounds: 2, crossGroupRounds: 1, maxIterations: 12,
      roles: {}, maxPremiumCalls: 12, escalationEnabled: true,
      graph: {
        nodes: [
          { id: 'triage', kind: 'model', label: '공유 증거·문제 분류', role: 'router', integrationId: 'ctf-toolpack', x: 20, y: 190 },
          { id: 'solver-a', kind: 'model', label: '독립 풀스택 솔버 A', role: 'coding', groupId: 'ctf-solver-swarm', integrationId: 'docker-sandbox', x: 300, y: 25 },
          { id: 'solver-b', kind: 'model', label: '독립 심층 솔버 B', role: 'reasoning', groupId: 'ctf-solver-swarm', integrationId: 'docker-sandbox', x: 300, y: 135 },
          { id: 'solver-c', kind: 'model', label: '독립 우회 솔버 C', role: 'general', groupId: 'ctf-solver-swarm', integrationId: 'docker-sandbox', x: 300, y: 245 },
          { id: 'solver-d', kind: 'model', label: '독립 고속 솔버 D', role: 'fast', groupId: 'ctf-solver-swarm', integrationId: 'docker-sandbox', x: 300, y: 355 },
          { id: 'verify', kind: 'model', label: '플래그 재현·최종 검증', role: 'critic', integrationId: 'docker-sandbox', x: 665, y: 190 },
        ],
        groups: [{ id: 'ctf-solver-swarm', name: 'CTF 경쟁 스웜', color: '#ff5fa2', discussionMode: 'competitive' }],
        edges: [
          { id: 'e1', from: 'triage', to: 'solver-a', label: '동일 증거' }, { id: 'e2', from: 'triage', to: 'solver-b', label: '동일 증거' },
          { id: 'e3', from: 'triage', to: 'solver-c', label: '동일 증거' }, { id: 'e4', from: 'triage', to: 'solver-d', label: '동일 증거' },
          { id: 'e5', from: 'solver-a', to: 'verify', label: '후보 풀이' }, { id: 'e6', from: 'solver-b', to: 'verify', label: '후보 풀이' },
          { id: 'e7', from: 'solver-c', to: 'verify', label: '후보 풀이' }, { id: 'e8', from: 'solver-d', to: 'verify', label: '후보 풀이' },
        ],
      },
    },
  ];
  return presets.map(clone);
}

export function defaultSettings(): AppSettings {
  return {
    network: {
      host: '127.0.0.1',
      port: 8787,
      externalAccess: false,
    },
    safety: {
      mode: 'ask',
      allowedRoots: [],
      maxReadBytes: 20000,
      maxShellBytes: 40000,
    },
    deviceName: hostname() || 'Mr.Robot PC',
    setup: {},
    voice: {
      enabled: false,
      wakePhrase: '로봇',
      language: 'ko-KR',
      pcPriorityMs: 900,
    },
  };
}

export function mrRobotHome(): string {
  return process.env.MR_ROBOT_HOME ?? join(homedir(), '.mr-robot');
}

export function defaultProviderBaseUrl(type: ProviderConfig['type']): string {
  switch (type) {
    case 'codex-cli':
    case 'claude-cli':
      return '';
    case 'anthropic':
      return 'https://api.anthropic.com';
    case 'ollama':
      return 'http://127.0.0.1:11434';
    default:
      return 'https://api.openai.com/v1';
  }
}

export function generateSecret(): string {
  // 32 bytes -> 64 hex chars. Hard to guess, easy to scan via QR.
  return randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
}

export function generatePin(): string {
  // A pairing PIN is a remote enrollment credential. Math.random() is not a
  // cryptographic generator and must never be used here.
  return String(randomInt(100000, 1_000_000));
}

/** Mint a fresh PIN while guaranteeing that the just-consumed code is not reissued. */
export function nextPairingPin(previous: string, generator: () => string = generatePin): string {
  let next = generator();
  for (let attempt = 0; attempt < 8 && next === previous; attempt++) next = generator();
  if (next === previous) {
    const previousNumber = Number(previous);
    next = String(Number.isInteger(previousNumber) && previousNumber >= 100000 && previousNumber < 999999 ? previousNumber + 1 : 100000);
  }
  return next;
}

function freshPairing(now = Date.now()): PairingConfig {
  return { secret: generateSecret(), pin: generatePin(), createdAt: now, pinCreatedAt: now };
}

function normalizePairing(value: Partial<PairingConfig> | undefined): { pairing: PairingConfig; migrated: boolean } {
  if (!value) return { pairing: freshPairing(), migrated: true };
  const now = Date.now();
  const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : now;
  const pinCreatedAt = typeof value.pinCreatedAt === 'number' && Number.isFinite(value.pinCreatedAt) ? value.pinCreatedAt : createdAt;
  return {
    pairing: {
      secret: typeof value.secret === 'string' && value.secret ? value.secret : generateSecret(),
      pin: typeof value.pin === 'string' && /^\d{6}$/.test(value.pin) ? value.pin : generatePin(),
      createdAt,
      pinCreatedAt,
    },
    migrated: value.pinCreatedAt === undefined,
  };
}

function recoveryTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function atomicWriteUtf8(file: string, value: string): void {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tmp, 'wx', 0o600);
    writeFileSync(descriptor, value, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tmp, file);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

function isConfigJson(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as Partial<MrRobotConfigData>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    if (parsed.settings != null && (typeof parsed.settings !== 'object' || Array.isArray(parsed.settings))) return false;
    if (parsed.pairing != null && (typeof parsed.pairing !== 'object' || Array.isArray(parsed.pairing))) return false;
    return [parsed.providers, parsed.routingPresets, parsed.workspaces, parsed.deviceLinks]
      .every((field) => field == null || (Array.isArray(field) && field.every((item) => Boolean(item && typeof item === 'object' && !Array.isArray(item)))));
  } catch {
    return false;
  }
}

function containsPlaintextProviderSecret(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as { providers?: Array<{ apiKey?: unknown }> };
    return Array.isArray(parsed.providers) && parsed.providers.some((provider) => typeof provider?.apiKey === 'string' && provider.apiKey.length > 0);
  } catch {
    return false;
  }
}

/**
 * JSON-backed config store at ~/.mr-robot/config.json. Written atomically
 * (write/fsync temp then rename) and keeps a last-known-good backup.
 *
 * Note on API keys: they are stored on the local machine only, in
 * `~/.mr-robot/config.json`. Treat that file like a password vault.
 */
export class ConfigStore {
  readonly dir: string;
  readonly file: string;
  readonly backupFile: string;
  private data: MrRobotConfigData;
  private readonly vault = new SecretVault();
  private readonly unavailableProviderSecrets = new Map<string, string>();
  private recoveryDiagnostics: ConfigRecoveryDiagnostic[] = [];
  private writesBlocked = false;

  constructor(home = mrRobotHome()) {
    this.dir = home;
    this.file = join(home, 'config.json');
    this.backupFile = `${this.file}.bak`;
    this.data = this.load();
  }

  private decode(raw: string): { data: MrRobotConfigData; needsRewrite: boolean } {
    const parsed = JSON.parse(raw) as Partial<MrRobotConfigData>;
    if (!isConfigJson(raw)) throw new Error('config structure is invalid');
    const defaults = defaultSettings();
    const rawSettings = parsed.settings ?? {};
    const rawSafety = (rawSettings as Partial<AppSettings>).safety as Partial<AppSettings['safety']> | undefined;
    const rawMode = (rawSafety as { mode?: string } | undefined)?.mode;
    const legacyMode = rawMode === 'confirm' ? 'ask' : rawMode;
    const storedProviders = (parsed.providers ?? []) as Array<ProviderConfig & { apiKeyProtected?: string }>;
    const unavailableSecrets = new Map<string, string>();
    const providers = storedProviders.map((provider) => {
      const protectedValue = provider.apiKeyProtected;
      let apiKey = provider.apiKey ?? '';
      if (protectedValue) {
        try {
          apiKey = this.vault.unprotect(protectedValue);
        } catch {
          apiKey = '';
          if (typeof provider.id === 'string' && provider.id) {
            unavailableSecrets.set(provider.id, protectedValue);
          }
        }
      }
      const { apiKeyProtected: _protected, ...rest } = provider;
      return { ...rest, apiKey };
    });
    const normalizedPairing = normalizePairing(parsed.pairing);
    const data: MrRobotConfigData = {
      settings: {
        ...defaults,
        ...rawSettings,
        network: { ...defaults.network, ...((rawSettings as Partial<AppSettings>).network ?? {}) },
        safety: {
          ...defaults.safety,
          ...(rawSafety ?? {}),
          mode: (legacyMode ?? defaults.safety.mode) as AppSettings['safety']['mode'],
        },
        setup: { ...defaults.setup, ...((rawSettings as Partial<AppSettings>).setup ?? {}) },
        voice: { ...defaults.voice!, ...((rawSettings as Partial<AppSettings>).voice ?? {}) },
      },
      providers,
      routing: { ...defaultRouting(), ...(parsed.routing ?? {}), roles: { ...(parsed.routing?.roles ?? {}) }, graph: parsed.routing?.graph ?? defaultRouting().graph },
      routingPresets: parsed.routingPresets ?? [],
      workspaces: parsed.workspaces ?? [],
      pairing: normalizedPairing.pairing,
      deviceLinks: (parsed.deviceLinks ?? []).map((link) => {
        const permissionCap = normalizeDevicePermission(link.permissionCap);
        return { ...link, permissionCap, capabilities: normalizeDeviceCapabilities(link.capabilities, permissionCap) };
      }),
    };
    this.unavailableProviderSecrets.clear();
    this.recoveryDiagnostics = this.recoveryDiagnostics.filter((item) => item.code !== 'provider-secret-unavailable');
    for (const [providerId, protectedValue] of unavailableSecrets) {
      this.unavailableProviderSecrets.set(providerId, protectedValue);
      this.recordDiagnostic({
        code: 'provider-secret-unavailable',
        message: `공급자 ${providerId}의 저장된 API 키를 현재 Windows 계정에서 복호화할 수 없습니다.`,
        providerId,
      });
    }
    return {
      data,
      needsRewrite: normalizedPairing.migrated || storedProviders.some((provider) => Boolean(provider.apiKey) && !provider.apiKeyProtected),
    };
  }

  private fresh(): MrRobotConfigData {
    return {
      settings: defaultSettings(),
      providers: [],
      routing: defaultRouting(),
      routingPresets: [],
      workspaces: [],
      pairing: freshPairing(),
      deviceLinks: [],
    };
  }

  private load(): MrRobotConfigData {
    if (!existsSync(this.file)) {
      const fresh = this.fresh();
      this.save(fresh);
      return fresh;
    }

    try {
      const decoded = this.decode(readFileSync(this.file, 'utf8'));
      if (decoded.needsRewrite) {
        try { this.save(decoded.data); }
        catch (error) { console.error('[config] loaded config but could not persist its safe migration:', error); }
      }
      return decoded.data;
    } catch (error) {
      console.error('[config] config is unreadable; preserving it for recovery:', error);
    }

    const quarantine = this.quarantine(this.file);
    if (quarantine) {
      this.recordDiagnostic({
        code: 'config-corrupt-quarantined',
        message: '손상되거나 읽을 수 없는 설정 원본을 격리했습니다.',
        path: quarantine,
      });
    }

    if (existsSync(this.backupFile)) {
      let backupRaw: string | undefined;
      let decoded: { data: MrRobotConfigData; needsRewrite: boolean } | undefined;
      try {
        backupRaw = readFileSync(this.backupFile, 'utf8');
        decoded = this.decode(backupRaw);
      } catch (error) {
        console.error('[config] last-known-good backup is also unreadable:', error);
        const backupQuarantine = this.quarantine(this.backupFile);
        if (backupQuarantine) {
          this.recordDiagnostic({
            code: 'config-corrupt-quarantined',
            message: '읽을 수 없는 설정 백업을 별도로 격리했습니다.',
            path: backupQuarantine,
          });
        }
      }
      if (backupRaw !== undefined && decoded !== undefined) {
        if (!this.writesBlocked) {
          try {
            atomicWriteUtf8(this.file, backupRaw);
            if (decoded.needsRewrite) this.save(decoded.data);
          } catch (error) {
            this.writesBlocked = true;
            this.recordDiagnostic({
              code: 'config-persistence-blocked',
              message: '정상 설정 백업은 읽었지만 복구본을 저장하지 못해 추가 저장을 차단했습니다.',
              path: this.backupFile,
            });
            console.error('[config] backup loaded but could not be restored atomically:', error);
          }
        }
        this.recordDiagnostic({
          code: 'config-backup-recovered',
          message: '마지막 정상 설정 백업으로 복구했습니다.',
          path: this.backupFile,
        });
        return decoded.data;
      }
    }

    const fresh = this.fresh();
    this.recordDiagnostic({
      code: 'config-fresh-recovery',
      message: '정상 백업이 없어 새 설정으로 시작했습니다. 격리된 원본은 수동 복구할 수 있습니다.',
      path: quarantine,
    });
    if (!this.writesBlocked) this.save(fresh);
    return fresh;
  }

  private recordDiagnostic(diagnostic: Omit<ConfigRecoveryDiagnostic, 'at'>): void {
    if (diagnostic.code === 'provider-secret-unavailable' && this.recoveryDiagnostics.some((item) => item.code === diagnostic.code && item.providerId === diagnostic.providerId)) return;
    this.recoveryDiagnostics.push({ ...diagnostic, at: Date.now() });
  }

  private quarantine(file: string): string | undefined {
    if (!existsSync(file)) return undefined;
    const target = `${file}.corrupt-${recoveryTimestamp()}-${randomUUID().slice(0, 8)}`;
    try {
      renameSync(file, target);
      return target;
    } catch {
      this.writesBlocked = true;
      this.recordDiagnostic({
        code: 'config-persistence-blocked',
        message: '손상된 설정 원본을 안전하게 격리하지 못해 추가 저장을 차단했습니다.',
        path: file,
      });
      return undefined;
    }
  }

  private save(data: MrRobotConfigData = this.data): void {
    if (this.writesBlocked) throw new Error('설정 복구 원본을 보존하기 위해 저장이 차단되었습니다.');
    mkdirSync(this.dir, { recursive: true });
    const persisted = {
      ...data,
      providers: data.providers.map((provider) => {
        const { apiKey, ...rest } = provider;
        const retainedProtected = this.unavailableProviderSecrets.get(provider.id);
        return {
          ...rest,
          ...(apiKey
            ? { apiKeyProtected: this.vault.protect(apiKey) }
            : retainedProtected
              ? { apiKeyProtected: retainedProtected }
              : {}),
        };
      }),
    };
    const serialized = JSON.stringify(persisted, null, 2);
    let backupRaw = serialized;
    if (existsSync(this.file)) {
      const currentRaw = readFileSync(this.file, 'utf8');
      if (!isConfigJson(currentRaw)) {
        const quarantined = this.quarantine(this.file);
        if (!quarantined) throw new Error('손상된 현재 설정을 격리하지 못했습니다.');
        this.recordDiagnostic({
          code: 'config-corrupt-quarantined',
          message: '저장 직전 감지한 손상 설정을 격리했습니다.',
          path: quarantined,
        });
      } else if (!containsPlaintextProviderSecret(currentRaw)) {
        backupRaw = currentRaw;
      }
    }
    if (existsSync(this.backupFile)) {
      const currentBackup = readFileSync(this.backupFile, 'utf8');
      if (!isConfigJson(currentBackup)) {
        const quarantined = this.quarantine(this.backupFile);
        if (!quarantined) throw new Error('손상된 설정 백업을 격리하지 못했습니다.');
      }
    }
    atomicWriteUtf8(this.backupFile, backupRaw);
    atomicWriteUtf8(this.file, serialized);
  }

  get settings(): AppSettings {
    return this.data.settings;
  }

  get providers(): ProviderConfig[] {
    return this.data.providers;
  }

  get pairing(): PairingConfig {
    return this.data.pairing;
  }

  get recovery(): ConfigRecoveryState {
    return {
      degraded: this.recoveryDiagnostics.length > 0,
      writesBlocked: this.writesBlocked,
      diagnostics: clone(this.recoveryDiagnostics),
    };
  }

  isProviderSecretUnavailable(id: string): boolean {
    return this.unavailableProviderSecrets.has(id);
  }

  get routing(): RoutingSettings {
    return this.data.routing;
  }

  get routingPresets(): RoutingPreset[] {
    return [...builtInRoutingPresets(), ...this.data.routingPresets].map(clone);
  }

  get workspaces(): WorkspaceInfo[] {
    return clone(this.data.workspaces);
  }

  addWorkspace(path: string, name?: string): WorkspaceInfo {
    const cleanPath = path.trim();
    if (!cleanPath) throw new Error('작업 폴더 경로를 입력하세요.');
    const absolutePath = resolve(cleanPath);
    if (!existsSync(absolutePath)) throw new Error(`작업 폴더가 존재하지 않습니다: ${absolutePath}`);
    try {
      if (!statSync(absolutePath).isDirectory()) throw new Error('not-directory');
    } catch {
      throw new Error(`폴더 경로가 아니거나 접근할 수 없습니다: ${absolutePath}`);
    }
    const existing = this.data.workspaces.find((item) => item.path.toLowerCase() === absolutePath.toLowerCase());
    if (existing) return clone(existing);
    const item: WorkspaceInfo = {
      id: randomUUID(),
      name: name?.trim().slice(0, 80) || absolutePath.split(/[\\/]/).filter(Boolean).at(-1) || '작업 폴더',
      path: absolutePath,
      isDefault: this.data.workspaces.length === 0,
      createdAt: Date.now(),
    };
    this.data.workspaces.push(item);
    const roots = new Set([...(this.data.settings.safety.allowedRoots ?? []), absolutePath]);
    this.data.settings.safety.allowedRoots = [...roots];
    this.save();
    return clone(item);
  }

  removeWorkspace(id: string): boolean {
    const item = this.data.workspaces.find((workspace) => workspace.id === id);
    if (!item) return false;
    this.data.workspaces = this.data.workspaces.filter((workspace) => workspace.id !== id);
    this.data.settings.safety.allowedRoots = (this.data.settings.safety.allowedRoots ?? [])
      .filter((root) => root.toLowerCase() !== item.path.toLowerCase());
    if (item.isDefault && this.data.workspaces[0]) this.data.workspaces[0].isDefault = true;
    this.save();
    return true;
  }

  setDefaultWorkspace(id: string): WorkspaceInfo {
    const selected = this.data.workspaces.find((workspace) => workspace.id === id);
    if (!selected) throw new Error('작업 폴더를 찾을 수 없습니다.');
    for (const workspace of this.data.workspaces) workspace.isDefault = workspace.id === id;
    this.save();
    return clone(selected);
  }

  exportUserRoutingPresets(): RoutingPreset[] {
    return clone(this.data.routingPresets);
  }

  validateRoutingPresets(value: unknown): void {
    normalizeRoutingPresetSnapshot(value);
  }

  restoreUserRoutingPresets(value: unknown): void {
    if (!Array.isArray(value)) throw new Error('복구할 프리셋 snapshot이 올바르지 않습니다.');
    // This path is only for a same-process snapshot returned by
    // exportUserRoutingPresets(). Rollback must remain possible even when an
    // older local store predates (or exceeds) the remote-import ceilings.
    const previous = this.data.routingPresets;
    this.data.routingPresets = clone(value as RoutingPreset[]);
    try {
      this.save();
    } catch (error) {
      this.data.routingPresets = previous;
      throw error;
    }
  }

  mergeRoutingPresets(value: unknown): { added: number; updated: number; unchanged: number } {
    const candidates = normalizeRoutingPresetSnapshot(value);
    const next = clone(this.data.routingPresets);
    let added = 0; let updated = 0; let unchanged = 0;
    for (const candidate of candidates) {
      const index = next.findIndex((item) => item.id === candidate.id);
      if (index < 0) {
        next.push(clone(candidate));
        added++;
      } else if (candidate.updatedAt > next[index].updatedAt) {
        next[index] = clone(candidate);
        updated++;
      } else unchanged++;
    }
    if (added || updated) {
      assertRoutingPresetSnapshotBudget(next);
      const previous = this.data.routingPresets;
      this.data.routingPresets = next;
      try {
        this.save();
      } catch (error) {
        this.data.routingPresets = previous;
        throw error;
      }
    }
    return { added, updated, unchanged };
  }

  /** Resolve a preset without changing the global routing selection. */
  routingForPreset(id: string): RoutingPresetSettings | undefined {
    const preset = this.routingPresets.find((item) => item.id === id);
    if (!preset) return undefined;
    const resolved: RoutingPresetSettings = {
      mode: preset.mode,
      executionMode: preset.executionMode ?? 'single',
      meetingRounds: Math.max(1, Math.min(3, preset.meetingRounds ?? 2)),
      crossGroupRounds: Math.max(0, Math.min(3, preset.crossGroupRounds ?? 1)),
      maxIterations: Math.max(1, Math.min(12, preset.maxIterations ?? 6)),
      roles: clone(preset.roles),
      maxPremiumCalls: preset.maxPremiumCalls,
      escalationEnabled: preset.escalationEnabled,
      graph: clone(preset.graph),
    };
    if (preset.builtin && resolved.graph) {
      const preferred = this.data.providers.find((provider) => provider.isDefault) ?? this.data.providers[0];
      if (preferred) {
        resolved.graph.nodes = resolved.graph.nodes.map((node) => ({
          ...node,
          providerId: node.providerId ?? preferred.id,
          providerModel: node.providerModel ?? efficientModel(preferred, node.role ?? 'general'),
        }));
      }
    }
    const graphRoles: RoutingPresetSettings['roles'] = {};
    for (const node of [...(resolved.graph?.nodes ?? [])].sort((a, b) => a.x - b.x)) {
      if (node.kind === 'model' && node.role && node.providerId) (graphRoles[node.role] ??= []).push(node.providerId);
    }
    if (Object.keys(graphRoles).length) resolved.roles = graphRoles;
    return resolved;
  }

  get deviceLinks(): DeviceLinkConfig[] {
    return this.data.deviceLinks;
  }

  createDeviceLink(name: string, permissionCap: PermissionMode, capabilities?: DeviceCapability[]): { token: string; link: DeviceLinkConfig } {
    const token = generateSecret();
    const link: DeviceLinkConfig = {
      id: randomUUID(), name: name.trim().slice(0, 80) || '연결된 기기', tokenHash: hashToken(token), permissionCap,
      capabilities: normalizeDeviceCapabilities(capabilities, permissionCap), createdAt: Date.now(),
    };
    this.data.deviceLinks.push(link);
    this.save();
    return { token, link };
  }

  findDeviceLink(token: string): DeviceLinkConfig | undefined {
    if (!token) return undefined;
    const hash = hashToken(token);
    return this.data.deviceLinks.find((link) => !link.revokedAt && safeHashEqual(link.tokenHash, hash));
  }

  patchDeviceLink(id: string, patch: { name?: string; permissionCap?: PermissionMode; capabilities?: DeviceCapability[] }): DeviceLinkConfig | undefined {
    const link = this.data.deviceLinks.find((item) => item.id === id && !item.revokedAt);
    if (!link) return undefined;
    if (patch.name !== undefined) link.name = patch.name.trim().slice(0, 80) || link.name;
    if (patch.permissionCap !== undefined) link.permissionCap = normalizeDevicePermission(patch.permissionCap);
    if (patch.capabilities !== undefined) link.capabilities = normalizeDeviceCapabilities(patch.capabilities, link.permissionCap);
    // A read-only link may inspect ordinary UI state but cannot import/export a
    // complete work snapshot, even if a stale client submits the capability.
    if (link.permissionCap === 'read-only') link.capabilities = link.capabilities.filter((item) => item !== 'work-sync');
    this.save();
    return link;
  }

  revokeDeviceLink(id: string): boolean {
    const link = this.data.deviceLinks.find((item) => item.id === id && !item.revokedAt);
    if (!link) return false;
    link.revokedAt = Date.now();
    this.save();
    return true;
  }

  updateRouting(patch: Partial<RoutingSettings>): RoutingSettings {
    const manuallyEdited = Object.keys(patch).some((key) => key !== 'activePresetId');
    this.data.routing = {
      ...this.data.routing,
      ...patch,
      roles: { ...this.data.routing.roles, ...(patch.roles ?? {}) },
      ...(manuallyEdited ? { activePresetId: undefined } : {}),
    };
    if (patch.graph) {
      const graphRoles: RoutingSettings['roles'] = {};
      for (const node of [...patch.graph.nodes].sort((a, b) => a.x - b.x)) {
        if (node.kind === 'model' && node.role && node.providerId) (graphRoles[node.role] ??= []).push(node.providerId);
      }
      this.data.routing.roles = graphRoles;
    }
    this.save();
    return this.data.routing;
  }

  saveRoutingPreset(name: string, description = '', id?: string): RoutingPreset {
    const cleanName = name.trim().slice(0, 80);
    if (!cleanName) throw new Error('프리셋 이름을 입력하세요.');
    if (id?.startsWith('builtin:')) throw new Error('기본 프리셋은 덮어쓸 수 없습니다.');
    const now = Date.now();
    const existing = id ? this.data.routingPresets.find((preset) => preset.id === id) : undefined;
    if (id && !existing) throw new Error('프리셋을 찾을 수 없습니다.');
    const preset: RoutingPreset = {
      id: existing?.id ?? randomUUID(),
      name: cleanName,
      description: description.trim().slice(0, 240) || undefined,
      builtin: false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      mode: this.data.routing.mode,
      executionMode: this.data.routing.executionMode ?? 'single',
      meetingRounds: Math.max(1, Math.min(3, this.data.routing.meetingRounds ?? 2)),
      crossGroupRounds: Math.max(0, Math.min(3, this.data.routing.crossGroupRounds ?? 1)),
      maxIterations: Math.max(1, Math.min(12, this.data.routing.maxIterations ?? 6)),
      roles: clone(this.data.routing.roles),
      maxPremiumCalls: this.data.routing.maxPremiumCalls,
      escalationEnabled: this.data.routing.escalationEnabled,
      graph: clone(this.data.routing.graph),
    };
    const index = this.data.routingPresets.findIndex((item) => item.id === preset.id);
    if (index >= 0) this.data.routingPresets[index] = preset;
    else this.data.routingPresets.push(preset);
    this.data.routing.activePresetId = preset.id;
    this.save();
    return clone(preset);
  }

  applyRoutingPreset(id: string): RoutingSettings {
    const preset = this.routingPresets.find((item) => item.id === id);
    if (!preset) throw new Error('프리셋을 찾을 수 없습니다.');
    const resolved = this.routingForPreset(id) as RoutingPresetSettings;
    this.data.routing = {
      ...resolved,
      activePresetId: preset.id,
    };
    this.deriveRoutingRoles();
    this.save();
    return clone(this.data.routing);
  }

  deleteRoutingPreset(id: string): boolean {
    if (id.startsWith('builtin:')) throw new Error('기본 프리셋은 삭제할 수 없습니다.');
    const before = this.data.routingPresets.length;
    this.data.routingPresets = this.data.routingPresets.filter((preset) => preset.id !== id);
    if (before === this.data.routingPresets.length) return false;
    if (this.data.routing.activePresetId === id) this.data.routing.activePresetId = undefined;
    this.save();
    return true;
  }

  private deriveRoutingRoles(): void {
    if (!this.data.routing.graph) return;
    const graphRoles: RoutingSettings['roles'] = {};
    for (const node of [...this.data.routing.graph.nodes].sort((a, b) => a.x - b.x)) {
      if (node.kind === 'model' && node.role && node.providerId) (graphRoles[node.role] ??= []).push(node.providerId);
    }
    this.data.routing.roles = graphRoles;
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.data.settings = {
      ...this.data.settings,
      ...patch,
      network: { ...this.data.settings.network, ...(patch.network ?? {}) },
      safety: { ...this.data.settings.safety, ...(patch.safety ?? {}) },
      setup: { ...this.data.settings.setup, ...(patch.setup ?? {}) },
      voice: { ...this.data.settings.voice!, ...(patch.voice ?? {}) },
    };
    this.save();
    return this.data.settings;
  }

  upsertProvider(provider: ProviderConfig): void {
    const i = this.data.providers.findIndex((p) => p.id === provider.id);
    if (i >= 0) this.data.providers[i] = provider;
    else this.data.providers.push(provider);
    this.clearUnavailableProviderSecret(provider.id);
    if (provider.isDefault) {
      for (const p of this.data.providers) if (p.id !== provider.id) p.isDefault = false;
    }
    this.save();
  }

  patchProvider(id: string, patch: Partial<ProviderConfig>): boolean {
    const index = this.data.providers.findIndex((p) => p.id === id);
    if (index < 0) return false;
    this.data.providers[index] = { ...this.data.providers[index], ...patch, id };
    if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) this.clearUnavailableProviderSecret(id);
    this.save();
    return true;
  }

  removeProvider(id: string): void {
    const before = this.data.providers.length;
    this.data.providers = this.data.providers.filter((p) => p.id !== id);
    if (this.data.providers.length !== before) {
      this.clearUnavailableProviderSecret(id);
      this.save();
    }
  }

  private clearUnavailableProviderSecret(id: string): void {
    this.unavailableProviderSecrets.delete(id);
    this.recoveryDiagnostics = this.recoveryDiagnostics.filter((item) => item.code !== 'provider-secret-unavailable' || item.providerId !== id);
  }

  setDefaultProvider(id: string): void {
    let found = false;
    for (const p of this.data.providers) {
      p.isDefault = p.id === id;
      if (p.id === id) found = true;
    }
    if (found) this.save();
  }

  regenerateSecret(): string {
    this.data.pairing = { ...this.data.pairing, secret: generateSecret(), createdAt: Date.now() };
    for (const link of this.data.deviceLinks) if (!link.revokedAt) link.revokedAt = Date.now();
    this.save();
    return this.data.pairing.secret;
  }

  regeneratePin(): string {
    const previous = this.data.pairing.pin;
    this.data.pairing.pin = nextPairingPin(previous);
    this.data.pairing.pinCreatedAt = Date.now();
    this.save();
    return this.data.pairing.pin;
  }

  get pin(): string {
    return this.data.pairing.pin;
  }

  get pinCreatedAt(): number {
    return this.data.pairing.pinCreatedAt;
  }
}

function safeHashEqual(a: string, b: string): boolean {
  return a.length === b.length && a === b;
}
