import type { ReasoningEffort } from '@mr-robot/shared';
import type { Turn } from './provider.js';

export type ExecutionDepth = 'direct' | 'standard' | 'deep';
/** Cheap initial hint, corrected by observed failures. Never selects a model or grants authority. */
export class AdaptiveExecution {
  readonly initial: ExecutionDepth;
  private failures = 0;
  private successes = 0;
  constructor(text: string, history: readonly Turn[] = []) {
    this.initial = /취약점|침투|보안.*분석|아키텍처|근본.*원인|증명|vulnerability|root cause|threat model|architecture|mathematical proof/i.test(text) ? 'deep'
      : /^(?:안녕(?:하세요)?|(?:ㅎㅇ){1,3}|하이|고마워(?:요)?|감사합니다|hello|hi|thanks)[.!?~\s]*$/i.test(text.trim())
        || /^(?:너|지금|현재).{0,12}(?:무슨|어떤|뭔)\s*모델.{0,6}[?？]?$/u.test(text.trim())
        || /^(?=.*\d)(?=.*[+*/-])[\d+*/().\s-]{1,80}[=?]?$/.test(text.trim())
        || simpleAnswerEcho(text, history) ? 'direct' : 'standard';
  }
  get depth(): ExecutionDepth { return this.failures >= 2 ? 'deep' : this.initial; }
  observe(success: boolean, kind: 'task' | 'environment' = 'task') {
    if (kind === 'environment') return;
    if (success) { if (++this.successes >= 2) { this.failures = 0; this.successes = 0; } }
    else { this.failures = Math.min(4, this.failures + 1); this.successes = 0; }
  }
  effort(requested: ReasoningEffort, supported: readonly ReasoningEffort[]): ReasoningEffort {
    // The user's selected depth is for substantive work, not a mandatory cost
    // floor for an unambiguous greeting/calculation. Never infer simplicity
    // from message length, lower an unknown capability, or change the model.
    if (this.depth === 'direct' && supported.includes('low')
      && ['auto', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(requested)) return 'low';
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

/** Repeat a bounded, directly preceding trivial answer, not its side effects.
 * Generic "again", work continuations and older context remain substantive.
 */
function simpleAnswerEcho(text: string, history: readonly Turn[]): boolean {
  if (!/^(?:(?:방금|직전|바로 전)\s*(?:계산한\s*)?(?:식과\s*)?(?:답|답변|응답)(?:을|를)?\s*(?:다시|한\s*번\s*더)\s*(?:말해\s*줘|보여\s*줘|알려\s*줘)|repeat\s+(?:the\s+)?(?:last|previous)\s+answer)[.!?~\s]*$/i.test(text.trim())) return false;
  const answer=history.at(-1),request=history.at(-2);
  return answer?.role === 'assistant' && request?.role === 'user'
    && answer.content.length > 0 && answer.content.length <= 2000 && !answer.toolCalls?.length
    && new AdaptiveExecution(request.content).initial === 'direct';
}
