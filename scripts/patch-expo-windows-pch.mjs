import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.platform !== 'win32') process.exit(0);

const file = resolve('apps/mobile/node_modules/expo-modules-core/android/cmake/common.cmake');
if (!existsSync(file)) process.exit(0);

const source = readFileSync(file, 'utf8');
if (source.includes('if(NOT CMAKE_HOST_WIN32)')) process.exit(0);

const block = `target_precompile_headers(
  EXPO_COMMON
  INTERFACE
  \${CMAKE_SOURCE_DIR}/src/main/cpp/ExpoHeader.pch
)`;
const replacement = `# Mr.Robot: non-ASCII Windows checkout workaround (same headers, no PCH).
if(NOT CMAKE_HOST_WIN32)
  ${block}
endif()`;

if (!source.includes(block)) {
  console.warn('[Mr.Robot] Expo PCH pattern changed; Windows non-ASCII path patch was skipped.');
  process.exit(0);
}

writeFileSync(file, source.replace(block, replacement), 'utf8');
console.log('[Mr.Robot] Patched Expo Android PCH for non-ASCII Windows paths.');
