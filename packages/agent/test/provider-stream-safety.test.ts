import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { AnthropicProvider } from '../src/ai/anthropic.js';
import { OpenAICompatibleProvider } from '../src/ai/openai.js';
import {
  MAX_PROVIDER_RECORDED_TOKENS,
  normalizeProviderUsageReport,
} from '../src/ai/provider.js';
import {
  createProviderRequestDeadline,
  ProviderDeadlineError,
  ProviderStreamLimitError,
  readErrorBody,
  readSse,
} from '../src/ai/sse.js';

const encoder = new TextEncoder();

function chunkedResponse(chunks: string[], onCancel?: (reason: unknown) => void): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
      else controller.close();
    },
    cancel(reason) {
      onCancel?.(reason);
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collectSse(response: Response, limits?: Parameters<typeof readSse>[1]) {
  const events = [];
  for await (const event of readSse(response, limits)) events.push(event);
  return events;
}

function sseResponse(lines: string[]): Response {
  return new Response(`${lines.join('\n')}\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('provider usage reports are untrusted accounting input', () => {
  test('normalizes valid reports and atomically rejects missing or malformed companions', () => {
    assert.deepEqual(normalizeProviderUsageReport({
      promptTokens: 12,
      completionTokens: 3,
      cachedPromptTokens: 4,
    }), {
      promptTokens: 12,
      completionTokens: 3,
      cachedPromptTokens: 4,
      reportStatus: 'reported',
    });
    assert.deepEqual(normalizeProviderUsageReport({ promptTokens: 1 }), {
      promptTokens: 0,
      completionTokens: 0,
      reportStatus: 'missing',
    });
    assert.deepEqual(normalizeProviderUsageReport({ promptTokens: 1, completionTokens: -1 }), {
      promptTokens: 0,
      completionTokens: 0,
      reportStatus: 'invalid',
    });
    assert.deepEqual(normalizeProviderUsageReport({ promptTokens: 1, completionTokens: Number.NaN }), {
      promptTokens: 0,
      completionTokens: 0,
      reportStatus: 'invalid',
    });
  });

  test('saturates huge finite counters and marks the report for audit', () => {
    const usage = normalizeProviderUsageReport({
      promptTokens: MAX_PROVIDER_RECORDED_TOKENS + 1,
      completionTokens: 2,
      reasoningTokens: MAX_PROVIDER_RECORDED_TOKENS * 2,
    });
    assert.equal(usage.promptTokens, MAX_PROVIDER_RECORDED_TOKENS);
    assert.equal(usage.completionTokens, 2);
    assert.equal(usage.reasoningTokens, MAX_PROVIDER_RECORDED_TOKENS);
    assert.equal(usage.reportStatus, 'capped');
  });
});

describe('SSE streams have host-owned resource bounds', () => {
  test('parses an ordinary low-traffic stream across CRLF and chunk boundaries', async () => {
    const events = await collectSse(chunkedResponse([
      'event: update\r\nda',
      'ta: {"ok":true}\r\n\r\ndata: [DONE]\n',
    ]));
    assert.deepEqual(events, [
      { event: 'update', data: '{"ok":true}' },
      { event: 'update', data: '[DONE]' },
    ]);
  });

  test('rejects cumulative bytes before decoding and cancels the body', async () => {
    let cancelled = false;
    const response = chunkedResponse(['data: 123456789\n'], () => { cancelled = true; });
    await assert.rejects(
      collectSse(response, { maxBytes: 8, maxLines: 100, maxLineBytes: 100, maxBufferBytes: 100 }),
      (error: unknown) => error instanceof ProviderStreamLimitError && error.code === 'total-bytes',
    );
    assert.equal(cancelled, true);
  });

  test('does not wait for a hostile stream cancellation hook', async () => {
    let cancelCalled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('data: oversized\n')); },
      cancel() {
        cancelCalled = true;
        return new Promise<void>(() => undefined);
      },
    }));
    const outcome = await Promise.race([
      collectSse(response, { maxBytes: 4, maxLines: 100, maxLineBytes: 100, maxBufferBytes: 100 })
        .then(() => 'unexpected-success')
        .catch((error: unknown) => error),
      delay(250).then(() => 'timed-out'),
    ]);
    assert.ok(outcome instanceof ProviderStreamLimitError);
    assert.equal(outcome.code, 'total-bytes');
    assert.equal(cancelCalled, true);
  });

  test('rejects an oversized line across chunks and an oversized pending buffer', async () => {
    await assert.rejects(
      collectSse(chunkedResponse(['data: 12', '3456789']), {
        maxBytes: 100,
        maxLines: 100,
        maxLineBytes: 12,
        maxBufferBytes: 100,
      }),
      (error: unknown) => error instanceof ProviderStreamLimitError && error.code === 'line-bytes',
    );
    await assert.rejects(
      collectSse(chunkedResponse(['data: x']), {
        maxBytes: 100,
        maxLines: 100,
        maxLineBytes: 100,
        maxBufferBytes: 6,
      }),
      (error: unknown) => error instanceof ProviderStreamLimitError && error.code === 'buffer-bytes',
    );
  });

  test('rejects a tiny-line flood independently of its byte ceiling', async () => {
    await assert.rejects(
      collectSse(chunkedResponse(['\n\n\n\n\n']), {
        maxBytes: 100,
        maxLines: 4,
        maxLineBytes: 100,
        maxBufferBytes: 100,
      }),
      (error: unknown) => error instanceof ProviderStreamLimitError && error.code === 'lines',
    );
  });

  test('enforces the host deadline and preserves external cancellation', async () => {
    const deadline = createProviderRequestDeadline(undefined, 15);
    try {
      await Promise.race([
        new Promise<void>((resolve) => deadline.signal.addEventListener('abort', () => resolve(), { once: true })),
        delay(250).then(() => { throw new Error('deadline did not fire'); }),
      ]);
      assert.equal(deadline.signal.aborted, true);
      assert.ok(deadline.signal.reason instanceof ProviderDeadlineError);
    } finally {
      deadline.dispose();
    }

    const external = new AbortController();
    const composed = createProviderRequestDeadline(external.signal, 1_000);
    const reason = new Error('caller cancelled');
    try {
      external.abort(reason);
      assert.equal(composed.signal.aborted, true);
      assert.equal(composed.signal.reason, reason);
    } finally {
      composed.dispose();
    }
  });

  test('bounds error response reads and cancels the remainder', async () => {
    let sent = false;
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encoder.encode('x'.repeat(70 * 1024)));
        }
      },
      cancel() { cancelled = true; },
    }), { status: 500 });
    const body = await readErrorBody(response);
    assert.equal(body.length, 500);
    assert.equal(cancelled, true);
  });
});

describe('provider adapters cannot make malformed metering look free', () => {
  test('OpenAI-compatible usage is monotonic, atomic, and capped', async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"}}],"usage":null}',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
        'data: {"choices":[],"usage":{"prompt_tokens":6,"completion_tokens":-1}}',
        'data: [DONE]',
      ]),
      sseResponse([
        `data: {"choices":[],"usage":{"prompt_tokens":${MAX_PROVIDER_RECORDED_TOKENS + 1},"completion_tokens":2}}`,
        'data: [DONE]',
      ]),
      sseResponse([
        'data: {"choices":[],"usage":{"prompt_tokens":7,"input_tokens":6,"completion_tokens":2}}',
        'data: [DONE]',
      ]),
    ];
    const seenSignals: AbortSignal[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      assert.ok(init?.signal);
      seenSignals.push(init.signal);
      const response = responses.shift();
      assert.ok(response);
      return response;
    }) as typeof fetch;
    try {
      const provider = new OpenAICompatibleProvider(
        'compat', 'Compat', 'openai-compatible', 'https://example.invalid/v1', 'model', 'key',
      );
      const malformed = await provider.chat({ turns: [{ role: 'user', content: 'test' }] });
      assert.equal(malformed.usage.reportStatus, 'invalid');
      assert.equal(malformed.usage.promptTokens, 0);
      assert.equal(malformed.usage.completionTokens, 0);

      const capped = await provider.chat({ turns: [{ role: 'user', content: 'test' }] });
      assert.equal(capped.usage.reportStatus, 'capped');
      assert.equal(capped.usage.promptTokens, MAX_PROVIDER_RECORDED_TOKENS);

      const aliasConflict = await provider.chat({ turns: [{ role: 'user', content: 'test' }] });
      assert.equal(aliasConflict.usage.reportStatus, 'invalid');
      assert.equal(seenSignals.length, 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Anthropic usage requires numeric start/final reports and a terminal event', async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      sseResponse([
        'event: message_start',
        'data: {"message":{"usage":{"input_tokens":3,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}}}',
        '',
        'event: message_delta',
        'data: {"usage":{"output_tokens":4}}',
        '',
        'event: message_stop',
        'data: {}',
        '',
        'event: message_delta',
        'data: {"usage":{"output_tokens":-1}}',
        '',
      ]),
      sseResponse([
        'event: message_start',
        'data: {"message":{"usage":{"input_tokens":3,"cache_read_input_tokens":"2"}}}',
        '',
        'event: message_delta',
        'data: {"usage":{"output_tokens":4}}',
        '',
        'event: message_stop',
        'data: {}',
        '',
      ]),
      sseResponse([
        'event: message_start',
        'data: {"message":{"usage":{"input_tokens":3}}}',
        '',
        'event: message_delta',
        'data: {"usage":{"output_tokens":1}}',
        '',
      ]),
    ];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      assert.ok(init?.signal);
      const response = responses.shift();
      assert.ok(response);
      return response;
    }) as typeof fetch;
    try {
      const provider = new AnthropicProvider(
        'anthropic', 'Anthropic', 'anthropic', 'https://example.invalid', 'model', 'key',
      );
      const valid = await provider.chat({ turns: [{ role: 'user', content: 'test' }] });
      assert.equal(valid.usage.promptTokens, 6);
      assert.equal(valid.usage.completionTokens, 4);
      assert.equal(valid.usage.cachedPromptTokens, 2);
      assert.equal(valid.usage.cacheWritePromptTokens, 1);
      assert.equal(valid.usage.reportStatus, 'reported');

      const malformed = await provider.chat({ turns: [{ role: 'user', content: 'test' }] });
      assert.equal(malformed.usage.reportStatus, 'invalid');
      assert.equal(malformed.usage.promptTokens, 0);
      assert.equal(malformed.usage.completionTokens, 0);

      await assert.rejects(
        provider.chat({ turns: [{ role: 'user', content: 'test' }] }),
        /before message_stop/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Anthropic tool arguments follow content indexes, not tool ordinals', () => {
  const event = (type: string, fields: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n`;
  const start = (index: number, id: string, input: unknown = {}) => event('content_block_start', { index, content_block: { type: 'tool_use', id, name: 'read_file', input } });
  const delta = (index: number, partial_json: string) => event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json } });
  const stop = (index: number) => event('content_block_stop', { index });
  const end = event('message_stop');
  async function withStream(lines: string[], check: (p: AnthropicProvider) => Promise<void>) {
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => sseResponse(lines)) as typeof fetch;
    try { await check(new AnthropicProvider('fixture', 'fixture', 'anthropic', 'https://example.invalid', 'fixture', '')); }
    finally { globalThis.fetch = previous; }
  }
  test('text/thinking before tools and interleaved argument chunks retain the correct call IDs', async () => {
    await withStream([
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'checking' } }), stop(0),
      event('content_block_start', { index: 1, content_block: { type: 'thinking' } }), stop(1),
      start(2, 'a'), start(3, 'b'), delta(3, '{"path":"b"}'), delta(2, '{"path":'), delta(2, '"a"}'), stop(3), stop(2), end,
    ], async p => {
      const emitted: string[] = [];
      const result = await p.chat({ turns: [], onEvent: e => { if (e.type === 'tool') emitted.push(e.call.id); } });
      assert.equal(result.text, 'checking');
      assert.deepEqual(result.toolCalls.map(c => [c.id, JSON.parse(c.args)]), [['a', { path: 'a' }], ['b', { path: 'b' }]]);
      assert.deepEqual(emitted, ['a', 'b']);
    });
  });
  test('initial object input is retained when the complete block has no deltas', async () => {
    await withStream([start(1, 'a', { path: 'ready' }), stop(1), end], async p => {
      const result = await p.chat({ turns: [] }); assert.deepEqual(JSON.parse(result.toolCalls[0].args), { path: 'ready' });
    });
  });
  test('truncated, duplicate, late and invalid blocks never emit executable tools', async () => {
    const streams = [
      [start(0, 'a'), delta(0, '{'), stop(0), end],
      [start(0, 'a'), end],
      [start(0, 'a'), stop(0), delta(0, '{}'), end],
      [start(0, 'a'), start(1, 'a'), end],
      [start(0, 'a'), start(0, 'b'), end],
      [delta(0, '{}'), end],
      [start(0, 'a'), delta(0, '[]'), stop(0), end],
      [start(0, 'a'), stop(0), event('error', { error: { type: 'overloaded_error' } }), end],
      [start(0, 'a'), stop(0)],
      [start(0, 'a', null), stop(0), end],
      [start(0, 'a'), event('content_block_delta', { delta: { type: 'input_json_delta', partial_json: '{}' } }), stop(0), end],
      [start(0, 'a'), 'event: content_block_delta\ndata: {broken\n', stop(0), end],
    ];
    for (const lines of streams) await withStream(lines, async p => {
      const emitted: string[] = [];
      await assert.rejects(p.chat({ turns: [], onEvent: e => { if (e.type === 'tool') emitted.push(e.call.id); } }));
      assert.deepEqual(emitted, []);
    });
  });
});
