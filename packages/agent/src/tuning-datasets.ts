import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const TUNING_DATASET_LIMITS = { bytes: 2 * 1024 * 1024, rows: 2000, messages: 64, messageBytes: 32 * 1024, datasets: 100, issues: 100 } as const;
export interface TuningMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface TuningExample { messages: TuningMessage[]; group?: string }
export interface TuningDatasetInput { jsonl: string; seed?: string; evalFraction?: number }
export interface TuningDatasetIssue { row?: number; severity: 'error' | 'warning'; code: string; message: string }
export interface TuningDatasetValidation {
  valid: boolean; importable: boolean; inputRows: number; uniqueRows: number; duplicateRows: number;
  groups: number; trainRows: number; evalRows: number; bytes: number;
  issues: TuningDatasetIssue[]; credentialRisks: number; piiRisks: number;
}
export interface TuningDatasetSummary {
  id: string; name: string; createdAt: number; seed: string; evalFraction: number; piiReviewed: boolean;
  counts: { inputRows: number; uniqueRows: number; duplicateRows: number; groups: number; trainRows: number; evalRows: number; bytes: number };
}
export interface TuningDatasetExport { dataset: TuningDatasetSummary; directory: string; trainPath: string; evalPath: string; manifestPath: string }
interface StoredDataset { version: 1; summary: TuningDatasetSummary; examples: TuningExample[]; fingerprint: string }
interface Prepared { validation: TuningDatasetValidation; examples: TuningExample[]; train: TuningExample[]; evaluation: TuningExample[]; seed: string; evalFraction: number }

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).every(key => keys.includes(key));

/** Conservative screening, not a guarantee that text contains no sensitive data. Never return matched text. */
export function tuningTextRisks(value: string): { credentials: boolean; pii: boolean } {
  const credentials = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/u.test(value)
    || /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[0-9A-Za-z-]{10,}|cfast_[A-Za-z0-9]{48})\b/u.test(value)
    || /\b(?:[MNO][A-Za-z0-9_-]{22,30}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}|mfa\.[A-Za-z0-9_-]{80,})\b/u.test(value)
    || /dpapi:v1(?::|\/)[A-Za-z0-9+/=]{16,}/u.test(value)
    || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(value)
    || /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|authorization)\s*[=:]\s*["']?(?:bearer\s+)?[A-Za-z0-9_+/.=-]{8,}/iu.test(value)
    || /\bBearer\s+[A-Za-z0-9_.~+/-]{16,}/iu.test(value)
    || /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/iu.test(value);
  const pii = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(value)
    || /(?:\b\d{6}-[1-4]\d{6}\b|\b01[016789][- .]?\d{3,4}[- .]?\d{4}\b|\+\d[\d ()-]{8,}\d)/u.test(value)
    || /(?:[A-Z]:[\\/]Users[\\/][^\\/\s]+|\/home\/[^/\s]+|\/Users\/[^/\s]+)/iu.test(value);
  return { credentials, pii };
}

function canonicalExample(example: TuningExample): string {
  return JSON.stringify(example.messages.map(message => ({ role: message.role, content: normalize(message.content) })));
}

function parseExample(value: unknown): TuningExample | undefined {
  if (!object(value) || !onlyKeys(value, ['messages', 'group']) || !Array.isArray(value.messages)
    || value.messages.length < 2 || value.messages.length > TUNING_DATASET_LIMITS.messages
    || (value.group !== undefined && (typeof value.group !== 'string' || !value.group.trim() || value.group.length > 200))) return undefined;
  const messages: TuningMessage[] = [];
  let next: 'user' | 'assistant' = 'user';
  for (const item of value.messages) {
    if (!object(item) || !onlyKeys(item, ['role', 'content']) || typeof item.content !== 'string'
      || !item.content.trim() || item.content.includes('\0') || Buffer.byteLength(item.content) > TUNING_DATASET_LIMITS.messageBytes) return undefined;
    if (item.role === 'system' && messages.length === 0) messages.push({ role: 'system', content: item.content });
    else if (item.role === next) {
      messages.push({ role: next, content: item.content });
      next = next === 'user' ? 'assistant' : 'user';
    } else return undefined;
  }
  if (messages.at(-1)?.role !== 'assistant' || !messages.some(message => message.role === 'user')) return undefined;
  return { messages, ...(typeof value.group === 'string' ? { group: value.group.trim() } : {}) };
}

/** Group every overlapping normalized user prompt and explicit source group before splitting. */
function split(examples: TuningExample[], seed: string, fraction: number): { examples: TuningExample[]; train: TuningExample[]; evaluation: TuningExample[]; groups: number } {
  const parents = examples.map((_, index) => index);
  const find = (index: number): number => { while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; } return index; };
  const keys = new Map<string, number>();
  examples.forEach((example, index) => {
    const values = example.messages.filter(message => message.role === 'user').map(message => `prompt:${hash(normalize(message.content))}`);
    if (example.group) values.push(`group:${hash(normalize(example.group))}`);
    for (const key of values) {
      const other = keys.get(key);
      if (other !== undefined) parents[find(index)] = find(other);
      else keys.set(key, index);
    }
  });
  const grouped = new Map<number, TuningExample[]>();
  examples.forEach((example, index) => { const key = find(index); grouped.set(key, [...(grouped.get(key) ?? []), example]); });
  const groups = [...grouped.values()].map(rows => {
    // Select a stable representative even when duplicate rows differ in spacing/case.
    const stable = [...rows].sort((a, b) => JSON.stringify(a.messages) < JSON.stringify(b.messages) ? -1 : JSON.stringify(a.messages) > JSON.stringify(b.messages) ? 1 : 0);
    const unique = [...new Map(stable.map(row => [canonicalExample(row), row])).values()];
    const group = hash(unique.map(canonicalExample).sort().join('\n'));
    return { rows: unique.map(row => ({ messages: row.messages, group })), key: hash(`${seed}\0${group}`) };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const heldOutCount = groups.length < 2 ? 0 : Math.max(1, Math.min(groups.length - 1, Math.round(groups.length * fraction)));
  const ordered = (rows: TuningExample[]): TuningExample[] => rows.sort((a, b) => canonicalExample(a).localeCompare(canonicalExample(b)));
  return { examples: ordered(groups.flatMap(group => group.rows)), evaluation: ordered(groups.slice(0, heldOutCount).flatMap(group => group.rows)), train: ordered(groups.slice(heldOutCount).flatMap(group => group.rows)), groups: groups.length };
}

function prepare(input: TuningDatasetInput): Prepared {
  const validation: TuningDatasetValidation = { valid: false, importable: false, inputRows: 0, uniqueRows: 0, duplicateRows: 0, groups: 0, trainRows: 0, evalRows: 0, bytes: 0, issues: [], credentialRisks: 0, piiRisks: 0 };
  let errors = 0;
  const issue = (severity: 'error' | 'warning', code: string, message: string, row?: number): void => {
    if (severity === 'error') errors++;
    if (validation.issues.length < TUNING_DATASET_LIMITS.issues) validation.issues.push({ severity, code, message, ...(row ? { row } : {}) });
  };
  const seed = typeof input?.seed === 'string' && input.seed.length > 0 && input.seed.length <= 64 ? input.seed : 'mr-robot-v1';
  const fraction = input?.evalFraction ?? 0.2;
  const empty = (): Prepared => ({ validation, examples: [], train: [], evaluation: [], seed, evalFraction: fraction });
  if (!input || typeof input.jsonl !== 'string') { issue('error', 'input', 'JSONL 문자열이 필요합니다.'); return empty(); }
  if (input.seed !== undefined && (typeof input.seed !== 'string' || !input.seed.length || input.seed.length > 64)) issue('error', 'seed', '분할 시드는 1~64자여야 합니다.');
  if (!Number.isFinite(fraction) || fraction < 0.05 || fraction > 0.5) issue('error', 'eval_fraction', '검증 비율은 0.05~0.5여야 합니다.');
  validation.bytes = Buffer.byteLength(input.jsonl);
  if (validation.bytes > TUNING_DATASET_LIMITS.bytes) { issue('error', 'size', '데이터셋은 최대 2MiB입니다.'); return empty(); }
  const lines = input.jsonl.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  const examples: TuningExample[] = [];
  const seen = new Set<string>();
  for (let line = 0; line < lines.length; line++) {
    if (!lines[line].trim()) continue;
    validation.inputRows++;
    if (validation.inputRows > TUNING_DATASET_LIMITS.rows) { issue('error', 'rows', '데이터셋은 최대 2,000행입니다.'); break; }
    let value: unknown;
    try { value = JSON.parse(lines[line]); } catch { issue('error', 'json', '올바른 JSON 객체가 아닙니다.', line + 1); continue; }
    const example = parseExample(value);
    if (!example) { issue('error', 'schema', 'messages의 system(선택) → user/assistant 순서와 문자열 content를 확인하세요. 마지막은 assistant여야 합니다.', line + 1); continue; }
    const risks = tuningTextRisks(example.messages.map(message => message.content).join('\n') + (example.group ?? ''));
    if (risks.credentials) { validation.credentialRisks++; issue('error', 'credential', '자격증명 의심 내용이 있어 저장을 차단했습니다. 원문을 검토해 제거하세요.', line + 1); }
    if (risks.pii) { validation.piiRisks++; issue('warning', 'pii', '이메일·전화번호·개인 경로 등 개인정보 의심 내용이 있습니다.', line + 1); }
    const fingerprint = hash(canonicalExample(example));
    if (seen.has(fingerprint)) validation.duplicateRows++;
    seen.add(fingerprint);
    examples.push(example);
  }
  validation.uniqueRows = seen.size;
  if (seen.size < 2) issue('error', 'examples', '분리 가능한 예제가 최소 2개 필요합니다.');
  const partition = split(examples, seed, fraction);
  if (Buffer.byteLength(partition.examples.map(example => JSON.stringify(example)).join('\n')) > TUNING_DATASET_LIMITS.bytes) issue('error', 'normalized_size', '그룹 메타데이터를 포함한 크기가 2MiB를 넘습니다. 입력을 더 작은 단위로 나누세요.');
  validation.groups = partition.groups;
  validation.trainRows = partition.train.length;
  validation.evalRows = partition.evaluation.length;
  if (partition.groups < 2 && examples.length >= 2) issue('error', 'leakage', '같은 질문·출처 그룹만 있어 학습/검증을 분리할 수 없습니다. 독립된 예제를 추가하세요.');
  if (seen.size < 100) issue('warning', 'small_dataset', '100개 미만의 예제입니다. 기능 시험은 가능하지만 일반화 성능을 입증하지 못합니다.');
  if (validation.duplicateRows) issue('warning', 'duplicates', '정규화 후 중복된 예제는 제거됩니다.');
  validation.valid = errors === 0;
  validation.importable = validation.valid && validation.piiRisks === 0;
  return { validation, ...partition, seed, evalFraction: fraction };
}

function assertWithin(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error('학습 데이터 경로가 보관 영역을 벗어났습니다.');
}

function privateWrite(file: string, raw: string): void {
  const temporary = `${file}.tmp-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, raw, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, file);
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function validSummary(value: unknown): value is TuningDatasetSummary {
  if (!object(value) || typeof value.id !== 'string' || !ID.test(value.id) || typeof value.name !== 'string'
    || !value.name.trim() || value.name.length > 80 || typeof value.seed !== 'string' || !value.seed.length || value.seed.length > 64
    || typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || typeof value.evalFraction !== 'number' || value.evalFraction < 0.05 || value.evalFraction > 0.5
    || typeof value.piiReviewed !== 'boolean' || !object(value.counts)) return false;
  const names = ['inputRows', 'uniqueRows', 'duplicateRows', 'groups', 'trainRows', 'evalRows', 'bytes'];
  const counts = value.counts;
  return names.every(name => Number.isSafeInteger(counts[name]) && Number(counts[name]) >= 0)
    && Number(counts.uniqueRows) <= TUNING_DATASET_LIMITS.rows
    && Number(counts.trainRows) + Number(counts.evalRows) === Number(counts.uniqueRows)
    && Number(counts.bytes) <= TUNING_DATASET_LIMITS.bytes;
}

/** Opt-in, local-host administrator only. No conversation import, network, execution, or credential storage. */
export class LocalTuningDatasets {
  readonly root: string;
  constructor(home: string) { this.root = resolve(home, 'private', 'tuning'); }

  validate(input: TuningDatasetInput): TuningDatasetValidation { return prepare(input).validation; }

  private directory(path: string): void {
    assertWithin(this.root, path);
    // Refuse symlink/junction redirects under the configured home, including private/ and tuning/.
    const home = dirname(dirname(this.root));
    mkdirSync(home, { recursive: true, mode: 0o700 });
    let current = home;
    for (const segment of relative(home, path).split(/[\\/]/u)) {
      current = join(current, segment);
      if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
      if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory()) throw new Error('학습 데이터 보관 경로는 링크가 아닌 전용 폴더여야 합니다.');
    }
    assertWithin(realpathSync(home), realpathSync(path));
  }

  private file(id: string): string {
    if (!ID.test(id)) throw new Error('데이터셋 식별자가 올바르지 않습니다.');
    return join(this.root, 'datasets', `${id}.json`);
  }

  private read(id: string): StoredDataset {
    this.directory(join(this.root, 'datasets'));
    const file = this.file(id);
    const stats = lstatSync(file);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > TUNING_DATASET_LIMITS.bytes * 2) throw new Error('학습 데이터 저장 파일이 올바르지 않습니다.');
    const stored = JSON.parse(readFileSync(file, 'utf8')) as StoredDataset;
    if (stored.version !== 1 || !validSummary(stored.summary) || stored.summary.id !== id || !Array.isArray(stored.examples)
      || stored.examples.length > TUNING_DATASET_LIMITS.rows || stored.examples.some(example => !parseExample(example))
      || stored.fingerprint !== hash(JSON.stringify(stored.examples))) throw new Error('학습 데이터 무결성 검사가 실패했습니다.');
    return stored;
  }

  import(input: TuningDatasetInput & { name: string; acknowledgePii?: boolean }): TuningDatasetSummary {
    const prepared = prepare(input);
    if (!prepared.validation.valid) throw new Error('학습 데이터 검증에 실패했습니다. 검증 결과를 확인하세요.');
    if (prepared.validation.piiRisks && input.acknowledgePii !== true) throw new Error('개인정보 의심 항목을 검토한 뒤 명시적으로 확인해야 저장할 수 있습니다.');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || /[\x00-\x1f]/u.test(input.name)) throw new Error('데이터셋 이름은 1~80자여야 합니다.');
    if (tuningTextRisks(input.name).credentials || tuningTextRisks(prepared.seed).credentials) throw new Error('이름 또는 분할 시드에 자격증명을 저장할 수 없습니다.');
    this.directory(join(this.root, 'datasets'));
    if (readdirSync(join(this.root, 'datasets')).filter(name => ID.test(name.replace(/\.json$/u, ''))).length >= TUNING_DATASET_LIMITS.datasets) throw new Error('로컬 데이터셋은 최대 100개입니다.');
    const { inputRows, uniqueRows, duplicateRows, groups, trainRows, evalRows, bytes } = prepared.validation;
    const summary: TuningDatasetSummary = { id: randomUUID(), name: input.name.trim(), createdAt: Date.now(), seed: prepared.seed,
      evalFraction: prepared.evalFraction, piiReviewed: input.acknowledgePii === true, counts: { inputRows, uniqueRows, duplicateRows, groups, trainRows, evalRows, bytes } };
    privateWrite(this.file(summary.id), JSON.stringify({ version: 1, summary, examples: prepared.examples, fingerprint: hash(JSON.stringify(prepared.examples)) } satisfies StoredDataset));
    // Small commit/index record keeps opening the settings screen independent of corpus size.
    privateWrite(join(this.root, 'datasets', `${summary.id}.meta.json`), JSON.stringify(summary));
    return structuredClone(summary);
  }

  list(): TuningDatasetSummary[] {
    if (!existsSync(this.root)) return [];
    this.directory(join(this.root, 'datasets'));
    const files = readdirSync(join(this.root, 'datasets')).filter(name => name.endsWith('.meta.json') && ID.test(name.slice(0, -10)));
    if (files.length > TUNING_DATASET_LIMITS.datasets) throw new Error('학습 데이터 저장 개수를 초과했습니다.');
    return files.map(name => {
      const file = join(this.root, 'datasets', name);
      const stats = lstatSync(file);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 4096) throw new Error('학습 데이터 목록이 올바르지 않습니다.');
      const summary: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!validSummary(summary) || summary.id !== name.slice(0, -10)) throw new Error('학습 데이터 목록의 무결성 검사가 실패했습니다.');
      return summary;
    }).sort((a, b) => b.createdAt - a.createdAt);
  }

  export(id: string): TuningDatasetExport {
    const stored = this.read(id);
    const prepared = prepare({ jsonl: stored.examples.map(row => JSON.stringify(row)).join('\n'), seed: stored.summary.seed, evalFraction: stored.summary.evalFraction });
    if (!prepared.validation.valid || (prepared.validation.piiRisks && !stored.summary.piiReviewed)) throw new Error('저장된 데이터의 재검증에 실패했습니다.');
    const directory = join(this.root, 'exports', id);
    this.directory(directory);
    const trainPath = join(directory, 'train.jsonl');
    const evalPath = join(directory, 'eval.jsonl');
    const manifestPath = join(directory, 'manifest.json');
    // The trainer must not receive group metadata or internal stored fingerprints.
    const serialize = (examples: TuningExample[]): string => examples.map(example => JSON.stringify({ messages: example.messages })).join('\n') + '\n';
    const train = serialize(prepared.train);
    const evaluation = serialize(prepared.evaluation);
    for (const file of [trainPath, evalPath, manifestPath]) if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('내보내기 대상이 링크입니다.');
    privateWrite(trainPath, train); privateWrite(evalPath, evaluation);
    // Publish last. The training script validates both checksums before reading data.
    privateWrite(manifestPath, JSON.stringify({ version: 1, kind: 'mr-robot-local-sft', dataset: stored.summary, trainSha256: hash(train), evalSha256: hash(evaluation),
      privacyReviewed: true, splitPolicy: 'connected-normalized-user-prompts-and-explicit-source-groups', network: 'disabled', trainingStarted: false }, null, 2));
    return { dataset: structuredClone(stored.summary), directory, trainPath, evalPath, manifestPath };
  }
}
