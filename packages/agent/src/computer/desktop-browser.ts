import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export function browserUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f"<>\\]/.test(value)) throw Error('브라우저 주소 형식이 올바르지 않습니다.');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw Error('인증정보가 없는 http/https 웹 주소만 열 수 있습니다.');
  return url.href;
}

/** Fixed installed browser paths and an argv array, never shell syntax, arbitrary
 * executables or custom URL schemes. No global CLI/OS policy is changed. */
export function browserInvocation(browser: unknown, url: unknown, env: NodeJS.ProcessEnv = process.env, exists = existsSync) {
  if (browser !== 'edge' && browser !== 'chrome') throw Error('지원하는 브라우저는 Edge와 Chrome입니다.');
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.ProgramW6432, env.LOCALAPPDATA].filter((v): v is string => !!v);
  const suffix = browser === 'edge' ? 'Microsoft/Edge/Application/msedge.exe' : 'Google/Chrome/Application/chrome.exe';
  const command = roots.map(root => join(root, suffix)).find(exists);
  if (!command) throw Error('선택한 브라우저의 설치 경로를 찾지 못했습니다. 다른 프로그램으로 자동 대체하지 않습니다.');
  return { command, args: ['--new-window', browserUrl(url)] };
}

export async function launchDesktopBrowser(input: Record<string, unknown>, signal: AbortSignal) {
  signal.throwIfAborted();
  if (process.platform !== 'win32') throw Error('Windows에서만 브라우저 열기를 지원합니다.');
  const { command, args } = browserInvocation(input.browser, input.url);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(systemroot|windir|comspec|path|pathext|temp|tmp|userprofile|appdata|localappdata|programdata|programfiles|programfiles\(x86\)|programw6432|os)$/i.test(key)));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, shell: false, windowsHide: false, detached: true, stdio: 'ignore' });
    child.once('error', () => reject(Error('브라우저 실행을 완료하지 못했습니다. OS 또는 브라우저 정책을 확인하세요. 자동 재시도하지 않습니다.')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  signal.throwIfAborted();
  return { action: { name: 'open_browser', verification: 'unverified' }, browser: input.browser,
    notice: '브라우저에 새 창 열기를 요청했습니다. 페이지 로드나 창 표시를 보장하지 않습니다. desktop_windows와 desktop_observe로 실제 결과를 확인하세요.' };
}
