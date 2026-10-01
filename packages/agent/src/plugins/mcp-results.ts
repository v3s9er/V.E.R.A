import { randomUUID } from 'node:crypto';

/** Short-lived, bounded, conversation/authority-scoped originals. No secrets on disk. */
export class McpResults {
  private values = new Map<string, { scope: string; server: string; text: string; bytes: number; expires: number }>();
  constructor(private now = Date.now, private maxBytes = 32 * 1024 * 1024) {}
  private prune() {
    for (const [id, value] of this.values) if (value.expires <= this.now()) this.values.delete(id);
  }
  clear(server?: string) {
    for (const [id, value] of this.values) if (!server || value.server === server) this.values.delete(id);
  }
  put(scope: string | undefined, server: string, text: string): string | undefined {
    this.prune();
    const bytes = Buffer.byteLength(text);
    if (!scope || bytes > Math.min(this.maxBytes, 8 * 1024 * 1024)) return undefined;
    let total = [...this.values.values()].reduce((sum, value) => sum + value.bytes, 0);
    while (this.values.size && (this.values.size >= 64 || total + bytes > this.maxBytes)) {
      const id = this.values.keys().next().value!;
      total -= this.values.get(id)!.bytes; this.values.delete(id);
    }
    const id = randomUUID();
    this.values.set(id, { scope, server, text, bytes, expires: this.now() + 15 * 60_000 });
    return id;
  }
  read(scope: string | undefined, id: unknown, offset: unknown = 0, limit: unknown = 4000) {
    this.prune();
    const value = typeof id === 'string' ? this.values.get(id) : undefined;
    if (!scope || !value || value.scope !== scope) throw new Error('이 대화에서 사용할 수 있는 MCP 결과가 없거나 만료되었습니다.');
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > value.text.length
      || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 4000) throw new Error('MCP 결과 범위가 올바르지 않습니다.');
    const start = Number(offset);
    if (start > 0 && /[\uDC00-\uDFFF]/.test(value.text[start] ?? '')) throw new Error('문자 중간부터 읽을 수 없습니다. nextOffset을 사용하세요.');
    let end = Math.min(value.text.length, start + Number(limit));
    if (end < value.text.length && /[\uD800-\uDBFF]/.test(value.text[end - 1] ?? '')) end--;
    if (end === start && start < value.text.length) end = Math.min(start + 2, value.text.length);
    return { resultId: id, format: 'json-fragment', offset: start, text: value.text.slice(start, end), originalChars: value.text.length,
      nextOffset: end < value.text.length ? end : null, untrusted: true };
  }
}
