import type { ModelTuningCapabilities, ModelTuningProfile, ProviderTuningSettings, ReasoningEffort } from '@mr-robot/shared';

export interface TuningDraft {
  id: string; name: string; reasoningEffort: string; responseStyle: string;
  maxOutputTokens: string; temperature: string; contextTokenLimit: string;
  helperMode: string; maxParallelHelpers: string;
}

export function tuningDraft(profile?: ModelTuningProfile, id = ''): TuningDraft {
  return {
    id: profile?.id ?? id, name: profile?.name ?? '', reasoningEffort: profile?.reasoningEffort ?? '',
    responseStyle: profile?.responseStyle ?? '', maxOutputTokens: String(profile?.maxOutputTokens ?? ''),
    temperature: String(profile?.temperature ?? ''), contextTokenLimit: String(profile?.contextTokenLimit ?? ''),
    helperMode: profile?.helperMode ?? '', maxParallelHelpers: String(profile?.maxParallelHelpers ?? ''),
  };
}

function numberField(text: string, label: string, min: number, max: number, integer = true): number | undefined {
  if (!text.trim()) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${label}은 ${min.toLocaleString()}–${max.toLocaleString()}${integer ? ' 정수' : ''} 범위로 입력하세요.`);
  return value;
}

export function profileFromDraft(draft: TuningDraft, capabilities: ModelTuningCapabilities): ModelTuningProfile {
  if (!draft.name.trim() || draft.name.length > 80) throw new Error('프로필 이름을 1–80자로 입력하세요.');
  if (draft.reasoningEffort && !capabilities.reasoningEfforts.includes(draft.reasoningEffort as ReasoningEffort)) throw new Error('이 모델에서 지원하는 추론 단계를 선택하세요.');
  const maxOutputTokens = numberField(draft.maxOutputTokens, '출력 토큰', 256, 131072);
  const temperature = numberField(draft.temperature, 'Temperature', 0, 2, false);
  const contextTokenLimit = numberField(draft.contextTokenLimit, '보조 문맥 한도', 2048, 262144);
  const maxParallelHelpers = numberField(draft.maxParallelHelpers, '병렬 보조 작업', 1, 2) as 1 | 2 | undefined;
  if (maxOutputTokens !== undefined && !capabilities.maxOutputTokens) throw new Error('이 공급자는 강제 출력 토큰 설정을 지원하지 않습니다. 값을 지워주세요.');
  if (temperature !== undefined && !capabilities.temperature.supported) throw new Error('이 모델은 temperature 지원을 확인할 수 없습니다. 값을 지워주세요.');
  if (temperature !== undefined && capabilities.temperature.requiresReasoningNone && draft.reasoningEffort !== 'none') throw new Error('Temperature를 사용하려면 추론 none을 직접 선택하세요.');
  return {
    id: draft.id, name: draft.name.trim(),
    ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort as ReasoningEffort } : {}),
    ...(draft.responseStyle ? { responseStyle: draft.responseStyle as ModelTuningProfile['responseStyle'] } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}), ...(temperature !== undefined ? { temperature } : {}),
    ...(contextTokenLimit !== undefined ? { contextTokenLimit } : {}), ...(maxParallelHelpers !== undefined ? { maxParallelHelpers } : {}),
    ...(draft.helperMode ? { helperMode: draft.helperMode as ModelTuningProfile['helperMode'] } : {}),
  };
}

export function replaceTuningProfile(settings: ProviderTuningSettings, profile: ModelTuningProfile, activate = false): ProviderTuningSettings {
  const exists = settings.profiles.some(item => item.id === profile.id);
  if (!exists && settings.profiles.length >= 16) throw new Error('프로필은 최대 16개입니다. 사용하지 않는 프로필을 먼저 삭제하세요.');
  return { profiles: exists ? settings.profiles.map(item => item.id === profile.id ? profile : item) : [...settings.profiles, profile],
    ...(activate || settings.activeProfileId ? { activeProfileId: activate ? profile.id : settings.activeProfileId } : {}) };
}

export function displayLatency(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '측정 없음';
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)}초`;
}
