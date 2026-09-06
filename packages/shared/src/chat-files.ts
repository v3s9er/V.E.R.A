export interface ChatFileLink { path: string; name: string }

/** Native chat renders file actions separately, not as unusable Windows URLs. */
export function chatFileDisplayText(text: string): string {
  return text.replace(/\[([^\r\n]+?)\]\(<[A-Za-z]:[\\/][^<>\r\n]+>\)/g, '$1')
    .replace(/\[([^\r\n]+?)\]\([A-Za-z]:[\\/][^()\r\n]+\)/g, '$1');
}

/** File references are data, never shell commands or automatically fetched URLs. */
export function chatFileLinks(text: string): ChatFileLink[] {
  const paths = new Set<string>();
  for (const match of text.slice(0, 200_000).matchAll(/<([A-Za-z]:[\\/][^<>\r\n]+)>|\]\(([A-Za-z]:[\\/][^()\r\n]+)\)/g)) {
    const path = (match[1] || match[2]).trim().replaceAll('/', '\\');
    if (path.length > 1024 || /[\x00-\x1f]/.test(path) || path.slice(2).includes(':')) continue;
    paths.add(path);
    if (paths.size >= 12) break;
  }
  return [...paths].map(path => ({ path, name: path.split('\\').pop() || '파일' }));
}
