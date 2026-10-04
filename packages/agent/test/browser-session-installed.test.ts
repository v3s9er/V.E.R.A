import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { BrowserCoordinator } from '../src/computer/browser-session.js';

// Explicit opt-in: a real installed browser, but only an owned headless context
// and a synthetic loopback fixture. No model, user profile, or external page.
test('installed Edge can observe, type, verify and click only its synthetic isolated page', { skip: process.env.VERA_BROWSER_LOCAL_FIXTURE !== 'yes' }, async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><body><h1>Synthetic browser fixture</h1><input aria-label="Synthetic note"><button onclick="document.getElementById(\'result\').textContent=\'Synthetic clicked\'">Synthetic button</button><p id="result">Synthetic waiting</p><input type="password" aria-label="Synthetic password" value="not-a-real-secret"></body></html>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const coordinator = new BrowserCoordinator({ launch: options => chromium.launch({ ...options, headless: true }) });
  const host = coordinator.create(() => {});
  const signal = new AbortController().signal;
  const read = (value: any) => JSON.parse(value.contentItems[0].text);
  try {
    const initial = read(await host.execute('browser_open', { browser: 'edge', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }, signal));
    assert.match(initial.text, /Synthetic browser fixture/);
    assert.equal(initial.elements.some((item: any) => /password/i.test(item.label)), false);
    assert.equal(JSON.stringify(initial).includes('not-a-real-secret'), false);
    const input = initial.elements.find((item: any) => item.label === 'Synthetic note');
    assert.ok(input?.editable);
    const typed = read(await host.execute('browser_type', { observation: initial.observation, element: input.id, text: 'Synthetic typed value' }, signal));
    assert.equal(typed.action.verification, 'input-value-verified');
    const button = typed.elements.find((item: any) => item.label === 'Synthetic button');
    assert.ok(button);
    const clicked = read(await host.execute('browser_click', { observation: typed.observation, element: button.id }, signal));
    assert.match(clicked.text, /Synthetic clicked/);
    assert.equal(clicked.action.verification, 'unverified', 'click itself is not a semantic-success claim');
    assert.equal(read(await host.execute('browser_close', {}, signal)).closed, true);
    assert.equal(coordinator.activeContexts, 0);
  } finally {
    host.dispose?.(); coordinator.dispose(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
