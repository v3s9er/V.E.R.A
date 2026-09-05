export interface SseEvent {
  event: string;
  data: string;
}

export const PROVIDER_STREAM_LIMITS = Object.freeze({
  timeoutMs: 10 * 60_000,
  maxBytes: 8 * 1024 * 1024,
  maxLines: 65_536,
  maxLineBytes: 1024 * 1024,
  maxBufferBytes: 1024 * 1024,
  maxErrorBodyBytes: 64 * 1024,
});

export type ProviderStreamLimitCode = 'total-bytes' | 'lines' | 'line-bytes' | 'buffer-bytes';

export class ProviderStreamLimitError extends Error {
  constructor(readonly code: ProviderStreamLimitCode) {
    super(`Provider stream exceeded the host safety limit (${code}).`);
    this.name = 'ProviderStreamLimitError';
  }
}

export class ProviderDeadlineError extends Error {
  constructor() {
    super('Provider request exceeded the host deadline.');
    this.name = 'ProviderDeadlineError';
  }
}

export interface ProviderRequestDeadline {
  signal: AbortSignal;
  dispose(): void;
}

/** A provider or caller cannot disable this host-owned wall-clock deadline. */
export function createProviderRequestDeadline(
  external?: AbortSignal,
  timeoutMs = PROVIDER_STREAM_LIMITS.timeoutMs,
): ProviderRequestDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Provider deadline must be a positive safe integer.');
  const host = new AbortController();
  const timer = setTimeout(() => host.abort(new ProviderDeadlineError()), timeoutMs);
  timer.unref?.();
  return {
    signal: external ? AbortSignal.any([external, host.signal]) : host.signal,
    dispose: () => clearTimeout(timer),
  };
}

export interface SseReadLimits {
  maxBytes?: number;
  maxLines?: number;
  maxLineBytes?: number;
  maxBufferBytes?: number;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch { /* response already ended/aborted */ }
}

function rejectStream(reader: ReadableStreamDefaultReader<Uint8Array>, code: ProviderStreamLimitCode): never {
  const error = new ProviderStreamLimitError(code);
  // Never await a provider-controlled stream's cancellation hook before
  // surfacing the hard-limit failure.
  cancelReader(reader, error);
  throw error;
}

/**
 * Minimal SSE reader over a fetch Response body stream. Yields one
 * {event, data} per data line; robust to CRLF and chunk boundaries.
 */
export async function* readSse(res: Response, limits: SseReadLimits = {}): AsyncGenerator<SseEvent> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const maxBytes = positiveLimit(limits.maxBytes, PROVIDER_STREAM_LIMITS.maxBytes);
  const maxLines = positiveLimit(limits.maxLines, PROVIDER_STREAM_LIMITS.maxLines);
  const maxLineBytes = positiveLimit(limits.maxLineBytes, PROVIDER_STREAM_LIMITS.maxLineBytes);
  const maxBufferBytes = positiveLimit(limits.maxBufferBytes, PROVIDER_STREAM_LIMITS.maxBufferBytes);
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let totalBytes = 0;
  let lineCount = 0;
  let currentLineBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - totalBytes) rejectStream(reader, 'total-bytes');
      totalBytes += value.byteLength;
      // LF is one byte in UTF-8, so scanning the raw bytes avoids repeatedly
      // re-encoding a growing unterminated line (an otherwise quadratic DoS).
      for (const byte of value) {
        if (byte === 0x0a) {
          lineCount += 1;
          if (lineCount > maxLines) rejectStream(reader, 'lines');
          currentLineBytes = 0;
        } else currentLineBytes += 1;
        if (currentLineBytes > maxLineBytes) rejectStream(reader, 'line-bytes');
      }
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
          continue;
        }
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data) yield { event, data };
        }
      }
      if (currentLineBytes > maxBufferBytes) rejectStream(reader, 'buffer-bytes');
    }
    // Flush only the decoder's bounded partial code point. An unterminated SSE
    // line remains intentionally uncommitted, so callers fail closed when a
    // provider omits its terminal event.
    buffer += decoder.decode();
  } finally {
    cancelReader(reader);
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

export async function readErrorBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (bytes < PROVIDER_STREAM_LIMITS.maxErrorBodyBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = PROVIDER_STREAM_LIMITS.maxErrorBodyBytes - bytes;
      const accepted = value.subarray(0, remaining);
      bytes += accepted.byteLength;
      text += decoder.decode(accepted, { stream: true });
      if (accepted.byteLength < value.byteLength) break;
    }
    text += decoder.decode();
    return text.slice(0, 500);
  } catch {
    return '';
  } finally {
    cancelReader(reader);
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}
