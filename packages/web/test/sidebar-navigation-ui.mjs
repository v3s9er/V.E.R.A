import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { fixtureServer } from './fixture-server.mjs';

// An isolated mock RPC dataset: no model, credentials, real files, or PC agent.
const server = await fixtureServer();
const screenshots = mkdtempSync(join(tmpdir(), 'vera-sidebar-navigation-'));
const errors = [];
let browser;
let activePage;
let activeWidth;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const width of [1280, 992, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 992 ? 530 : 800 }, hasTouch: width === 390 });
    activePage = page; activeWidth = width;
    await page.route('**/*', server.route);
    page.on('pageerror', error => errors.push(`${width}px: ${error.message}`));
    await page.goto(`${server.origin}/test/runtime-preview.html?embedded&sidebarFixture`);
    await page.getByLabel('대화 이름', { exact: true }).waitFor();
    const sidebar = page.locator('.conversation-list');
    const nav = async () => {
      if (width < 760 && !await page.locator('.conversation-layout').evaluate(element => element.classList.contains('navigation-open'))) {
        await page.getByLabel('프로젝트와 대화 목록 열기').click();
      }
    };
    const project = id => sidebar.locator(`[data-project-id="${id}"]`);
    const row = id => sidebar.locator(`[data-conversation-id="${id}"]`);
    const group = name => sidebar.getByLabel(`${name} 대화 접기/펼치기`, { exact: true });
    const select = async id => { await nav(); await row(id).click(); await expect(page.locator('.chat-input')).toBeEnabled(); };
    const rpc = method => page.evaluate(method => window.runtimeFixture.calls.filter(call => call.method === method), method);
    const menu = id => row(id).locator('..').getByRole('button', { name: / 메뉴$/ });
    const saveDocsProject = async () => {
      await nav();
      await sidebar.getByLabel('사용 가이드 프로젝트 설정', { exact: true }).click();
      const projectDialog = page.getByRole('dialog', { name: '프로젝트 설정', exact: true });
      await projectDialog.getByRole('button', { name: '저장', exact: true }).click();
      await expect(projectDialog).toHaveCount(0);
      await expect(page.getByLabel('대화 이름', { exact: true })).toHaveValue('사용 가이드 초안');
      await nav();
    };
    const checkBounds = async () => {
      const bounds = await sidebar.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const scrollers = [...element.querySelectorAll('*')].filter(node => {
          const style = getComputedStyle(node);
          return ['auto', 'scroll'].includes(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
        }).map(node => ({ className: node.className, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight }));
        const retained = ['.conversation-brand', '.project-nav-heading', '.profile-shortcuts', '.profile-trigger'].map(selector => {
          const node = element.querySelector(selector);
          const box = node.getBoundingClientRect();
          return { selector, left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height };
        });
        return { viewportWidth: innerWidth, viewportHeight: innerHeight, left: rect.left, right: rect.right, bottom: rect.bottom,
          sidebarWidth: element.clientWidth, sidebarScrollWidth: element.scrollWidth,
          bodyWidth: document.documentElement.scrollWidth, scrollers, retained };
      });
      assert.ok(bounds.left >= -1 && bounds.right <= bounds.viewportWidth + 1 && bounds.bottom <= bounds.viewportHeight + 1, JSON.stringify(bounds));
      assert.ok(bounds.sidebarScrollWidth <= bounds.sidebarWidth + 1 && bounds.bodyWidth <= width + 1, `no horizontal overflow: ${JSON.stringify(bounds)}`);
      assert.ok(bounds.scrollers.length <= 1, `one vertical list scroller: ${JSON.stringify(bounds.scrollers)}`);
      assert.ok(bounds.retained.every(item => item.height > 0 && item.left >= bounds.left - 1 && item.right <= bounds.right + 1 && item.top >= 0 && item.bottom <= bounds.bottom + 1), `heading and profile footer remain visible: ${JSON.stringify(bounds.retained)}`);
      return bounds;
    };

    await nav();
    await expect(sidebar.locator('.project-nav-items')).toHaveCount(0);
    await expect(group('앱 리뉴얼')).toHaveCount(1);
    await expect(project('empty')).toBeVisible();
    await expect(row('sidebar-discord')).toHaveCount(0);
    await expect(row('sidebar-archived')).toHaveCount(0);
    await expect(row('sidebar-orphan')).toBeVisible();
    await expect(row('sidebar-unassigned')).toBeVisible();
    await expect(project('__unassigned__').getByRole('button', { name: /새 대화/ })).toHaveCount(0);
    await expect(project('design').locator('[data-conversation-id]')).toHaveCount(8);
    for (const id of ['chat-design', 'sidebar-19', 'sidebar-20']) await expect(row(id)).toBeVisible();
    await expect(row('sidebar-6')).toHaveCount(0);
    await expect(sidebar).not.toContainText(/\d+개 메시지/);
    assert.equal(await group('앱 리뉴얼').evaluate(element => element.tagName), 'BUTTON');
    await checkBounds();
    if (width === 390) {
      const widths = await sidebar.evaluate(element => ({ sidebar: element.clientWidth,
        create: element.querySelector('.conversation-list-head button').getBoundingClientRect().width,
        tabs: element.querySelector('.conversation-spaces').getBoundingClientRect().width,
      }));
      assert.ok(widths.create >= widths.sidebar - 28 && widths.tabs >= widths.sidebar - 28, `mobile action and tabs span the drawer: ${JSON.stringify(widths)}`);
    }
    await page.screenshot({ path: join(screenshots, `${width}-default.png`) });

    // Expand the long list, then collapse it while keeping an older selected chat.
    await project('design').getByRole('button', { name: /더 보기/ }).click();
    await expect(project('design').locator('[data-conversation-id]')).toHaveCount(21);
    const longBounds = await checkBounds();
    assert.equal(longBounds.scrollers.length, 1, 'expanded conversations share one vertical scroll area');
    await select('sidebar-8');
    await nav();
    await project('design').getByRole('button', { name: '대화 접기', exact: true }).click();
    await expect(row('sidebar-8')).toBeVisible();
    await expect(row('chat-design')).toHaveCount(0);
    await expect(project('design').locator('[data-conversation-id]')).toHaveCount(8);

    // Search temporarily opens collapsed groups without overwriting the preference.
    const beforeCollapseCreates = (await rpc('conversations.create')).length;
    await group('앱 리뉴얼').click();
    await expect(group('앱 리뉴얼')).toHaveAttribute('aria-expanded', 'false');
    await expect(project('design').locator('[data-conversation-id]')).toHaveCount(0);
    assert.equal((await rpc('conversations.create')).length, beforeCollapseCreates, 'project header never creates a chat');
    const search = sidebar.getByLabel('대화 검색', { exact: true });
    await search.fill('화면 검증 대화 12');
    await expect(row('sidebar-12')).toBeVisible();
    await expect(sidebar.locator('[data-conversation-id]')).toHaveCount(1);
    await select('sidebar-12');
    await nav();
    await expect(search).toHaveValue('화면 검증 대화 12');
    await expect(row('sidebar-12')).toBeVisible();
    await search.fill('일치하지 않는 검색어');
    await expect(sidebar.locator('[data-conversation-id]')).toHaveCount(0);
    await search.fill('');
    await expect(group('앱 리뉴얼')).toHaveAttribute('aria-expanded', 'false');
    await page.reload();
    await page.getByLabel('대화 이름', { exact: true }).waitFor();
    await nav();
    await expect(group('앱 리뉴얼')).toHaveAttribute('aria-expanded', 'false');
    await group('앱 리뉴얼').focus();
    await page.keyboard.press('Space');
    await expect(group('앱 리뉴얼')).toHaveAttribute('aria-expanded', 'true');

    // Keyboard and pointer actions remain available without permanent row clutter.
    const targetMenu = menu('sidebar-1');
    await targetMenu.focus();
    await expect.poll(() => targetMenu.evaluate(element => Number(getComputedStyle(element).opacity)), { message: 'keyboard focus exposes actions' }).toBe(1);
    await page.keyboard.press('Enter');
    const openedMenu = page.getByRole('menu');
    await expect(openedMenu).toBeVisible();
    await expect(openedMenu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(openedMenu.getByRole('menuitem').last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(openedMenu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(openedMenu).toHaveCount(0);
    await expect(targetMenu).toBeFocused();
    await nav();
    if (width === 390) {
      await search.focus();
      await expect.poll(() => targetMenu.evaluate(element => Number(getComputedStyle(element).opacity)), { message: 'touch exposes actions' }).toBe(1);
    } else {
      await targetMenu.hover();
      await expect.poll(() => targetMenu.evaluate(element => Number(getComputedStyle(element).opacity)), { message: 'hover exposes actions' }).toBe(1);
    }
    await targetMenu.click();
    await expect(openedMenu).toBeVisible();
    const tree = sidebar.locator('.project-tree');
    await tree.evaluate(element => element.dispatchEvent(new Event('scroll')));
    await expect(openedMenu).toBeVisible();
    const treeScroll = await tree.evaluate(element => {
      const before = element.scrollTop;
      element.scrollTop = before + 60 <= element.scrollHeight - element.clientHeight ? before + 60 : before - 60;
      return { before, after: element.scrollTop };
    });
    assert.notEqual(treeScroll.before, treeScroll.after, 'fixture must move the menu anchor');
    await expect(openedMenu).toHaveCount(0);

    // Saving one project's settings cannot leave a hidden filter for another.
    await saveDocsProject();
    await targetMenu.click();
    await page.getByRole('menuitem', { name: /대화 고정/ }).click();
    await expect(page.getByLabel('대화 이름', { exact: true })).toHaveValue('화면 검증 대화 01');
    await nav();

    // Archive and restore retain their own list and never mix Discord records.
    await targetMenu.click();
    await page.getByRole('menuitem', { name: /보관함으로 이동/ }).click();
    await nav();
    await expect(row('sidebar-1')).toHaveCount(0);
    await saveDocsProject();
    await sidebar.getByRole('button', { name: '보관함', exact: true }).click();
    await expect(page.getByLabel('대화 이름', { exact: true })).toHaveValue('화면 검증 대화 01');
    await nav();
    await expect(row('sidebar-1')).toBeVisible();
    await expect(row('sidebar-archived')).toBeVisible();
    await expect(row('sidebar-discord-archived')).toHaveCount(0);
    await menu('sidebar-1').click();
    await page.getByRole('menuitem', { name: /진행 중으로 복원/ }).click();
    await nav();
    await expect(row('sidebar-1')).toHaveCount(0);
    await sidebar.getByRole('button', { name: '진행 중', exact: true }).click();
    await nav();
    await expect(row('sidebar-1')).toBeVisible();
    await sidebar.getByRole('tab', { name: 'Discord', exact: true }).click();
    await nav();
    await expect(row('sidebar-discord')).toBeVisible();
    await expect(row('sidebar-1')).toHaveCount(0);
    await expect(sidebar.getByRole('button', { name: '＋ 새 대화', exact: true })).toHaveCount(0);
    await sidebar.getByRole('button', { name: '보관함', exact: true }).click();
    await nav();
    await expect(row('sidebar-discord-archived')).toBeVisible();
    await expect(row('sidebar-archived')).toHaveCount(0);
    await sidebar.getByRole('tab', { name: '내 대화', exact: true }).click();
    await nav();
    await expect(row('sidebar-1')).toBeVisible();

    // Empty project headers are navigation only. The adjacent action supplies its id.
    const createsBeforeEmpty = (await rpc('conversations.create')).length;
    await group('빈 프로젝트').click();
    await group('빈 프로젝트').click();
    assert.equal((await rpc('conversations.create')).length, createsBeforeEmpty);
    await project('empty').getByRole('button', { name: /새 대화/ }).click();
    await expect(page.getByLabel('대화 이름', { exact: true })).toHaveValue('새 대화');
    assert.equal((await rpc('conversations.create')).at(-1).params.workspaceId, 'empty');
    await nav();
    await expect(project('empty').locator('[data-conversation-id]')).toHaveCount(1);

    // Project creation, rename, and unlink use the existing modal/RPC contract.
    await sidebar.getByRole('button', { name: '프로젝트 만들기', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '새 프로젝트', exact: true });
    await dialog.getByLabel('프로젝트 이름', { exact: true }).fill('새 검증 프로젝트');
    await dialog.getByRole('button', { name: '프로젝트 만들기', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const createdProject = (await rpc('projects.create')).at(-1);
    assert.equal(createdProject.params.name, '새 검증 프로젝트');
    await nav();
    await expect(group('새 검증 프로젝트')).toBeVisible();
    await sidebar.getByLabel('새 검증 프로젝트 프로젝트 설정', { exact: true }).click();
    dialog = page.getByRole('dialog', { name: '프로젝트 설정', exact: true });
    await dialog.getByLabel('프로젝트 이름', { exact: true }).fill('이름 바꾼 프로젝트');
    await dialog.getByRole('button', { name: '저장', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await nav();
    await expect(group('이름 바꾼 프로젝트')).toBeVisible();
    await sidebar.getByLabel('이름 바꾼 프로젝트 프로젝트 설정', { exact: true }).click();
    dialog = page.getByRole('dialog', { name: '프로젝트 설정', exact: true });
    await dialog.getByRole('button', { name: '연결 해제', exact: true }).click();
    await dialog.getByRole('button', { name: '연결 해제 확인', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await nav();
    await expect(group('이름 바꾼 프로젝트')).toHaveCount(0);
    assert.equal((await rpc('projects.delete')).length, 1);

    const newConversation = width < 760 ? page.getByLabel('새 대화 만들기', { exact: true }) : sidebar.getByRole('button', { name: '＋ 새 대화', exact: true });
    // A disconnected conversation remains readable; creating a new one uses a valid project.
    await select('sidebar-orphan');
    const createsBeforeOrphan = (await rpc('conversations.create')).length;
    await newConversation.click();
    await expect.poll(async () => (await rpc('conversations.create')).length).toBe(createsBeforeOrphan + 1);
    await expect(page.getByLabel('대화 이름', { exact: true })).toHaveValue('새 대화');
    assert.equal((await rpc('conversations.create')).at(-1).params.workspaceId, 'design');
    await nav();
    await select('sidebar-orphan');
    await expect(page.getByLabel('대화 이름', { exact: true })).toHaveValue('연결 해제된 프로젝트 대화');
    assert.equal((await rpc('conversations.update')).filter(call => call.params.id === 'sidebar-orphan' && Object.hasOwn(call.params, 'workspaceId')).length, 0, 'new chat does not reassign the existing orphan');
    await nav();
    await search.fill('화면 검증 대화 12');
    const createsBeforeGlobal = (await rpc('conversations.create')).length;
    if (width < 760) await sidebar.getByLabel('프로젝트 목록 닫기', { exact: true }).click();
    await newConversation.click();
    await expect.poll(async () => (await rpc('conversations.create')).length).toBe(createsBeforeGlobal + 1);
    await expect(page.getByLabel('대화 이름', { exact: true })).toHaveValue('새 대화');
    await nav();
    await expect(search).toHaveValue('');
    await checkBounds();
    await page.screenshot({ path: join(screenshots, `${width}-verified.png`) });
    await page.close();
    console.log(`${width}px: unified tree, five recent plus exceptions, search, persistent collapse, keyboard menus, archive/Discord, project CRUD, explicit new-chat target passed`);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ screenshots, inference: false, errors }));
} catch (error) {
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: join(screenshots, `${activeWidth}-failure.png`) });
  console.error(JSON.stringify({ screenshots, inference: false, errors }));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
