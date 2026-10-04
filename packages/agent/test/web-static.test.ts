import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { mountWebUi } from '../src/server/web-static.js';

test('client HTML never caches, missing chunks stay 404, and unrelated API routes fall through', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vera-static-fixture-'));
  mkdirSync(join(directory, 'assets'));
  writeFileSync(join(directory, 'index.html'), '<!doctype html><title>synthetic client A</title>');
  writeFileSync(join(directory, 'assets', 'app-synthetic.js'), 'export const synthetic = true;');
  const app = express();
  mountWebUi(app, directory);
  app.use((_req, res) => res.status(418).send('not a client route'));
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const path of ['/', '/index.html', '/conversation/synthetic']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
      assert.match(await response.text(), /synthetic client A/);
    }
    writeFileSync(join(directory, 'index.html'), '<!doctype html><title>synthetic client B</title>');
    assert.match(await (await fetch(base + '/')).text(), /synthetic client B/);
    for (const path of ['/assets/removed.js', '/assets/missing', '/removed.css', '/favicon.svg']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 404, path);
      assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
      assert.doesNotMatch(await response.text(), /<!doctype html>/);
    }
    const asset = await fetch(base + '/assets/app-synthetic.js');
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /synthetic = true/);
    assert.equal((await fetch(base + '/api/unknown')).status, 418);
    assert.equal((await fetch(base + '/conversation/synthetic', { method: 'POST' })).status, 418);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
