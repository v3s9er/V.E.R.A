import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(
  repoRoot,
  'apps/mobile/node_modules/expo-file-system/android/src/main/java/expo/modules/filesystem/legacy/FileSystemLegacyModule.kt',
);

// Root installs can run before the standalone mobile dependencies exist. The
// mobile package has its own postinstall hook, which applies this patch after
// expo-file-system is present.
if (!existsSync(file)) {
  console.log('[Mr.Robot] expo-file-system is not installed yet; mobile postinstall will apply the redirect patch.');
  process.exit(0);
}

const source = readFileSync(file, 'utf8');
const marker = '.followRedirects(false)';
if (source.includes(marker) && source.includes('.followSslRedirects(false)')) {
  console.log('[Mr.Robot] Expo FileSystem redirect hardening is already applied.');
  process.exit(0);
}

const anchor = `val builder = OkHttpClient.Builder()
          .connectTimeout(60, TimeUnit.SECONDS)`;
const replacement = `val builder = OkHttpClient.Builder()
          // Mr.Robot: never forward bearer or Cloudflare Access headers across
          // an HTTP redirect. Redirect responses are returned to JS as 3xx and
          // rejected before a temporary file is shared or an upload succeeds.
          .followRedirects(false)
          .followSslRedirects(false)
          .connectTimeout(60, TimeUnit.SECONDS)`;

if (!source.includes(anchor)) {
  throw new Error('[Mr.Robot] SECURITY: expo-file-system OkHttp pattern changed; refusing to install without redirect hardening.');
}

writeFileSync(file, source.replace(anchor, replacement), 'utf8');
console.log('[Mr.Robot] Patched Expo FileSystem to reject HTTP(S) redirects.');
