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
for (let i = 0; i < map.sources.length; i++) {
  const source = normalize(map.sources[i]);
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
console.log('APK source provenance verified: ' + seen.size + ' current app modules');
