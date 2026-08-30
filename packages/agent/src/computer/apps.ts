import type { ShellResult } from '@mr-robot/shared';
import { runShell } from './shell.js';

/** Single-quote a value for PowerShell (doubles embedded single quotes). */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Launch an app, open a file/folder, or navigate to a URL. Non-blocking. */
export async function launchApp(target: string, args: string[] = [], signal?: AbortSignal): Promise<ShellResult> {
  const argPart = args.length > 0 ? ` -ArgumentList ${args.map(psQuote).join(',')}` : '';
  const cmd = `Start-Process -FilePath ${psQuote(target)}${argPart}`;
  return runShell(cmd, { shell: 'powershell', timeoutMs: 15000, signal });
}
