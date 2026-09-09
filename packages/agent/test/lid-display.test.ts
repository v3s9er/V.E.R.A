import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createLidDisplayPlugin, lidDisplayHelperPath } from '../src/plugins/lid-display.js';

assert.ok(lidDisplayHelperPath().endsWith('bridge.ps1'));
const commands = new Map<string, Function>(), events = new Map<string, Function>(), timers = new Set<NodeJS.Timeout>();
let enabled = false, starts = 0, current: any, written = '', stopped = 0;
const runtime: any = { platform: 'win32', helper: () => lidDisplayHelperPath(), spawn: (command: string, args: string[], options: any) => {
  starts++; assert.match(command, /System32.*powershell.exe$/i);
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.ok(!args.includes('-Command') && !args.includes('-ExecutionPolicy'));
  const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { throw new Error('must restore gracefully'); } });
  proc.stdin.on('data', chunk => { written += chunk.toString(); });
  proc.stdin.on('finish', () => { stopped++; proc.emit('close', 0); });
  current = proc; return proc;
} };
const ctx: any = { emit() {}, registerCommand(name: string, fn: Function, opts: any) { assert.equal(opts.adminOnly, true); assert.equal(opts.tool, false); commands.set(name, fn); }, on(name: string, fn: Function) { events.set(name, fn); },
  setTimeout(fn: Function, ms: number) { const timer = setTimeout(() => fn(), ms); timers.add(timer); return timer; }, clearTimeout(timer: NodeJS.Timeout) { clearTimeout(timer); timers.delete(timer); } };
const plugin = createLidDisplayPlugin(() => enabled, runtime);
try {
  assert.equal(plugin.manifest.enabledByDefault, false);
  await plugin.activate!(ctx); events.get('plugins.changed')!(); assert.equal(starts, 0);
  enabled = true; events.get('plugins.changed')!(); assert.equal(starts, 1);
  current.stdout.write('{"state":"ready","detail":""}\n');
  assert.equal(commands.get('lid-display.status')!().state, 'ready');
  events.get('plugins.changed')!(); assert.equal(starts, 1, 'unrelated plugin changes do not duplicate watcher');
  commands.get('lid-display.restore')!(); assert.match(written, /restore\n/);
  enabled = false; events.get('plugins.changed')!(); await new Promise(r => setImmediate(r));
  assert.match(written, /stop\n/); assert.equal(stopped, 1); assert.equal(timers.size, 0);
  enabled = true; events.get('plugins.changed')!(); assert.equal(starts, 2);
  await plugin.deactivate!(ctx); assert.equal(stopped, 2); assert.equal(timers.size, 0);
} finally { for (const timer of timers) clearTimeout(timer); }
console.log('Lid plugin passed: opt-in, local-admin only, hidden fixed helper, no duplicate process, graceful shutdown and timer cleanup.');
