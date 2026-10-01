import type { ProviderType } from './protocol.js';

/** Visibility is not entitlement. The provider validates access on every request. */
export function supportsDaybreak(provider: { type: ProviderType; baseUrl?: string; model: string } | undefined, model = provider?.model ?? ''): boolean {
  if (!provider || !/^gpt-/i.test(model)) return false;
  if (provider.type === 'codex-cli') return true;
  if (provider.type !== 'openai-compatible') return false;
  return /^https:\/\/api\.openai\.com(?::443)?(?:\/|$)/i.test(provider.baseUrl ?? '');
}

export function daybreakProgram(model: string, enabled: boolean): 'standard' | 'daybreakBlue' | 'daybreakRed' {
  if (!enabled) return 'standard';
  return /^gpt-daybreak-red-|^gpt-[\d.]+-cyber(?:-|$)/i.test(model) ? 'daybreakRed' : 'daybreakBlue';
}

export function visibleModelChoices(models: readonly string[], selected?: string): string[] {
  // Legacy Daybreak aliases remain usable if already selected, but are not duplicate model choices.
  return [...new Set([...models.filter(model => !/^gpt-daybreak-(?:blue|red)-latest$/i.test(model)), ...(selected ? [selected] : [])])];
}
