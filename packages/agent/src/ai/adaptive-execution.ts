import type { ReasoningEffort } from '@mr-robot/shared';

export type ExecutionDepth = 'direct' | 'standard' | 'deep';
/** Cheap initial hint, corrected by observed failures. Never selects a model or grants authority. */
export class AdaptiveExecution {
  readonly initial: ExecutionDepth;
  private failures = 0;
  private successes = 0;
  constructor(text: string) {
    this.initial = /취약점|침투|보안.*분석|아키텍처|근본.*원인|증명|vulnerability|root cause|threat model|architecture|mathematical proof/i.test(text) ? 'deep'
      : /^(?:안녕(?:하세요)?|고마워|감사합니다|hello|hi|thanks)[.!?~\s]*$/i.test(text.trim())
        || /^(?:너|지금|현재).{0,12}(?:무슨|어떤|뭔)\s*모델.{0,6}[?？]?$/u.test(text.trim())
        || /^[\d+*/().\s-]{1,80}[=?]?$/.test(text.trim()) ? 'direct' : 'standard';
  }
  get depth(): ExecutionDepth { return this.failures >= 2 ? 'deep' : this.initial; }
  observe(success: boolean, kind: 'task' | 'environment' = 'task') {
    if (kind === 'environment') return;
    if (success) { if (++this.successes >= 2) { this.failures = 0; this.successes = 0; } }
    else { this.failures = Math.min(4, this.failures + 1); this.successes = 0; }
  }
  effort(requested: ReasoningEffort, supported: readonly ReasoningEffort[]): ReasoningEffort {
    if (requested !== 'auto') return supported.includes(requested) ? requested : 'auto';
    const preferred = this.depth === 'deep' ? 'high' : this.depth === 'direct' ? 'low' : 'medium';
    return supported.includes(preferred) ? preferred : 'auto';
  }
  guidance(): string {
    const instruction = this.depth === 'direct' ? 'Answer directly. Do not create plans or helpers for a simple request.'
      : this.depth === 'deep' ? 'Separate hypotheses, gather independent evidence, reproduce safely and check counterexamples. Delegate only independent branches with explicit scope and evidence requirements. Sequential reasoning stays with you.'
      : 'Use a short plan only if useful. Batch independent reads, execute dependent changes in order and verify actual artifacts.';
    return `Execution depth hint: ${this.depth}. ${instruction} Reassess based on actual evidence. Never broaden access with difficulty, silently replace the selected model, repeat an uncertain write, or report completion without evidence. Authentication/environment failures require concrete repairs, not more reasoning.`;
  }
}
