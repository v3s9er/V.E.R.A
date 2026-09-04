import type { ModelRole, ReasoningEffort, RoutingMode, RoutingPresetSettings } from '@mr-robot/shared';
import type { ConfigStore } from '../config.js';
import type { AiProvider } from './provider.js';
import type { ProviderRegistry } from './registry.js';

export interface RouteDecision {
  provider?: AiProvider;
  role: ModelRole;
  effort: ReasoningEffort;
  reason: string;
}

/** Stable task-shape signal shared by routing and adaptive run budgeting. */
export function taskComplexityScore(text: string): number {
  let score = Math.min(3, Math.floor(text.length / 1200));
  if (/분석|추론|증명|설계|아키텍처|최적화|원인|디버그|research|analy[sz]e|reason|prove|architect|debug/i.test(text)) score += 2;
  if (/비교|검증|테스트|보안|법률|의료|금융|trade-?off|verify|security/i.test(text)) score += 1;
  if (/코드|구현|리팩터|버그|파일|프로젝트|code|implement|refactor|repository/i.test(text)) score += 1;
  return score;
}

function automaticEffort(score: number, mode: RoutingMode): ReasoningEffort {
  const bias = mode === 'quality' ? 2 : mode === 'economy' ? -1 : 0;
  const value = score + bias;
  if (value <= 0) return 'none';
  if (value <= 2) return 'low';
  if (value <= 4) return 'medium';
  if (value <= 6) return 'high';
  return 'xhigh';
}

export class ModelRouter {
  constructor(private readonly registry: ProviderRegistry, private readonly config: ConfigStore) {}

  decide(text: string, requestedEffort: ReasoningEffort = 'auto', providerId?: string, providerModel?: string, routing?: RoutingPresetSettings | null): RouteDecision {
    if (routing === null) {
      const provider = providerId ? this.registry.getForModel(providerId, providerModel) : this.registry.default();
      const effort = provider && !provider.supportedReasoning.includes(requestedEffort) ? 'auto' : requestedEffort;
      return { provider, role: 'general', effort, reason: '대화 단일 모델' };
    }
    const settings = routing ?? this.config.routing;
    const mode = settings.mode;
    const score = taskComplexityScore(text);
    let role: ModelRole = 'general';
    if (/코드|구현|리팩터|버그|code|implement|refactor|repository/i.test(text)) role = 'coding';
    else if (/이미지|사진|화면|image|photo|screenshot|vision/i.test(text)) role = 'vision';
    else if (score >= 5 || mode === 'quality') role = 'reasoning';
    else if (score <= 1 || mode === 'economy') role = 'fast';

    if (!settings.escalationEnabled && role === 'reasoning' && mode !== 'quality') role = 'general';
    const graphChoice = !providerId
      ? [...(settings.graph?.nodes ?? [])]
        .sort((a, b) => a.x - b.x)
        .find((node) => node.kind === 'model' && node.role === role && node.providerId)
      : undefined;
    let provider = this.registry.resolve(
      role,
      providerId ?? graphChoice?.providerId,
      providerModel ?? graphChoice?.providerModel,
      settings.roles[role],
    );
    if (!providerId && settings.maxPremiumCalls === 0) {
      const free = this.registry.list().filter((p) => p.costTier === 0);
      const roleFree = (settings.roles[role] ?? []).map((id) => free.find((p) => p.id === id)).find(Boolean);
      const selected = roleFree ?? free[0];
      if (selected) provider = this.registry.get(selected.id);
    }
    let effort = requestedEffort === 'auto' ? automaticEffort(score, mode) : requestedEffort;
    if (provider && !provider.supportedReasoning.includes(effort)) effort = 'auto';
    return {
      provider,
      role,
      effort,
      reason: providerId
        ? '대화에서 지정한 모델'
        : graphChoice
          ? `${mode} 정책 · ${role} 역할 노드 · ${graphChoice.label}`
          : `${mode} 정책 · 복잡도 ${score} · ${role} 역할`,
    };
  }
}
