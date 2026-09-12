import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from '@playwright/test';

const output = await mkdtemp(join(tmpdir(), 'mrrobot-calendar-ui-'));
const server = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), plugins: [react()], server: { host: '127.0.0.1', port: 0, proxy: {} } });
await server.listen();
const origin = 'http://127.0.0.1:'+server.httpServer.address().port;
let browser; const errors = [];
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const [width,height] of [[1280,800],[820,650],[390,780],[320,480],[780,360]]) {
    const page = await browser.newPage({ viewport:{width,height}, deviceScaleFactor:1 });
    page.setDefaultTimeout(10_000);
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === origin && !url.pathname.startsWith('/api/') ? route.continue() : route.abort();
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin+'/test/calendar-preview.html');
    for (const mode of ['일정 화면','플러그인 화면']) {
      await page.getByRole('button', {name:mode,exact:true}).click();
      const days = page.getByRole('gridcell');
      await days.first().waitFor();
      assert.ok(await days.count() >= 28, 'all month dates rendered');
      const geometry = await page.locator('.work-calendar-panel').evaluate(el => {
        const box=el.getBoundingClientRect(), grid=el.querySelector('.work-calendar-grid').getBoundingClientRect();
        return { panelHeight:box.height, gridHeight:grid.height, clipped:grid.bottom>box.bottom+1, overflow:document.documentElement.scrollWidth>innerWidth+1 };
      });
      assert.ok(geometry.gridHeight >= 300 && !geometry.clipped && !geometry.overflow, JSON.stringify({width,height,mode,...geometry}));
      assert.ok(await days.first().evaluate(el => el.getBoundingClientRect().width >= 30), 'calendar date remains readable');
      assert.ok(await page.locator('.work-status').first().evaluate(el => el.getBoundingClientRect().height < 30), 'status does not wrap vertically');
      await days.last().scrollIntoViewIfNeeded();
      await days.last().click();
      await page.getByRole('region', {name:/근무 상세/}).waitFor();
      await page.screenshot({path:join(output,width+'x'+height+'-'+(mode==='일정 화면'?'schedule':'plugin')+'.png')});
      const month = await page.locator('.month-nav h4').textContent();
      await page.getByRole('button', {name:'다음 달',exact:true}).click();
      await page.waitForFunction(old => document.querySelector('.month-nav h4').textContent!==old, month);
      await page.getByRole('button', {name:'이전 달',exact:true}).click();
      await page.waitForFunction(old => document.querySelector('.month-nav h4').textContent===old, month);
      await page.getByRole('button', {name:'오늘',exact:true}).click();
      console.log(width+'x'+height+' '+mode+': month bounds, last-day scroll/click, detail and navigation passed');
    }
    assert.match(await page.locator('.run-panel-heading b').textContent(), /실행 오류/);
    assert.equal(await page.locator('.run-panel-indicator').textContent(), '!');
    await page.close();
  }
  assert.deepEqual(errors, [], 'calendar browser errors');
} finally { await browser?.close(); await server.close(); }
console.log('Synthetic screenshots: '+output);
