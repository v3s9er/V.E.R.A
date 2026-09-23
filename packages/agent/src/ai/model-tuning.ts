import type { ModelTuningCapabilities, ModelTuningProfile, ProviderTuningSettings, ReasoningEffort } from '@mr-robot/shared';
import type { AiProvider, ChatRequest } from './provider.js';

type TuningProvider = Pick<AiProvider, 'type' | 'model' | 'baseUrl' | 'supportedReasoning'>;
const efforts = new Set<ReasoningEffort>(['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max']);
const profileKeys = new Set(['id', 'name', 'reasoningEffort', 'maxOutputTokens', 'temperature', 'contextTokenLimit', 'helperMode', 'maxParallelHelpers', 'responseStyle']);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 형식이 올바르지 않습니다.`);
  return value as Record<string, unknown>;
}

function optionalNumber(value: unknown, label: string, min: number, max: number, integer = true): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${label}: ${min}–${max}${integer ? ' 정수' : ''} 범위여야 합니다.`);
  }
  return value;
}

/** Strict validation excludes model ids, credentials, permissions and budget overrides. */
export function normalizeProviderTuningSettings(value: unknown): ProviderTuningSettings {
  const source = record(value, '모델 튜닝');
  if (Object.keys(source).some(key => key !== 'profiles' && key !== 'activeProfileId')) throw new Error('알 수 없는 모델 튜닝 설정입니다.');
  if (!Array.isArray(source.profiles) || source.profiles.length > 16) throw new Error('공급자별 튜닝 프로필은 최대 16개입니다.');
  const seen = new Set<string>();
  const profiles = source.profiles.map(raw => {
    const item = record(raw, '튜닝 프로필');
    if (Object.keys(item).some(key => !profileKeys.has(key))) throw new Error('알 수 없는 튜닝 프로필 항목입니다.');
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(item.id) || seen.has(item.id)) throw new Error('튜닝 프로필 ID 형식 또는 중복을 확인하세요.');
    seen.add(item.id);
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80 || /[\u0000-\u001f\u007f]/u.test(item.name)) throw new Error('튜닝 프로필 이름은 1–80자여야 합니다.');
    if (item.reasoningEffort !== undefined && !efforts.has(item.reasoningEffort as ReasoningEffort)) throw new Error('추론 단계가 올바르지 않습니다.');
    if (item.helperMode !== undefined && item.helperMode !== 'auto' && item.helperMode !== 'off') throw new Error('보조 작업 설정이 올바르지 않습니다.');
    if (item.responseStyle !== undefined && !['default', 'concise', 'detailed'].includes(String(item.responseStyle))) throw new Error('답변 길이 설정이 올바르지 않습니다.');
    const maxOutputTokens = optionalNumber(item.maxOutputTokens, '최대 출력 토큰', 256, 131_072);
    const temperature = optionalNumber(item.temperature, 'Temperature', 0, 2, false);
    const contextTokenLimit = optionalNumber(item.contextTokenLimit, '문맥 토큰 한도', 2_048, 262_144);
    const maxParallelHelpers = optionalNumber(item.maxParallelHelpers, '병렬 보조 작업', 1, 2) as 1 | 2 | undefined;
    return {
      id: item.id, name: item.name.trim(),
      ...(item.reasoningEffort !== undefined ? { reasoningEffort: item.reasoningEffort as ReasoningEffort } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(contextTokenLimit !== undefined ? { contextTokenLimit } : {}),
      ...(maxParallelHelpers !== undefined ? { maxParallelHelpers } : {}),
      ...(item.helperMode !== undefined ? { helperMode: item.helperMode as 'auto' | 'off' } : {}),
      ...(item.responseStyle !== undefined ? { responseStyle: item.responseStyle as ModelTuningProfile['responseStyle'] } : {}),
    } satisfies ModelTuningProfile;
  });
  if (source.activeProfileId !== undefined && (typeof source.activeProfileId !== 'string' || !seen.has(source.activeProfileId))) throw new Error('선택한 튜닝 프로필을 찾을 수 없습니다.');
  return { profiles, ...(source.activeProfileId !== undefined ? { activeProfileId: source.activeProfileId as string } : {}) };
}

export function activeTuningProfile(settings: ProviderTuningSettings): ModelTuningProfile | undefined {
  return settings.profiles.find(profile => profile.id === settings.activeProfileId);
}

/** Unknown gateways/models intentionally do not inherit unverified API capabilities. */
export function getTuningCapabilities(provider: TuningProvider): ModelTuningCapabilities {
  const subscription = provider.type === 'codex-cli' || provider.type === 'claude-cli';
  let officialOpenAi = false;
  try { officialOpenAi = new URL(provider.baseUrl).hostname.toLowerCase() === 'api.openai.com'; } catch { /* CLI has no URL. */ }
  const gpt4 = /^gpt-(?:4\.1(?:-(?:mini|nano))?|4o(?:-mini)?|4(?:-turbo)?)(?:-\d{4}-\d{2}-\d{2})?$/i.test(provider.model);
  const noneTemperature = /^gpt-5\.[12](?:-\d{4}-\d{2}-\d{2})?$/i.test(provider.model);
  // Ollama documents temperature on its OpenAI-compatible chat endpoint. Other
  // endpoints can still be used, but unsupported knobs are not guessed from ids.
  const temperatureSupported = provider.type === 'ollama' || (officialOpenAi && (gpt4 || noneTemperature));
  let reasoningEfforts: ReasoningEffort[] = [...provider.supportedReasoning];
  if (!subscription) {
    // Do not advertise reasoning knobs just because an arbitrary compatible
    // endpoint happens to accept a model id with a familiar-looking name.
    let verifiedEfforts: ReasoningEffort[] = ['auto'];
    if (officialOpenAi) {
      if (/^gpt-6-astra(?:-\d{4}-\d{2}-\d{2})?$/i.test(provider.model)) verifiedEfforts = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
      else if (/^gpt-(?:5\.6-sol|6-luna)(?:-\d{4}-\d{2}-\d{2})?$/i.test(provider.model)) verifiedEfforts = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];
      else if (/^gpt-5\.[245](?:-\d{4}-\d{2}-\d{2})?$/i.test(provider.model)) verifiedEfforts = ['auto', 'none', 'low', 'medium', 'high', 'xhigh'];
      else if (/^gpt-5\.1(?:-\d{4}-\d{2}-\d{2})?$/i.test(provider.model)) verifiedEfforts = ['auto', 'none', 'low', 'medium', 'high'];
      else if (/^(?:gpt-5(?:-mini|-nano)?|o[134](?:-mini)?)(?:-\d{4}-\d{2}-\d{2})?$/i.test(provider.model)) verifiedEfforts = ['auto', 'low', 'medium', 'high'];
    }
    reasoningEfforts = reasoningEfforts.filter(value => verifiedEfforts.includes(value));
  }
  return {
    reasoningEfforts,
    maxOutputTokens: !subscription,
    temperature: { supported: !subscription && temperatureSupported, min: 0, max: 2, ...(officialOpenAi && noneTemperature ? { requiresReasoningNone: true } : {}) },
    weightTraining: subscription ? 'unavailable-subscription' : 'external-only',
    notes: [
      ...(subscription ? ['구독 CLI는 모델 가중치 파인튜닝과 강제 출력 토큰/temperature 설정을 지원하지 않습니다.'] : []),
      ...(!temperatureSupported && !subscription ? ['이 모델의 temperature 지원을 확인하지 못해 해당 설정은 비활성화됩니다.'] : []),
      '문맥·출력 설정은 기존 안전 한도와 질문 예산을 늘리지 않습니다.',
      '가중치 학습은 여기서 실행하거나 대화 데이터를 외부로 업로드하지 않습니다.',
    ],
  };
}

export interface ResolvedModelTuning extends Omit<ModelTuningProfile, 'id' | 'name'> {
  profileId?: string;
}

export function validateSamplingTemperature(provider: TuningProvider, temperature: number | undefined, reasoningEffort?: ReasoningEffort): void {
  if (temperature === undefined) return;
  optionalNumber(temperature, 'Temperature', 0, 2, false);
  const capabilities = getTuningCapabilities(provider);
  if (!capabilities.temperature.supported) throw new Error('선택한 모델에서 temperature 지원을 확인할 수 없습니다. 튜닝 프로필에서 제거하세요.');
  if (capabilities.temperature.requiresReasoningNone && reasoningEffort !== 'none') throw new Error('이 모델의 temperature는 추론 none을 명시한 경우에만 사용할 수 있습니다.');
}

/** Explicit per-chat reasoning wins. Other invalid selections fail visibly. */
export function resolveModelTuning(
  profile: ModelTuningProfile | undefined,
  provider: TuningProvider,
  explicitReasoning?: ReasoningEffort,
): ResolvedModelTuning {
  if (!profile) return {};
  const normalized = normalizeProviderTuningSettings({ profiles: [profile] }).profiles[0];
  const capabilities = getTuningCapabilities(provider);
  const reasoningEffort = explicitReasoning && explicitReasoning !== 'auto' ? explicitReasoning : normalized.reasoningEffort;
  if (reasoningEffort && !capabilities.reasoningEfforts.includes(reasoningEffort)) throw new Error(`선택한 모델은 ${reasoningEffort} 추론 단계를 지원하지 않습니다. 튜닝 프로필을 변경하세요.`);
  if (normalized.maxOutputTokens !== undefined && !capabilities.maxOutputTokens) throw new Error('구독 CLI에는 강제 출력 토큰 설정을 적용할 수 없습니다. 튜닝 프로필에서 제거하세요.');
  validateSamplingTemperature(provider, normalized.temperature, reasoningEffort);
  const { id: _id, name: _name, ...knobs } = normalized;
  return { ...knobs, ...(reasoningEffort ? { reasoningEffort } : {}), profileId: normalized.id };
}

export function tuningInstructions(tuning: ResolvedModelTuning): string {
  switch (tuning.responseStyle) {
    case 'concise': return 'Response preference: be concise and lead with the result. Preserve necessary evidence, limitations and safety information. Do not omit requested work.';
    case 'detailed': return 'Response preference: provide useful detail, evidence and verification appropriate to the task. Do not repeat information or invent unsupported results.';
    default: return '';
  }
}

/** Invoke before admission/reservation; this only tightens an existing output cap. */
export function applyModelTuning(request: ChatRequest, tuning: ResolvedModelTuning): ChatRequest {
  if (!tuning.profileId) return request;
  const instructions = tuningInstructions(tuning);
  return {
    ...request,
    ...(tuning.reasoningEffort ? { reasoningEffort: tuning.reasoningEffort } : {}),
    ...(tuning.temperature !== undefined ? { temperature: tuning.temperature } : {}),
    ...(tuning.maxOutputTokens !== undefined ? { maxTokens: Math.min(request.maxTokens ?? tuning.maxOutputTokens, tuning.maxOutputTokens) } : {}),
    ...(instructions ? { system: [request.system, instructions].filter(Boolean).join('\n\n') } : {}),
  };
}
