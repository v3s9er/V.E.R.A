import test from 'node:test';
import assert from 'node:assert/strict';
import { browserInvocation, browserUrl } from '../src/computer/desktop-browser.js';
import { DesktopCoordinator, supportedDesktopKey, validateDesktopInput } from '../src/computer/desktop-session.js';

test('browser opener accepts only fixed browsers and separated http(s) URL argv', () => {
  const env = { ProgramFiles: 'C:/Fixture/Program Files' };
  const invocation = browserInvocation('edge', 'https://example.com/path?q=a&b=2', env, () => true);
  assert.match(invocation.command.replaceAll('\\', '/'), /Microsoft\/Edge\/Application\/msedge\.exe$/);
  assert.deepEqual(invocation.args, ['--new-window', 'https://example.com/path?q=a&b=2']);
  for (const url of ['file:///C:/private', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com\n--flag', 'https://example.com/"', '--new-window', 'ms-settings:']) assert.throws(() => browserUrl(url));
  assert.throws(() => browserInvocation('powershell', 'https://example.com', env, () => true));
  assert.throws(() => browserInvocation('chrome', 'https://example.com', env, () => false));
});

test('invalid keys are rejected before touching desktop focus or consuming the lease', () => {
  for (const key of ['Win', 'Meta+R', 'Ctrl+Win', 'Ctrl+Ctrl+A', 'PowerShell', 'Alt+F4']) assert.equal(supportedDesktopKey(key), false);
  for (const key of ['Enter', 'Ctrl+L', 'Ctrl+Shift+Z', 'Alt+Left', 'Ctrl+A']) assert.equal(supportedDesktopKey(key), true);
  assert.throws(() => validateDesktopInput('desktop_act', { action: 'key', observation: '12345678-1234-1234-1234-123456789abc', value: 'Win' }), /지원하지 않는 키/);
});

test('browser opening obeys live authority, cancellation and the shared desktop lease', async () => {
  let allowed = true, calls = 0;
  const coordinator = new DesktopCoordinator(undefined, async () => { calls++; return { action: { name: 'open_browser', verification: 'unverified' }, browser: 'edge', notice: 'fixture' }; });
  const first = coordinator.create(() => { if (!allowed) throw Error('revoked'); });
  const second = coordinator.create(() => {}), abort = new AbortController();
  const input = { browser: 'edge', url: 'https://example.com' };
  try {
    await first.execute('desktop_open_browser', input, abort.signal);
    await assert.rejects(second.execute('desktop_open_browser', input, abort.signal), /다른 대화/);
    allowed = false; await assert.rejects(first.execute('desktop_open_browser', input, abort.signal), /revoked/);
    first.dispose(); abort.abort(); await assert.rejects(second.execute('desktop_open_browser', input, abort.signal));
    assert.equal(calls, 1);
  } finally { first.dispose(); second.dispose(); coordinator.dispose(); }
});
