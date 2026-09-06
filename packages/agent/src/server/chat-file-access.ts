import { win32 } from 'node:path';
import { chatFileLinks } from '@mr-robot/shared';

export function chatFileRoot(path: string, messages: Array<{ role: string; content: string }>, workspace: string | undefined, downloads: string, full: boolean): string | undefined {
  if (!/^[a-z]:[\\/]/i.test(path) || path.length > 1024 || /[\x00-\x1f]/.test(path) || path.slice(2).includes(':')) return;
  const normalized = win32.resolve(path).toLowerCase();
  const checked = normalized.split('\\').map(part => part.replace(/[ .]+$/g, '')).join('\\');
  // Chat links must never become a shortcut to credential stores, even with full access.
  if (/(?:^|[\\/])(?:\.mr-robot|\.nexus|\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.npmrc|\.netrc|\.git-credentials|\.codex|\.claude|\.git|appdata|\.env(?:\.[^\\/]*)?)(?:[\\/]|$)/i.test(checked)
    || /\.(?:pem|key|jks|keystore|pfx|p12|dpapi)$/i.test(checked)) return;
  if (!messages.some(m => m.role === 'assistant' && chatFileLinks(m.content).some(f => win32.resolve(f.path).toLowerCase() === normalized))) return;
  for (const root of [workspace, full ? downloads : undefined]) {
    if (!root) continue;
    const relative = win32.relative(win32.resolve(root), normalized);
    if (relative && !relative.startsWith('..') && !win32.isAbsolute(relative)) return root;
  }
}
