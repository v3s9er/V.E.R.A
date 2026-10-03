import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { fixtureServer } from './fixture-server.mjs';

const output = await mkdtemp(join(tmpdir(), 'mrrobot-model-picker-'));
const server = await fixtureServer();
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const [width, height] of [[1280, 800], [390, 780], [390, 430]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', server.route);
    await page.goto(server.origin + '/test/runtime-preview.html?embedded');
    await page.getByLabel('대화 모델', { exact: true }).click();
    await page.getByLabel('모델 검색').fill('sol');
    await page.getByRole('button', { name: /^gpt-6-sol/ }).click();
    const daybreak = page.getByRole('button', { name: /Daybreak/ });
    await daybreak.waitFor();
    await daybreak.click();
    await expect(daybreak).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('대화 모델', { exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'gpt-daybreak-blue-latest', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Claude 구독', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: /^gpt-6-sol/ }).count(), 0);
    await page.screenshot({ path: join(output, `${width}x${height}-picker.png`) });
    const fits = await page.getByRole('dialog').evaluate(element => { const r = element.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.top >= -1; });
    assert.ok(fits, 'picker must remain within viewport');
    await page.getByRole('button', { name: 'claude-sonnet', exact: true }).click();
    await expect(page.getByRole('button', { name: /Daybreak/ })).toHaveCount(0);
    await page.getByLabel('대화 모델', { exact: true }).click();
    await page.getByLabel('모델 검색').fill('gpt-6-sol');
    await page.getByRole('button', { name: /^gpt-6-sol/ }).click();
    await expect(page.getByRole('button', { name: /Daybreak/ })).toHaveAttribute('aria-pressed', 'false');
    assert.deepEqual(errors, []);
    console.log(`${width}x${height}: search, provider filter, toggle persistence and provider switch passed`);
    await page.close();
  }
} finally { await browser?.close(); await server.close(); }
console.log(`Screenshots: ${output}`);
