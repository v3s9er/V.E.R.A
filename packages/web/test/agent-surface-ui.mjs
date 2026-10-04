import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { fixtureServer } from './fixture-server.mjs';
const output = await mkdtemp(join(tmpdir(), 'mrrobot-surface-'));
const server = await fixtureServer();
let browser;
const errors = [];
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const [width, height] of [[1280, 800], [992, 530], [390, 780]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(6000);
    await page.route('**/*', server.route);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.origin + '/test/runtime-preview.html?embedded&longHistory');
    await page.getByLabel('대화 이름').waitFor();
    if (width <= 900) await page.getByLabel('프로젝트와 대화 목록 열기').click();
    const list = page.locator('.conversation-items');
    assert.equal(await list.locator('.conversation-item').count(), 62);
    assert.ok(await list.locator('.conversation-item').evaluateAll(items => items.every(el => el.getBoundingClientRect().height >= 40)), 'long history rows must not collapse');
    await list.locator('.conversation-item').last().scrollIntoViewIfNeeded();
    await list.locator('.conversation-item-main').last().click();
    if (width <= 900) await page.getByLabel('프로젝트와 대화 목록 열기').click();
    await page.getByRole('button', { name: '＋ 새 대화', exact: true }).click();
    await page.screenshot({ path: join(output, `${width}-empty.png`) });
    await page.locator('.chat-input').fill('실행 로그 확인');
    await page.getByRole('button', { name: '보내기', exact: true }).click();
    await page.getByRole('region', { name: '실시간 작업 로그' }).getByText('파일 읽기', { exact: true }).waitFor();
    const feed = page.locator('.run-timeline');
    assert.equal(await feed.locator('li').count(), 1);
    assert.doesNotMatch(await feed.innerText(), /undefined|\{\s*"|NaN/);
    const headerBackground = await page.locator('.chat-commandbar').evaluate(el => getComputedStyle(el).backgroundColor);
    assert.equal(headerBackground, 'rgba(0, 0, 0, 0)', 'header must blend into the workspace');
    await page.screenshot({ path: join(output, `${width}-working.png`) });
    await page.getByRole('button', { name: '테스트 응답 완료' }).click();
    await page.getByRole('button', { name: '보내기', exact: true }).waitFor();
    assert.equal(await feed.count(), 0, 'reply replaces the waiting log, detailed history stays accessible');
    console.log(`${width}x${height}: 62 history rows, inline tool log, response transition and unified header passed`);
    await page.close();
  }
} finally { await browser?.close(); await server.close(); }
assert.deepEqual(errors, []);
console.log(`Surface screenshots: ${output}`);
