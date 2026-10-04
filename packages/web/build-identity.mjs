import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Public source inputs only: never include runtime profiles, env files, paths,
// account metadata, build timestamps, or a machine-specific Git directory.
const INPUTS = ['src', 'public', 'index.html', 'package.json', 'vite.config.ts', 'build-identity.mjs', '../shared/src', '../shared/package.json'];

export function clientBuildIdentity(directory = dirname(fileURLToPath(import.meta.url))) {
  const hash = createHash('sha256');
  const add = (relative) => {
    const path = resolve(directory, relative);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error('Client identity inputs cannot be symbolic links.');
    if (entry.isDirectory()) {
      for (const name of readdirSync(path).sort()) add(`${relative}/${name}`);
      return;
    }
    if (!entry.isFile()) throw new Error('Client identity input must be a regular file.');
    hash.update(relative).update('\0').update(createHash('sha256').update(readFileSync(path)).digest()).update('\0');
  };
  for (const input of INPUTS) add(input);
  const { version } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid client package version.');
  return { version, build: hash.digest('hex').slice(0, 12) };
}
