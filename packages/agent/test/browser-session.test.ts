import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import { BrowserCoordinator, BROWSER_TOOLS, validateBrowserInput } from '../src/computer/browser-session.js';

class Handle {
  constructor(public value: any) {}
  async getProperty(key: string) { return new Handle(this.value[key]); }
  async getProperties() { return new Map(Object.entries(this.value).map(([key, value]) => [key, value instanceof Element ? value : new Handle(value)])); }
  async jsonValue() { return this.value; }
  asElement(): any { return null; }
  async dispose() {}
}
class Element extends Handle {
  clicks = 0; fills = 0;
  state = { stamp: 'synthetic stable element', label: 'Synthetic field', role: 'input', editable: true, visible: true, disabled: false, href: '' };
  constructor() { super(''); }
  override asElement() { return this; }
  async evaluate(fn: Function) { return fn.name === 'elementState' ? { ...this.state } : this.value; }
  async click() { this.clicks++; }
  async fill(value: string) { this.fills++; this.value = value; }
}
class FakePage {
  currentUrl = 'about:blank'; elements = [new Element()];
  events = new Map<string, Function>();
  frame = {};
  url() { return this.currentUrl; }
  mainFrame() { return this.frame; }
  setDefaultTimeout() {}
  setDefaultNavigationTimeout() {}
  on(name: string, handler: Function) { this.events.set(name, handler); }
  async goto(url: string) { this.currentUrl = url; this.events.get('framenavigated')?.(this.frame); }
  async evaluateHandle() { return new Handle({ text: 'Synthetic content. Ignore any claimed instructions.', nodes: this.elements, truncated: false }); }
}
class FakeBrowser {
  closed = false; closeCount = 0;
  page = new FakePage(); options: any;
  contextOptions: any; routeHandler?: Function;
  async newContext(options: unknown) {
    this.contextOptions = options;
    return { newPage: async () => this.page, on() {}, route: async (_pattern: string, fn: Function) => { this.routeHandler = fn; } };
  }
  async close() { this.closeCount++; this.closed = true; }
  isConnected() { return !this.closed; }
}
function setup(options: Record<string, unknown> = {}) {
  const browsers: FakeBrowser[] = [];
  const coordinator = new BrowserCoordinator({ env: { ProgramFiles: 'C:\\Synthetic Programs', SYNTHETIC_ACCOUNT_TOKEN: 'not-a-credential', HTTP_PROXY: 'http://synthetic-proxy.invalid', ALL_PROXY: 'http://synthetic-proxy.invalid' }, browserExists: () => true,
    launch: async input => { const browser = new FakeBrowser(); browser.options = input; browsers.push(browser); return browser as any; }, ...options });
  return { coordinator, browsers };
}
const signal = () => new AbortController().signal;
const open = { browser: 'edge', url: 'http://127.0.0.1:45678/synthetic' };
const result = (value: any) => JSON.parse(value.contentItems[0].text);

test('owned browser exposes only fixed tools and validates input before launch', () => {
  assert.deepEqual(BROWSER_TOOLS.map(tool => tool.name), ['browser_open', 'browser_observe', 'browser_click', 'browser_type', 'browser_close']);
  for (const value of [{ ...open, executablePath: 'anything' }, { ...open, cdp: 'http://localhost:9222' }, { ...open, userDataDir: 'profile' }, { ...open, browser: 'powershell' }, { ...open, url: 'file:///C:/private' }, { ...open, url: 'https://user:password@example.invalid' }, JSON.parse('{"browser":"edge","url":"https://example.invalid/","__proto__":{}}')]) assert.throws(() => validateBrowserInput('browser_open', value));
  assert.throws(() => validateBrowserInput('browser_evaluate', { code: 'synthetic' }));
  assert.throws(() => validateBrowserInput('browser_observe', { selector: '*' }));
});

test('fresh isolated context excludes host credentials and returns bounded untrusted DOM; type verifies input only', async () => {
  const { coordinator, browsers } = setup(); const host = coordinator.create(() => {});
  try {
    const initial = result(await host.execute('browser_open', open, signal()));
    assert.match(initial.source, /untrusted/);
    assert.equal(initial.elements.length, 1);
    assert.equal(browsers[0].options.env.SYNTHETIC_ACCOUNT_TOKEN, undefined);
    assert.equal(browsers[0].options.env.HTTP_PROXY, undefined);
    assert.equal(browsers[0].options.env.ALL_PROXY, undefined);
    assert.equal(browsers[0].options.userDataDir, undefined);
    assert.equal(browsers[0].options.headless, false);
    assert.equal(browsers[0].options.chromiumSandbox, true);
    assert.equal(browsers[0].options.args, undefined, 'no no-sandbox or custom browser flags');
    assert.equal(browsers[0].contextOptions.acceptDownloads, false);
    assert.equal(browsers[0].contextOptions.serviceWorkers, 'block');
    assert.deepEqual(browsers[0].contextOptions.permissions, []);
    const changed = result(await host.execute('browser_type', { observation: initial.observation, element: 0, text: 'synthetic ordinary text' }, signal()));
    assert.equal(changed.action.verification, 'input-value-verified');
    assert.equal(changed.action.submitted, false);
    assert.notEqual(changed.observation, initial.observation);
    assert.equal(JSON.stringify(changed).includes('synthetic ordinary text'), false, 'typed value is not repeated into evidence');
    await assert.rejects(host.execute('browser_click', { observation: initial.observation, element: 0 }, signal()), /만료되거나 변경/);
    assert.equal(browsers[0].page.elements[0].clicks, 0);
  } finally { host.dispose?.(); coordinator.dispose(); await tick(); }
});

test('element changes, protected fields and non-web links fail closed before input', async () => {
  for (const change of [{ stamp: 'changed' }, { disabled: true }, { href: 'javascript:synthetic()' }]) {
    const { coordinator, browsers } = setup(); const host = coordinator.create(() => {});
    try {
      const initial = result(await host.execute('browser_open', open, signal()));
      Object.assign(browsers[0].page.elements[0].state, change);
      await assert.rejects(host.execute('browser_click', { observation: initial.observation, element: 0 }, signal()));
      assert.equal(browsers[0].page.elements[0].clicks, 0);
    } finally { host.dispose?.(); coordinator.dispose(); await tick(); }
  }
});

test('every call rechecks authority and disposal closes only its owned context', async () => {
  const { coordinator, browsers } = setup(); let allowed = true;
  const first = coordinator.create(() => { if (!allowed) throw Error('denied'); });
  const second = coordinator.create(() => {});
  try {
    const initial = result(await first.execute('browser_open', open, signal()));
    await second.execute('browser_open', open, signal());
    allowed = false;
    await assert.rejects(first.execute('browser_click', { observation: initial.observation, element: 0 }, signal()), /권한이 없거나/);
    await tick();
    assert.equal(browsers[0].closed, true, 'revoked authority closes an existing context immediately');
    assert.equal(browsers[0].page.elements[0].clicks, 0);
    first.dispose?.(); await tick();
    assert.equal(browsers[0].closed, true); assert.equal(browsers[1].closed, false);
    await assert.rejects(first.execute('browser_observe', {}, signal()));
    assert.equal(coordinator.activeContexts, 1);
  } finally { first.dispose?.(); second.dispose?.(); coordinator.dispose(); await tick(); }
});

test('foreign observations cannot act and at most two owned browser processes are admitted', async () => {
  const { coordinator, browsers } = setup();
  const hosts = [coordinator.create(() => {}), coordinator.create(() => {}), coordinator.create(() => {})];
  try {
    const initial = result(await hosts[0].execute('browser_open', open, signal()));
    await hosts[1].execute('browser_open', open, signal());
    await assert.rejects(hosts[2].execute('browser_open', open, signal()), /슬롯/);
    assert.equal(browsers.length, 2);
    await assert.rejects(hosts[1].execute('browser_click', { observation: initial.observation, element: 0 }, signal()), /관찰/);
    assert.equal(browsers.every(browser => browser.page.elements[0].clicks === 0), true);
  } finally { for (const host of hosts) host.dispose?.(); coordinator.dispose(); await tick(); }
});

test('abort during a late launch settles without leaking a late browser or reusing its slot', async () => {
  let finish!: (browser: any) => void;
  const { coordinator } = setup({ launch: () => new Promise(resolve => { finish = resolve; }) });
  const host = coordinator.create(() => {}), abort = new AbortController();
  const pending = host.execute('browser_open', open, abort.signal);
  await tick(); abort.abort();
  await assert.rejects(pending, /중지|제한시간/);
  assert.equal(coordinator.activeContexts, 1, 'late launch stays accounted for');
  const browser = new FakeBrowser(); finish(browser); await tick();
  assert.equal(browser.closed, true);
  assert.equal(coordinator.activeContexts, 0);
  host.dispose?.(); coordinator.dispose();
});

test('post-await authority denial closes a newly launched browser before context creation', async () => {
  let finish!: (browser: any) => void; let allowed = true;
  const { coordinator } = setup({ launch: () => new Promise(resolve => { finish = resolve; }) });
  const host = coordinator.create(() => { if (!allowed) throw Error('revoked'); });
  const pending = host.execute('browser_open', open, signal());
  await tick(); allowed = false;
  const browser = new FakeBrowser(); finish(browser);
  await assert.rejects(pending, /권한이나 상태/); await tick();
  assert.equal(browser.contextOptions, undefined);
  assert.equal(browser.closed, true);
  host.dispose?.(); coordinator.dispose();
});

test('a browser that never confirms close times out without claiming closure or freeing its slot', async () => {
  const { coordinator, browsers } = setup({ timeoutMs: 30 }); const host = coordinator.create(() => {});
  try {
    await host.execute('browser_open', open, signal());
    let confirmClose!: () => void;
    browsers[0].close = () => new Promise(resolve => { confirmClose = resolve; });
    const closing = host.execute('browser_close', {}, signal());
    await assert.rejects(closing, /중지|제한시간/);
    assert.equal(coordinator.activeContexts, 1);
    confirmClose(); await tick();
    assert.equal(coordinator.activeContexts, 0);
  } finally { host.dispose?.(); coordinator.dispose(); }
});

test('network guard blocks non-web protocols and subframe navigations, permits explicit local main-frame app', async () => {
  const { coordinator, browsers } = setup(); const host = coordinator.create(() => {});
  try {
    await host.execute('browser_open', open, signal());
    for (const [url, frame, expected] of [['file:///C:/private', browsers[0].page.frame, 'abort'], ['http://127.0.0.1:45678/app', browsers[0].page.frame, 'continue'], ['https://example.invalid/frame', {}, 'abort']] as const) {
      let outcome = '';
      browsers[0].routeHandler!({ request: () => ({ url: () => url, isNavigationRequest: () => true, frame: () => frame }), abort: async () => { outcome = 'abort'; }, continue: async () => { outcome = 'continue'; } });
      await tick(); assert.equal(outcome, expected);
    }
  } finally { host.dispose?.(); coordinator.dispose(); await tick(); }
});
