import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

// Requires the local Vite fixture server. An isolated headless Edge profile is
// used; no cookies, open user tabs, PC RPC endpoints or model accounts are used.
const output = await mkdtemp(join(tmpdir(), 'mrrobot-ui-'));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const failures = [], errors = [];
try {
  for (const [width, height] of [[1280,800], [820,650], [390,780], [390,430]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(5000);
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:5178/test/runtime-preview.html?embedded');
    await page.getByLabel('대화 이름').waitFor();
    const screenshot = async name => page.screenshot({ path: join(output, `${width}x${height}-${name}.png`) });
    const check = async name => {
      const geometry = await page.evaluate(() => {
        const r = sel => { const el = document.querySelector(sel); const box = el?.getBoundingClientRect(); return box ? { x: box.x, y: box.y, right: box.right, bottom: box.bottom, height: box.height } : null; };
        const composer = document.querySelector('.chat-inputbar');
        return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, input: r('.chat-input'), composer: r('.chat-inputbar'), actions: r('.composer-send-actions'), scroll: r('.chat-scroll'), clippedControls: composer.scrollHeight > composer.clientHeight + 1 };
      });
      await screenshot(name);
      assert.ok(geometry.scrollWidth <= width + 1, `horizontal overflow ${JSON.stringify(geometry)}`);
      assert.ok(geometry.input && geometry.input.y >= 0 && geometry.input.bottom <= height + 1, `input hidden ${JSON.stringify(geometry)}`);
      assert.ok(geometry.composer.bottom <= height + 1, `composer hidden ${JSON.stringify(geometry)}`);
      assert.ok(!geometry.clippedControls && geometry.actions.bottom <= height + 1, `send/stop clipped ${JSON.stringify(geometry)}`);
      assert.ok(geometry.scroll.height >= 60, `messages squeezed ${JSON.stringify(geometry)}`);
    };
    try {
      await check('idle');
      if (width <= 900) await page.getByLabel('프로젝트와 대화 목록 열기').click();
      await page.getByRole('button', { name: /사용 가이드.*1/ }).click();
      await page.getByRole('button', { name: '＋ 새 대화', exact: true }).click().catch(async () => {
        if (width <= 900) { await page.getByLabel('프로젝트와 대화 목록 열기').click(); await page.getByRole('button', { name: '＋ 새 대화', exact: true }).click(); } else throw Error('new conversation not reachable');
      });
      await page.locator('.chat-input').fill('테스트 작업');
      await page.getByRole('button', { name: '보내기', exact: true }).click();
      await page.getByText('도구로 작업 중', { exact: true }).waitFor();
      await check('running');
      await page.locator('.run-panel summary').click();
      await page.getByRole('list', { name: '실제 작업 기록' }).waitFor();
      await page.locator('.chat-input').fill('추가 지시 테스트');
      await page.getByRole('button', { name: '명령 끼워넣기', exact: true }).click();
      await page.getByLabel('실행 중인 작업 중지').click();
      await page.getByText('작업 중지됨', { exact: true }).waitFor();
      await page.getByRole('button', { name: '보내기', exact: true }).waitFor();
      await page.locator('.run-panel summary').click();
      await check('cancelled');
      if (width <= 900) await page.getByLabel('프로젝트와 대화 목록 열기').click();
      await page.getByLabel('프로젝트 만들기', { exact: true }).click();
      await page.getByLabel('프로젝트 이름', { exact: true }).fill('UI 테스트 프로젝트');
      await page.getByRole('button', { name: '프로젝트 만들기', exact: true }).last().click();
      await page.locator('.context-trigger').filter({ hasText: 'UI 테스트 프로젝트' }).waitFor();
      await check('project');
      console.log(`${width}x${height}: project creation, switching, streaming state, steering, cancellation and bounds passed`);
    } catch (error) { await screenshot('failure'); failures.push(`${width}x${height}: ${error.message}`); }
    finally { await page.close(); }
  }
} finally { await browser.close(); }
console.log(`Screenshots: ${output}`);
assert.deepEqual(errors, [], 'browser runtime errors');
assert.deepEqual(failures, [], 'UI regressions');
