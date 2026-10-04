import type { ModelReasoningCapabilities, ProviderInfo, ReasoningEffort } from './protocol.js';

export const REASONING_EFFORT_ORDER: readonly ReasoningEffort[] = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** A Codex model override never inherits another model's options. */
export function reasoningEffortsForModel(
  provider?: Pick<ProviderInfo, 'type' | 'model' | 'supportedReasoning' | 'modelCapabilities'>,
  model = provider?.model,
  capabilities: Record<string, ModelReasoningCapabilities> | undefined = provider?.modelCapabilities,
): ReasoningEffort[] {
  const supported = provider?.type === 'codex-cli'
    ? model && Object.hasOwn(capabilities ?? {}, model) ? capabilities![model].supportedReasoningEfforts : []
    : provider?.supportedReasoning ?? [];
  return REASONING_EFFORT_ORDER.filter(value => value === 'auto' || supported.includes(value));
}
