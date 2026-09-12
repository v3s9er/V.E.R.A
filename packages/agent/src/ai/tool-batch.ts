/** Independent read-only file observations may overlap. Mutations, desktop
 * actions and unknown/plugin tools always retain their original order. */
const PARALLEL_READS = new Set(['read_file', 'list_files']);
export async function executeToolBatch<T extends { name: string }, R>(
  calls: readonly T[], execute: (call: T, index: number) => Promise<R>, signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < calls.length;) {
    signal?.throwIfAborted();
    let end = i + 1;
    if (PARALLEL_READS.has(calls[i].name)) {
      while (end < calls.length && end - i < 3 && PARALLEL_READS.has(calls[end].name)) end++;
    }
    // Drain every started read before crossing a mutation barrier or rejecting.
    const batch = await Promise.allSettled(calls.slice(i, end).map((call, offset) => execute(call, i + offset)));
    signal?.throwIfAborted();
    const failed = batch.find((item): item is PromiseRejectedResult => item.status === 'rejected');
    if (failed) throw failed.reason;
    for (const item of batch) if (item.status === 'fulfilled') results.push(item.value);
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
