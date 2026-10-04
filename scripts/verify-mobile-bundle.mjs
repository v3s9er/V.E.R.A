// Verify provenance, not only successful Gradle execution or a version label.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = fileURLToPath(new URL('../apps/mobile/', import.meta.url));
const normalize = value => value.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '').replace(/\/$/, '');
const base = normalize(resolve(mobile)) + '/';
const map = JSON.parse(readFileSync(resolve(mobile, 'android/app/build/generated/sourcemaps/react/release/index.android.bundle.map'), 'utf8'));
const seen = new Set();
const sharedRoot = resolve(mobile, '../../packages/shared');
const sharedBase = normalize(sharedRoot) + '/';
const sharedSeen = new Set();
for (let i = 0; i < map.sources.length; i++) {
  const source = normalize(map.sources[i]);
  const sharedRelative = source.startsWith('/packages/shared/src/') ? source.slice('/packages/shared/'.length)
    : source.startsWith(sharedBase + 'src/') ? source.slice(sharedBase.length) : undefined;
  if (sharedRelative) {
    assert.ok(!sharedRelative.split('/').includes('..'), 'Unsafe shared source path');
    const bundled = map.sourcesContent?.[i];
    assert.equal(typeof bundled, 'string', 'Missing shared source content');
    assert.equal(bundled.replaceAll('\r\n', '\n'), readFileSync(resolve(sharedRoot, sharedRelative), 'utf8').replaceAll('\r\n', '\n'), 'Stale shared app module: ' + sharedRelative);
    sharedSeen.add(sharedRelative);
    continue;
  }
  assert.ok(!source.includes('/packages/shared/src/'), 'Shared source from another checkout: ' + source);
  // Metro emits project files as /App.tsx and /src/... but outside-root
  // dependency/junction sources as absolute paths. Compare contents in both.
  const projectRelative = /^\/?(?:App\.tsx$|src\/)/.test(source);
  if (!projectRelative && !/\/apps\/mobile\/(?:App\.tsx|src\/)/.test(source)) continue;
  assert.ok(projectRelative || source.startsWith(base), 'APK contains app source from another checkout: ' + source);
  const relative = projectRelative ? source.replace(/^\//, '') : source.slice(base.length);
  assert.ok(!relative.split('/').includes('..'), 'Unsafe source map path');
  const actual = map.sourcesContent?.[i];
  assert.equal(typeof actual, 'string', 'Missing source content: ' + relative);
  assert.ok(actual.replaceAll('\r\n', '\n') === readFileSync(resolve(mobile, relative), 'utf8').replaceAll('\r\n', '\n'), 'Stale bundled app source: ' + relative);
  seen.add(relative);
}
assert.ok(seen.has('App.tsx') && seen.has('src/screens/SchedulesScreen.tsx'), 'Required application screens absent from bundle');
assert.ok(sharedSeen.has('src/run-presentation.ts') && sharedSeen.has('src/chat-lifecycle.ts'), 'Required shared lifecycle modules absent from bundle');
console.log(`APK source provenance verified: ${seen.size} current app modules, ${sharedSeen.size} shared modules`);
