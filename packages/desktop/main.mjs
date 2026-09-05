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
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { WebSocket as NativeWebSocket } from 'ws';
import { openTrustedNmapRouteWithHttpsFallback } from './nmap-route.mjs';
import { normalizeRemotePairOrigin, postPinnedRemotePairJson } from './remote-pair-security.mjs';

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

// The staged runtime, Windows executable, installer, Android package and web
// favicon all derive from the same canonical mobile brand asset.
const runtimeIconPath = existsSync(resolve(here, 'icon.png'))
  ? resolve(here, 'icon.png')
  : resolve(here, 'build', 'icon.png');

let server = null;
let agentPort = 0;
let win = null;
let tray = null;
let quitting = false;
let stopped = false;
const activeDownloads = new Map();
const activeDownloadPaths = new Map();
const MAX_DESKTOP_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_LOCAL_RPC_BYTES = 8 * 1024 * 1024;
const DESKTOP_LOCAL_AUTH_TOKEN = 'electron-main-process-managed-session';
const DESKTOP_REMOTE_AUTH_PREFIX = 'electron-main-process-pc:';
const DESKTOP_PENDING_AUTH_PREFIX = 'electron-main-process-pending:';
const pendingPcCredentials = new Map();
let localRpcSocket = null;
let localRpcGeneration = 0;
let localRpcRequestId = 1;
let localRpcAuthenticated = false;
const localRpcPending = new Map();
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

function isLoopbackHost(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  const octets = host.split('.').map(Number);
  return octets.length === 4
    && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && octets[0] === 127;
}

function normalizeTrustedPcOrigin(value) {
  const parsed = new URL(String(value ?? ''));
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) {
    throw new Error('PC 접속 주소가 안전한 origin이 아닙니다.');
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    throw new Error('평문 PC 접속 주소는 이 PC의 loopback만 허용됩니다. 원격 PC는 HTTPS로 다시 등록하세요.');
  }
  return parsed.origin;
}

function originFromRegistryParts(protocol, host, port) {
  const literal = String(host ?? '').trim().replace(/^\[|\]$/g, '');
  if (!literal || literal.length > 512 || /[\s/@?#]/.test(literal)) throw new Error('PC 호스트가 올바르지 않습니다.');
  const formatted = literal.includes(':') ? `[${literal}]` : literal;
  return normalizeTrustedPcOrigin(`${protocol}://${formatted}:${port}`);
}

function sanitizePcRegistry(value) {
  if (!Array.isArray(value) || value.length > 100) throw new Error('PC 등록 정보가 올바르지 않습니다.');
  const seen = new Set();
  return value.flatMap((entry) => {
    try {
      const id = String(entry?.id ?? '').trim().slice(0, 160);
      const name = String(entry?.name ?? '').trim().slice(0, 160) || '연결된 PC';
      const protocol = entry?.protocol === 'https' ? 'https' : 'http';
      const port = Math.max(1, Math.min(65535, Number(entry?.port) || 8787));
      const secret = String(entry?.secret ?? '').slice(0, 4096);
      const access = normalizeCloudflareAccessCredentials(entry?.accessClientId, entry?.accessClientSecret);
      const primary = originFromRegistryParts(protocol, entry?.host, port);
      if (!id || seen.has(id) || (secret.length < 32 && !desktopRemotePcId(secret) && !desktopPendingCredentialId(secret))) return [];
      seen.add(id);
      const candidates = [
        primary,
        entry?.activeOrigin,
        ...(Array.isArray(entry?.origins) ? entry.origins.slice(0, 24) : []),
        ...(Array.isArray(entry?.hosts) ? entry.hosts.slice(0, 16).map((item) => {
          const raw = String(item ?? '').trim();
          if (!raw) return undefined;
          return /^https?:\/\//i.test(raw) ? raw : originFromRegistryParts(protocol, raw, port);
        }) : []),
      ];
      const origins = [...new Set(candidates.filter(Boolean).flatMap((candidate) => {
        try { return [normalizeTrustedPcOrigin(candidate)]; } catch { return []; }
      }))];
      const requestedActive = entry?.activeOrigin ? (() => {
        try { return normalizeTrustedPcOrigin(entry.activeOrigin); } catch { return undefined; }
      })() : undefined;
      const activeOrigin = requestedActive && origins.includes(requestedActive) ? requestedActive : primary;
      const requestedCredentialOrigin = entry?.credentialOrigin ? (() => {
        try { return normalizeTrustedPcOrigin(entry.credentialOrigin); } catch { return undefined; }
      })() : undefined;
      const credentialOrigin = requestedCredentialOrigin && origins.includes(requestedCredentialOrigin)
        ? requestedCredentialOrigin
        : undefined;
      const requestedAccessOrigin = entry?.accessOrigin ?? entry?.cloudflareAccessOrigin;
      const accessOrigin = access && requestedAccessOrigin ? (() => {
        try {
          const normalized = normalizeTrustedPcOrigin(requestedAccessOrigin);
          return credentialOrigin && normalized === credentialOrigin && new URL(normalized).protocol === 'https:' ? normalized : undefined;
        } catch { return undefined; }
      })() : undefined;
      const primaryUrl = new URL(primary);
      const activeUrl = new URL(activeOrigin);
      return [{
        id,
        name,
        host: primaryUrl.hostname.replace(/^\[|\]$/g, ''),
        hosts: origins.map((origin) => new URL(origin).hostname.replace(/^\[|\]$/g, '')).slice(0, 16),
        activeHost: activeUrl.hostname.replace(/^\[|\]$/g, ''),
        origins,
        activeOrigin,
        protocol: primaryUrl.protocol === 'https:' ? 'https' : 'http',
        port: Number(primaryUrl.port || (primaryUrl.protocol === 'https:' ? 443 : 80)),
        secret,
        credentialOrigin,
        ...(access && accessOrigin ? {
          accessClientId: access.clientId,
          accessClientSecret: access.clientSecret,
          accessOrigin,
        } : {}),
        addedAt: Number(entry?.addedAt) || Date.now(),
      }];
    } catch {
      return [];
    }
  });
}

function assertTrustedRenderer(event) {
  const expected = agentPort ? `http://127.0.0.1:${agentPort}` : '';
  let actual = '';
  try { actual = new URL(event.senderFrame?.url ?? '').origin; } catch { /* reject below */ }
  if (!win || event.sender !== win.webContents || event.senderFrame?.parent || actual !== expected) {
    throw new Error('신뢰할 수 없는 화면의 데스크톱 요청을 차단했습니다.');
  }
}

function normalizeCloudflareAccessCredentials(clientId, clientSecret, optional = true) {
  const id = String(clientId ?? '').trim();
  const secret = String(clientSecret ?? '').trim();
  if (!id && !secret && optional) return null;
  if (!id || !secret || id.length < 20 || id.length > 512 || secret.length < 20 || secret.length > 512
    || !/^[A-Za-z0-9._~-]+$/.test(id) || !/^[A-Za-z0-9._~-]+$/.test(secret)) {
    throw new Error('Cloudflare Access Client ID와 Secret 형식이 올바르지 않습니다.');
  }
  return { clientId: id, clientSecret: secret };
}

function cloudflareAccessHeaders(credentials) {
  return credentials ? {
    'CF-Access-Client-Id': credentials.clientId,
    'CF-Access-Client-Secret': credentials.clientSecret,
  } : {};
}

function settleLocalRpc(error) {
  const pending = [...localRpcPending.values()];
  localRpcPending.clear();
  for (const entry of pending) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
}

function closeLocalRpc(notifyRenderer = false, reason = '로컬 에이전트 연결이 종료되었습니다.') {
  localRpcGeneration++;
  const socket = localRpcSocket;
  localRpcSocket = null;
  localRpcAuthenticated = false;
  settleLocalRpc(new Error(reason));
  try { socket?.close(); } catch { /* best effort */ }
  if (notifyRenderer && win && !win.isDestroyed()) win.webContents.send('mr-robot:local-rpc-close', reason);
}

function callLocalRpc(method, params, timeoutMs = 60_000, allowAuth = false) {
  const socket = localRpcSocket;
  if (!socket || socket.readyState !== 1) return Promise.reject(new Error('로컬 에이전트에 연결되어 있지 않습니다.'));
  const normalizedMethod = String(method ?? '');
  if (!normalizedMethod || normalizedMethod.length > 160 || (!allowAuth && normalizedMethod === 'auth')) {
    return Promise.reject(new Error('허용되지 않은 로컬 RPC 요청입니다.'));
  }
  const id = localRpcRequestId++;
  const payload = JSON.stringify({ id, method: normalizedMethod, params });
  if (Buffer.byteLength(payload, 'utf8') > MAX_LOCAL_RPC_BYTES) return Promise.reject(new Error('로컬 RPC 요청이 너무 큽니다.'));
  const boundedTimeout = Math.max(1_000, Math.min(15 * 60_000, Number(timeoutMs) || 60_000));
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      localRpcPending.delete(id);
      rejectPromise(new Error(`응답 시간 초과: ${normalizedMethod}`));
    }, boundedTimeout);
    localRpcPending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    try { socket.send(payload); }
    catch (error) {
      localRpcPending.delete(id);
      clearTimeout(timer);
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function desktopRemoteAuthToken(id) {
  return `${DESKTOP_REMOTE_AUTH_PREFIX}${id}`;
}

function desktopRemotePcId(value) {
  const token = String(value ?? '');
  const id = token.startsWith(DESKTOP_REMOTE_AUTH_PREFIX) ? token.slice(DESKTOP_REMOTE_AUTH_PREFIX.length) : '';
  return id && id.length <= 160 ? id : null;
}

function desktopPendingCredentialId(value) {
  const token = String(value ?? '');
  const id = token.startsWith(DESKTOP_PENDING_AUTH_PREFIX) ? token.slice(DESKTOP_PENDING_AUTH_PREFIX.length) : '';
  return /^[a-f\d-]{36}$/i.test(id) ? id : null;
}

function prunePendingPcCredentials() {
  const now = Date.now();
  for (const [id, entry] of pendingPcCredentials) if (entry.expiresAt <= now) pendingPcCredentials.delete(id);
  while (pendingPcCredentials.size > 16) pendingPcCredentials.delete(pendingPcCredentials.keys().next().value);
}

function redactPcRegistry(value) {
  return value.map((pc) => {
    const { accessClientId: _accessClientId, accessClientSecret: _accessClientSecret, accessOrigin: _accessOrigin, ...safe } = pc;
    return {
      ...safe,
      secret: desktopRemoteAuthToken(pc.id),
      hasAccessCredentials: Boolean(pc.accessClientId && pc.accessClientSecret),
      cloudflareAccessOrigin: pc.accessOrigin,
    };
  });
}

async function connectLocalRpc(input) {
  if (!server || !agentPort) throw new Error('로컬 에이전트가 아직 시작되지 않았습니다.');
  const requestedUrl = String(input?.url ?? `ws://127.0.0.1:${agentPort}/ws`).slice(0, 4096);
  let parsedUrl;
  try { parsedUrl = new URL(requestedUrl); } catch { throw new Error('RPC 접속 주소가 올바르지 않습니다.'); }
  if (!['ws:', 'wss:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password
    || parsedUrl.pathname !== '/ws' || parsedUrl.search || parsedUrl.hash) {
    throw new Error('RPC 접속 주소가 안전하지 않습니다.');
  }
  const origin = `${parsedUrl.protocol === 'wss:' ? 'https:' : 'http:'}//${parsedUrl.host}`;
  const credentialReference = String(input?.credentialRef ?? DESKTOP_LOCAL_AUTH_TOKEN);
  const credential = resolveDesktopCredential(credentialReference, origin);
  if (!credential) throw new Error('암호화된 PC 자격증명 참조가 올바르지 않습니다.');
  const edgeCredentials = resolveDesktopAccessCredentials(credentialReference, origin);
  const edgeHeaders = cloudflareAccessHeaders(edgeCredentials);
  let protocols;
  if (parsedUrl.protocol === 'wss:') {
    const ticketResponse = await fetch(new URL('/api/ws-ticket', origin), {
      method: 'POST',
      headers: { ...edgeHeaders, 'x-mr-robot-token': credential, accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
    });
    if (!ticketResponse.ok) throw new Error(`WebSocket 보안 티켓 발급 실패 (HTTP ${ticketResponse.status})`);
    const ticket = await ticketResponse.json();
    if (typeof ticket?.protocol !== 'string' || !/^mr-robot-ticket\.[A-Za-z0-9_-]{43}$/.test(ticket.protocol)
      || !Number.isFinite(ticket.expiresAt) || ticket.expiresAt <= Date.now()) {
      throw new Error('WebSocket 보안 티켓 응답이 올바르지 않습니다.');
    }
    protocols = ['mr-robot-rpc-v1', ticket.protocol];
  }
  closeLocalRpc(false, 'PC 에이전트에 다시 연결합니다.');
  const generation = ++localRpcGeneration;
  const socket = new NativeWebSocket(parsedUrl.href, protocols ?? [], {
    headers: parsedUrl.protocol === 'wss:' ? edgeHeaders : undefined,
  });
  localRpcSocket = socket;
  socket.onmessage = (event) => {
    if (generation !== localRpcGeneration || socket !== localRpcSocket) return;
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message?.id === 0 && typeof message.event === 'string') {
      if (win && !win.isDestroyed()) win.webContents.send('mr-robot:local-rpc-event', { event: message.event, data: message.data });
      return;
    }
    const pending = localRpcPending.get(message?.id);
    if (!pending) return;
    localRpcPending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(String(message?.error?.message ?? '로컬 RPC 요청이 실패했습니다.')));
  };
  socket.onclose = () => {
    if (generation !== localRpcGeneration || socket !== localRpcSocket) return;
    closeLocalRpc(true);
  };
  socket.onerror = () => { /* onclose performs one fail-closed cleanup */ };
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('로컬 에이전트 연결 시간 초과')), 8_000);
      socket.onopen = () => { clearTimeout(timer); resolvePromise(); };
      socket.addEventListener('close', () => { clearTimeout(timer); rejectPromise(new Error('로컬 에이전트 연결이 닫혔습니다.')); }, { once: true });
    });
  } catch (error) {
    if (generation === localRpcGeneration && socket === localRpcSocket) closeLocalRpc(false, '로컬 에이전트 연결에 실패했습니다.');
    throw error;
  }
  if (generation !== localRpcGeneration || socket !== localRpcSocket) throw new Error('로컬 에이전트 연결이 취소되었습니다.');
  const auth = await callLocalRpc('auth', { secret: credential }, 8_000, true);
  const localCredential = credentialReference === DESKTOP_LOCAL_AUTH_TOKEN;
  if (!auth?.ok || (localCredential && auth.isAdmin !== true)) {
    closeLocalRpc(false, 'PC 인증에 실패했습니다.');
    throw new Error('PC 인증에 실패했습니다.');
  }
  localRpcAuthenticated = true;
  return { ok: true, isAdmin: auth.isAdmin === true, permissionCap: auth.permissionCap ?? 'read-only' };
}

function createDownloadLimitStream(maxBytes) {
  let received = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) callback(new Error('다운로드는 최대 2GB까지 허용됩니다.'));
      else callback(null, chunk);
    },
  });
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
  const incoming = sanitizePcRegistry(value);
  const existingResult = loadPcRegistry();
  const existing = existingResult.ok ? existingResult.value : [];
  const consumedPending = [];
  const sanitized = incoming.map((pc) => {
    const pendingId = desktopPendingCredentialId(pc.secret);
    if (pendingId) {
      prunePendingPcCredentials();
      const pending = pendingPcCredentials.get(pendingId);
      if (!pending || !pc.origins.includes(pending.origin)) throw new Error('PC 연결 자격증명이 만료되었거나 주소가 일치하지 않습니다.');
      consumedPending.push(pendingId);
      return {
        ...pc,
        host: new URL(pending.origin).hostname.replace(/^\[|\]$/g, ''),
        hosts: [new URL(pending.origin).hostname.replace(/^\[|\]$/g, '')],
        origins: [pending.origin],
        activeHost: new URL(pending.origin).hostname.replace(/^\[|\]$/g, ''),
        activeOrigin: pending.origin,
        protocol: 'https',
        port: 443,
        secret: pending.secret,
        credentialOrigin: pending.origin,
        ...(pending.edgeCredentials ? {
          accessClientId: pending.edgeCredentials.clientId,
          accessClientSecret: pending.edgeCredentials.clientSecret,
          accessOrigin: pending.accessOrigin,
        } : {}),
      };
    }
    const referencedId = desktopRemotePcId(pc.secret);
    if (!referencedId) return pc;
    const stored = existing.find((item) => item.id === referencedId && item.id === pc.id);
    if (!stored) throw new Error('암호화된 PC 자격증명 참조가 만료되었거나 올바르지 않습니다.');
    return {
      ...stored,
      name: pc.name,
      activeOrigin: pc.activeOrigin && stored.origins.includes(pc.activeOrigin) ? pc.activeOrigin : stored.activeOrigin,
      activeHost: pc.activeOrigin && stored.origins.includes(pc.activeOrigin)
        ? new URL(pc.activeOrigin).hostname.replace(/^\[|\]$/g, '')
        : stored.activeHost,
    };
  });
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
    for (const id of consumedPending) pendingPcCredentials.delete(id);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    if (rotated && !existsSync(file) && existsSync(backup)) {
      try { renameSync(backup, file); } catch { /* load path can still recover from backup */ }
    }
    throw error;
  }
}

function resolveDesktopCredential(reference, origin) {
  if (reference === DESKTOP_LOCAL_AUTH_TOKEN) {
    if (origin !== `http://127.0.0.1:${agentPort}` || !server) throw new Error('로컬 자격증명 범위를 벗어났습니다.');
    return server.secret;
  }
  const id = desktopRemotePcId(reference);
  if (!id) return null;
  const registry = loadPcRegistry();
  if (!registry.ok) throw new Error(registry.error);
  const pc = registry.value.find((item) => item.id === id && item.credentialOrigin === origin);
  if (!pc) throw new Error('암호화된 PC 자격증명과 요청 주소가 일치하지 않습니다.');
  return pc.secret;
}

function resolveDesktopAccessCredentials(reference, origin) {
  if (reference === DESKTOP_LOCAL_AUTH_TOKEN) return null;
  const id = desktopRemotePcId(reference);
  if (!id) return null;
  const registry = loadPcRegistry();
  if (!registry.ok) throw new Error(registry.error);
  const pc = registry.value.find((item) => item.id === id && item.credentialOrigin === origin);
  if (!pc) throw new Error('암호화된 PC 자격증명과 요청 주소가 일치하지 않습니다.');
  if (!pc.accessOrigin || pc.accessOrigin !== origin) return null;
  return normalizeCloudflareAccessCredentials(pc.accessClientId, pc.accessClientSecret);
}

async function boundedResponseText(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('PC 연결 응답이 너무 큽니다.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    try { await reader.cancel(); } catch { /* stream already closed */ }
  }
}

async function pairRemotePc(input) {
  const origin = normalizeRemotePairOrigin(String(input?.origin ?? ''));
  const pin = String(input?.pin ?? '').trim();
  if (!/^(?:\d{6}|\d{12})$/.test(pin)) throw new Error('연결 PIN 형식이 올바르지 않습니다.');
  const deviceName = String(input?.deviceName ?? 'Mr.Robot 데스크톱').trim().slice(0, 160) || 'Mr.Robot 데스크톱';
  const permissionCap = input?.permissionCap === 'read-only' ? 'read-only' : 'ask';
  const edgeCredentials = normalizeCloudflareAccessCredentials(input?.accessClientId, input?.accessClientSecret);
  const response = await postPinnedRemotePairJson(
    origin,
    { pin, deviceName, permissionCap },
    cloudflareAccessHeaders(edgeCredentials),
    { timeoutMs: 10_000, maxResponseBytes: 64 * 1024 },
  );
  {
    const bodyText = response.bodyText;
    let body;
    try { body = JSON.parse(bodyText); } catch { body = {}; }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(String(body?.error ?? `PIN 교환 실패 (HTTP ${response.statusCode})`));
    }
    const secret = String(body?.secret ?? '');
    if (secret.length < 32 || secret.length > 4096) throw new Error('PC 연결 자격증명 응답이 올바르지 않습니다.');
    prunePendingPcCredentials();
    const id = randomUUID();
    pendingPcCredentials.set(id, {
      secret,
      origin,
      edgeCredentials,
      accessOrigin: edgeCredentials ? origin : undefined,
      expiresAt: Date.now() + 2 * 60_000,
    });
    return { credentialRef: `${DESKTOP_PENDING_AUTH_PREFIX}${id}` };
  }
}

function icon() {
  const image = nativeImage.createFromPath(runtimeIconPath);
  if (image.isEmpty()) throw new Error(`Mr.Robot icon could not be loaded: ${runtimeIconPath}`);
  return image;
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

  // Renderer HTTP requests receive administrator authorization only after they
  // enter Chromium's network boundary. JavaScript never receives the global
  // secret, while the exact embedded loopback API remains fully functional.
  const localOrigin = new URL(url).origin;
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    if (server && win && details.webContentsId === win.webContents.id) {
      const parsed = new URL(details.url);
      const tokenHeader = Object.keys(headers).find((key) => key.toLowerCase() === 'x-mr-robot-token');
      const reference = tokenHeader ? headers[tokenHeader] : '';
      // Chromium may carry custom headers into a redirected request. Remove
      // every renderer-supplied or previously injected credential first, then
      // re-add secrets only when the new request still matches the exact
      // registered Mr.Robot API origin. This makes cross-origin redirects
      // fail closed instead of forwarding either credential layer.
      const sensitiveHeaders = new Set([
        'x-mr-robot-token',
        'cf-access-client-id',
        'cf-access-client-secret',
      ]);
      for (const key of Object.keys(headers)) {
        if (sensitiveHeaders.has(key.toLowerCase())) delete headers[key];
      }
      if (parsed.pathname.startsWith('/api/') && (reference === DESKTOP_LOCAL_AUTH_TOKEN || desktopRemotePcId(reference))) {
        try {
          const credential = resolveDesktopCredential(reference, parsed.origin);
          if (credential) headers['x-mr-robot-token'] = credential;
          const edgeCredentials = resolveDesktopAccessCredentials(reference, parsed.origin);
          if (edgeCredentials) {
            headers['CF-Access-Client-Id'] = edgeCredentials.clientId;
            headers['CF-Access-Client-Secret'] = edgeCredentials.clientSecret;
          }
        } catch {
          // Fail closed without forwarding even the opaque registry reference.
        }
      }
    }
    callback({ requestHeaders: headers });
  });

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

  win.webContents.on('will-navigate', (event, nextUrl) => {
    try {
      if (new URL(nextUrl).origin !== localOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      if (typeof target !== 'string' || target.length > 2_048 || /[\u0000-\u001f\u007f]/.test(target)) return { action: 'deny' };
      const parsed = new URL(target);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(parsed.href).catch(() => {});
      else {
        void openTrustedNmapRouteWithHttpsFallback(target, (externalUrl) => shell.openExternal(externalUrl));
      }
    } catch { /* malformed or unsafe URL */ }
    return { action: 'deny' };
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    closeLocalRpc(false, '렌더러가 종료되었습니다.');
    logStartup(`renderer exited: ${details.reason} (${details.exitCode})`);
  });
  win.webContents.on('destroyed', () => closeLocalRpc(false, '렌더러가 종료되었습니다.'));

  void win.loadURL(url);
}

ipcMain.handle('mr-robot:choose-directory', async (event) => {
  assertTrustedRenderer(event);
  const result = await dialog.showOpenDialog(win ?? undefined, { properties: ['openDirectory', 'createDirectory'], title: 'Mr.Robot 작업 폴더 선택' });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle('mr-robot:choose-calendar-workbook', async (event) => {
  assertTrustedRenderer(event);
  const result = await dialog.showOpenDialog(win ?? undefined, {
    properties: ['openFile'],
    title: '암호화해 가져올 근무 일정 선택',
    filters: [{ name: 'Excel 통합 문서', extensions: ['xlsx'] }],
  });
  if (result.canceled) return null;
  const selected = result.filePaths[0];
  if (!selected || !selected.toLowerCase().endsWith('.xlsx')) throw new Error('매크로 없는 .xlsx 파일만 가져올 수 있습니다.');
  if (statSync(selected).size > 25 * 1024 * 1024) throw new Error('근무 일정 파일은 최대 25MB까지 가져올 수 있습니다.');
  return selected;
});

ipcMain.handle('mr-robot:pcs.load', (event) => {
  assertTrustedRenderer(event);
  const loaded = loadPcRegistry();
  return loaded.ok ? { ...loaded, value: redactPcRegistry(loaded.value) } : loaded;
});
ipcMain.handle('mr-robot:pcs.save', (event, value) => {
  assertTrustedRenderer(event);
  savePcRegistry(value);
  return { ok: true };
});
ipcMain.handle('mr-robot:pcs.pair', async (event, input) => {
  assertTrustedRenderer(event);
  return pairRemotePc(input);
});

ipcMain.handle('mr-robot:download', async (event, input) => {
  assertTrustedRenderer(event);
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
  const effectiveToken = resolveDesktopCredential(token, parsed.origin);
  if (!effectiveToken) throw new Error('등록된 PC 주소와 자격증명이 일치하지 않아 다운로드를 차단했습니다.');
  const edgeCredentials = resolveDesktopAccessCredentials(token, parsed.origin);
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
      headers: { ...cloudflareAccessHeaders(edgeCredentials), 'x-mr-robot-token': effectiveToken },
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok || !response.body) throw new Error(`다운로드 실패 (HTTP ${response.status})`);
    const advertised = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(advertised) && advertised > MAX_DESKTOP_DOWNLOAD_BYTES) throw new Error('다운로드는 최대 2GB까지 허용됩니다.');
    await pipeline(Readable.fromWeb(response.body), createDownloadLimitStream(MAX_DESKTOP_DOWNLOAD_BYTES), createWriteStream(partialPath, { flags: 'w' }), { signal: controller.signal });
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

ipcMain.handle('mr-robot:download.cancel', (event, id) => {
  assertTrustedRenderer(event);
  const controller = activeDownloads.get(String(id));
  controller?.abort();
  return { ok: Boolean(controller) };
});

// The desktop renderer receives only non-sensitive loopback coordinates. The
// main process owns its authenticated RPC transport and HTTP authorization.
ipcMain.handle('mr-robot:local-connection', (event) => {
  assertTrustedRenderer(event);
  if (!server || !agentPort) throw new Error('로컬 에이전트가 아직 시작되지 않았습니다.');
  const info = server.pairingInfo(false);
  return {
    name: info.deviceName,
    host: '127.0.0.1',
    port: agentPort,
    auth: DESKTOP_LOCAL_AUTH_TOKEN,
  };
});

ipcMain.handle('mr-robot:local-rpc.connect', async (event, input) => {
  assertTrustedRenderer(event);
  return connectLocalRpc(input);
});
ipcMain.handle('mr-robot:local-rpc.call', async (event, method, params, timeoutMs) => {
  assertTrustedRenderer(event);
  if (!localRpcAuthenticated) throw new Error('로컬 관리자 세션이 인증되지 않았습니다.');
  const normalizedMethod = String(method ?? '');
  const result = await callLocalRpc(normalizedMethod, params, timeoutMs);
  // Rotation changes the main-process credential in place. The renderer only
  // needs acknowledgement/PIN refresh and must never receive the new bearer.
  if (normalizedMethod === 'pairing.regenerate' && result && typeof result === 'object') {
    const { secret: _discarded, ...safeResult } = result;
    return safeResult;
  }
  return result;
});
ipcMain.on('mr-robot:local-rpc.close', (event) => {
  assertTrustedRenderer(event);
  closeLocalRpc(false, '화면에서 로컬 연결을 종료했습니다.');
});

async function quit() {
  quitting = true;
  closeLocalRpc(false, 'Mr.Robot을 종료합니다.');
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
