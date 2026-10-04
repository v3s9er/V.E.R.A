// Uses the staged application and real Electron, with temporary empty app data.
// No user conversations, credentials, Discord connection, or model calls.
import { _electron } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
config.updateSettings({
  network:{...config.settings.network,host:'127.0.0.1',port:0,externalAccess:false},
  // The first-run wizard may automatically install missing dependencies. This
  // window-recovery test must not install or update anything on the host.
  setup:{...config.settings.setup,dependencyWizardCompletedAt:Date.now(),dependencyWizardVersion:5},
});
const app = await _electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [join(root, 'packages/desktop/.stage'), `--user-data-dir=${join(privateTestDir, 'desktop')}`],
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')),
    MR_ROBOT_HOME: join(privateTestDir, 'agent') },
  timeout: 60_000,
});
try {
  assert.deepEqual(await app.evaluate(({app}) => ({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), agentHome: process.env.MR_ROBOT_HOME })), {
    userData: join(privateTestDir, 'desktop'), sessionData: join(privateTestDir, 'desktop'), agentHome: join(privateTestDir, 'agent'),
  }, 'The smoke test must not use the real desktop or agent profile');
  const page = await app.firstWindow();
  await page.locator('textarea').first().waitFor({state:'visible', timeout:60_000});
  await page.waitForFunction(() => document.querySelector('.conversation-item.active') && !document.querySelector('textarea')?.disabled && document.querySelector('.composer-model-controls'));
  const initialConversation = await page.evaluate(() => ({
    count: document.querySelectorAll('.conversation-item').length,
    title: document.querySelector('.conversation-item.active .conversation-title')?.textContent,
  }));
  assert.match(await page.title(), /PC AI/);
  if (process.platform === 'win32') {
    const chrome = await page.evaluate(() => ({
      enabled: document.documentElement.dataset.windowChrome,
      drag: getComputedStyle(document.querySelector('.desktop-drag-region')).getPropertyValue('-webkit-app-region'),
      inputTop: document.querySelector('textarea').getBoundingClientRect().top,
      inputBottom: document.querySelector('textarea').getBoundingClientRect().bottom,
      height: innerHeight,
      overlay: navigator.windowControlsOverlay?.visible,
      header: getComputedStyle(document.querySelector('.chat-commandbar')).backgroundColor,
    }));
    assert.equal(chrome.enabled, 'overlay');
    assert.equal(chrome.drag, 'drag');
    assert.equal(chrome.overlay, true, 'Native Windows caption buttons must remain visible');
    assert.equal(chrome.header, 'rgba(0, 0, 0, 0)', 'Production lazy CSS must not restore the detached header');
    assert.ok(chrome.inputTop >= 32 && chrome.inputBottom <= chrome.height);
    await page.screenshot({ path: join(privateTestDir, 'native-window.png') });
    console.log(`Native chrome screenshot: ${join(privateTestDir, 'native-window.png')}`);
    for (const [width, height] of [[992, 530], [1280, 800]]) {
      // Simulate a smaller monitor work area only inside this isolated Electron
      // process. Exercise the shipped display-change handler, not an OS resize
      // helper or a production source modification.
      const bounds = await app.evaluate(({BrowserWindow, screen}, size) => {
        const w = BrowserWindow.getAllWindows()[0];
        const display = screen.getDisplayMatching(w.getBounds());
        const original = screen.getDisplayMatching;
        const workArea = { ...display.workArea, width: size.width, height: size.height };
        try {
          screen.getDisplayMatching = () => ({ ...display, workArea });
          w.setBounds(workArea);
          screen.emit('display-metrics-changed', {}, []);
          return w.getBounds();
        } finally { screen.getDisplayMatching = original; }
      }, {width, height});
      // Windows' hidden native frame rounded the requested outer bounds by
      // 2 DIP in the live smoke. Keep that tolerance separate from strict
      // composer/overflow assertions against the actual viewport below.
      assert.ok(Math.abs(bounds.width - width) <= 4, `Unexpected native window width: ${bounds.width}`);
      assert.ok(Math.abs(bounds.height - height) <= 4, `Unexpected native window height: ${bounds.height}`);
      await page.waitForFunction(({width, height}) => innerWidth <= width + 4 && innerWidth >= width - 32 && innerHeight <= height + 4 && innerHeight >= height - 48, {width, height});
      const layout = await page.evaluate(() => {
        const composer = document.querySelector('.chat-inputbar').getBoundingClientRect();
        const textarea = document.querySelector('textarea');
        const input = textarea.getBoundingClientRect();
        return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
          composer: { top: composer.top, bottom: composer.bottom, left: composer.left, right: composer.right },
          input: { top: input.top, bottom: input.bottom, height: input.height },
          inputUncovered: document.elementFromPoint(input.x + input.width / 2, input.y + input.height / 2) === textarea,
          overlay: navigator.windowControlsOverlay?.visible,
          drag: getComputedStyle(document.querySelector('.desktop-drag-region')).getPropertyValue('-webkit-app-region') };
      });
      assert.equal(layout.overlay, true, 'Native caption controls must survive a display resize');
      assert.equal(layout.drag, 'drag');
      assert.ok(layout.composer.top >= 32 && layout.composer.bottom <= layout.height + 1, 'Whole composer must fit vertically');
      assert.ok(layout.composer.left >= 0 && layout.composer.right <= layout.width + 1, 'Whole composer must fit horizontally');
      assert.ok(layout.input.height > 0 && layout.input.top >= 32 && layout.input.bottom <= layout.height, 'Textarea must remain visible');
      assert.equal(layout.inputUncovered, true, 'A setup modal or overlay must not obscure the composer');
      assert.ok(layout.scrollWidth <= layout.width + 1, 'Resizing must not introduce page horizontal overflow');
      const screenshot = join(privateTestDir, `native-window-${width}x${height}.png`);
      await page.screenshot({path: screenshot});
      console.log(`PASS: simulated work area ${width}x${height}; viewport ${layout.width}x${layout.height}; composer + native overlay visible; screenshot ${screenshot}`);
    }
  }
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
  let restored;
  for (let i = 0; i < 60 && !restored?.ready; i++) {
    restored = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
      `({ ready: Boolean(document.querySelector('textarea')?.getBoundingClientRect().height > 0 && !document.querySelector('textarea').disabled && document.querySelector('.composer-model-controls') && document.querySelector('.conversation-item.active') && typeof window.mrRobotDesktop?.callLocalRpc === 'function'), count: document.querySelectorAll('.conversation-item').length, title: document.querySelector('.conversation-item.active .conversation-title')?.textContent })`,
    ));
    if (!restored.ready) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(restored?.ready, true, 'Recovered renderer must restore an enabled composer, model controls, selected conversation, and IPC bridge');
  assert.deepEqual({count: restored.count, title: restored.title}, initialConversation, 'Temporary conversation must survive renderer recovery');
  assert.equal(await app.evaluate(() => process.pid), pid, 'Agent process must not restart');
  const recoveredPng = await app.evaluate(async ({BrowserWindow}) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  writeFileSync(join(privateTestDir, 'native-window-recovered.png'), Buffer.from(recoveredPng, 'base64'));
  console.log(`Recovered renderer screenshot: ${join(privateTestDir, 'native-window-recovered.png')}`);
  console.log('PASS: staged native UI rendered, renderer crash recovered, conversation and enabled composer restored, agent PID preserved');
} finally {
  await app.close();
}
