/** Primary ARC-AGI-2 data only. No upstream executable code is downloaded. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ARC_REVISION = 'f3283f727488ad98fe575ea6a5ac981e4a188e49';
export const ARC_MANIFEST_SHA256 = '9f2da6db0d779f6bdda014de1c23c4c0cbe9f5eea1a24b58aab07d47c6c8b1b3';
export const ARC_LICENSE_SHA256 = '8360699be7ffadd4b460e4287c1f7d0ada282518ee8e375fff603b1b3ecbb43f';
export const ARC_SOURCE = 'https://github.com/arcprize/ARC-AGI-2';
export const ARC_RAW = `https://raw.githubusercontent.com/arcprize/ARC-AGI-2/${ARC_REVISION}`;
export const ARC_KNOWN_DEVELOPMENT_IDS = ['2c181942', '38007db0', '3dc255db', '88bcf3b4'] as const;
export type ArcGrid = number[][];
export interface ArcVisible { train: Array<{ input: ArcGrid; output: ArcGrid }>; test: Array<{ input: ArcGrid }> }
export interface ArcTask { id: string; visible: ArcVisible; expected: ArcGrid[]; sourceSha256: string }
export interface ArcManifestEntry { id: string; path: string; gitBlobSha1: string }
type Selection = { kind: 'development' | 'locally-unused'; seed: string; ids: string[]; excludedIds: string[];
  inventory: Array<{ path: string; sha256: string; ids: string[] }>; coverage: string };
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const blobDigest = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}$/.test(value);
const validIds = (value: unknown): value is string[] => Array.isArray(value) && value.every(validId) && new Set(value).size === value.length;

function grid(value: unknown): ArcGrid {
  if (!Array.isArray(value) || !value.length || value.length > 30 || !Array.isArray(value[0]) || !value[0].length || value[0].length > 30
    || !value.every(row => Array.isArray(row) && row.length === value[0].length && row.every(cell => Number.isInteger(cell) && cell >= 0 && cell <= 9))) throw new Error('Invalid ARC grid');
  return value.map(row => [...row]);
}
export function parseArcTask(id: string, value: unknown, sourceSha256 = ''): ArcTask {
  const task = value as any;
  if (!validId(id) || !task || !Array.isArray(task.train) || !Array.isArray(task.test)
    || task.train.length < 1 || task.train.length > 20 || task.test.length < 1 || task.test.length > 20) throw new Error('Invalid ARC task');
  // Construct a fresh whitelist projection; never spread a test pair containing its answer.
  const train = task.train.map((pair: any) => ({ input: grid(pair?.input), output: grid(pair?.output) }));
  const test = task.test.map((pair: any) => ({ input: grid(pair?.input) }));
  const expected = task.test.map((pair: any) => grid(pair?.output));
  return { id, visible: { train, test }, expected, sourceSha256 };
}
export function arcPrompt(visible: ArcVisible): string {
  const render = (value: ArcGrid) => value.map(row => row.join('')).join('\n');
  return 'Infer the grid transformation from ALL demonstration pairs and apply it to EVERY test input. Digits 0-9 are colour symbols; positions and dimensions matter. Use only the supplied grids. Bounded local scratch calculations and configured read-only helpers are allowed when useful. Do not access the network, external files, accounts, answer keys or other conversations. This is a text-grid reasoning task, not image recognition. Return one final answer per test input, in order, using exactly: OUTPUT 1, digit-only grid rows, END; then OUTPUT 2 if needed. No prose, markdown fences, alternative answers or extra blocks.\n\n'
    + visible.train.map((pair, index) => `TRAIN ${index + 1} INPUT\n${render(pair.input)}\nTRAIN ${index + 1} OUTPUT\n${render(pair.output)}`).join('\n\n')
    + '\n\n' + visible.test.map((pair, index) => `TEST ${index + 1} INPUT\n${render(pair.input)}`).join('\n\n');
}
export function gradeArc(text: string, expected: readonly ArcGrid[]) {
  const invalid = () => ({ passed: false, failure: 'answer_format', correctOutputs: 0, expectedOutputs: expected.length });
  if (!expected.length || text.length > 25_000) return invalid();
  const lines = text.trim().split(/\r?\n/), outputs: ArcGrid[] = [];
  let position = 0;
  for (let index = 0; index < expected.length; index++) {
    if (lines[position++] !== `OUTPUT ${index + 1}`) return invalid();
    const rows: ArcGrid = [];
    while (position < lines.length && lines[position] !== 'END') {
      const line = lines[position++];
      if (!/^[0-9]{1,30}$/.test(line) || rows.length >= 30) return invalid();
      rows.push([...line].map(Number));
    }
    if (lines[position++] !== 'END' || !rows.length || rows.some(row => row.length !== rows[0].length)) return invalid();
    outputs.push(rows);
    while (lines[position] === '') position++;
  }
  if (position !== lines.length) return invalid();
  const correctOutputs = outputs.filter((output, index) => JSON.stringify(output) === JSON.stringify(expected[index])).length;
  return { passed: correctOutputs === expected.length, failure: correctOutputs === expected.length ? null : 'wrong_answer', correctOutputs, expectedOutputs: expected.length };
}

export function selectArcIds(ids: readonly string[], excluded: readonly string[], seed: string, count: number): string[] {
  if (!validIds([...ids]) || !validIds([...excluded]) || !seed || seed.length > 200 || !Number.isInteger(count) || count < 1 || count > ids.length) throw new Error('Invalid ARC selection');
  const excludedSet = new Set(excluded);
  const selected = ids.filter(id => !excludedSet.has(id)).sort((a, b) => digest(`${seed}:data/evaluation/${a}.json`).localeCompare(digest(`${seed}:data/evaluation/${b}.json`)) || a.localeCompare(b)).slice(0, count);
  if (selected.length !== count) throw new Error('Insufficient locally unused ARC tasks');
  return selected;
}
/** Inspect only identifier fields; never print or retain report prompts/answers. */
export function extractArcIds(value: unknown): string[] {
  const found = new Set<string>();
  const inspect = (entry: unknown, field = '', depth = 0): void => {
    if (depth > 30) return;
    if (typeof entry === 'string' && ['id', 'taskId', 'ids', 'taskIds'].includes(field)) {
      const id = entry.replace(/^arc-/, ''); if (validId(id)) found.add(id);
    } else if (Array.isArray(entry)) {
      // Grid/prompt/answer bodies cannot contain identifier fields and are not scanned.
      if (!['input', 'output', 'expected', 'outputs', 'train', 'test', 'messages', 'manifest'].includes(field)) entry.forEach(item => inspect(item, field, depth + 1));
    } else if (entry && typeof entry === 'object') {
      for (const [key, item] of Object.entries(entry)) if (!['prompt', 'text', 'answer', 'expected', 'messages', 'task', 'manifest'].includes(key)) inspect(item, key, depth + 1);
    }
  };
  inspect(value); return [...found].sort();
}
function validateManifest(value: unknown): ArcManifestEntry[] {
  if (!Array.isArray(value) || value.length !== 120) throw new Error('ARC evaluation manifest must contain 120 tasks');
  const manifest = value.map(row => {
    if (!row || !validId(row.id) || row.path !== `data/evaluation/${row.id}.json` || !/^[a-f0-9]{40}$/.test(row.gitBlobSha1)) throw new Error('Invalid ARC manifest entry');
    return { id: row.id, path: row.path, gitBlobSha1: row.gitBlobSha1 };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (!validIds(manifest.map(row => row.id)) || digest(JSON.stringify(manifest)) !== ARC_MANIFEST_SHA256) throw new Error('Pinned ARC manifest checksum mismatch');
  return manifest;
}
function readRegular(path: string, maximum: number): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error('Invalid ARC evidence file');
  return readFileSync(path);
}
export function readArcCache(path: string): { tasks: ArcTask[]; selection: Selection; sha256: string } {
  const bytes = readRegular(path, 5_000_000), cache = JSON.parse(bytes.toString('utf8'));
  if (cache.schemaVersion !== 1 || cache.dataset !== 'arcprize/ARC-AGI-2' || cache.revision !== ARC_REVISION || cache.split !== 'data/evaluation'
    || cache.declaredLicense !== 'Apache-2.0' || typeof cache.licenseText !== 'string' || digest(cache.licenseText) !== ARC_LICENSE_SHA256) throw new Error('Unexpected ARC provenance or license');
  const manifest = validateManifest(cache.manifest), selection = cache.selection as Selection;
  if (!selection || !['development', 'locally-unused'].includes(selection.kind) || !validIds(selection.ids) || !selection.ids.length || !validIds(selection.excludedIds)
    || !Array.isArray(selection.inventory) || typeof selection.seed !== 'string' || typeof selection.coverage !== 'string'
    || !Array.isArray(cache.records) || cache.records.length !== selection.ids.length) throw new Error('Invalid ARC selection record');
  for (const row of selection.inventory) if (!row || typeof row.path !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256) || !validIds(row.ids)) throw new Error('Invalid ARC exclusion inventory');
  if (selection.kind === 'locally-unused') {
    if (!ARC_KNOWN_DEVELOPMENT_IDS.every(id => selection.excludedIds.includes(id)) || selection.inventory.some(row => row.ids.some(id => !selection.excludedIds.includes(id)))) throw new Error('Incomplete ARC exclusions');
    const selected = selectArcIds(manifest.map(row => row.id), selection.excludedIds, selection.seed, selection.ids.length);
    if (JSON.stringify(selected) !== JSON.stringify(selection.ids)) throw new Error('ARC selection is not the frozen identifier-only sample');
  }
  const tasks = cache.records.map((record: any, index: number) => {
    if (record?.id !== selection.ids[index] || typeof record.rawJson !== 'string') throw new Error('Invalid ARC record order');
    const pinned = manifest.find(row => row.id === record.id), raw = Buffer.from(record.rawJson);
    if (!pinned || raw.length > 100_000 || blobDigest(raw) !== pinned.gitBlobSha1 || digest(raw) !== record.sha256) throw new Error('Pinned ARC task checksum mismatch');
    return parseArcTask(record.id, JSON.parse(record.rawJson), record.sha256);
  });
  return { tasks, selection, sha256: digest(bytes) };
}

async function fetchPrimary(url: string, maximum: number): Promise<Buffer> {
  if (!url.startsWith(`${ARC_RAW}/`) && url !== `https://api.github.com/repos/arcprize/ARC-AGI-2/git/trees/${ARC_REVISION}?recursive=1`) throw new Error('Only pinned primary ARC data is allowed');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'Vera-local-evaluation' } });
  if (!response.ok) throw new Error(`ARC primary source HTTP ${response.status}`);
  const chunks: Uint8Array[] = []; let length = 0;
  for await (const chunk of response.body!) { length += chunk.length; if (length > maximum) throw new Error('ARC primary response exceeds size limit'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export async function prepareArcCache(argv: string[]): Promise<void> {
  const raw: Record<string, string> = {}, allowed = new Set(['out-cache', 'reports-dir', 'selection', 'seed', 'count', 'ids']);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '');
    if (!argv[index]?.startsWith('--') || !allowed.has(key) || key in raw || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Invalid ARC preparation option');
    raw[key] = argv[index + 1];
  }
  if (!raw['out-cache'] || !['development', 'locally-unused'].includes(raw.selection)) throw new Error('Required --out-cache and --selection development|locally-unused');
  const output = resolve(raw['out-cache']); if (existsSync(output)) throw new Error('Existing ARC cache is never overwritten');
  if (raw.selection === 'locally-unused' && (!raw['reports-dir'] || !raw.seed || raw.ids)) throw new Error('Locally unused selection requires --reports-dir and --seed, without --ids');
  if (raw.selection === 'development' && (!raw.ids || raw['reports-dir'] || raw.count || raw.seed)) throw new Error('Development selection requires explicit --ids only');
  const tree = JSON.parse((await fetchPrimary(`https://api.github.com/repos/arcprize/ARC-AGI-2/git/trees/${ARC_REVISION}?recursive=1`, 1_000_000)).toString('utf8'));
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('Incomplete ARC repository tree');
  const manifest = validateManifest(tree.tree.filter((row: any) => row.type === 'blob' && /^data\/evaluation\/[a-f0-9]{8}\.json$/.test(row.path))
    .map((row: any) => ({ id: row.path.slice(-13, -5), path: row.path, gitBlobSha1: row.sha })));
  const inventory: Selection['inventory'] = [], excluded = new Set<string>(ARC_KNOWN_DEVELOPMENT_IDS);
  if (raw.selection === 'locally-unused') {
    const directory = resolve(raw['reports-dir']), files = readdirSync(directory).filter(name => name.endsWith('.json')).sort();
    if (files.length > 2000) throw new Error('Too many ARC exclusion reports');
    for (const name of files) {
      const bytes = readRegular(join(directory, name), 20_000_000), ids = extractArcIds(JSON.parse(bytes.toString('utf8'))).filter(id => manifest.some(row => row.id === id));
      if (ids.length) { inventory.push({ path: name, sha256: digest(bytes), ids }); ids.forEach(id => excluded.add(id)); }
    }
    if (!inventory.length) throw new Error('No prior ARC identifiers found; exclusion coverage must be reviewed');
  }
  const ids = raw.selection === 'development' ? raw.ids.split(',') : selectArcIds(manifest.map(row => row.id), [...excluded].sort(), raw.seed, raw.count === undefined ? 6 : Number(raw.count));
  if (!validIds(ids) || !ids.length || ids.some(id => !manifest.some(row => row.id === id))) throw new Error('Unknown ARC evaluation IDs');
  const selection: Selection = { kind: raw.selection as Selection['kind'], seed: raw.seed ?? '', ids, excludedIds: [...excluded].sort(), inventory,
    coverage: 'Identifier fields from top-level JSON in the specified validation directory, plus known development IDs. Not proof of absence from other local history or model training.' };
  // Freeze selection before requesting any selected task contents. Never print grids.
  console.log(JSON.stringify({ event: 'arc-selection', revision: ARC_REVISION, kind: selection.kind, ids, excludedIds: selection.excludedIds, inventoryFiles: inventory.length }));
  const licenseText = (await fetchPrimary(`${ARC_RAW}/LICENSE`, 50_000)).toString('utf8');
  if (digest(licenseText) !== ARC_LICENSE_SHA256) throw new Error('Pinned ARC license checksum mismatch');
  const records = [];
  for (const id of ids) {
    const entry = manifest.find(row => row.id === id)!, bytes = await fetchPrimary(`${ARC_RAW}/${entry.path}`, 100_000);
    if (blobDigest(bytes) !== entry.gitBlobSha1) throw new Error('Pinned ARC task checksum mismatch');
    parseArcTask(id, JSON.parse(bytes.toString('utf8')));
    records.push({ id, rawJson: bytes.toString('utf8'), sha256: digest(bytes) });
  }
  const cache = { schemaVersion: 1, dataset: 'arcprize/ARC-AGI-2', revision: ARC_REVISION, split: 'data/evaluation', declaredLicense: 'Apache-2.0', licenseText, manifest, selection, records };
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(cache, null, 2)}\n`, { flag: 'wx' });
  const verified = readArcCache(output);
  console.log(JSON.stringify({ event: 'arc-cache-ready', sha256: verified.sha256, tasks: verified.tasks.length, testInputs: verified.tasks.reduce((count, task) => count + task.visible.test.length, 0), inference: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) prepareArcCache(process.argv.slice(2)).catch(() => { console.error('ARC preparation failed; no inference was started. Check arguments, pinned-source access and exclusion inventory.'); process.exitCode = 1; });
