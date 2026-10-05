import type { ReasoningEffort } from '@mr-robot/shared';
import type { AiProvider } from './provider.js';

/** Reporting data only. Never supplies credentials, user ids or authorization.
 * Keep changing effort in context, not stable instructions/session cache keys.
 */
export function executionMetadata(provider: Pick<AiProvider, 'label' | 'model'>, effort?: ReasoningEffort): string {
  return `Current V.E.R.A execution metadata (reporting only): provider=${JSON.stringify(provider.label)}, model=${JSON.stringify(provider.model)}, reasoning_effort=${effort ?? 'auto'}.
This is the option sent for THIS call, not a measurement of internal reasoning. If auto, no explicit effort was supplied and the provider default is unverified. Execution-depth hints direct/standard/deep are NOT reasoning-effort settings. For questions about this call, report these current values, not old answers or depth hints.`;
}

export function executionContext(context: string | undefined, provider: Pick<AiProvider, 'label' | 'model'>, effort?: ReasoningEffort): string {
  return [context, executionMetadata(provider, effort)].filter(Boolean).join('\n\n');
}
