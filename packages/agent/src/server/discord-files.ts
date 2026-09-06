import { basename, relative } from 'node:path';
import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { resolveConfinedPath } from './http.js';

export function readDiscordFile(root: string, path: string, offset: number, limit: number, version?: string) {
  const target = resolveConfinedPath(root, relative(root, path));
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('파일 전송 요청이 올바르지 않습니다.');
  const fd = openSync(target, 'r');
  try {
    const stat = fstatSync(fd), current = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
    if (!stat.isFile() || stat.size > Math.min(limit, 25 * 1024 * 1024)) throw new Error('Discord 첨부 한도를 초과했습니다. 모바일 앱의 암호화 파일 전송을 사용하세요.');
    if (offset > stat.size || version && version !== current) throw new Error('전송 중 파일이 변경됐습니다. 다시 요청하세요.');
    const bytes = Buffer.alloc(Math.min(128 * 1024, stat.size - offset));
    const size = readSync(fd, bytes, 0, bytes.length, offset);
    return { name: basename(target), size: stat.size, version: current, offset, data: bytes.subarray(0, size).toString('base64'), done: offset + size === stat.size };
  } finally { closeSync(fd); }
}
