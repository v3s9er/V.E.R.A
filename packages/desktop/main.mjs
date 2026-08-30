/**
 * Mr.Robot desktop shell (Electron).
 *
 * Runs the agent server IN-PROCESS (the desktop app IS the agent), then shows
 * the web UI in a native window. Closing the window hides it to the tray —
 * the agent keeps running so phones can keep connecting.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, session, shell, Tray } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { appendFileSync, closeSync, copyFileSync, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const here = dirname(fileURLToPath(import.meta.url));
const bundledAgent = resolve(here, 'agent.mjs');
let AgentServer;
try {
  ({ AgentServer } = await import(existsSync(bundledAgent) ? pathToFileURL(bundledAgent).href : '@mr-robot/agent'));
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  appendStartupLog(message);
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
const activeDownloads = new Map();
const activeDownloadPaths = new Map();
let desktopPreferences = { openAtLogin: true, closeToTray: true };

function startupLogPath() {
  return resolve(app.getPath('temp'), 'mr-robot-startup-error.log');
}

function appendStartupLog(message) {
  try {
    const file = startupLogPath();
    if (existsSync(file) && statSync(file).size > 1024 * 1024) {
      const previous = `${file}.previous`;
      try { rmSync(previous, { force: true }); } catch { /* best effort */ }
      try { renameSync(file, previous); } catch { /* another process may hold it */ }
    }
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch { /* diagnostics must never prevent startup */ }
}

function registryFile() {
  return resolve(app.getPath('userData'), 'trusted-pcs.bin');
}

function registryBackupFile() {
  return `${registryFile()}.previous`;
}

function preferencesFile() {
  return resolve(app.getPath('userData'), 'desktop-preferences.json');
}

function loadDesktopPreferences() {
  try {
    const file = preferencesFile();
    if (!existsSync(file)) return { ...desktopPreferences };
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      openAtLogin: parsed?.openAtLogin !== false,
      closeToTray: parsed?.closeToTray !== false,
    };
  } catch (error) {
    appendStartupLog('failed to read desktop preferences: ' + (error instanceof Error ? error.message : String(error)));
    return { ...desktopPreferences };
  }
}

function saveDesktopPreferences() {
  const file = preferencesFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(desktopPreferences, null, 2), 'utf8');
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: desktopPreferences.openAtLogin, path: process.execPath });
}

function showMainWindow() {
  if (!win) return;
  win.show();
  win.focus();
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mr.Robot 열기', click: showMainWindow },
    { label: agentPort ? '로컬 에이전트 · ' + agentPort + ' 포트' : '로컬 에이전트 · 시작 중', enabled: false },
    { label: '원격 연결 설정', click: () => { showMainWindow(); win?.webContents.send('mr-robot:navigate', 'plugins'); } },
    { label: '실행 중 작업 모두 중지', click: () => {
      const count = server?.cancelAllRuns?.() ?? 0;
      tray?.displayBalloon?.({ title: 'Mr.Robot', content: count ? count + '개 작업에 중지 요청을 보냈습니다.' : '실행 중인 작업이 없습니다.' });
    } },
    { type: 'separator' },
    { label: 'Windows 시작 시 실행', type: 'checkbox', checked: desktopPreferences.openAtLogin, click: (item) => {
      desktopPreferences.openAtLogin = item.checked;
      saveDesktopPreferences();
      rebuildTrayMenu();
    } },
    { label: '창을 닫아도 백그라운드 실행', type: 'checkbox', checked: desktopPreferences.closeToTray, click: (item) => {
      desktopPreferences.closeToTray = item.checked;
      saveDesktopPreferences();
      rebuildTrayMenu();
    } },
    { type: 'separator' },
    { label: 'Mr.Robot 완전히 종료', click: () => void quit() },
  ]));
}

function sanitizePcRegistry(value) {
  if (!Array.isArray(value) || value.length > 100) throw new Error('PC 등록 정보가 올바르지 않습니다.');
  return value.map((entry) => ({
    id: String(entry?.id ?? '').slice(0, 160),
    name: String(entry?.name ?? '').slice(0, 160),
    host: String(entry?.host ?? '').slice(0, 512),
    hosts: Array.isArray(entry?.hosts) ? entry.hosts.map((item) => String(item).slice(0, 512)).slice(0, 16) : undefined,
    activeHost: entry?.activeHost ? String(entry.activeHost).slice(0, 512) : undefined,
    origins: Array.isArray(entry?.origins) ? entry.origins.map((item) => String(item).slice(0, 1024)).slice(0, 24) : undefined,
    activeOrigin: entry?.activeOrigin ? String(entry.activeOrigin).slice(0, 1024) : undefined,
    protocol: entry?.protocol === 'https' ? 'https' : 'http',
    port: Math.max(1, Math.min(65535, Number(entry?.port) || 8787)),
    secret: String(entry?.secret ?? '').slice(0, 4096),
    addedAt: Number(entry?.addedAt) || Date.now(),
  })).filter((entry) => entry.id && entry.host && entry.secret);
}

function readPcRegistryFile(file) {
  const value = JSON.parse(safeStorage.decryptString(readFileSync(file)));
  return sanitizePcRegistry(value);
}

function syncFile(file) {
  // FlushFileBuffers on Windows requires a handle opened with write access.
  // A read-only descriptor can fail with EPERM even for a file we just wrote.
  const fd = openSync(file, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function restorePcRegistryBackup(file, backup) {
  const temp = `${file}.restore-${process.pid}-${Date.now()}`;
  const corrupt = `${file}.corrupt-${process.pid}-${Date.now()}`;
  let movedCorrupt = false;
  try {
    copyFileSync(backup, temp);
    syncFile(temp);
    if (existsSync(file)) {
      renameSync(file, corrupt);
      movedCorrupt = true;
    }
    renameSync(temp, file);
    if (movedCorrupt) rmSync(corrupt, { force: true });
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    if (movedCorrupt && !existsSync(file) && existsSync(corrupt)) {
      try { renameSync(corrupt, file); } catch { /* backup remains authoritative */ }
    }
    throw error;
  }
}

function loadPcRegistry() {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'Windows 보안 저장소를 사용할 수 없습니다.' };
  }
  const file = registryFile();
  const backup = registryBackupFile();
  if (!existsSync(file) && !existsSync(backup)) return { ok: true, value: [] };
  try {
    if (!existsSync(file)) throw new Error('primary registry missing');
    return { ok: true, value: readPcRegistryFile(file) };
  } catch (primaryError) {
    appendStartupLog(`failed to read encrypted PC registry primary: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`);
    try {
      if (!existsSync(backup)) throw new Error('registry backup missing');
      const value = readPcRegistryFile(backup);
      restorePcRegistryBackup(file, backup);
      appendStartupLog('recovered encrypted PC registry from previous backup');
      return { ok: true, value, recovered: true };
    } catch (backupError) {
      appendStartupLog(`failed to recover encrypted PC registry backup: ${backupError instanceof Error ? backupError.message : String(backupError)}`);
      return { ok: false, error: '암호화된 PC 연결 정보를 읽지 못했습니다. 기존 정보는 덮어쓰지 않았습니다.' };
    }
  }
}

function savePcRegistry(value) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 보안 저장소를 사용할 수 없습니다.');
  const sanitized = sanitizePcRegistry(value);
  const file = registryFile();
  const backup = registryBackupFile();
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  let rotated = false;
  try {
    writeFileSync(temp, safeStorage.encryptString(JSON.stringify(sanitized)));
    syncFile(temp);
    if (existsSync(file)) {
      rmSync(backup, { force: true });
      renameSync(file, backup);
      rotated = true;
    }
    renameSync(temp, file);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    if (rotated && !existsSync(file) && existsSync(backup)) {
      try { renameSync(backup, file); } catch { /* load path can still recover from backup */ }
    }
    throw error;
  }
}

function icon() {
  return nativeImage.createFromBuffer(Buffer.from(ICON_B64, 'base64'));
}

function logStartup(error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  appendStartupLog(message);
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
    minWidth: 760,
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
      backgroundThrottling: true,
      preload: resolve(here, 'preload.cjs'),
    },
  });

  win.once('ready-to-show', () => win?.show());

  // Close hides to tray — the agent keeps serving the phone.
  win.on('close', (e) => {
    if (!quitting && desktopPreferences.closeToTray) {
      e.preventDefault();
      win?.hide();
    } else if (!quitting) {
      e.preventDefault();
      void quit();
    }
  });

  const localOrigin = new URL(url).origin;
  win.webContents.on('will-navigate', (event, nextUrl) => {
    try {
      if (new URL(nextUrl).origin !== localOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      const parsed = new URL(target);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(parsed.href);
    } catch { /* malformed or unsafe URL */ }
    return { action: 'deny' };
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    logStartup(`renderer exited: ${details.reason} (${details.exitCode})`);
  });

  void win.loadURL(url);
}

ipcMain.handle('mr-robot:choose-directory', async () => {
  const result = await dialog.showOpenDialog(win ?? undefined, { properties: ['openDirectory', 'createDirectory'], title: 'Mr.Robot 작업 폴더 선택' });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle('mr-robot:pcs.load', () => loadPcRegistry());
ipcMain.handle('mr-robot:pcs.save', (_event, value) => {
  savePcRegistry(value);
  return { ok: true };
});

ipcMain.handle('mr-robot:download', async (_event, input) => {
  const id = String(input?.id ?? '').slice(0, 120);
  const rawUrl = String(input?.url ?? '').slice(0, 4096);
  const token = String(input?.token ?? '').slice(0, 4096);
  const suggestedName = String(input?.suggestedName ?? 'download.bin')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .slice(0, 180) || 'download.bin';
  if (!id || activeDownloads.has(id)) throw new Error('다운로드 식별자가 올바르지 않습니다.');
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('다운로드 주소가 올바르지 않습니다.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('HTTP 또는 HTTPS 다운로드만 허용됩니다.');
  }
  const picked = await dialog.showSaveDialog(win ?? undefined, { title: 'Mr.Robot 파일 저장', defaultPath: suggestedName });
  if (picked.canceled || !picked.filePath) return { canceled: true };
  const destinationKey = resolve(picked.filePath).toLocaleLowerCase('en-US');
  if (activeDownloadPaths.has(destinationKey)) throw new Error('같은 위치로 다른 다운로드가 진행 중입니다. 완료하거나 중지한 뒤 다시 시도하세요.');
  const partialPath = resolve(dirname(picked.filePath), `.mr-robot-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.part`);
  const backupPath = `${partialPath}.previous`;
  let backedUpExisting = false;
  const controller = new AbortController();
  activeDownloads.set(id, controller);
  activeDownloadPaths.set(destinationKey, id);
  try {
    const response = await fetch(parsed.href, {
      headers: token ? { 'x-mr-robot-token': token } : undefined,
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`다운로드 실패 (HTTP ${response.status})`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partialPath, { flags: 'w' }), { signal: controller.signal });
    // Preserve an existing destination until the complete response has reached
    // disk. The Save dialog already owns the overwrite decision.
    if (existsSync(picked.filePath)) {
      rmSync(backupPath, { force: true });
      renameSync(picked.filePath, backupPath);
      backedUpExisting = true;
    }
    renameSync(partialPath, picked.filePath);
    if (backedUpExisting) rmSync(backupPath, { force: true });
    return { canceled: false, path: picked.filePath };
  } catch (error) {
    try { rmSync(partialPath, { force: true }); } catch { /* best effort partial-file cleanup */ }
    if (backedUpExisting && existsSync(backupPath) && !existsSync(picked.filePath)) {
      try { renameSync(backupPath, picked.filePath); } catch { /* keep backup beside destination */ }
    }
    if (controller.signal.aborted) throw new Error('다운로드를 중지했습니다.');
    throw error;
  } finally {
    activeDownloads.delete(id);
    if (activeDownloadPaths.get(destinationKey) === id) activeDownloadPaths.delete(destinationKey);
  }
});

ipcMain.handle('mr-robot:download.cancel', (_event, id) => {
  const controller = activeDownloads.get(String(id));
  controller?.abort();
  return { ok: Boolean(controller) };
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
  for (const controller of activeDownloads.values()) controller.abort();
  activeDownloads.clear();
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
      session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      desktopPreferences = loadDesktopPreferences();
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: desktopPreferences.openAtLogin, path: process.execPath });
      const port = await startAgent();
      createWindow(`http://127.0.0.1:${port}`);

      tray = new Tray(icon());
      tray.setToolTip('Mr.Robot — PC AI 에이전트 (실행 중)');
      rebuildTrayMenu();
      tray.on('click', showMainWindow);
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
