import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { DesktopRuntime, desktopHelperPath } from '../src/computer/desktop-runtime.js';
import { DesktopCoordinator, desktopResult, validateDesktopInput, DESKTOP_TOOLS } from '../src/computer/desktop-session.js';
import { ToolExecutor } from '../src/ai/executor.js';

const fixture = fileURLToPath(new URL('./fixtures/desktop-runtime.mjs', import.meta.url));
const runtime = (timeoutMs = 1500) => new DesktopRuntime({ command: process.execPath, args: [fixture], timeoutMs, idleMs: 50 });
const ref = '12345678-1234-1234-1234-123456789abc';
test('desktop helper reuses process and preserves Unicode without command-line payloads', async () => {
  const r = runtime();
  try {
    const a = await r.request('owner', 'ok', { value: '한글 " $() ` 파일' });
    const b = await r.request('owner', 'ok', {});
    assert.equal(a.pid, b.pid); assert.equal(a.value, '한글 " $() ` 파일');
  } finally { r.dispose(); }
});
test('desktop helper rejects overlap, aborts active work and restarts after retirement', async () => {
  const r = runtime(); const abort = new AbortController();
  try {
    const pending = r.request('a', 'hang', {}, abort.signal);
    await assert.rejects(r.request('b', 'ok', {}), /진행 중/);
    abort.abort(); await assert.rejects(pending, /중지/);
    assert.equal((await r.request('a', 'ok', {})).value, '한글 ✓');
  } finally { r.dispose(); }
});
test('helper timeout, malformed correlation and crash fail closed without replay', async () => {
  for (const [command, expected] of [['hang', /시간이 초과/], ['wrong-id', /응답 검증/], ['exit', /종료/]] as const) {
    // Include cold process startup in the fixture budget. A 250ms deadline
    // intermittently rejected the healthy replacement on loaded Windows hosts.
    const r = runtime();
    try {
      const first = await r.request('a', 'ok', {});
      await assert.rejects(r.request('a', command, {}), expected);
      const replacement = await r.request('a', 'ok', {});
      assert.equal(replacement.owner, 'a');
      assert.notEqual(replacement.pid, first.pid, 'failed helper must retire before a new request');
    }
    finally { r.dispose(); }
  }
});
test('disposed runtime cannot respawn while retiring', async () => {
  const r = runtime(); await r.request('a', 'ok', {}); r.dispose();
  await assert.rejects(r.request('a', 'ok', {}), /종료/);
});
test('desktop lease spans calls, separates tickets and checks live authorization', async () => {
  let allowed = true;
  const coordinator = new DesktopCoordinator(runtime());
  const a = coordinator.create(() => { if (!allowed) throw Error('revoked'); });
  const b = coordinator.create(() => {}); const signal = new AbortController().signal;
  try {
    await a.execute('desktop_windows', {}, signal);
    await assert.rejects(b.execute('desktop_windows', {}, signal), /다른 대화/);
    allowed = false; await assert.rejects(a.execute('desktop_windows', {}, signal), /revoked/);
    a.dispose(); await b.execute('desktop_windows', {}, signal);
    await assert.rejects(a.execute('desktop_windows', {}, signal));
  } finally { a.dispose(); b.dispose(); coordinator.dispose(); }
});
test('desktop input rejects arbitrary command, invalid ref, extra fields and oversized input', () => {
  for (const [name, input] of [
    ['shell', {}], ['desktop_windows', { command: 'anything' }], ['desktop_observe', { window: '1234' }],
    ['desktop_observe', { window: ref, screenshot: 'false' }], ['desktop_act', { observation: ref, action: 'click', element: -1 }],
    ['desktop_act', { observation: ref, action: 'key', value: '\0' }], ['desktop_act', { observation: ref, action: 'set_value', element: 0, value: 'x'.repeat(8001) }],
    ['desktop_act', { observation: ref, action: 'click', x: 12 }],
    ['desktop_act', { observation: ref, action: 'click', x: 12, y: -1 }],
    ['desktop_act', { observation: ref, action: 'click', x: 12, y: 5, element: 1 }],
  ] as Array<[string, unknown]>) assert.throws(() => validateDesktopInput(name, input));
  assert.deepEqual(validateDesktopInput('desktop_observe', { window: ref, screenshot: true }), { window: ref, screenshot: true });
  assert.equal(DESKTOP_TOOLS.length, 4, 'small always-available native surface');
  assert.equal(validateDesktopInput('desktop_act', { observation: ref, action: 'click', x: 12, y: 5 }).x, 12);
});
test('image result is multimodal, not a fake capture boolean or base64 text blob', () => {
  const result = desktopResult({ tree: '[1] Button', image: 'data:image/png;base64,aGVsbG8=' });
  assert.equal(result.contentItems[0].type, 'inputText');
  assert.equal(result.contentItems[1].type, 'inputImage');
  assert.equal(JSON.stringify(result.contentItems[0]).includes('base64'), false);
  assert.throws(() => desktopResult({ image: 'https://untrusted.example/image.png' }));
  assert.throws(() => desktopResult({ image: 'data:image/png;base64,' + 'a'.repeat(1_400_000) }));
});
test('read-only/workspace/ask caps never gain desktop access through native tools', () => {
  let mode = 'full';
  const executor = new ToolExecutor({ computer: {} as any, safety: () => ({ mode } as any) });
  for (const cap of ['read-only', 'workspace', 'ask'] as const) assert.throws(() => executor.assertDesktopAuthority(cap), /접근/);
  executor.assertDesktopAuthority('full'); mode = 'read-only';
  assert.throws(() => executor.assertDesktopAuthority('full', true), /접근/);
});
test('backend source contracts cover bounded traversal, tokens, focus, identity and verified outcomes', () => {
  const source = readFileSync(desktopHelperPath(), 'utf8');
  for (const expected of ['DateTime.UtcNow>=expires', 'token=null; // Consume', 'c.BoundingRectangle!=r.Bounds', 'p.StartTime.ToUniversalTime().Ticks!=w.Start',
    'GetAncestor(WindowFromPoint(p),2)!=w.H', 'visited<400', 'timer.ElapsedMilliseconds<1500', 'CloseDesktop(h)', 'Value(r.E)==',
    'finally{foreach(var m in mods)', 'post_state_unavailable', 'hasPrivate||truncated']) assert.ok(source.includes(expected), expected);
  assert.equal(source.includes('Invoke-Expression'), false);
});
test('real installed Windows backend compiles and handshakes without inspecting any user UI', { skip: process.platform !== 'win32' }, async () => {
  const r = new DesktopRuntime();
  try {
    const start = performance.now(); const a = await r.request('compile-test', 'capabilities', {}); const coldMs = performance.now() - start;
    const warm = performance.now(); const b = await r.request('compile-test', 'capabilities', {});
    assert.equal(a.backend, 'windows-uia'); assert.equal(b.semantic, true);
    console.log(JSON.stringify({ backendHandshake: 'passed', coldMs: Math.round(coldMs), warmMs: Math.round(performance.now() - warm), userUiRead: false }));
  } finally { r.dispose(); }
});
