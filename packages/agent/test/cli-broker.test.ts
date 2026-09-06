import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { pooledCodexText, closeTextWorkers } from '../src/ai/cli-text-pool.js';
import type { BrokerAgentRequest } from '../src/ai/provider.js';
let toolCalls = 0;
const base: BrokerAgentRequest = { tools: [{ name: 'public_search', description: 'fixture', parameters: { type: 'object' } }], turns: [],
  executeTool: async (_n, _v, signal) => { signal.throwIfAborted(); toolCalls++; return 'evidence'; } };
const call = (mode: string, extra: Partial<BrokerAgentRequest> = {}) => pooledCodexText({ command: process.execPath, prefixArgs: [fileURLToPath(new URL('./fixtures/broker-app-server.mjs', import.meta.url))], env: process.env, model: 'fixture', providerId: 'fixture', req: { ...base, turns: [{ role: 'user', content: mode }], ...extra } });
try {
  const texts: string[] = [];
  assert.equal((await call('normal', { onEvent: e => { if (e.type === 'text') texts.push(e.text); } })).text, 'finished');
  assert.deepEqual(texts, ['finished'], 'streamed final not duplicated');
  for (const attack of ['native', 'forbidden', 'other-thread', 'other-turn', 'namespace']) await assert.rejects(call(attack), /격리|네이티브/);
  assert.equal(toolCalls, 1, 'invalid requests never reach broker');
  let cancelled = false;
  await assert.rejects(call('duplicate', { executeTool: (_n, _v, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')); }, { once: true });
  }) }), /검증/);
  assert.ok(cancelled, 'protocol denial cancels running broker tool');
  const controller = new AbortController();
  await assert.rejects(call('wait', { signal: controller.signal, executeTool: (_n, _v, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    controller.abort();
  }) }), /중지/);
  assert.equal((await call('normal')).text, 'finished', 'cancelled workers release slots');
  console.log('Native broker policy: allowlist, namespace/thread/turn binding, duplicate-call denial, cancellation propagation, streaming deduplication passed.');
} finally { closeTextWorkers(); }
