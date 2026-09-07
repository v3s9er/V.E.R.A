import assert from 'node:assert/strict';
import { DiscordSandboxPool, reusableSandboxArgs, type DockerCommand } from '../src/server/discord-sandbox.js';
const id = 'sha256:' + 'a'.repeat(64);
const calls: string[][] = [];
let present = false, execGate: (() => void) | undefined;
const command: DockerCommand = async (args, input, signal) => {
  calls.push(args); signal?.throwIfAborted();
  if (args[0] === 'info') return { code: 0, output: 'linux' };
  if (args[0] === 'image') return { code: present ? 0 : 1, output: present ? id : 'not found' };
  if (args[0] === 'pull') { present = true; return { code: 0, output: '' }; }
  if (args[0] === 'exec') {
    assert.ok(args.includes('--user=65534:65534'));
    if (input === 'wait') await new Promise<void>((resolve, reject) => {
      execGate = resolve;
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    if (input === 'bad') return { code: 1, output: 'test error' };
    return { code: 0, output: args[4] };
  }
  return { code: 0, output: '' };
};
const pool = new DiscordSandboxPool(command, 40);
try {
  const first = await pool.execute('ticket-A', 'print(1)');
  assert.equal(await pool.execute('ticket-A', 'print(2)'), first, 'same ticket reuses container');
  const second = await pool.execute('ticket-B', 'print(1)');
  assert.notEqual(first, second, 'different tickets never share container');
  assert.equal(calls.filter(a => a[0] === 'pull').length, 1, 'one-time base image setup');
  assert.equal(calls.filter(a => a[0] === 'run').length, 2);
  for (const args of calls.filter(a => a[0] === 'run')) {
    assert.ok(args.includes(id));
    assert.ok(!args.includes('-v') && !args.some(a => a.startsWith('--mount') || a.startsWith('--privileged')));
    for (const flag of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=512m', '--user=65533:65533', '--entrypoint=/bin/sleep']) assert.ok(args.includes(flag));
    assert.equal(args.at(-1), '900', 'daemon-side watchdog independent of app timers');
  }
  await new Promise(r => setTimeout(r, 80));
  assert.ok(calls.some(a => a[0] === 'rm' && a[2] === first));
  assert.notEqual(await pool.execute('ticket-A', 'print(3)'), first, 'expired sandbox recreated');
  const abort = new AbortController();
  const waiting = pool.execute('ticket-A', 'wait', abort.signal);
  while (!execGate) await new Promise(r => setTimeout(r, 1));
  await assert.rejects(pool.execute('ticket-A', 'print(4)'), /실행 중/);
  abort.abort(); await assert.rejects(waiting, /aborted/);
  await assert.rejects(pool.execute('ticket-C', 'bad'), /test error/);
  assert.ok(calls.filter(a => a[0] === 'rm').length >= 6);
} finally { await pool.close(); }
await assert.rejects(pool.execute('ticket-A', 'print(1)'), /종료/);
const failed = new DiscordSandboxPool(async () => ({ code: 1, output: 'daemon unavailable' }));
try { await assert.rejects(failed.execute('ticket', 'print(1)'), /Docker Linux/); } finally { await failed.close(); }
assert.ok(reusableSandboxArgs('fixed', id).includes('--pull=never'));
console.log('Sandbox: one-time image preparation, immutable ID, per-ticket reuse, idle cleanup, concurrent denial, abort/failure cleanup, no host fallback passed.');
