import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installWindowRecovery } from '../../packages/desktop/window-recovery.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(options = {}) {
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  window.webContents.getURL = () => window.url ?? '';
  window.webContents.isCrashed = () => false;
  window.isDestroyed = () => false;
  window.show = () => {};
  window.loads = [];
  window.loadURL = url => { window.loads.push(url); return Promise.resolve(); };
  const logs = [];
  const recovery = installWindowRecovery(window, {
    url: 'http://127.0.0.1:9876', log: code => logs.push(code),
    loadTimeoutMs: 1000, retryDelayMs: 2, stableMs: 1000, ...options,
  });
  return { window, recovery, logs };
}

test('renderer exit retries only the trusted local UI', async t => {
  const { window, recovery, logs } = fixture(); t.after(recovery.dispose);
  recovery.start(); window.url = 'http://127.0.0.1:9876/';
  window.webContents.emit('did-finish-load');
  window.webContents.emit('render-process-gone', {}, {reason: 'crashed'});
  await wait(15);
  assert.deepEqual(window.loads, ['http://127.0.0.1:9876/', 'http://127.0.0.1:9876/']);
  assert.deepEqual(logs, ['desktop-ui:renderer-exited']);
});

test('repeated crashes are bounded even after a successful document load', async t => {
  let prompts = 0;
  const { window, recovery } = fixture({onUnavailable: async () => { prompts++; return false; }});
  t.after(recovery.dispose); recovery.start();
  for (let i=0; i<4; i++) {
    window.webContents.emit('did-finish-load');
    window.webContents.emit('render-process-gone');
    await wait(10);
  }
  assert.equal(window.loads.length, 3);
  assert.ok(prompts >= 1);
});

test('load rejection and did-fail-load coalesce without leaking error data', async t => {
  const { window, recovery, logs } = fixture(); t.after(recovery.dispose);
  window.loadURL = url => { window.loads.push(url); return Promise.reject(Object.assign(new Error('secret URL'), {errno:-102})); };
  recovery.start();
  window.webContents.emit('did-fail-load', {}, -102, 'sensitive text', 'https://secret.invalid', true);
  // Drain loadURL's rejection, but do not race a real 1ms wait against the
  // intentionally separate 2ms retry (both can expire together under load).
  await Promise.resolve();
  assert.equal(window.loads.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0], 'desktop-ui:load-failed:-102');
});

test('subframe and cancelled navigation failures do not reload the page', async t => {
  const { window, recovery, logs } = fixture(); t.after(recovery.dispose); recovery.start();
  window.webContents.emit('did-fail-load', {}, -102, '', '', false);
  window.webContents.emit('did-fail-load', {}, -3, '', '', true);
  await wait(10); assert.equal(window.loads.length, 1); assert.equal(logs.length, 0);
});

test('hung load shows manual recovery after bounded retries', async t => {
  let prompts = 0;
  const { window, recovery } = fixture({loadTimeoutMs:5, onUnavailable:async () => { prompts++; return false; }});
  t.after(recovery.dispose); recovery.start(); await wait(100);
  assert.equal(window.loads.length, 3); assert.equal(prompts, 1);
  recovery.ensureVisible(); assert.equal(window.loads.length, 4);
});

test('manual retry is explicit; healthy reopens do not reload', async t => {
  const { window, recovery } = fixture({maxAutomaticRetries:0, onUnavailable:async () => true});
  t.after(recovery.dispose); recovery.start();
  window.webContents.emit('render-process-gone'); await wait(10);
  assert.equal(window.loads.length, 2);
  window.url = 'http://127.0.0.1:9876/'; window.webContents.emit('did-finish-load');
  recovery.ensureVisible(); assert.equal(window.loads.length, 2);
});

test('disposal and shutdown cancel retries and release event handlers', async () => {
  const { window, recovery } = fixture(); recovery.start();
  window.webContents.emit('render-process-gone'); recovery.dispose(); await wait(10);
  assert.equal(window.loads.length, 1); assert.equal(window.webContents.listenerCount('render-process-gone'), 0);
  const other = fixture({isQuitting: () => true}); other.recovery.start();
  other.window.webContents.emit('render-process-gone'); assert.equal(other.window.loads.length, 0); other.recovery.dispose();
});

test('recovery rejects external destinations', () => {
  assert.throws(() => fixture({url:'https://example.com'}), /embedded loopback/);
});
