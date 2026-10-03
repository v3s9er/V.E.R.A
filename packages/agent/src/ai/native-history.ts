import type { Turn } from './provider.js';

const excerpt = (text: string, chars: number) => {
  if (text.length <= chars) return text;
  let head = text.slice(0, Math.floor(chars / 2));
  let tail = chars > 0 ? text.slice(-Math.ceil(chars / 2)) : '';
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return `${head}\n[content omitted]\n${tail}`;
};

/** Rebuild a lost CLI session from bounded, well-formed records, not a sliced
 * JSON string. Keep a contiguous suffix starting at a user request. Oversized
 * newest groups are explicitly excerpts, never pretend to be complete tools. */
export function nativeHistory(history: readonly Turn[], limit = 48_000): string {
  const budget = Math.max(512, Math.min(48_000, Number.isFinite(limit) ? Math.floor(limit) : 48_000));
  const wrap = (records: unknown[], omitted: number) => JSON.stringify({ omittedEarlierRecords: omitted, records });
  let records: Turn[] = [], start = history.length;
  for (let end = history.length; end > 0;) {
    let begin = end - 1;
    while (begin > 0 && history[begin].role !== 'user') begin--;
    const candidate = [...history.slice(begin, end), ...records];
    if (wrap(candidate, begin).length > budget) break;
    records = candidate; start = begin; end = begin;
  }
  if (records.length || !history.length) return wrap(records, start);
  // A single huge recent exchange must not hide the user's latest topic. This
  // fallback is data only; omit structured tool payloads instead of severing
  // tool-call/result pairs or supplying malformed arguments as valid evidence.
  const recent = history.slice(-Math.min(8, history.length));
  for (let chars = Math.floor((budget - 400) / (recent.length * 2)); chars >= 0; chars = Math.floor(chars / 2)) {
    const excerpts = recent.map(turn => ({ role: turn.role,
      content: excerpt(turn.content, chars),
      ...(turn.toolCalls || turn.toolResults ? { omittedToolPayload: true } : {}),
    }));
    const text = JSON.stringify({ omittedEarlierRecords: history.length - recent.length, incompleteRecords: true, records: excerpts });
    if (text.length <= budget) return text;
    if (!chars) break;
  }
  return JSON.stringify({ omittedEarlierRecords: history.length, incompleteRecords: true, records: [] });
}
