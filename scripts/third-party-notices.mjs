import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = join(repoRoot, 'THIRD_PARTY_NOTICES.txt');
const legalFilePattern = /^(?:(?:licen[cs]e|unlicense|notice|copying|copyright(?:[-_. ]?notice)?)(?:[._ -].*)?|third[-_. ]?party[-_. ]?(?:notices?(?:[-_. ]?text)?|licen[cs]es?)(?:[._ -].*)?|.+\.licen[cs]e(?:\..*)?)$/i;
const maxLegalFileBytes = 8 * 1024 * 1024;
const sortText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function readOutputArgument(argv) {
  let output = defaultOutput;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output') {
      const value = argv[index + 1];
      if (!value) throw new Error('--output requires a file path');
      output = resolve(value);
      index += 1;
    } else if (argument.startsWith('--output=')) {
      output = resolve(argument.slice('--output='.length));
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return output;
}

function parseJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function normalizeLocation(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe package-lock location: ${value}`);
  }
  return normalized === '.' ? '' : normalized;
}

function packageDirectory(baseDirectory, location) {
  const normalized = normalizeLocation(location);
  const directory = resolve(baseDirectory, ...normalized.split('/').filter(Boolean));
  const base = resolve(baseDirectory);
  if (directory !== base && !directory.startsWith(`${base}${sep}`)) {
    throw new Error(`Package path escapes its install root: ${location}`);
  }
  return directory;
}

function dependencyCandidates(fromLocation, dependencyName) {
  const candidates = [];
  let current = normalizeLocation(fromLocation);
  while (true) {
    candidates.push(normalizeLocation(posix.join(current, 'node_modules', dependencyName)));
    if (!current) break;
    const parent = posix.dirname(current);
    current = parent === '.' ? '' : parent;
  }
  return [...new Set(candidates)];
}

function resolveDependency(packages, fromLocation, dependencyName) {
  return dependencyCandidates(fromLocation, dependencyName).find((candidate) => packages[candidate]);
}

function productionClosure(lock, label, baseDirectory) {
  const packages = lock.packages;
  if (!packages || typeof packages !== 'object') {
    throw new Error(`${label}: package-lock.json does not contain a packages map`);
  }

  const visited = new Set();
  const externalLocations = new Set();
  const workspaceRoots = Object.keys(packages)
    .map(normalizeLocation)
    .filter((location) => !location.split('/').includes('node_modules'))
    .sort(sortText);

  const visitDependency = (fromLocation, dependencyName, optional) => {
    const resolvedLocation = resolveDependency(packages, fromLocation, dependencyName);
    if (!resolvedLocation) {
      if (optional) return;
      throw new Error(`${label}: cannot resolve ${dependencyName} from ${fromLocation || '<root>'}`);
    }
    const resolvedEntry = packages[resolvedLocation];
    if (optional && !resolvedEntry.link && !existsSync(join(packageDirectory(baseDirectory, resolvedLocation), 'package.json'))) {
      // package-lock records optional binaries for every supported platform.
      // Only the package selected by npm for this build can enter this artifact.
      return;
    }
    visitPackage(resolvedLocation);
  };

  const visitEdges = (location, entry) => {
    for (const dependencyName of Object.keys(entry.dependencies ?? {}).sort(sortText)) {
      visitDependency(location, dependencyName, false);
    }
    for (const dependencyName of Object.keys(entry.optionalDependencies ?? {}).sort(sortText)) {
      visitDependency(location, dependencyName, true);
    }
    for (const dependencyName of Object.keys(entry.peerDependencies ?? {}).sort(sortText)) {
      const optional = entry.peerDependenciesMeta?.[dependencyName]?.optional === true;
      visitDependency(location, dependencyName, optional);
    }
  };

  const visitPackage = (rawLocation) => {
    const location = normalizeLocation(rawLocation);
    if (visited.has(location)) return;
    const entry = packages[location];
    if (!entry) throw new Error(`${label}: missing lock entry for ${location}`);
    visited.add(location);

    if (entry.link) {
      const target = normalizeLocation(entry.resolved);
      const targetEntry = packages[target];
      if (!targetEntry) throw new Error(`${label}: broken workspace link ${location} -> ${target}`);
      visitEdges(target, targetEntry);
      return;
    }

    externalLocations.add(location);
    visitEdges(location, entry);
  };

  for (const workspaceLocation of workspaceRoots) {
    const entry = packages[workspaceLocation];
    if (entry?.dev === true) continue;
    visitEdges(workspaceLocation, entry);
  }

  return [...externalLocations].sort(sortText);
}

function normalizedLicenseExpression(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const values = value.map(normalizedLicenseExpression).filter((item) => item !== '(not declared)');
    if (values.length > 0) return values.join(' OR ');
  }
  if (value && typeof value === 'object' && typeof value.type === 'string') return value.type.trim();
  return '(not declared)';
}

function readPackageRecord(baseDirectory, location, lockEntry, label) {
  const directory = packageDirectory(baseDirectory, location);
  const manifestPath = join(directory, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`${label}: npm install is incomplete; missing package.json for ${location}`);
  }
  const manifest = parseJson(manifestPath);
  const name = String(manifest.name ?? lockEntry.name ?? location.split('/node_modules/').at(-1) ?? '').trim();
  const version = String(lockEntry.version ?? manifest.version ?? '').trim();
  if (!name || !version) throw new Error(`${label}: package name/version is missing for ${location}`);
  if (lockEntry.version && manifest.version !== lockEntry.version) {
    throw new Error(`${label}: installed package is stale for ${name}; lock=${lockEntry.version}, installed=${manifest.version ?? '(missing)'}`);
  }

  const legalFiles = [];
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && legalFilePattern.test(entry.name))
    .sort((left, right) => sortText(left.name.toLowerCase(), right.name.toLowerCase()) || sortText(left.name, right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const size = statSync(path).size;
    if (size > maxLegalFileBytes) {
      throw new Error(`${label}: legal file exceeds ${maxLegalFileBytes} bytes: ${name}@${version}/${entry.name}`);
    }
    const raw = readFileSync(path);
    if (raw.includes(0)) {
      throw new Error(`${label}: legal file is not text: ${name}@${version}/${entry.name}`);
    }
    const text = raw.toString('utf8')
      .replace(/^\uFEFF/, '')
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''))
      .join('\n')
      .trimEnd();
    legalFiles.push({ name: entry.name, text });
  }

  return {
    name,
    version,
    license: normalizedLicenseExpression(lockEntry.license ?? manifest.license ?? manifest.licenses),
    legalFiles,
  };
}

function collectInventory() {
  const sources = [
    { label: 'Desktop', directory: repoRoot, lockPath: join(repoRoot, 'package-lock.json') },
    { label: 'Mobile', directory: join(repoRoot, 'apps', 'mobile'), lockPath: join(repoRoot, 'apps', 'mobile', 'package-lock.json') },
  ];
  const inventory = new Map();

  for (const source of sources) {
    const lock = parseJson(source.lockPath);
    for (const location of productionClosure(lock, source.label, source.directory)) {
      const record = readPackageRecord(source.directory, location, lock.packages[location], source.label);
      const key = `${record.name}\0${record.version}`;
      let combined = inventory.get(key);
      if (!combined) {
        combined = {
          name: record.name,
          version: record.version,
          licenses: new Set(),
          products: new Set(),
          legalFiles: new Map(),
        };
        inventory.set(key, combined);
      }
      combined.licenses.add(record.license);
      combined.products.add(source.label);
      for (const file of record.legalFiles) {
        const digest = createHash('sha256').update(file.text).digest('hex');
        combined.legalFiles.set(`${file.name.toLowerCase()}\0${digest}`, file);
      }
    }
  }

  return [...inventory.values()].sort((left, right) =>
    sortText(left.name.toLowerCase(), right.name.toLowerCase())
      || sortText(left.name, right.name)
      || sortText(left.version, right.version));
}

function render(inventory) {
  const lines = [
    'MR.ROBOT THIRD-PARTY SOFTWARE NOTICES',
    '',
    'This file is generated from the production dependency closures recorded in',
    'package-lock.json and apps/mobile/package-lock.json. It intentionally contains',
    'no generation timestamp, machine path, environment variable, or credential.',
    '',
    `Package count: ${inventory.length}`,
    '',
  ];

  for (const record of inventory) {
    lines.push('='.repeat(80));
    lines.push(`${record.name}@${record.version}`);
    lines.push(`Products: ${[...record.products].sort(sortText).join(', ')}`);
    lines.push(`SPDX license expression: ${[...record.licenses].sort(sortText).join(' | ')}`);
    const legalFiles = [...record.legalFiles.values()].sort((left, right) =>
      sortText(left.name.toLowerCase(), right.name.toLowerCase())
        || sortText(left.name, right.name)
        || sortText(left.text, right.text));
    if (legalFiles.length === 0) {
      lines.push('License/notice files: none found in the installed package root.');
      lines.push('');
      continue;
    }
    lines.push('');
    for (const file of legalFiles) {
      lines.push(`--- ${file.name} ---`);
      lines.push(file.text || '(empty file)');
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

const outputPath = readOutputArgument(process.argv.slice(2));
const inventory = collectInventory();
const rendered = render(inventory);
writeFileSync(outputPath, rendered, 'utf8');
console.log(`Third-party notices generated: ${outputPath} (${inventory.length} packages)`);
