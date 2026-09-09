import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../../desktop/main.mjs', import.meta.url), 'utf8');
const body = source.match(/function showMainWindow\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(body);
for (const minimized of [true, false]) {
  const calls = [];
  const win = { isMinimized: () => minimized, restore: () => calls.push('restore'), show: () => calls.push('show'), focus: () => calls.push('focus') };
  runInNewContext(body + '\nshowMainWindow();', { win });
  assert.deepEqual(calls, minimized ? ['restore', 'show', 'focus'] : ['show', 'focus']);
}
runInNewContext(body + '\nshowMainWindow();', { win: null });
assert.ok(source.includes("app.on('second-instance', showMainWindow)"));
console.log('Desktop reopen: minimized windows restore before show/focus; tray and shortcut use the same path.');
