/** Host-owned policy, not model instructions or Discord command visibility. */
export type DiscordAccess = 'blocked' | 'search' | 'isolated' | 'full';
export function parseDiscordAccess(value: unknown): DiscordAccess {
  if (value === 'blocked' || value === 'search' || value === 'isolated' || value === 'full') return value;
  throw new Error('사용자 권한 정책이 올바르지 않습니다.');
}
export function discordAccess(admin: boolean, policies: Record<string, unknown>, scope: string): DiscordAccess {
  if (Object.hasOwn(policies, scope)) return parseDiscordAccess(policies[scope]);
  return admin ? 'full' : 'isolated';
}
export const DISCORD_ADMIN_ACTIONS = new Set(['access', 'user-access', 'model-limit', 'thread.bind', 'thread.unbind', 'thread.panel', 'approve']);
