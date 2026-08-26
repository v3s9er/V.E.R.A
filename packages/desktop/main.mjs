/**
 * Mr.Robot desktop shell (Electron).
 *
 * Runs the agent server IN-PROCESS (the desktop app IS the agent), then shows
 * the web UI in a native window. Closing the window hides it to the tray —
 * the agent keeps running so phones can keep connecting.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { appendFileSync, existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const bundledAgent = resolve(here, 'agent.mjs');
let AgentServer;
try {
  ({ AgentServer } = await import(existsSync(bundledAgent) ? pathToFileURL(bundledAgent).href : '@mr-robot/agent'));
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  try { appendFileSync(resolve(app.getPath('temp'), 'mr-robot-startup-error.log'), `${new Date().toISOString()} ${message}\n`); } catch { /* best effort */ }
  throw error;
}

// 32x32 gradient logo (generated at build time).
const ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAOZSURBVFhHxdfbT1RHHAfwefTRP6FvtbFGYlODRqtGTWmtGgwaWTW7irDCZruAi+KVIcbiJdZFrAiiq5EQY2wLbQ0qWlPTaDXGC3iLN7xHk0YW9nIuc8756pzNbtgt3Zl90P0m87qfmTnn/H6/JSRDfBVanq/CcPm8JvX6+GLUU8Vo+WpGy2sYda9ltHQdo6UbGC3ZxOjyOo066zXq3KLRZVs1uqRBo44GxeXYoeWl//b/proMY/xu69fqchNVHhOVXhPf+0x4Kw14qg1U+A2UrzHgrmUoW89QupGhZDPDijodrnodzi06lm3VsbRBg2O7huKdGhbv0rDoRxVFAbW7sDGan24m419puFa7TeVD4AsDKor2qFiwV0Vhs9IwLYhRKXjNSmOV320hG7xmFwNtZljTxOTxfQrm71cwt0VtTuL82rM5eeCwgRv3LNx9bOFOf3z1PrLwUxeTwue1KviuLYY5B5Tp9gb8ZdZ5WfzUBdOGh+N3nli4/cTE7acmTl8zsDQggR+M4ZtDkX5S58QoWXxvu5ER5+vWMxMtPUyMB6MoOBIFqVql58vg/JnfeiDG7fXchKtVjH99NAri8xiVMvi6QPz0MnjfcxPrf9aF+Oz2CAgvMiKcf2qNHYY03vfCxJ5zuhCf1REBsSucAOff+eYW9h/8wSsL/W8sPHydivNFT2pCfOYxewOMinBeZEp+0JP4y38tGCZSYlnA65Bl470vTZR0qEJ8xvEICK/tIjxRZNrPGggrVqqclqhmobOXSeHTT4RB7MYigfMKF+xh6d6I6epjUvhXv/AN8K4mgfMKp8v5dhzHYkJ8amcYhLdUGbz2iJ5uZEz9n6oQn/JbGMTu5wKc1/Y2yetP5OhNXYhP/n0IxB4mBDhvLPR4djew86IqxCedHALhk4wI543F0aSmGxmz/I+YEM/vHgLhY5QITzSWU31GujNirrwypPCJp4dA4jOcGOeNZVGLgrfRzHUgrFlY2BmVwr/sGQSJD5BiPNFYig+rOHt/5JvgJ88G/+LcIAifXmXx4bXd06Wg6ZJmv+3NVzV4z8g98+H4hPODIPbonCUuU+Fk8Ly/BkGKt6m1ucLHXwiBLN6hFOQKH/d3CMS5G6NzhX9+MQR7Ki4KqP25wMf+E1LiG2hUCnKAY8zlt7XJPyeF+2LBj4l/dmXgUhLnmR8cGD2vVe3+WPin1wc+SdlAIt+2RVwFh6IDHwhXUq79fd4B90qNYqnHq5EAAAAASUVORK5CYII=';

let server = null;
let agentPort = 0;
let win = null;
let tray = null;
let quitting = false;
let stopped = false;

function icon() {
  return nativeImage.createFromBuffer(Buffer.from(ICON_B64, 'base64'));
}

function logStartup(error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  try { appendFileSync(resolve(app.getPath('temp'), 'mr-robot-startup-error.log'), `${new Date().toISOString()} ${message}\n`); } catch { /* best effort */ }
}

function webDir() {
  const packaged = resolve(here, 'web');
  const development = resolve(here, '..', 'web', 'dist');
  return existsSync(packaged) ? packaged : existsSync(development) ? development : undefined;
}

async function startAgent() {
  server = new AgentServer();
  const { port } = await server.start({ webDir: webDir() });
  agentPort = port;
  server.bus.on('voice.wake', (data) => {
    if (data?.kind !== 'pc') return;
    if (win) { win.show(); win.focus(); }
  });
  return port;
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    title: 'Mr.Robot',
    backgroundColor: '#0b0f1a',
    autoHideMenuBar: true,
    icon: icon(),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: resolve(here, 'preload.cjs'),
    },
  });

  win.once('ready-to-show', () => win?.show());

  // Close hides to tray — the agent keeps serving the phone.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  void win.loadURL(url);
}

ipcMain.handle('mr-robot:choose-directory', async () => {
  const result = await dialog.showOpenDialog(win ?? undefined, { properties: ['openDirectory', 'createDirectory'], title: 'Mr.Robot 작업 폴더 선택' });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

// The desktop renderer talks directly to the agent embedded in this process.
// It never needs pairing, a saved PC entry, LAN discovery, or a tunnel plugin.
ipcMain.handle('mr-robot:local-connection', () => {
  if (!server || !agentPort) throw new Error('로컬 에이전트가 아직 시작되지 않았습니다.');
  const info = server.pairingInfo(true);
  return {
    name: info.deviceName,
    host: '127.0.0.1',
    port: agentPort,
    secret: server.secret,
  };
});

async function quit() {
  quitting = true;
  try {
    if (server && !stopped) {
      stopped = true;
      await server.stop();
    }
  } catch (err) {
    console.error('shutdown error:', err);
  }
  app.quit();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  logStartup('single-instance lock is already held');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady()
    .then(async () => {
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
      const port = await startAgent();
      createWindow(`http://127.0.0.1:${port}`);

      tray = new Tray(icon());
      tray.setToolTip('Mr.Robot — PC AI 에이전트 (실행 중)');
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Mr.Robot 열기', click: () => win && (win.show(), win.focus()) },
          { type: 'separator' },
          { label: '종료', click: () => void quit() },
        ]),
      );
      tray.on('click', () => win && (win.show(), win.focus()));
    })
    .catch((err) => {
      logStartup(err);
      console.error('failed to start Mr.Robot:', err);
      app.quit();
    });

  // Keep running in the tray when the window closes.
  app.on('window-all-closed', () => {
    /* intentional no-op */
  });

  app.on('before-quit', (e) => {
    if (!stopped && server) {
      e.preventDefault();
      void quit();
    }
  });
}
