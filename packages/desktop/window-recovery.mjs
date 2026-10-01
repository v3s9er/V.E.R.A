/** Recover the UI only: never restart the agent, erase storage, or relax its policy. */
export function installWindowRecovery(window, {
  url, log = () => {}, isQuitting = () => false, onUnavailable = async () => false,
  loadTimeoutMs = 20_000, retryDelayMs = 500, stableMs = 60_000, maxAutomaticRetries = 2,
}) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password) {
    throw new Error('Desktop recovery requires the embedded loopback origin');
  }
  let disposed = false;
  let loading = false;
  let failed = false;
  let prompting = false;
  let retries = 0;
  let generation = 0;
  let watchdog;
  let retryTimer;
  let stableTimer;
  const alive = () => !disposed && !isQuitting() && !window.isDestroyed();
  const clearTimers = () => {
    clearTimeout(watchdog); clearTimeout(retryTimer); clearTimeout(stableTimer);
    watchdog = retryTimer = stableTimer = undefined;
  };
  const start = () => {
    if (!alive()) return;
    clearTimers();
    const current = ++generation;
    loading = true;
    failed = false;
    watchdog = setTimeout(() => fail('load-timeout'), loadTimeoutMs);
    try {
      Promise.resolve(window.loadURL(target.href)).catch(error => {
        if (current === generation) fail(`load-rejected:${Number.isInteger(error?.errno) ? error.errno : 'unknown'}`);
      });
    } catch { fail('load-threw'); }
  };
  const fail = (reason) => {
    if (!alive() || retryTimer || prompting) return;
    ++generation; // Ignore rejection from an earlier navigation after a crash/retry.
    clearTimers();
    loading = false;
    failed = true;
    log(`desktop-ui:${reason}`); // Fixed codes only, no URLs, renderer text or credentials.
    if (retries < maxAutomaticRetries) {
      retries += 1;
      retryTimer = setTimeout(start, retryDelayMs);
      return;
    }
    prompting = true;
    window.show();
    Promise.resolve().then(onUnavailable).then(retry => {
      prompting = false;
      if (retry && alive()) { retries = 0; start(); }
    }, () => { prompting = false; });
  };
  const finished = () => {
    if (!alive()) return;
    ++generation;
    clearTimers();
    loading = false;
    failed = false;
    // Do not grant unlimited retries to a renderer that crashes just after each load.
    stableTimer = setTimeout(() => { retries = 0; }, stableMs);
  };
  const failedLoad = (_event, code, _description, _validatedUrl, isMainFrame) => {
    if (isMainFrame && code !== -3) fail(`load-failed:${Number.isInteger(code) ? code : 'unknown'}`);
  };
  const gone = () => fail('renderer-exited');
  const dispose = () => {
    disposed = true;
    ++generation;
    clearTimers();
    window.webContents.removeListener('did-finish-load', finished);
    window.webContents.removeListener('did-fail-load', failedLoad);
    window.webContents.removeListener('render-process-gone', gone);
    window.removeListener('closed', dispose);
  };
  window.webContents.on('did-finish-load', finished);
  window.webContents.on('did-fail-load', failedLoad);
  window.webContents.on('render-process-gone', gone);
  window.once('closed', dispose);
  return {
    start,
    ensureVisible() {
      if (alive() && !loading && !retryTimer && !prompting
          && (failed || window.webContents.isCrashed() || !window.webContents.getURL()
            || window.webContents.getURL() === 'about:blank')) {
        retries = 0;
        start();
      }
    },
    dispose,
  };
}
