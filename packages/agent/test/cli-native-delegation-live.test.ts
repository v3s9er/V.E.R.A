// Opt-in account-backed smoke. This is NOT a benchmark, and is never enabled by
// normal test scripts. It uses only a newly created synthetic read-only folder.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pooledNativeCodex, closeNativeWorkers } from '../src/ai/cli-native-pool.js';
import { waitForCliRetirements } from '../src/ai/cli-process-retirement.js';
import { resolveCliInvocation, cliSubscriptionEnvironment } from '../src/ai/cli.js';
import { NATIVE_DELEGATION_GUIDANCE } from '../src/ai/native-delegation.js';
import type { NativeAgentRequest, NativeToolEvent } from '../src/ai/provider.js';

if (process.env.VERA_NATIVE_DELEGATION_LIVE !== '1') {
  console.log('SKIP: account-backed native delegation smoke requires VERA_NATIVE_DELEGATION_LIVE=1.');
} else {
  const directory = mkdtempSync(join(tmpdir(), 'vera-live-native-delegation-'));
  const controller = new AbortController();
  const cli = resolveCliInvocation('codex-cli', 'codex');
  const env = cliSubscriptionEnvironment('codex-cli');
  const wireTrace = join(directory, 'metadata-wire.jsonl');
  const diagnostic = process.env.VERA_NATIVE_DELEGATION_DIAGNOSTICS === '1';
  const invocation = diagnostic ? { command: process.execPath,
    prefixArgs: [fileURLToPath(new URL('./fixtures/native-delegation-wire-proxy.mjs', import.meta.url))] } : cli;
  if (diagnostic) Object.assign(env, { VERA_WIRE_COMMAND: cli.command, VERA_WIRE_PREFIX: JSON.stringify(cli.prefixArgs), VERA_WIRE_TRACE: wireTrace });
  const events: NativeToolEvent[] = [];
  writeFileSync(join(directory, 'helper.txt'), 'Synthetic fixture. Add only these two numbers: 17 and 25.\n', { flag: 'wx' });
  const input = 'This is a bounded native delegation integration test. Spawn exactly ONE built-in native helper with the same selected gpt-6-sol model and high effort (do not override model or effort). Ask only that helper to read helper.txt in the current synthetic workspace and return the sum of its two numbers. Do not read the file yourself, use host tools, access other files, or change anything. Wait for the helper to finish and verify its returned arithmetic, then output exactly NATIVE_DELEGATION_OK followed by a space and the sum. Do not spawn another helper.';
  const request: NativeAgentRequest = { prompt: input, cwd: directory, permissionMode: 'read-only', reasoningEffort: 'high', nativeDelegation: { maxAgents: 1 },
    signal: controller.signal, onTool: event => events.push(event),
    session: { key: 'synthetic-live-native-delegation', directory, history: [], input, instructions: NATIVE_DELEGATION_GUIDANCE,
      context: 'Selected model: gpt-6-sol. Selected reasoning effort: high. This task is a synthetic local transport integration check only.' } };
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const started = performance.now();
    const result = await pooledNativeCodex({ ...invocation, env, providerId: 'synthetic-live', model: 'gpt-6-sol', req: request });
    if (diagnostic) {
      const counts: Record<string, number> = {};
      for (const line of readFileSync(wireTrace, 'utf8').trim().split('\n')) {
        const key = JSON.stringify(JSON.parse(line)); counts[key] = (counts[key] ?? 0) + 1;
      }
      console.log(JSON.stringify({ metadataOnly: counts, publicToolEvents: events.map(e => ({ name: e.name, status: e.status })) }));
    }
    assert.equal(result.text.trim(), 'NATIVE_DELEGATION_OK 42');
    assert.equal(events.filter(event => event.name === 'native_agent_spawn' && event.status === 'done').length, 1, 'must actually use one native helper, not merely answer directly');
    assert.ok(events.some(event => event.name === 'native_agent_wait' && event.status === 'done'), 'must observe helper completion');
    assert.equal(result.usage.reportStatus, 'missing', 'parent counters cannot establish full child billing');
    console.log(JSON.stringify({ nativeDelegationLive: 'passed', model: 'gpt-6-sol', reasoningEffort: 'high', elapsedMs: Math.round(performance.now() - started),
      completedNativeSpawns: 1, parentReportedTokens: result.usage.promptTokens + result.usage.completionTokens, childUsageKnown: false, accountUsage: true }));
  } finally {
    clearTimeout(timeout); controller.abort(); closeNativeWorkers(); await waitForCliRetirements(env);
    const target = resolve(directory), parent = resolve(tmpdir()) + sep;
    assert.ok(target.startsWith(parent) && target.slice(parent.length).startsWith('vera-live-native-delegation-'));
    rmSync(target, { recursive: true, force: true });
  }
}
