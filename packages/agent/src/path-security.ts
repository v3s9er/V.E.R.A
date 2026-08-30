import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

function containedBy(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

/**
 * Resolve a model/client supplied path beneath one trusted workspace.
 *
 * Existing components are inspected one-by-one and reparse points are
 * rejected, so a symlink or Windows junction cannot redirect a later read or
 * mutation outside the selected workspace. Missing suffixes are allowed only
 * when the caller is preparing a new destination.
 */
export function resolveWorkspacePath(
  workspaceRoot: string,
  value: unknown,
  options: { mustExist?: boolean } = {},
): string {
  const root = resolve(workspaceRoot);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new Error('선택한 작업 폴더를 찾을 수 없습니다.');
  }
  const rootReal = realpathSync(root);
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('파일 경로가 필요합니다.');
  const target = resolve(isAbsolute(raw) ? raw : join(root, raw));
  if (!containedBy(root, target)) throw new Error('선택한 작업 폴더 밖의 경로는 사용할 수 없습니다.');

  const rel = relative(root, target);
  let cursor = root;
  for (const component of rel.split(/[\\/]+/).filter(Boolean)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) break;
    const entry = lstatSync(cursor);
    if (entry.isSymbolicLink()) throw new Error('심볼릭 링크나 junction을 통한 경로는 사용할 수 없습니다.');
    if (!containedBy(rootReal, realpathSync(cursor))) {
      throw new Error('선택한 작업 폴더 밖의 경로는 사용할 수 없습니다.');
    }
  }
  if (options.mustExist !== false && !existsSync(target)) throw new Error('요청한 파일 또는 폴더를 찾을 수 없습니다.');
  return target;
}

/** Resolve a path inside exactly one of the registered workspace roots. */
export function resolveRegisteredWorkspacePath(
  workspaceRoots: readonly string[],
  value: unknown,
  options: { mustExist?: boolean } = {},
): string {
  let lastError: unknown;
  for (const root of workspaceRoots) {
    try {
      return resolveWorkspacePath(root, value, options);
    } catch (error) {
      lastError = error;
    }
  }
  if (workspaceRoots.length === 0) throw new Error('등록된 작업 폴더가 없습니다.');
  throw lastError instanceof Error ? lastError : new Error('등록된 작업 폴더 밖의 경로는 사용할 수 없습니다.');
}
