import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { fixtureServer } from './fixture-server.mjs';

const server = await fixtureServer();
let browser;
const errors = [];
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const query of ['cancelDelayMs=6500', 'rpcDelayMs=4000', 'rpcDelayMs=4000&lateFailure']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route('**/*', server.route);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.origin}/test/runtime-preview.html?embedded&${query}`);
    await page.getByLabel('대화 이름').waitFor();
    await page.locator('.chat-input').fill('첫 번째 요청');
    await page.getByRole('button', { name: '보내기', exact: true }).click();
    await page.getByText('도구로 작업 중', { exact: true }).waitFor();
    if (query.startsWith('cancel')) {
      await page.getByLabel('실행 중인 작업 중지').click();
      await page.waitForTimeout(3200);
      assert.ok(await page.getByLabel('실행 중인 작업 중지').isDisabled(), 'cancel acknowledgement must not prematurely unlock send');
      assert.equal(await page.getByRole('button', { name: '보내기', exact: true }).count(), 0);
      await page.getByText('작업 중지됨', { exact: true }).waitFor();
      await page.getByRole('button', { name: '보내기', exact: true }).waitFor();
    } else {
      await page.getByRole('button', { name: '테스트 응답 완료', exact: true }).click();
      await page.getByRole('button', { name: '보내기', exact: true }).waitFor();
      await page.locator('.chat-input').fill('두 번째 요청');
      await page.getByRole('button', { name: '보내기', exact: true }).click();
      await page.getByText('도구로 작업 중', { exact: true }).waitFor();
      await page.waitForTimeout(4500);
      assert.equal(await page.getByLabel('실행 중인 작업 중지').count(), 1, 'late old RPC must not stop the new UI');
      assert.equal(await page.getByText('LATE_OLD_REPLY', { exact: true }).count(), 0);
      await page.getByLabel('실행 중인 작업 중지').click();
    }
    console.log(`${query}: passed`);
    await page.close();
  }
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await server.close(); }
