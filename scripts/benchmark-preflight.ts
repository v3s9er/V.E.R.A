import { CliFailure } from '../packages/agent/src/ai/cli-failure.js';

/** Require the exact requested model before inference; never silently substitute tiers. */
export function assertBenchmarkModelAvailable(requested: string, models: readonly string[]): void {
  if (!models.includes(requested)) throw new CliFailure('model_unavailable');
}
