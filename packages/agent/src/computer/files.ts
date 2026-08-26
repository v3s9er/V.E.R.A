import { promises as fs } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { FsEntry } from '@mr-robot/shared';

function toAbs(p: string): string {
  return resolve(p);
}

export async function listFiles(path: string): Promise<FsEntry[]> {
  const abs = toAbs(path);
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries: FsEntry[] = [];
  for (const e of dirents) {
    const full = resolve(abs, e.name);
    try {
      const st = await fs.stat(full);
      entries.push({
        name: e.name,
        path: full,
        isDirectory: e.isDirectory(),
        size: st.size,
        modifiedAt: st.mtimeMs,
      });
    } catch {
      // Skip entries that vanish mid-scan.
    }
  }
  entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
  return entries;
}

/** Read up to `maxBytes` from a UTF-8 file (never slurps unbounded input). */
export async function readFileText(path: string, maxBytes = 20000): Promise<string> {
  const abs = toAbs(path);
  const handle = await fs.open(abs, 'r');
  try {
    const stat = await handle.stat();
    const len = Math.min(Math.max(0, maxBytes), stat.size);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await handle.read(buf, 0, len, 0);
    const truncated = stat.size > maxBytes;
    const text = buf.toString('utf8', 0, bytesRead);
    return truncated ? text + `\n…[truncated: ${stat.size} bytes total]` : text;
  } finally {
    await handle.close();
  }
}

export async function writeFileText(path: string, content: string, append = false): Promise<{ path: string; bytes: number }> {
  const abs = toAbs(path);
  await fs.mkdir(dirname(abs), { recursive: true });
  if (append) await fs.appendFile(abs, content, 'utf8');
  else await fs.writeFile(abs, content, 'utf8');
  return { path: abs, bytes: Buffer.byteLength(content, 'utf8') };
}

export async function deletePath(path: string, recursive = false): Promise<{ path: string }> {
  const abs = toAbs(path);
  await fs.rm(abs, { recursive, force: false });
  return { path: abs };
}

export async function movePath(from: string, to: string): Promise<{ from: string; to: string }> {
  const a = toAbs(from);
  const b = toAbs(to);
  await fs.mkdir(dirname(b), { recursive: true });
  await fs.rename(a, b);
  return { from: a, to: b };
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(toAbs(path));
    return true;
  } catch {
    return false;
  }
}

export function joinPath(base: string, ...parts: string[]): string {
  return [base, ...parts].join(sep);
}
