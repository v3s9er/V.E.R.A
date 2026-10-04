import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { fixtureServer } from './fixture-server.mjs';

const server = await fixtureServer();
const screenshots = mkdtempSync(join(tmpdir(), 'vera-conversation-flow-'));
const errors = [];
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const width of [1280, 992, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 992 ? 530 : 800 } });
    await page.route('**/*', server.route);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.origin}/test/runtime-preview.html?embedded&rpcDelayMs=1000`);
    await page.getByLabel('대화 이름').waitFor();
    const nav = async () => { if (!await page.locator('.conversation-list').isVisible()) await page.getByLabel('프로젝트와 대화 목록 열기').click(); };
    const open = async id => { await nav(); await page.locator(`[data-conversation-id="${id}"]`).click(); await page.waitForFunction(() => !document.querySelector('.chat-input')?.disabled); };
    const newButton = () => width < 760 ? page.getByLabel('새 대화 만들기') : page.getByRole('button', { name: '＋ 새 대화', exact: true });
    await page.locator('.chat-input').fill('독립 실행 A');
    await page.getByRole('button', { name: '보내기', exact: true }).click();
    await page.locator('.run-panel.phase-working').waitFor();
    await page.locator('.chat-input').fill('A에 남긴 초안');
    await page.evaluate(() => window.runtimeFixture.setCreateDelay(180));
    await newButton().dblclick();
    await page.waitForFunction(() => document.querySelector('[aria-label="대화 이름"]')?.value === '새 대화' && !document.querySelector('.chat-input')?.disabled);
    assert.equal(await page.evaluate(() => window.runtimeFixture.calls.filter(c => c.method === 'conversations.create').length), 1, 'duplicate new clicks create only one conversation');
    assert.equal(await page.locator('.chat-input').inputValue(), '');
    await page.locator('.chat-input').fill('독립 실행 B');
    await page.getByRole('button', { name: '보내기', exact: true }).click();
    await page.locator('.run-panel.phase-working').waitFor();
    const started = await page.evaluate(() => window.runtimeFixture.calls.filter(c => c.method === 'chat.start').map(c => c.params.conversationId));
    assert.equal(started.length, 2); assert.notEqual(started[0], started[1]);
    assert.equal(await page.evaluate(() => window.runtimeFixture.activeIds().length), 2);
    await page.locator('.chat-input').fill('B에 남긴 초안');
    await page.evaluate(id => window.runtimeFixture.complete(id), started[0]);
    await page.waitForTimeout(1200);
    assert.equal(await page.getByLabel('실행 중인 작업 중지').count(), 1, 'background completion cannot settle selected run');
    await open(started[0]); assert.equal(await page.locator('.chat-input').inputValue(), 'A에 남긴 초안');
    await open(started[1]); assert.equal(await page.locator('.chat-input').inputValue(), 'B에 남긴 초안');
    await page.getByLabel('대화 모델', { exact: true }).click();
    await page.getByLabel('모델 검색').fill('luna');
    await page.getByRole('button', { name: /^gpt-6-luna/ }).click();
    await page.waitForFunction(() => document.querySelector('.pending-execution-config'));
    assert.ok(await page.getByLabel('입력창 액세스 권한').isEnabled());
    await page.getByLabel('입력창 액세스 권한').selectOption('read-only');
    await page.getByRole('button', { name: '중지하고 적용', exact: true }).waitFor();
    assert.match(await page.locator('.pending-execution-config').innerText(), /다음 실행에 적용.*변경 전 확인/s);
    assert.equal(await page.evaluate(() => window.runtimeFixture.activeIds().length), 1, 'next-run save must not interrupt');
    await page.screenshot({ path: join(screenshots, `${width}-pending.png`) });
    await page.getByRole('button', { name: '중지하고 적용', exact: true }).click();
    await page.getByRole('button', { name: '보내기', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.runtimeFixture.activeIds().length), 0);
    assert.equal(await page.evaluate(() => window.runtimeFixture.calls.filter(c => c.method === 'chat.start').length), 2, 'apply must never replay work');
    assert.equal(await page.locator('.chat-input').inputValue(), 'B에 남긴 초안');
    const configure = await page.evaluate(() => window.runtimeFixture.calls.filter(c => c.method === 'chat.configure').at(-1).params);
    assert.equal(configure.apply, 'stop-current'); assert.ok(configure.expectedRunId); assert.deepEqual(configure.patch, {});

    // Reopening A must not start a snapshot read until A's earlier save settles.
    // Otherwise an old get response can overwrite the newer configuration.
    await open(started[0]);
    await page.evaluate(() => window.runtimeFixture.holdConfigure());
    await page.getByLabel('입력창 액세스 권한').selectOption('read-only');
    await page.waitForFunction(id => window.runtimeFixture.calls.some(c => c.method === 'chat.configure' && c.params.conversationId === id), started[0]);
    await open(started[1]);
    await page.evaluate(id => window.runtimeFixture.setGetDelay(id, 600), started[0]);
    await nav(); await page.locator(`[data-conversation-id="${started[0]}"]`).click();
    await page.waitForTimeout(100);
    await page.evaluate(() => window.runtimeFixture.releaseConfigure());
    await page.waitForFunction(() => !document.querySelector('.chat-input')?.disabled);
    assert.equal(await page.getByLabel('입력창 액세스 권한').inputValue(), 'read-only', 'a delayed get must not overwrite a configuration saved while navigating');

    await page.evaluate(id => { window.runtimeFixture.setGetDelay(id, 900); window.runtimeFixture.setCreateDelay(40); }, started[0]);
    await nav(); await page.locator(`[data-conversation-id="${started[0]}"]`).click();
    await newButton().click();
    await page.waitForFunction(() => document.querySelector('[aria-label="대화 이름"]')?.value === '새 대화' && !document.querySelector('.chat-input')?.disabled);
    const selected = await page.locator('.conversation-item.active [data-conversation-id]').getAttribute('data-conversation-id');
    await page.waitForTimeout(1100);
    assert.equal(await page.locator('.conversation-item.active [data-conversation-id]').getAttribute('data-conversation-id'), selected, 'late old load cannot replace newly created selection');
    await nav();
    const group = page.getByLabel('앱 리뉴얼 대화 접기/펼치기');
    await group.click(); assert.equal(await group.getAttribute('aria-expanded'), 'false');
    await page.reload(); await page.getByLabel('대화 이름').waitFor(); await nav();
    assert.equal(await group.getAttribute('aria-expanded'), 'false', 'project collapse is persistent');
    await page.screenshot({ path: join(screenshots, `${width}-projects.png`) });
    await page.close();
    console.log(`${width}px: concurrent runs, drafts, delayed navigation, pending config, explicit stop, collapse passed`);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ screenshots, inference: false, errors }));
} finally { await browser?.close(); await server.close(); }
