// Manual acceptance fixture. Controls ONLY its own synthetic window; no user data.
const { app, BrowserWindow, ipcMain } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const http = require('node:http');
app.commandLine.appendSwitch('force-renderer-accessibility');
let window, runtime, browserServer;
app.whenReady().then(async () => {
  const { DesktopRuntime } = await import(pathToFileURL(path.resolve(__dirname, '../../dist/computer/desktop-runtime.js')).href);
  runtime = new DesktopRuntime();
  window = new BrowserWindow({ width: 700, height: 560, title: 'MrRobot Desktop Test Fixture', webPreferences: { nodeIntegration: true, contextIsolation: false } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>MrRobot Desktop Test Fixture</title></head>
    <body style="background:#111827;color:#e5e7eb;font:18px system-ui;padding:28px">
    <h2>Mr.Robot · Desktop acceptance test</h2><p>This window contains synthetic test data only.</p>
    <label>Test text <input id="text" aria-label="Test text" value="before" style="font:20px system-ui;width:300px;padding:8px"></label>
    <p><button id="apply" onclick="document.getElementById('result').textContent='Applied: '+document.getElementById('text').value">Apply test</button></p>
    <p id="result">Not applied</p><button id="run">Run acceptance test</button><button id="browser">Test browser opening</button><pre id="status" style="white-space:pre-wrap">Ready</pre>
    <script>require('electron').ipcRenderer.on('status',(_,s)=>document.getElementById('status').textContent=s);
    document.getElementById('run').onclick=()=>require('electron').ipcRenderer.send('run');document.getElementById('browser').onclick=()=>require('electron').ipcRenderer.send('browser');</script></body></html>`));
  window.show(); window.focus();
});
let running = false;
ipcMain.on('run', async event => {
  if (running || event.sender !== window.webContents) return;
  running = true; const times = [], started = performance.now();
  runtime.reset(); // Reload backend source and start with an empty observation cache.
  const call = async (name, args) => { const start = performance.now();const value = await runtime.request('synthetic-desktop-harness', name, args);times.push([name, Math.round(performance.now()-start)]);return value; };
  const index = (state, expression) => { const line = state.tree.split('\n').find(s=>expression.test(s));if(!line)throw Error('Expected fixture control missing: '+expression+'\n'+state.tree);return Number(line.match(/\[(\d+)\]/)[1]); };
  try {
    await window.webContents.executeJavaScript("document.getElementById('text').value='before';document.getElementById('result').textContent='Not applied'");
    window.webContents.send('status', 'Running product backend against this test window…');
    const windows = await call('desktop_windows', {});
    const target = windows.windows.filter(w => w.title === 'MrRobot Desktop Test Fixture');
    if (target.length !== 1) throw Error('Test window was not uniquely identified');
    let state = await call('desktop_observe', { window: target[0].window });
    state = await call('desktop_act', { observation: state.observation, action: 'set_value', element: index(state, /Edit .*Test text/), value: '한글 테스트 742' });
    if (state.action.verification !== 'verified') throw Error('SetValue was not verified: '+state.tree);
    state = await call('desktop_act', { observation: state.observation, action: 'click', element: index(state, /Button .*Apply test/) });
    if (!state.tree.includes('Applied: 한글 테스트 742')) throw Error('Button result not visible in fresh tree');
    const old = state.observation;
    state = await call('desktop_observe', { window: target[0].window, screenshot: true });
    if (!state.image?.startsWith('data:image/png;base64,')) throw Error('Actual screenshot missing: '+state.imageStatus);
    let rejected = false;
    try { await call('desktop_act', { observation: old, action: 'click', element: 0 }); } catch { rejected = true; }
    if (!rejected) throw Error('Stale observation was accepted');
    window.webContents.send('status', 'PASS · Unicode readback, semantic button, fresh tree, actual image, stale-token rejection\n'+JSON.stringify({ totalMs: Math.round(performance.now()-started), steps: times },null,2));
  } catch(error) { window.webContents.send('status', 'FAIL · '+error.message); }
  finally { running = false; }
});
ipcMain.on('browser', async event => {
  if (running || event.sender !== window.webContents) return;
  running = true;
  try {
    const { launchDesktopBrowser } = await import(pathToFileURL(path.resolve(__dirname, '../../dist/computer/desktop-browser.js')).href);
    browserServer ??= http.createServer((_req, res) => { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"});res.end('<!doctype html><meta charset="utf-8"><title>MrRobot Browser Test Fixture</title><body style="font:20px system-ui;padding:40px"><h1>MrRobot Browser Test Fixture</h1><p>Synthetic local test. No account or user data.</p><button onclick="document.getElementById(\'result\').textContent=\'Page confirmed\'">Confirm synthetic page</button><p id="result">Ready</p></body>'); });
    if (!browserServer.listening) await new Promise(resolve => browserServer.listen(0,'127.0.0.1',resolve));
    window.webContents.send('status','Opening synthetic local page in Edge…');
    await launchDesktopBrowser({browser:'edge', url:'http://127.0.0.1:'+browserServer.address().port}, new AbortController().signal);
    let target;
    for(let i=0;i<20&&!target;i++) { const list=await runtime.request('synthetic-browser-harness','desktop_windows',{});target=list.windows.find(w=>w.app==='msedge'&&w.title.includes('MrRobot Browser Test Fixture'));if(!target)await new Promise(r=>setTimeout(r,250)); }
    if(!target)throw Error('Browser test window was not observed');
    let state=await runtime.request('synthetic-browser-harness','desktop_observe',{window:target.window});
    const line=state.tree.split('\n').find(s=>/Button .*Confirm synthetic page/.test(s));
    if(!line)throw Error('Synthetic page control not found');
    state=await runtime.request('synthetic-browser-harness','desktop_act',{observation:state.observation,action:'click',element:Number(line.match(/\[(\d+)\]/)[1])});
    if(!state.tree.includes('Page confirmed'))throw Error('Browser click result not confirmed');
    window.webContents.send('status','PASS · fixed Edge opener, real window observation, focus and semantic click');
  } catch(error) { window.webContents.send('status','FAIL · '+error.message); }
  finally { running=false; }
});
app.on('window-all-closed', () => { runtime?.dispose();browserServer?.close();app.quit(); });
