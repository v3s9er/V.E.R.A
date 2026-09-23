/** Data-only, immutable upstream snapshot. No upstream Python/model code executes. */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const BFCL_REVISION = 'f7cf7359b7ac615a0b294831c5ba2bc95ee4a000';
const dataRoot = 'berkeley-function-call-leaderboard/bfcl_eval/data/';
export const BFCL_FILES = [
  { file: 'LICENSE', path: 'LICENSE', sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4' },
  { file: 'simple_python.questions.jsonl', path: `${dataRoot}BFCL_v4_simple_python.json`, sha256: '82dd63ba502eb2520c6b5d1d9a5c4b590e03ff261565175561f6228a367d1991' },
  { file: 'multiple.questions.jsonl', path: `${dataRoot}BFCL_v4_multiple.json`, sha256: 'aef168155ebd74b7ac2401198b201343bc7d16d7a3d7e0d4e6d8ee82c6969b2a' },
  { file: 'parallel.questions.jsonl', path: `${dataRoot}BFCL_v4_parallel.json`, sha256: '19f51a82eff42e5d62541aa500115a056eb78f437c2ba1f10415fd7c8e5dda84' },
  { file: 'irrelevance.questions.jsonl', path: `${dataRoot}BFCL_v4_irrelevance.json`, sha256: '2b6ed4c2e992cdcf5f1678a701851f944bef7550ee026ed1ddb89efed5be01a6' },
  { file: 'simple_python.answers.jsonl', path: `${dataRoot}possible_answer/BFCL_v4_simple_python.json`, sha256: '90cd5bc653690ee8e459b5b3f3fc9458606f7f3fcbf795bb51b7dc581f8c86dc' },
  { file: 'multiple.answers.jsonl', path: `${dataRoot}possible_answer/BFCL_v4_multiple.json`, sha256: '244e00ce9395df948bcafc7bee64e8f9c87ef70887587d83cae45b13699f3047' },
  { file: 'parallel.answers.jsonl', path: `${dataRoot}possible_answer/BFCL_v4_parallel.json`, sha256: '8a6aa19c1adddc6a5a2f7e40f9dbf30cc7e95815e7b830c90589ab318229e0f0' },
] as const;
export const benchmarkHash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function readBfclCache(directory: string): Record<string, string> {
  const folder = resolve(directory), output: Record<string, string> = {};
  const info = lstatSync(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Use an ordinary benchmark cache directory.');
  for (const file of BFCL_FILES) {
    const target = join(folder, file.file), stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid benchmark cache entry.');
    const bytes = readFileSync(target);
    if (benchmarkHash(bytes) !== file.sha256) throw new Error(`Pinned benchmark checksum mismatch: ${file.file}`);
    output[file.file] = bytes.toString('utf8');
  }
  return output;
}

export async function downloadBfclCache(directory: string) {
  const folder = resolve(directory);
  mkdirSync(folder, { recursive: true });
  if (lstatSync(folder).isSymbolicLink()) throw new Error('Linked benchmark cache refused.');
  for (const file of BFCL_FILES) {
    const target = join(folder, file.file);
    let existing = false;
    try { lstatSync(target); existing = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing) {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024 || benchmarkHash(readFileSync(target)) !== file.sha256) throw new Error('Existing cache differs; refusing overwrite.');
      continue;
    }
    const response = await fetch(`https://raw.githubusercontent.com/ShishirPatil/gorilla/${BFCL_REVISION}/${file.path}`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.body) throw new Error(`Benchmark download failed (${response.status}).`);
    const reader = response.body.getReader(), chunks: Buffer[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 2 * 1024 * 1024) throw new Error('Benchmark download too large.');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    const bytes = Buffer.concat(chunks);
    if (benchmarkHash(bytes) !== file.sha256) throw new Error(`Upstream checksum mismatch: ${file.file}`);
    writeFileSync(target, bytes, { flag: 'wx' });
  }
  return readBfclCache(folder);
}
