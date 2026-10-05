import { REASONING_EFFORT_ORDER, type ReasoningEffort } from '@mr-robot/shared';

export interface DiscordModelAssignment { providerId: string; model: string; effort: ReasoningEffort }
export function parseDiscordModelAssignment(value: unknown): DiscordModelAssignment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('관리자 모델 지정값이 올바르지 않습니다.');
  const v = value as Record<string, unknown>;
  if (['providerId', 'model'].some(key => typeof v[key] !== 'string' || !v[key] || (v[key] as string).length > 200 || v[key] !== (v[key] as string).trim())
    || !REASONING_EFFORT_ORDER.includes(v.effort as ReasoningEffort)) throw new Error('관리자 모델·추론 지정값이 올바르지 않습니다.');
  return { providerId: v.providerId as string, model: v.model as string, effort: v.effort as ReasoningEffort };
}
export function assertDiscordAssignedModel(assignment: DiscordModelAssignment, actual: { providerId: string; model: string }): void {
  if (assignment.providerId !== actual.providerId || assignment.model !== actual.model) throw new Error('관리자가 지정한 공급자·모델 외에는 실행할 수 없습니다. 관리자에게 설정 확인을 요청하세요.');
}
