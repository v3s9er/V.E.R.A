import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { MemoryItem } from '@mr-robot/shared';

const MAX_FILES = 64, MAX_BYTES = 128 * 1024;
const packageName = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 180 && /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(value);
const inside = (root: string, path: string) => { const r = relative(root, path); return !isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`); };
type Manifest = { name: string; path: string; digest: string; at: number; data: Record<string, any> };
export interface ProjectKnowledge { facts: MemoryItem[]; partial: boolean }

/** Only selected-project package metadata; no scripts, dependency URLs, credentials,
 * document contents, network, traversal, or persistent memory writes. */
export async function readProjectKnowledge(workspacePath: string, workspaceId: string): Promise<ProjectKnowledge> {
  const output: ProjectKnowledge = { facts: [], partial: false };
  const root = await realpath(workspacePath).catch(() => '');
  if (!root) return output;
  const safePath = async (path: string) => {
    if (!inside(root, path)) return false;
    let current = root;
    for (const part of relative(root, path).split(sep).filter(Boolean)) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) return false;
    }
    return inside(root, await realpath(path));
  };
  const read = async (directory: string): Promise<Manifest | undefined> => {
    const path = join(directory, 'package.json');
    try {
      if (!await safePath(path)) { output.partial = true; return; }
      const before = await lstat(path, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > MAX_BYTES) { output.partial = true; return; }
      const file = await open(path, 'r');
      try {
        const stat = await file.stat({ bigint: true });
        if (!stat.isFile() || stat.size > MAX_BYTES || stat.ino !== before.ino || stat.dev !== before.dev) { output.partial = true; return; }
        // Fixed-size read remains bounded even if another process grows the file.
        const bytes = Buffer.alloc(MAX_BYTES + 1);
        let count = 0;
        while (count < bytes.length) {
          const next = await file.read(bytes, count, bytes.length - count, count);
          if (!next.bytesRead) break;
          count += next.bytesRead;
        }
        if (count > MAX_BYTES) { output.partial = true; return; }
        const after = await lstat(path, { bigint: true });
        if (!await safePath(path) || !after.isFile() || after.nlink !== 1n || after.ino !== stat.ino || after.dev !== stat.dev
          || after.mtimeNs !== stat.mtimeNs || after.size !== BigInt(count)) { output.partial = true; return; }
        const body = bytes.subarray(0, count);
        const data: unknown = JSON.parse(body.toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data) || !packageName((data as any).name)) { output.partial = true; return; }
        return { name: (data as any).name, path: relative(root, path).split(sep).join('/'), digest: createHash('sha256').update(body).digest('hex'), at: Number(stat.mtimeMs), data: data as Record<string, any> };
      } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') output.partial = true; return; }
  };
  const primary = await read(root);
  if (!primary) return output;
  const manifests = [primary];
  const raw = primary.data.workspaces;
  const patterns: unknown[] = Array.isArray(raw) ? raw : Array.isArray(raw?.packages) ? raw.packages : [];
  const directories = new Set<string>([root]);
  let entries = 0;
  const add = async (directory: string) => {
    if (directories.has(directory)) return;
    if (directories.size >= MAX_FILES) { output.partial = true; return; }
    directories.add(directory);
    const manifest = await read(directory);
    if (manifest) manifests.push(manifest);
  };
  for (const pattern of patterns.slice(0, MAX_FILES)) {
    // Deliberately small glob vocabulary: literal relative directories or trailing /*.
    if (typeof pattern !== 'string' || pattern.length > 180 || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*(?:\/\*)?$/.test(pattern)
      || pattern.split('/').some(p => p === '..' || p === '.' || p === 'node_modules' || p.startsWith('.'))) { output.partial = true; continue; }
    const wildcard = pattern.endsWith('/*');
    const base = resolve(root, wildcard ? pattern.slice(0, -2) : pattern);
    if (!wildcard) { await add(base); continue; }
    try {
      if (!await safePath(base)) { output.partial = true; continue; }
      const dir = await opendir(base);
      for await (const entry of dir) {
        if (++entries > 256 || directories.size >= MAX_FILES) { output.partial = true; break; }
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') await add(join(base, entry.name));
        else if (entry.isSymbolicLink()) output.partial = true;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') output.partial = true; }
  }
  if (patterns.length > MAX_FILES) output.partial = true;
  const names = new Set(manifests.map(m => m.name));
  for (const m of manifests) {
    const addFact = (predicate: string, object: string) => {
      const relation = { subject: m.name, predicate, object };
      output.facts.push({ id: `manifest:${createHash('sha256').update(JSON.stringify([workspaceId, m.path, m.digest, relation])).digest('hex').slice(0, 24)}`,
        text: `${m.name} ${predicate} ${object}`, tags: ['project-metadata'], createdAt: m.at, updatedAt: m.at, workspaceId,
        source: `project-manifest:${m.path}#sha256=${m.digest}`, relationMode: 'fact', relation });
    };
    addFact('located_in', m.path.replace(/\/?package.json$/, '') || '.');
    if (m !== primary && m.name !== primary.name) addFact('part_of', primary.name);
    const deps = new Set<string>();
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const values = m.data[field];
      if (values && typeof values === 'object' && !Array.isArray(values)) for (const name of Object.keys(values)) if (names.has(name)) deps.add(name);
    }
    for (const name of [...deps].sort()) addFact('depends_on', name);
  }
  return output;
}
