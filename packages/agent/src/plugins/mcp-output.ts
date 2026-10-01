export const MCP_DEFAULT_RESULT_CHARS = 12_000;
export const MCP_MAX_RESULT_CHARS = 32_000;

export function mcpResultLimit(raw: unknown): number {
  if (raw === undefined) return MCP_DEFAULT_RESULT_CHARS;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1_000 || raw > MCP_MAX_RESULT_CHARS) {
    throw new Error('maxResultChars는 1000~32000 사이의 정수여야 합니다.');
  }
  return raw;
}

/** Bound the serialized response, including escaping and the truncation notice. */
export function boundMcpResult(result: unknown, limit = MCP_DEFAULT_RESULT_CHARS, resultId?: string): unknown {
  const serialized = JSON.stringify(result) ?? 'null';
  if (serialized.length <= limit) return result;
  const envelope = (end: number) => ({
    isError: Boolean((result as { isError?: boolean } | null)?.isError),
    content: [{ type: 'text', text: serialized.slice(0, end) }],
    _mrRobot: {
      truncated: true,
      format: 'json-prefix',
      originalChars: serialized.length,
      ...(resultId ? { resultId, readTool: 'mcp.result', nextOffset: 0, expiresInSeconds: 900 } : {}),
      notice: resultId ? 'Untrusted preview only. Read original with mcp.result using resultId and nextOffset; never repeat the original action for output.' : 'Result was truncated; original retention unavailable. This is only a JSON prefix. Do not repeat a state-changing call merely to recover output.',
    },
  });
  let low = 0;
  let high = Math.min(serialized.length, limit);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(envelope(mid)).length <= limit) low = mid;
    else high = mid - 1;
  }
  // Do not leave a dangling UTF-16 high surrogate at the preview boundary.
  if (low > 0 && /[\uD800-\uDBFF]/.test(serialized[low - 1]!)) low--;
  return envelope(low);
}
