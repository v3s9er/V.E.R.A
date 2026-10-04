import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { configureDesktopBranding, DESKTOP_LOGIN_ITEM_NAME } from '../../desktop/branding.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
const oldDisplayName = /Mr\.\s?Robot|MR\.ROBOT/;

function sourceFiles(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(path) : /\.(tsx?|css)$/.test(entry.name) ? [path] : [];
  });
}

test('web and mobile screens use V.E.R.A without changing internal client identifiers', () => {
  for (const path of [...sourceFiles('packages/web/src'), ...sourceFiles('apps/mobile/src/screens')]) {
    assert.doesNotMatch(read(path), oldDisplayName, `old display branding in ${path}`);
  }
  assert.match(read('packages/web/index.html'), /<title>V\.E\.R\.A — PC AI 에이전트<\/title>/);
  assert.match(read('packages/web/src/views/ChatView.tsx'), /V\.E\.R\.A AGENT/);
  assert.match(read('apps/mobile/src/screens/PcListScreen.tsx'), />V\.E\.R\.A<\/Text>/);
  for (const path of ['assets/brand/icon.svg', 'packages/web/public/favicon.svg']) {
    assert.match(read(path), /aria-label="V\.E\.R\.A"/);
  }
  assert.match(read('packages/web/src/rpc.ts'), /export class MrRobotClient/);
});

test('display metadata preserves Windows and Android installation identity', () => {
  const desktop = JSON.parse(read('packages/desktop/electron-builder.json'));
  assert.equal(desktop.productName, 'V.E.R.A');
  assert.equal(desktop.nsis.shortcutName, 'V.E.R.A');
  assert.equal(desktop.executableName, 'Mr.Robot');
  assert.equal(desktop.appId, 'com.polaris.mrrobot');
  const { expo } = JSON.parse(read('apps/mobile/app.json'));
  assert.equal(expo.name, 'V.E.R.A');
  assert.equal(expo.slug, 'mr-robot-mobile');
  assert.equal(expo.android.package, 'com.mrrobot.mobile');
  assert.match(read('apps/mobile/android/app/src/main/res/values/strings.xml'), /name="app_name">V\.E\.R\.A</);
});

for (const isPackaged of [true, false]) {
  test(`desktop display rename preserves the ${isPackaged ? 'installed' : 'development'} profile`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'vera-branding-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const paths = { appData: resolve(directory, 'roaming'), userData: resolve(directory, 'development') };
    const originalUserData = paths.userData;
    const calls = [];
    let name = 'mr-robot-desktop';
    configureDesktopBranding({
      isPackaged,
      getPath: (key) => paths[key],
      setPath: (key, value) => {
        assert.ok(existsSync(value), 'Electron requires the profile directory to exist');
        paths[key] = value;
        calls.push(['path', key]);
      },
      setName: (value) => { name = value; calls.push(['name']); },
    });
    assert.equal(name, 'V.E.R.A');
    assert.equal(paths.userData, isPackaged ? resolve(paths.appData, 'mr-robot-desktop') : originalUserData);
    assert.equal(paths.sessionData, paths.userData);
    assert.deepEqual(calls, [['path', 'userData'], ['path', 'sessionData'], ['name']]);
  });
}

test('desktop bootstrap stages and applies branding before starting the agent', () => {
  const main = read('packages/desktop/main.mjs');
  assert.match(main, /import \{ configureDesktopBranding, DESKTOP_LOGIN_ITEM_NAME \} from '\.\/branding\.mjs'/);
  assert.ok(main.indexOf('configureDesktopBranding(app);') < main.indexOf('let AgentServer;'));
  assert.match(read('scripts/stage-desktop.mjs'), /copyFileSync\(join\(desktop, 'branding\.mjs'\), join\(stage, 'branding\.mjs'\)\)/);
  assert.equal(DESKTOP_LOGIN_ITEM_NAME, 'electron.app.Mr.Robot');
  assert.equal(main.match(/name: DESKTOP_LOGIN_ITEM_NAME/g)?.length, 2, 'both startup settings writes use the existing Windows registry value');
});

test('an explicit packaged user-data-dir isolates profiles and the instance lock', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'vera-branding-override-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const override = resolve(directory, 'isolated-profile');
  const paths = { appData: resolve(directory, 'normal-roaming'), userData: resolve(directory, 'default-profile') };
  configureDesktopBranding({
    isPackaged: true,
    commandLine: { hasSwitch: (name) => name === 'user-data-dir', getSwitchValue: () => override },
    getPath: (key) => paths[key],
    setPath: (key, value) => { paths[key] = value; },
    setName: () => {},
  });
  assert.equal(paths.userData, override);
  assert.equal(paths.sessionData, override);
  assert.ok(existsSync(override));
  assert.equal(existsSync(resolve(paths.appData, 'mr-robot-desktop')), false);
});

test('existing pairing, authentication and encrypted storage formats stay compatible', () => {
  assert.match(read('packages/web/src/pcs.ts'), /const KEY = 'mr-robot\.pcs'/);
  assert.match(read('packages/web/src/rpc.ts'), /'x-mr-robot-token': secret/);
  assert.match(read('packages/web/src/views/PluginsView.tsx'), /app: 'mr-robot'/);
  assert.match(read('apps/mobile/src/pairing.ts'), /obj\.app !== 'mr-robot'/);
  assert.match(read('apps/mobile/src/secureFiles.ts'), /Mr\.Robot\/files\/v1\//);
  assert.match(read('apps/mobile/src/secureFiles.ts'), /mr-robot\.file-key\./);
});
