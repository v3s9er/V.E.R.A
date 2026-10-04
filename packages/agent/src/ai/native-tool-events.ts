import type { NativeToolEvent } from './provider.js';

const names: Record<string, string> = {
  commandExecution: 'native_command', fileChange: 'native_file_change',
  webSearch: 'native_web_search', imageView: 'native_image_view',
  mcpToolCall: 'native_mcp', dynamicToolCall: 'native_host_tool',
  // Older/experimental app-server variants use these for code-mode batches.
  functionCall: 'native_function', customToolCall: 'native_custom_tool',
};

/** Call only AFTER thread/turn correlation. Never retain provider payloads. */
export class NativeToolEvents {
  private items = new Map<string, { name: string; started: number; done: boolean; failed: boolean }>();
  constructor(private emit?: (event: NativeToolEvent) => void, private now = Date.now) {}
  private publish(event: NativeToolEvent): void {
    try { this.emit?.(event); } catch { /* Progress consumers cannot break execution. */ }
  }
  accept(method: string, item: any): void {
    const name = Object.hasOwn(names, item?.type) ? names[item.type] : undefined;
    if (!name || !['item/started', 'item/completed'].includes(method)
      || typeof item.id !== 'string' || !item.id || item.id.length > 200) return;
    let previous = this.items.get(item.id);
    if (!previous) {
      if (this.items.size >= 2048) throw new Error('네이티브 도구 이벤트 한도를 초과했습니다.');
      previous = { name, started: this.now(), done: false, failed: false };
      this.items.set(item.id, previous);
      this.publish({ name, callId: item.id, input: {}, status: 'start' });
    }
    if (method !== 'item/completed') return;
    const failed = ['failed', 'declined', 'cancelled', 'interrupted'].includes(item.status)
      || item.success === false || item.error != null
      || (typeof item.exitCode === 'number' && item.exitCode !== 0);
    if (previous.done) {
      // A raw output proves return, not success. Later explicit failure is
      // authoritative, but must not close another call or charge time twice.
      if (failed && !previous.failed) {
        previous.failed = true;
        this.publish({ name: previous.name, callId: item.id, input: {}, status: 'error', terminalCorrection: true });
      }
      return;
    }
    previous.done = true;
    previous.failed = failed;
    this.publish({ name: previous.name, callId: item.id, input: {}, status: failed ? 'error' : 'done',
      elapsedMs: Math.max(0, this.now() - previous.started) });
  }
  finish(): void {
    for (const [id, item] of this.items) if (!item.done) {
      item.done = true;
      this.publish({ name: item.name, callId: id, input: {}, status: 'error', elapsedMs: Math.max(0, this.now() - item.started) });
    }
    this.items.clear();
  }
}
