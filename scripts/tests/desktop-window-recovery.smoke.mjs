// Uses the staged application and real Electron, with temporary empty app data.
// No user conversations, credentials, Discord connection, or model calls.
import { _electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { ConfigStore } from '../../packages/agent/dist/config.js';

const privateTestDir = mkdtempSync(join(tmpdir(), 'mrrobot-ui-recovery-'));
const root = resolve(import.meta.dirname, '../..');
// A fresh data directory still defaults to 8787; never compete with the user's
// installed agent. Let the OS assign an isolated loopback port for this test.
const config = new ConfigStore(join(privateTestDir, 'agent'));
config.updateSettings({network:{...config.settings.network,host:'127.0.0.1',port:0,externalAccess:false}});
const app = await _electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [join(root, 'packages/desktop/.stage'), `--user-data-dir=${join(privateTestDir, 'desktop')}`],
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')),
    MR_ROBOT_HOME: join(privateTestDir, 'agent') },
  timeout: 60_000,
});
try {
  const page = await app.firstWindow();
  await page.locator('textarea').first().waitFor({state:'visible', timeout:60_000});
  assert.match(await page.title(), /PC AI/);
  const pid = await app.evaluate(() => process.pid);
  await app.evaluate(({BrowserWindow}) => {
    const w = BrowserWindow.getAllWindows()[0];
    globalThis.__recoveryObserved = new Promise(resolve => {
      w.webContents.once('render-process-gone', () => {
        w.webContents.once('did-finish-load', () => resolve(true));
      });
    });
    w.webContents.forcefullyCrashRenderer();
  });
  assert.equal(await Promise.race([
    app.evaluate(() => globalThis.__recoveryObserved),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Renderer recovery timed out')), 30_000).unref()),
  ]), true);
  // Playwright retains the old target's crashed flag even when Electron recovers
  // its WebContents. Inspect the replacement renderer through the main process.
  let rendered = false;
  for (let i = 0; i < 60 && !rendered; i++) {
    rendered = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
      `Boolean(document.querySelector('textarea')?.getBoundingClientRect().height > 0 && typeof window.mrRobotDesktop?.callLocalRpc === 'function')`,
    ));
    if (!rendered) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(rendered, true, 'Recovered renderer must display the composer and IPC bridge');
  assert.equal(await app.evaluate(() => process.pid), pid, 'Agent process must not restart');
  console.log('PASS: staged native UI rendered, renderer crash recovered, composer visible, agent PID preserved');
} finally {
  await app.close();
}
