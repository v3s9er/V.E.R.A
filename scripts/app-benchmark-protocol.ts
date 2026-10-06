import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AIME_JSON_SHA256, AIME_REVISION, gradeAime, readAimeCache, selectAimeYear } from './benchmark-aime-data.js';
import { ARC_LICENSE_SHA256, ARC_MANIFEST_SHA256, ARC_RAW, ARC_REVISION, ARC_SOURCE, arcPrompt, gradeArc, readArcCache, type ArcGrid } from './benchmark-arc-data.js';
import { workCaseRoutePolicy, workOntologyTasks, type WorkScenario } from './app-benchmark-work.js';

export type Arm = 'single' | 'adaptive' | 'ontology-adaptive';
export interface Relation { subject: string; predicate: string; object: string }
export interface BenchmarkTask {
  id: string; prompt: string; relations: Relation[]; expected: number | string | ArcGrid[];
  sourceSha256?: string; testInputs?: number; recallCase?: 'exact' | 'absent' | 'hub'; answerLines?: number; work?: WorkScenario;
}
export interface BenchmarkOptions {
  appPath: string; expectedVersion: string; suite: 'aime' | 'relations' | 'arc2' | 'knowledge-recall' | 'work-ontology'; cache?: string; year: number;
  model: string; effort: string; arms: Arm[]; repetitions: number; deadlineMs: number;
  prefix: string; cli: string; planOnly: boolean; preflightOnly: boolean; allowUsage: boolean; seed: string;
  ids?: string[]; tokenPolicy: 'quality' | 'audit-only'; planHash?: string; arcSelection?: 'development' | 'locally-unused';
}
// Stay well below the product's 120 RPC messages per 10-second window during setup.
export const KNOWLEDGE_RECALL_MEMORY_ADD_INTERVAL_MS = 250;
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function parseOptions(argv: string[]): BenchmarkOptions {
  const allowed = new Set(['app-path', 'expected-version', 'suite', 'cache', 'year', 'model', 'effort', 'arms', 'repetitions', 'timeout-ms', 'out-prefix', 'cli', 'plan-only', 'preflight-only', 'allow-account-usage', 'seed', 'ids', 'token-policy', 'plan-hash', 'arc-selection']);
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.replace(/^--/, '');
    if (!argv[i]?.startsWith('--') || !allowed.has(name) || name in raw || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Invalid, missing or repeated benchmark option');
    raw[name] = argv[i + 1];
  }
  for (const key of ['app-path', 'expected-version', 'model', 'effort', 'out-prefix']) if (!raw[key]) throw new Error(`Required --${key}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(raw.model)) throw new Error('Exact model ID required');
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(raw.effort)) throw new Error('Explicit reasoning effort required');
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(raw['expected-version'])) throw new Error('Exact application version required');
  const suite = raw.suite ?? 'aime';
  if (!['aime', 'relations', 'arc2', 'knowledge-recall', 'work-ontology'].includes(suite)) throw new Error('Unknown suite');
  const arms = (raw.arms ?? (suite === 'work-ontology' ? 'single' : suite === 'knowledge-recall' ? 'ontology-adaptive' : suite === 'relations' ? 'single,adaptive,ontology-adaptive' : 'single,adaptive')).split(',') as Arm[];
  if (!arms.length || new Set(arms).size !== arms.length || arms.some(arm => !['single', 'adaptive', 'ontology-adaptive'].includes(arm))) throw new Error('Invalid benchmark arms');
  if (suite === 'knowledge-recall' && (arms.length !== 1 || arms[0] !== 'ontology-adaptive')) throw new Error('Knowledge recall compares application versions using only ontology-adaptive');
  if (suite === 'work-ontology' && (arms.length !== 1 || arms[0] !== 'single' || raw.model !== 'gpt-6-sol' || raw.effort !== 'high')) throw new Error('Work ontology requires the single arm with requested gpt-6-sol and high effort');
  if (['aime', 'arc2'].includes(suite) && arms.includes('ontology-adaptive')) throw new Error('AIME/ARC have no supplied ontology: use the separate relations suite');
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = raw[name] === undefined ? fallback : Number(raw[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid --${name}`);
    return value;
  };
  for (const key of ['plan-only', 'preflight-only', 'allow-account-usage']) if (raw[key] !== undefined && !['yes', 'no'].includes(raw[key])) throw new Error(`Invalid --${key}`);
  const planOnly = raw['plan-only'] === 'yes', preflightOnly = raw['preflight-only'] === 'yes', allowUsage = raw['allow-account-usage'] === 'yes';
  if (planOnly && preflightOnly) throw new Error('Choose one non-inference mode');
  if (!planOnly && !preflightOnly && !allowUsage) throw new Error('Execution requires --allow-account-usage yes');
  if (['aime', 'arc2'].includes(suite) && !raw.cache) throw new Error('Pinned --cache required for public tasks');
  if (suite === 'knowledge-recall' && (raw.cache || raw.year)) throw new Error('Knowledge recall uses generated memory facts; do not supply --cache or --year');
  if (suite === 'work-ontology' && (raw.cache || raw.year)) throw new Error('Work ontology uses generated workspace fixtures; do not supply --cache or --year');
  const tokenPolicy = raw['token-policy'] ?? 'audit-only';
  if (!['quality', 'audit-only'].includes(tokenPolicy)) throw new Error('Invalid token policy');
  if (tokenPolicy !== 'audit-only' && arms.some(arm => arm !== 'single')) throw new Error('Adaptive helpers require --token-policy audit-only in the current product');
  if (raw['plan-hash'] && !/^[a-f0-9]{64}$/.test(raw['plan-hash'])) throw new Error('Invalid plan hash');
  if (suite === 'work-ontology' && !planOnly && !preflightOnly && !raw['plan-hash']) throw new Error('Work ontology execution requires an explicit frozen --plan-hash');
  const ids = raw.ids?.split(',');
  if (ids && (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !(suite === 'arc2' ? /^[a-f0-9]{8}$/ : /^\d{4}-AIME-(I|II)-\d{2}$/).test(id)))) throw new Error('Invalid benchmark IDs');
  if (ids && ['relations', 'knowledge-recall', 'work-ontology'].includes(suite)) throw new Error('--ids is only for public development subsets');
  if (suite === 'arc2') {
    if (!['development', 'locally-unused'].includes(raw['arc-selection'])) throw new Error('Explicit --arc-selection required');
    if ((raw['arc-selection'] === 'development') !== Boolean(ids)) throw new Error('Only ARC development selection requires explicit --ids');
    if (raw.year || raw.seed) throw new Error('ARC selection is frozen in its prepared cache; do not supply --year or --seed');
  } else if (raw['arc-selection']) throw new Error('--arc-selection is only for ARC');
  return { appPath: resolve(raw['app-path']), expectedVersion: raw['expected-version'], suite: suite as BenchmarkOptions['suite'], cache: raw.cache && resolve(raw.cache), year: integer('year', 2022, 2022, 2024), model: raw.model, effort: raw.effort, arms, repetitions: integer('repetitions', 2, 1, 20), deadlineMs: integer('timeout-ms', suite === 'arc2' ? 600_000 : 300_000, 10_000, 1_200_000), prefix: resolve(raw['out-prefix']), cli: raw.cli ?? 'codex', planOnly, preflightOnly, allowUsage, seed: raw.seed ?? (suite === 'work-ontology' ? 'vera-work-ontology-v1' : suite === 'knowledge-recall' ? 'vera-knowledge-recall-v1' : 'vera-relations-v1'), ids, tokenPolicy: tokenPolicy as BenchmarkOptions['tokenPolicy'], planHash: raw['plan-hash'], arcSelection: raw['arc-selection'] as BenchmarkOptions['arcSelection'] };
}

function regularFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('Application input must be a regular, non-linked file');
}
export function validateAppPath(input: string): { kind: 'stage' | 'installed'; path: string; files: string[]; version?: string } {
  const path = resolve(input), stat = lstatSync(path);
  if (stat.isSymbolicLink() || realpathSync(path).toLowerCase() !== path.toLowerCase()) throw new Error('Application path must be canonical and not a symlink');
  if (stat.isDirectory()) {
    const files = ['package.json', 'main.mjs', 'preload.cjs', 'agent.mjs'].map(name => join(path, name));
    files.forEach(regularFile);
    const manifest = JSON.parse(readFileSync(files[0], 'utf8'));
    if (!['mr-robot-desktop', 'vera-desktop'].includes(manifest.name) || manifest.main !== 'main.mjs') throw new Error('Not a staged application');
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isFile() && /\.(?:mjs|cjs|json)$/.test(entry.name) && !files.includes(join(path, entry.name))) { regularFile(join(path, entry.name)); files.push(join(path, entry.name)); }
    }
    const walkWeb = (directory: string) => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const child = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Linked frontend asset');
        if (entry.isDirectory()) walkWeb(child);
        else { regularFile(child); files.push(child); }
        if (files.length > 10_000) throw new Error('Excessive staged asset count');
      }
    };
    walkWeb(join(path, 'web'));
    return { kind: 'stage', path, files: files.sort(), version: manifest.version };
  }
  regularFile(path);
  if (!/\.exe$/i.test(path)) throw new Error('Installed app must be a Windows executable');
  const archive = join(dirname(path), 'resources', 'app.asar');
  regularFile(archive);
  return { kind: 'installed', path, files: [path, archive] };
}
export function hashFiles(files: readonly string[]): Record<string, string> {
  return Object.fromEntries(files.map(path => [path.replaceAll('\\', '/'), sha256(readFileSync(path))]));
}
export function schedule(tasks: readonly Pick<BenchmarkTask, 'id'>[], arms: readonly Arm[], repetitions: number) {
  const rows: Array<{ taskId: string; arm: Arm; repetition: number }> = [];
  for (let repetition = 0; repetition < repetitions; repetition++) for (let index = 0; index < tasks.length; index++) {
    const shifted = arms.map((_, j) => arms[(index + j) % arms.length]);
    const ordered = repetition % 2 ? shifted.reverse() : shifted;
    rows.push(...ordered.map(arm => ({ taskId: tasks[index].id, arm, repetition })));
  }
  return rows;
}
export function relationTasks(seed: string): BenchmarkTask[] {
  return Array.from({ length: 6 }, (_, index) => {
    const suffix = sha256(`${seed}:${index}`).slice(0, 8);
    const a = `api_${suffix}`, b = `queue_${suffix}`, c = `store_${suffix}`, d = `docs_${suffix}`;
    const relations = [
      { subject: a, predicate: 'depends_on', object: b }, { subject: b, predicate: 'depends_on', object: c },
      { subject: d, predicate: 'part_of', object: `project_${suffix}` },
      { subject: a, predicate: 'owner', object: 'TeamA' }, { subject: a, predicate: 'owner', object: 'TeamB' },
    ];
    return { id: `relations-${index + 1}-${suffix}`, relations, expected: 'Q1: YES\nQ2: UNKNOWN\nQ3: CONFLICT\nQ4: UNKNOWN', prompt: `Use only these supplied dependency facts. depends_on is transitive; part_of alone does not imply depends_on. owner is single-valued and different assertions remain CONFLICT; no last-write-wins. Missing information means UNKNOWN.\n${relations.map(r => `${r.subject} | ${r.predicate} | ${r.object}`).join('\n')}\nDoes ${a} transitively depend on ${c}? Q1: YES, NO or UNKNOWN.\nDoes ${d} depend on ${c}? Q2: YES, NO or UNKNOWN.\nIs the owner of ${a} uniquely resolved? Q3: YES or CONFLICT.\nDo we know the owner of ${c}? Q4: YES or UNKNOWN.\nOutput exactly four Q1: VALUE through Q4: VALUE lines. You may inspect only supplied facts and the empty scratch workspace, and use configured helpers if worthwhile. No network, external files, answer keys or other conversations.` };
  });
}
/** Facts are seeded through scoped memory.add only; none are rendered into the question. */
export function knowledgeRecallTasks(seed: string): BenchmarkTask[] {
  const rules = 'Use only stored facts scoped to this project and conversation. Match complete entity identifiers exactly; similar names are different entities. depends_on is transitive; part_of alone does not imply depends_on. Different assertions for a single-valued status or owner remain CONFLICT; no last-write-wins. Report UNKNOWN for any unsupported claim. Do not substitute other entities or list unrelated facts. Local scratch and configured read-only helpers are allowed. No network, external files, other projects/conversations or answer keys.';
  const tasks: BenchmarkTask[] = [];
  for (const kind of ['exact', 'absent'] as const) {
    const suffix = sha256(`${seed}:${kind}`).slice(0, 8), scope = `@recall_${suffix}`;
    const target = `${scope}/name`, query = kind === 'exact' ? target : `${scope}/missing`;
    const relations = [{ subject: target, predicate: 'status', object: 'blocked' },
      ...Array.from({ length: 100 }, (_, i) => ({ subject: `${target}${i}`, predicate: 'status', object: 'ready' }))];
    tasks.push({ id: `knowledge-recall-${kind}-${suffix}`, recallCase: kind, answerLines: 2, relations,
      expected: `Q1: ${kind === 'exact' ? 'blocked' : 'UNKNOWN'}\nQ2: UNKNOWN`,
      prompt: `${rules}\nFor ${query}, what status is supported by stored facts? Q1: the exact stored value, CONFLICT or UNKNOWN.\nFor that same entity, what owner is supported? Q2: the exact stored value, CONFLICT or UNKNOWN.\nOutput exactly two lines: Q1: VALUE and Q2: VALUE. Preserve the case of stored values.` });
  }
  const suffix = sha256(`${seed}:hub`).slice(0, 8), scope = `@recall_${suffix}`;
  const target = `${scope}/service`, middle = `${scope}/queue`, core = `${scope}/store`, leaf = `${scope}/leaf`, hub = `${scope}/membership_${suffix}`;
  const relations = [
    { subject: target, predicate: 'depends_on', object: middle }, { subject: middle, predicate: 'depends_on', object: core },
    { subject: core, predicate: 'depends_on', object: leaf }, { subject: leaf, predicate: 'status', object: 'blocked' },
    { subject: leaf, predicate: 'status', object: 'ready' }, { subject: target, predicate: 'part_of', object: hub },
    ...Array.from({ length: 200 }, (_, i) => ({ subject: `${scope}/sibling${i}`, predicate: 'part_of', object: hub })),
  ];
  tasks.push({ id: `knowledge-recall-hub-${suffix}`, recallCase: 'hub', answerLines: 3, relations,
    expected: 'Q1: YES\nQ2: CONFLICT\nQ3: UNKNOWN',
    prompt: `${rules}\nStarting only at ${target}, does the stored depends_on graph support a dependency path of exactly three edges? Q1: YES or UNKNOWN.\nFor the terminal entity reached by that path, is its status uniquely resolved? Q2: YES, CONFLICT or UNKNOWN.\nFor the starting entity, what owner is supported? Q3: the exact stored value, CONFLICT or UNKNOWN.\nOutput exactly three lines: Q1: VALUE, Q2: VALUE and Q3: VALUE.` });
  return tasks;
}

/** Receipt + list read-back verifies setup independently of retrieval success or inference count. */
export function verifyKnowledgeRecallSetup(relations: readonly Relation[], receipts: readonly any[], stored: unknown,
  scope: { workspaceId: string; conversationId: string }) {
  const matches = (item: any, relation: Relation) => item && typeof item.id === 'string' && item.id.length > 0
    && item.workspaceId === scope.workspaceId && item.conversationId === scope.conversationId
    && item.relationMode === 'fact' && !item.supersededBy && canonicalJson(item.relation) === canonicalJson(relation);
  if (!relations.length || receipts.length !== relations.length || new Set(receipts.map(item => item?.id)).size !== relations.length
    || receipts.some((item, i) => !matches(item, relations[i])) || !Array.isArray(stored)) throw new Error('memory_setup_mismatch');
  const scoped = stored.filter(item => item && (!item.workspaceId || item.workspaceId === scope.workspaceId)
    && (!item.conversationId || item.conversationId === scope.conversationId));
  if (scoped.length !== relations.length || receipts.some((receipt, i) => {
    const rows = scoped.filter(item => item.id === receipt.id);
    return rows.length !== 1 || !matches(rows[0], relations[i]);
  })) throw new Error('memory_setup_mismatch');
  return { verified: true as const, expectedRelations: relations.length, receiptCount: receipts.length, storedCount: scoped.length,
    relationsSha256: sha256(canonicalJson(relations)) };
}

export function assertKnowledgeTelemetry(suite: BenchmarkOptions['suite'], arm: Arm, knowledge: any): void {
  // Missing-entity recall must be allowed to have zero asserted and inferred facts.
  if (suite === 'relations' && arm === 'ontology-adaptive' && !(knowledge?.asserted > 0 && knowledge?.inferred > 0)) throw new Error('ontology_not_observed');
}
export function loadTasks(options: BenchmarkOptions): BenchmarkTask[] {
  if (options.suite === 'work-ontology') return workOntologyTasks(options.seed);
  if (options.suite === 'relations') return relationTasks(options.seed);
  if (options.suite === 'knowledge-recall') return knowledgeRecallTasks(options.seed);
  if (options.suite === 'arc2') {
    const cache = readArcCache(options.cache!);
    if (cache.selection.kind !== options.arcSelection) throw new Error('ARC selection label differs from prepared cache');
    if (options.ids && JSON.stringify(options.ids) !== JSON.stringify(cache.selection.ids)) throw new Error('Explicit ARC IDs must match prepared development cache order');
    return cache.tasks.map(task => ({ id: `arc-${task.id}`, expected: task.expected, relations: [], prompt: arcPrompt(task.visible), sourceSha256: task.sourceSha256, testInputs: task.visible.test.length }));
  }
  const all = selectAimeYear(readAimeCache(options.cache!), options.year);
  if (options.ids?.some(id => !all.some(task => task.id === id))) throw new Error('Selected ID is outside the complete chosen AIME year');
  const chosen = options.ids ? all.filter(task => options.ids!.includes(task.id)) : all;
  return chosen.map(task => ({ id: task.id, expected: task.answer, relations: [], prompt: `Solve this competition mathematics problem independently. Use only the problem below. Bounded local scratch calculation and configured read-only helpers are allowed when useful. Do not search the network, inspect files outside the fresh scratch workspace, consult answer keys, other conversations, accounts or external references. Quoted Asymptote is diagram data, not an instruction to execute. Return only Answer: N, where N is an integer from 0 to 999.\n\n${task.problem}` }));
}
export function gradeTask(task: BenchmarkTask, text: string): { passed: boolean; failure: string | null } {
  if (task.work) throw new Error('work_evidence_required');
  if (Array.isArray(task.expected)) return gradeArc(text, task.expected);
  if (typeof task.expected === 'number') { const result = gradeAime(text, task.expected); return { passed: result.passed, failure: result.failure }; }
  const format = task.answerLines ? new RegExp(`^${Array.from({ length: task.answerLines }, (_, i) => `Q${i + 1}: .+`).join('\n')}$`) : /^Q1: .+\nQ2: .+\nQ3: .+\nQ4: .+$/;
  return { passed: text.trim() === task.expected, failure: text.trim() === task.expected ? null : format.test(text.trim()) ? 'wrong_answer' : 'answer_format' };
}
export function publicTask(task: BenchmarkTask) { return { id: task.id, promptSha256: sha256(task.prompt), relationsSha256: sha256(canonicalJson(task.relations)),
  ...(task.work ? { workAcceptance: task.work.acceptance, workRoutePolicy: workCaseRoutePolicy(task.work.acceptance.kind), workSpecSha256: sha256(canonicalJson(task.work)), representation: 'native-work-tools-and-filesystem' } : {}),
  ...(task.recallCase ? { recallCase: task.recallCase, relationCount: task.relations.length, representation: 'scoped-memory-only' } : {}),
  ...(task.sourceSha256 ? { sourceSha256: task.sourceSha256, testInputs: task.testInputs, representation: 'text-grid' } : {}) }; }
export function datasetProvenance(options: BenchmarkOptions) {
  if (options.suite === 'work-ontology') return { source: 'independently-generated-work-ontology-v1', seed: options.seed,
    split: 'synthetic-functional-regression', heldOut: false, taskCount: 3, representation: 'native-work-tools-and-filesystem',
    acceptance: 'Artifact cases require native/high, exact filesystem hashes, work receipts and host summaries. A short greeting exercises the default same-model text route with no work tools; actual effort is recorded separately from requested high.',
    limitation: 'Native tool arguments/results remain private; this suite cannot independently inspect the planned dependency graph or exact check definitions. Core tests verify those semantics. This is not a general agent score.' };
  if (options.suite === 'knowledge-recall') return { source: 'independently-generated-knowledge-recall-v1', seed: options.seed,
    split: 'synthetic-functional-regression', heldOut: false, taskCount: 3, representation: 'scoped-memory-only',
    comparison: 'same suite and ontology-adaptive arm across frozen application versions; not mode superiority',
    contamination: 'Deterministic synthetic fixtures for three known recall failure modes; repetitions are not independent tasks or a general accuracy benchmark.' };
  if (options.suite === 'arc2') {
    const cache = readArcCache(options.cache!);
    return { source: ARC_SOURCE, revision: ARC_REVISION, split: options.arcSelection === 'locally-unused' ? 'predeclared-locally-unused-public-subset' : 'explicit-development-subset', heldOut: false,
      selection: cache.selection, manifestSha256: ARC_MANIFEST_SHA256, cacheSha256: cache.sha256, declaredLicense: 'Apache-2.0', licenseUrl: `${ARC_RAW}/LICENSE`, licenseSha256: ARC_LICENSE_SHA256,
      representation: 'text-grid', score: 'exact-pass@1-all-test-grids', officialScore: false,
      contamination: 'Public evaluation tasks may be in training. Locally unused only means absent from the declared report inventory when selection was frozen; repetitions are not independent unseen tasks.' };
  }
  return options.suite === 'aime' ? { source: 'AI-MO/aimo-validation-aime', revision: AIME_REVISION, sha256: AIME_JSON_SHA256, year: options.year, split: options.ids ? 'explicit-development-subset' : 'complete-public-year', heldOut: false, contamination: 'Public tasks may be in model training; prior local runs exist.' } : { source: 'independently-generated-relations-v1', seed: options.seed, split: 'synthetic-functional-regression', heldOut: false };
}
export function usageCounts(value: any) {
  const valid = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  // Old versions omit trust metadata. Conservatively mark absent/zero reports unknown.
  const known = value && !['missing', 'invalid'].includes(value.reportStatus) && valid(value.promptTokens) && valid(value.completionTokens) && (value.promptTokens + value.completionTokens > 0 || ['reported', 'capped'].includes(value.reportStatus));
  return { promptTokens: known ? value.promptTokens as number : null, completionTokens: known ? value.completionTokens as number : null,
    totalTokens: known ? value.promptTokens + value.completionTokens : null, cachedPromptTokens: known && valid(value.cachedPromptTokens) ? value.cachedPromptTokens as number : null,
    reportStatus: known ? value.reportStatus ?? 'reported-positive-aggregate' : 'unknown' };
}
export function outputPaths(prefix: string) { return ['plan.json', 'manifest.json', 'progress.jsonl', 'report.json'].map(suffix => `${prefix}.${suffix}`); }
export function assertFreshOutputs(prefix: string): void { if (outputPaths(prefix).some(existsSync)) throw new Error('Existing benchmark evidence is never overwritten; choose a new prefix'); }
/** Check the effective server value, not the caller's requested permission. */
export function assertWorkspacePermission(value: unknown): void {
  if (value !== 'workspace') throw new Error('effective_permission_mismatch');
}
