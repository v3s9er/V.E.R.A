/** Administrative product tiers, not a benchmark or cross-vendor quality ranking. */
export const DISCORD_MODEL_CEILINGS = ['spark', 'mini', 'luna', 'terra', 'sol', 'astra', 'unlimited'] as const;
export type DiscordModelCeiling = typeof DISCORD_MODEL_CEILINGS[number];
/** Compatibility baseline, not an explicit grant of newly delegated models. */
export type DiscordModelPolicy = DiscordModelCeiling | 'default';
const models: Readonly<Record<string, number>> = Object.freeze({
  'gpt-5.3-codex-spark': 0,
  'gpt-5.4-mini': 1,
  'gpt-5.6-luna': 2,
  'gpt-5.6-terra': 3,
  'gpt-5.6-sol': 4,
  'gpt-6-sol': 4,
  'gpt-6-astra': 5,
});
export function parseDiscordModelCeiling(value: unknown): DiscordModelCeiling {
  if (typeof value !== 'string' || !(DISCORD_MODEL_CEILINGS as readonly string[]).includes(value)) throw new Error('모델 상한 설정이 올바르지 않습니다. 관리자가 다시 설정하세요.');
  return value as DiscordModelCeiling;
}
export function parseDiscordModelPolicy(value: unknown): DiscordModelPolicy {
  return value === 'default' ? 'default' : parseDiscordModelCeiling(value);
}
export function discordModelPolicy(admin: boolean, limits: Record<string, unknown>, scope: string): DiscordModelPolicy {
  return Object.hasOwn(limits, scope) ? parseDiscordModelCeiling(limits[scope]) : admin ? 'unlimited' : 'default';
}
export function discordModelAllowed(ceiling: DiscordModelPolicy, model: unknown): boolean {
  parseDiscordModelPolicy(ceiling);
  if (typeof model !== 'string' || !model || model !== model.trim()) return false;
  // Preserve existing provider/legacy-model access without implicitly granting
  // the new GPT-6 family. New aliases must not bypass explicit administrator consent.
  if (ceiling === 'default') return !/(?:^|[/:])gpt-(?:[6-9]|\d{2,})/i.test(model) && !/^(?:sol|astra)$/i.test(model);
  if (ceiling === 'unlimited') return true;
  // Exact IDs only: unknown providers, aliases, dates and new models fail closed.
  return typeof model === 'string' && Object.hasOwn(models, model)
    && models[model]! <= DISCORD_MODEL_CEILINGS.indexOf(ceiling);
}
export function assertDiscordModelAllowed(ceiling: DiscordModelPolicy, model: unknown): void {
  if (ceiling === 'default' && !discordModelAllowed(ceiling, model)) throw new Error('이 모델은 서버 관리자의 사용자별 허가가 필요합니다. /robot model-limit에서 sol 또는 astra 상한을 허가받은 뒤 /robot model을 다시 여세요. PC 접근 권한은 별개입니다.');
  if (!discordModelAllowed(ceiling, model)) throw new Error(`사용자 모델 상한은 ${ceiling} 이하입니다. 상위·미분류 모델은 사용할 수 없습니다. /robot model에서 허용 모델을 선택하세요.`);
}
