import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { fixtureServer } from './fixture-server.mjs';

// Private synthetic fixture only: no PC RPC, account access, or model inference.
const server = await fixtureServer(), output = await mkdtemp(join(tmpdir(), 'vera-observation-ui-'));
const errors = [];
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const [width, height] of [[1280, 800], [992, 530], [390, 430]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', server.route);
    await page.goto(`${server.origin}/test/runtime-preview.html?embedded`);
    await page.getByLabel('대화 이름').waitFor();
    await page.locator('.chat-input').fill('도구 관측 표시 테스트');
    await page.getByRole('button', { name: '보내기', exact: true }).click();
    await page.locator('.run-panel.phase-working').waitFor();
    await page.evaluate(() => window.runtimeFixture.setObservationLimited(true));
    const notice = page.locator('.run-observation-notice');
    await notice.waitFor();
    assert.equal(await notice.innerText(), '일부 내부 도구 기록은 이 연결에서 제공되지 않습니다');
    assert.equal(await page.locator('.run-panel').getAttribute('open'), null, 'limitation must be visible without opening history');
    await page.evaluate(() => window.runtimeFixture.setHelperState('completed'));
    await page.locator('.run-panel').getByText('최종 결과 검토 중', { exact: true }).waitFor();
    assert.ok(await notice.isVisible(), 'generic status and verification must not clear the limitation');
    assert.doesNotMatch(await page.locator('.run-panel').innerText(), /FIXTURE_PRIVATE/);
    const geometry = await page.evaluate(() => {
      const box = document.querySelector('.run-observation-notice').getBoundingClientRect();
      const input = document.querySelector('.chat-input').getBoundingClientRect();
      return { notice: { x: box.x, right: box.right, y: box.y, bottom: box.bottom }, input: { y: input.y, bottom: input.bottom }, scrollWidth: document.documentElement.scrollWidth };
    });
    assert.ok(geometry.notice.x >= 0 && geometry.notice.right <= width && geometry.notice.y >= 0 && geometry.notice.bottom <= height);
    assert.ok(geometry.input.y >= 0 && geometry.input.bottom <= height && geometry.scrollWidth <= width + 1, 'notice must not hide composer or overflow');
    await page.screenshot({ path: join(output, `${width}x${height}-limited.png`) });
    await page.getByRole('button', { name: '테스트 응답 완료', exact: true }).click();
    await page.locator('.run-panel').getByText('응답 완료 · 실행 오류 확인', { exact: true }).waitFor();
    assert.ok(await notice.isVisible(), 'terminal response retains the notice and error state');
    await page.locator('.chat-input').fill('새 실행');
    await page.getByRole('button', { name: '보내기', exact: true }).click();
    await page.locator('.run-panel.phase-working').waitFor();
    assert.equal(await notice.count(), 0, 'a fresh run must not inherit the previous limitation');
    await page.getByLabel('실행 중인 작업 중지').click();
    await page.close();
    console.log(`${width}x${height}: persistent notice, verification/error independence, fresh-run reset and composer bounds passed`);
  }
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await server.close(); }
console.log(`Screenshots: ${output}`);
