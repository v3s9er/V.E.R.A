/**
 * License audit: lists the direct dependencies and their licenses, then scans
 * the whole node_modules tree for copyleft licenses (GPL/AGPL/LGPL/SSPL/BSL)
 * that could constrain a proprietary/installer distribution.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve('.');

// 1. direct deps (root + workspaces + mobile)
const manifests = ['.', 'packages/shared', 'packages/agent', 'packages/web', 'packages/desktop', 'apps/mobile'];
const direct = new Map();
for (const m of manifests) {
  const p = join(root, m, 'package.json');
  if (!existsSync(p)) continue;
  const pkg = JSON.parse(readFileSync(p, 'utf8'));
  for (const name of Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })) {
    if (name.startsWith('@mr-robot/')) continue;
    direct.set(name, { from: m, version: (pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]) ?? '?' });
  }
}

const licenseOf = (dir) => {
  try {
    const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return typeof p.license === 'string' ? p.license : p.license?.type ?? '(custom/see file)';
  } catch {
    return '?';
  }
};

console.log('=== DIRECT DEPENDENCIES ===');
for (const [name, meta] of [...direct.entries()].sort()) {
  const candidates = [join(root, meta.from, 'node_modules', name), join(root, 'node_modules', name)];
  const dir = candidates.find((candidate) => existsSync(candidate));
  const lic = dir ? licenseOf(dir) : '?';
  console.log(`${name.padEnd(44)} ${lic}`);
}

// 2. scan full tree for copyleft
const COPYLEFT = /\b(GPL|AGPL|LGPL|SSPL|BUSL|BSL|Elastic License|CC BY-NC|CC-BY-NC)\b/i;
const hasCopyleftAtom = (value) => COPYLEFT.test(String(value));

// An SPDX OR grants a choice. Copyleft is unavoidable only when every branch
// is copyleft. An AND requires every term, so one copyleft term is enough.
const hasUnavoidableCopyleft = (expression) => {
  if (typeof expression !== 'string' || !expression.trim()) return false;
  const tokens = expression.match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[^\s()]+/gi) ?? [];
  let cursor = 0;

  const parsePrimary = () => {
    const token = tokens[cursor++];
    if (!token) throw new Error('missing SPDX term');
    let result;
    if (token === '(') {
      result = parseOr();
      if (tokens[cursor++] !== ')') throw new Error('unclosed SPDX group');
    } else if (token === ')') {
      throw new Error('unexpected SPDX group close');
    } else {
      result = hasCopyleftAtom(token);
    }
    if (tokens[cursor]?.toUpperCase() === 'WITH') {
      cursor += 1;
      if (!tokens[cursor] || tokens[cursor] === '(' || tokens[cursor] === ')') throw new Error('missing SPDX exception');
      cursor += 1;
    }
    return result;
  };

  const parseAnd = () => {
    let result = parsePrimary();
    while (tokens[cursor]?.toUpperCase() === 'AND') {
      cursor += 1;
      result = parsePrimary() || result;
    }
    return result;
  };

  const parseOr = () => {
    let result = parseAnd();
    while (tokens[cursor]?.toUpperCase() === 'OR') {
      cursor += 1;
      result = parseAnd() && result;
    }
    return result;
  };

  try {
    const result = parseOr();
    if (cursor !== tokens.length) throw new Error('unexpected SPDX token');
    return result;
  } catch {
    // Custom/non-SPDX declarations remain conservatively classified, while a
    // clearly expressed OR still receives the same selectable-license logic.
    const alternatives = expression.split(/\s+OR\s+/i);
    return alternatives.length > 1
      ? alternatives.every((alternative) => hasCopyleftAtom(alternative))
      : hasCopyleftAtom(expression);
  }
};

for (const [expression, expected] of [
  ['BSD-3-Clause OR GPL-3.0-only', false],
  ['GPL-2.0-only OR AGPL-3.0-only', true],
  ['MIT AND LGPL-3.0-only', true],
  ['(GPL-3.0-only OR MIT) AND Apache-2.0', false],
]) {
  if (hasUnavoidableCopyleft(expression) !== expected) throw new Error(`SPDX classifier regression: ${expression}`);
}
const hits = new Map();
let scanned = 0;
const walk = (dir, depth) => {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith('@')) {
      // scoped: walk one level deeper
      const sub = join(dir, e.name);
      for (const s of readdirSync(sub, { withFileTypes: true })) {
        if (s.isDirectory()) {
          const pkg = join(sub, s.name, 'package.json');
          if (existsSync(pkg)) {
            scanned++;
            const lic = licenseOf(join(sub, s.name));
            if (hasUnavoidableCopyleft(String(lic))) hits.set(`${e.name}/${s.name}`, lic);
          }
        }
      }
    } else if (e.isDirectory()) {
      const pkg = join(dir, e.name, 'package.json');
      if (existsSync(pkg)) {
        scanned++;
        const lic = licenseOf(join(dir, e.name));
        if (hasUnavoidableCopyleft(String(lic))) hits.set(e.name, lic);
      }
    }
  }
};

const nm = join(root, 'node_modules');
walk(nm, 1);
// also apps/mobile/node_modules (separate install)
if (existsSync(join(root, 'apps/mobile/node_modules'))) walk(join(root, 'apps/mobile/node_modules'), 1);

console.log(`\n=== UNAVOIDABLE COPYLEFT SCAN (${scanned} packages) ===`);
if (hits.size === 0) {
  console.log('None found — no GPL/AGPL/LGPL/SSPL/BSL-style copyleft licenses.');
} else {
  for (const [name, lic] of hits) console.log(`${name.padEnd(40)} ${lic}`);
}
