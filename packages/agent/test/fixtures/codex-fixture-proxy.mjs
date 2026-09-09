// Test only: real installed Codex, synthetic local HTTP provider, no account use.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const trace = value => { if (process.env.MRROBOT_FIXTURE_TRACE === '1') appendFileSync(join(process.env.CODEX_HOME, 'fixture-transport.jsonl'), JSON.stringify({ fixtureProcess: process.pid, ...value }) + '\n'); };
process.on('uncaughtException', error => { trace({ proxyError: error.message }); process.exit(1); });
const settings = {
  model_provider: 'fixture', 'model_providers.fixture.name': 'fixture',
  'model_providers.fixture.base_url': `http://127.0.0.1:${process.env.MRROBOT_FIXTURE_PORT}/v1`,
  'model_providers.fixture.wire_api': 'responses',
  'model_providers.fixture.requires_openai_auth': false,
};
const reorder = process.env.MRROBOT_FIXTURE_EARLY_LIFECYCLE !== '0';
const child = spawn(process.env.MRROBOT_FIXTURE_COMMAND, [...JSON.parse(process.env.MRROBOT_FIXTURE_PREFIX), ...process.argv.slice(2), ...Object.entries(settings).flatMap(([k, v]) => ['-c', `${k}=${JSON.stringify(v)}`])], { stdio: reorder ? ['pipe', 'pipe', 'pipe'] : 'inherit', windowsHide: true });
if (reorder) {
  child.stderr.on('data', chunk => {
    // Retain diagnostic categories only, never raw CLI stderr or local paths.
    trace({ stderrBytes: chunk.length, sqliteInitializationFailed: /failed to initialize (?:sqlite )?state runtime/.test(chunk.toString()) });
    process.stderr.write(chunk);
  });
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', () => {});
  createInterface({ input: child.stdout }).on('line', line => {
    const m = JSON.parse(line);
    trace({ method: m.method, id: m.id, hasThreadId: Boolean(m.params?.threadId ?? m.params?.thread?.id), threadReply: Boolean(m.result?.thread), turnReply: Boolean(m.result?.turn), rpcError: Boolean(m.error) });
    // Force lifecycle events before RPC acknowledgements, using IDs returned by
    // the real installed CLI. No account/model traffic: provider stays localhost.
    if (m.id !== undefined && m.result?.thread?.id) process.stdout.write(JSON.stringify({ method: 'thread/status/changed', params: { threadId: m.result.thread.id, status: { type: 'idle' } } }) + '\n');
    if (m.id !== undefined && m.result?.turn?.id) setTimeout(() => process.stdout.write(line + '\n'), 80);
    else process.stdout.write(line + '\n');
  });
}
child.on('error', () => process.exit(1));
child.on('close', (code, signal) => { trace({ childExit: code, signal }); process.exit(code ?? 1); });
