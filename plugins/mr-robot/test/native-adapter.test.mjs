import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createPagePublisherPlugin } from '../index.mjs';

function harness() {
  const commands = new Map(), subscriptions = new Map(), timers = new Set(), launches = [];
  const storage = new Map();
  const ctx = {
    storage: { get: key => storage.get(key), set: (key, value) => storage.set(key, value) },
    registerCommand: (name, handler, opts) => commands.set(name, { handler, opts }),
    on: (event, fn) => subscriptions.set(event, fn),
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout: timer => { clearTimeout(timer); timers.delete(timer); },
  };
  const native = createPagePublisherPlugin({
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PROVIDER_SECRET: 'do-not-inherit' },
    spawn(command, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      child.kill = () => { if (!child.killed) { child.killed = true; queueMicrotask(() => child.emit('close', null)); } };
      launches.push({ command, args, options, child });
      return child;
    },
  });
  native.activate(ctx);
  const call = (name, params = {}, execution = {}) => commands.get(`page-publisher.${name}`).handler(params, execution);
  const toggle = enabled => subscriptions.get('plugins.changed')([{ id: 'page-publisher', enabled }]);
  return { native, commands, timers, launches, call, toggle };
}

test('attachment is OFF and starts no processes or timers', async () => {
  const h = harness();
  assert.equal(h.native.manifest.enabledByDefault, false);
  h.toggle(false);
  assert.equal(h.call('status').enabled, false);
  assert.equal(h.call('status').running, 0);
  await assert.rejects(h.call('list'), /꺼져/);
  assert.equal(h.launches.length, 0);
  assert.equal(h.timers.size, 0);
  for (const { opts } of h.commands.values()) assert.equal(opts.adminOnly, true);
  h.native.deactivate();
});

test('enabled jobs use separate arguments and a restricted environment', async () => {
  const h = harness(); h.toggle(true);
  const result = h.call('list');
  await new Promise(resolve => setImmediate(resolve));
  const launch = h.launches[0];
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.options.env.PROVIDER_SECRET, undefined);
  assert.equal(launch.options.env.PYTHONUTF8, '1');
  assert.deepEqual(launch.args.slice(-2), ['list', '--json']);
  launch.child.stdout.emit('data', '[]'); launch.child.emit('close', 0);
  assert.deepEqual(await result, []);
  assert.equal(h.call('status').running, 0);
  assert.equal(h.timers.size, 0);
  h.native.deactivate();
});

test('OFF cancels current and queued jobs, even after immediately re-enabling', async () => {
  const h = harness(); h.toggle(true);
  const first = h.call('list'); const second = h.call('list');
  const firstFailure = assert.rejects(first); const secondFailure = assert.rejects(second, /취소/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.launches.length, 1);
  h.toggle(false); h.toggle(true);
  await Promise.all([firstFailure, secondFailure]);
  assert.equal(h.launches[0].child.killed, true);
  assert.equal(h.launches.length, 1);
  assert.equal(h.timers.size, 0);
  h.native.deactivate();
});

test('disabling stops an active loopback preview', async () => {
  const h = harness(); h.toggle(true);
  const result = h.call('preview.start', { site: 'example' });
  const launch = h.launches[0];
  assert.deepEqual(launch.args.slice(-4), ['--host', '127.0.0.1', '--port', '0']);
  launch.child.stdout.emit('data', 'Previewing source at http://127.0.0.1:4173/\n');
  assert.deepEqual(await result, { url: 'http://127.0.0.1:4173/' });
  h.toggle(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launch.child.killed, true);
  assert.equal(h.call('status').previewUrl, null);
  assert.equal(h.call('status').running, 0);
  assert.equal(h.timers.size, 0);
  h.native.deactivate();
});

test('mutating page commands remain approval-gated and deletion requires confirmation', () => {
  const h = harness(); h.toggle(true);
  for (const name of ['save', 'delete', 'restore', 'restore-revision', 'build', 'preview.start']) {
    assert.equal(h.commands.get(`page-publisher.${name}`).opts.destructive, true);
  }
  assert.throws(() => h.call('delete', { site: 'example' }), /confirmed/);
  assert.throws(() => h.call('save', { site: 'example', source: 'relative-path' }), /absolute/);
  assert.equal(h.launches.length, 0);
  h.native.deactivate();
});
