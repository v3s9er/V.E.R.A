import type { ReasoningEffort } from './protocol.js';

/** Host-owned inference settings. These never change model identity or access. */
export interface ModelTuningProfile {
  id: string;
  name: string;
  reasoningEffort?: ReasoningEffort;
  /** API output ceiling including reasoning tokens; native CLI does not support it. */
  maxOutputTokens?: number;
  temperature?: number;
  /** Tightens secondary retained context; original dialogue/tool pairs are kept. */
  contextTokenLimit?: number;
  helperMode?: 'auto' | 'off';
  maxParallelHelpers?: 1 | 2;
  responseStyle?: 'default' | 'concise' | 'detailed';
}

export interface ProviderTuningSettings {
  profiles: ModelTuningProfile[];
  /** Omitted means the existing application defaults are unchanged. */
  activeProfileId?: string;
}

export interface ModelTuningCapabilities {
  reasoningEfforts: ReasoningEffort[];
  maxOutputTokens: boolean;
  temperature: {
    supported: boolean;
    min: number;
    max: number;
    requiresReasoningNone?: boolean;
  };
  /** Weight training requires a separately configured external training workflow. */
  weightTraining: 'unavailable-subscription' | 'external-only';
  notes: string[];
}
