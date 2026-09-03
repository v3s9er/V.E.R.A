export function boundedUtf8Preview(value: string, maxBytes: number): {
  text: string;
  truncated: boolean;
} {
  const input = Buffer.from(value, 'utf8');
  const byteLimit = Number.isSafeInteger(maxBytes) ? Math.max(0, maxBytes) : 0;
  const decoded = input.subarray(0, byteLimit).toString('utf8')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '\uFFFD');
  let text = '';
  let used = 0;
  for (const character of decoded) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > byteLimit) break;
    text += character;
    used += bytes;
  }
  return {
    text,
    truncated: input.byteLength > byteLimit || text.length !== decoded.length,
  };
}
