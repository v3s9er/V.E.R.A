/** Independent read-only file observations may overlap. Mutations, desktop
 * actions and unknown/plugin tools always retain their original order. */
const PARALLEL_READS = new Set(['read_file', 'list_files']);
const MAX_PARALLEL_READS = 3;
export async function executeToolBatch<T extends { name: string }, R>(
  calls: readonly T[], execute: (call: T, index: number) => Promise<R>, signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < calls.length;) {
    signal?.throwIfAborted();
    let end = i + 1;
    if (PARALLEL_READS.has(calls[i].name)) {
      while (end < calls.length && PARALLEL_READS.has(calls[end].name)) end++;
    }
    // Refill a free lane immediately; a slow read must not stall the next
    // independent read. The entire segment still drains before a mutation.
    const segment: R[] = new Array(end - i);
    const start = i;
    let next = start;
    let failure: { error: unknown } | undefined;
    const worker = async () => {
      while (next < end && !failure && !signal?.aborted) {
        const index = next++;
        try { segment[index - start] = await execute(calls[index], index); }
        catch (error) { failure ??= { error }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_READS, end - start) }, worker));
    signal?.throwIfAborted();
    if (failure) throw failure.error;
    results.push(...segment);
    i = end;
  }
  return results;
}

export function toolResultSucceeded(content: string): boolean {
  try {
    const result = JSON.parse(content);
    if (!result || typeof result !== 'object' || Array.isArray(result)) return true;
    return !result.error && result.ok !== false && result.cancelled !== true && result.launched !== false
      && !(typeof result.exitCode === 'number' && result.exitCode !== 0);
  } catch { return true; }
}
