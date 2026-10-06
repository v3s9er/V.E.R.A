/** Small actual-application workflow fixtures; no provider calls or product implementation imports. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BenchmarkTask } from './app-benchmark-protocol.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const WORK_TOOLS = ['work_plan', 'work_update', 'work_check', 'work_status'] as const;
export type WorkTool = typeof WORK_TOOLS[number];
export interface WorkAcceptance {
  kind: 'create' | 'recovery' | 'greeting'; taskCount: number; checkCount: number;
  artifactSha256: string[]; requiresFailedCheck: boolean;
}
export interface WorkScenario {
  acceptance: WorkAcceptance;
  initialFiles: Array<{ path: string; content: string }>;
  artifacts: Array<{ path: string; sha256: string }>;
}
export interface WorkSummary {
  total: number; reported: number; verified: number; blocked: number; checksPassed: number; checksFailed: number; stale?: boolean;
}
export interface WorkEvidence {
  artifacts: Array<{ present: boolean; sha256: string | null; bytes: number | null; issue: string | null }>;
  tools: Array<{ name: WorkTool; status: 'start' | 'done' | 'error' }>;
  progress: WorkSummary[]; final: WorkSummary | null; invalidObservation: boolean;
}
export function validWorkAcceptance(value: any): value is WorkAcceptance {
  if (!value || !['create', 'recovery', 'greeting'].includes(value.kind)) return false;
  const expected = value.kind === 'greeting' ? 0 : value.kind === 'create' ? 1 : 2;
  return value.taskCount === expected && value.checkCount === expected && value.requiresFailedCheck === (value.kind === 'recovery')
    && Array.isArray(value.artifactSha256) && value.artifactSha256.length === expected
    && value.artifactSha256.every((hash: unknown) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash));
}
/** Requested high remains saved; the product may lower a trivial greeting's actual effort. */
export function workCaseRoutePolicy(kind: WorkAcceptance['kind']) {
  return { routingPresetId: null, transport: kind === 'greeting' ? 'codex-text' : 'codex-native',
    allowedEfforts: kind === 'greeting' ? ['low', 'high'] : ['high'], childDelegationRequired: false };
}
export function workRouteMatches(kind: WorkAcceptance['kind'], route: any, transport: unknown): boolean {
  const policy = workCaseRoutePolicy(kind);
  return policy.allowedEfforts.includes(route?.effort) && Array.isArray(transport) && transport.length > 0
    && transport.every(timing => timing?.transport === policy.transport);
}

export function workOntologyTasks(seed: string): BenchmarkTask[] {
  const suffix = digest(seed).slice(0, 12), result = `WORK_RESULT_${suffix}\n`, source = `WORK_SOURCE_${suffix}\n`, bundle = `WORK_BUNDLE_${suffix}\n`;
  const rules = 'Work only in the current fresh scratch workspace. Use the native work_plan, work_update, work_check and work_status tools to track and verify the requested work. File acceptance is exact UTF-8 without a BOM, with the specified final LF newline. Do not use network access, private files, other projects/conversations or external answer keys. Finish with a brief human-readable result, not tool JSON.';
  const createArtifact = { path: 'result.txt', sha256: digest(result) };
  const repairArtifacts = [{ path: 'source.txt', sha256: digest(source) }, { path: 'bundle.txt', sha256: digest(bundle) }];
  return [
    { id: `work-ontology-create-${suffix}`, relations: [], expected: '',
      work: { acceptance: { kind: 'create', taskCount: 1, checkCount: 1, artifactSha256: [createArtifact.sha256], requiresFailedCheck: false }, initialFiles: [], artifacts: [createArtifact] },
      prompt: `${rules}\nCreate result.txt containing exactly ${JSON.stringify(result)} (JSON string notation describes the bytes; do not write the quotes). Plan one task with id create-artifact and one sha256 acceptance check with id result-hash, path result.txt, expected ${createArtifact.sha256}. Mark the task running, create the file, then mark completed and run work_check. Finish by reading work_status.` },
    { id: `work-ontology-recovery-${suffix}`, relations: [], expected: '',
      work: { acceptance: { kind: 'recovery', taskCount: 2, checkCount: 2, artifactSha256: repairArtifacts.map(item => item.sha256), requiresFailedCheck: true },
        initialFiles: [{ path: 'source.txt', content: `STALE_SOURCE_${suffix}\n` }], artifacts: repairArtifacts },
      prompt: `${rules}\nThe workspace contains a stale source.txt. Plan task repair-source with sha256 check source-hash for source.txt, expected ${repairArtifacts[0].sha256}; plan task create-bundle with dependsOn [repair-source] and sha256 check bundle-hash for bundle.txt, expected ${repairArtifacts[1].sha256}. Before changing either file, run work_check on repair-source so the initial failed acceptance is recorded. Then repair source.txt to exactly ${JSON.stringify(source)}, mark repair-source completed and verify it with work_check. Respect the dependency before creating bundle.txt containing exactly ${JSON.stringify(bundle)}. Mark create-bundle running and completed around its work, run its acceptance check, and finish by reading work_status. JSON string notation describes file bytes, not literal quotes.` },
    { id: `work-ontology-greeting-${suffix}`, relations: [], expected: '',
      work: { acceptance: { kind: 'greeting', taskCount: 0, checkCount: 0, artifactSha256: [], requiresFailedCheck: false }, initialFiles: [], artifacts: [] },
      prompt: '안녕' },
  ];
}

function workspaceFile(workspace: string, name: string): string {
  if (!/^[a-z][a-z0-9-]*\.txt$/.test(name)) throw new Error('work_fixture_path_invalid');
  const root = resolve(workspace), stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root).toLowerCase() !== root.toLowerCase()) throw new Error('work_workspace_invalid');
  return join(root, name);
}
export function prepareWorkWorkspace(scenario: WorkScenario, workspace: string): void {
  for (const file of scenario.initialFiles) writeFileSync(workspaceFile(workspace, file.path), file.content, { encoding: 'utf8', flag: 'wx' });
}
export function readWorkArtifacts(scenario: WorkScenario, workspace: string): WorkEvidence['artifacts'] {
  return scenario.artifacts.map(artifact => {
    try {
      const file = workspaceFile(workspace, artifact.path), stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16_384) return { present: true, sha256: null, bytes: null, issue: 'unsafe_or_oversized_artifact' };
      const data = readFileSync(file);
      return { present: true, sha256: digest(data), bytes: data.length, issue: null };
    } catch (error) {
      return { present: false, sha256: null, bytes: null, issue: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing_artifact' : 'artifact_unreadable' };
    }
  });
}
export function newWorkEvidence(): WorkEvidence { return { artifacts: [], tools: [], progress: [], final: null, invalidObservation: false }; }
export function workSummary(value: unknown): WorkSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>, fields = ['total', 'reported', 'verified', 'blocked', 'checksPassed', 'checksFailed'] as const;
  if (fields.some(field => !Number.isSafeInteger(row[field]) || (row[field] as number) < 0 || (row[field] as number) > 32)
    || (row.stale !== undefined && typeof row.stale !== 'boolean')) return null;
  return { ...Object.fromEntries(fields.map(field => [field, row[field]])), ...(row.stale !== undefined ? { stale: row.stale as boolean } : {}) } as WorkSummary;
}
export function observeWorkTool(evidence: WorkEvidence, value: any): void {
  if (!WORK_TOOLS.includes(value?.name)) return;
  if (!['start', 'done', 'error'].includes(value.status) || evidence.tools.length >= 256) { evidence.invalidObservation = true; return; }
  // Native tool input and output stay private. Only host-emitted name/status receipts are retained.
  evidence.tools.push({ name: value.name, status: value.status });
}
export function observeWorkProgress(evidence: WorkEvidence, value: unknown): void {
  if (value === undefined) return;
  const summary = workSummary(value);
  if (!summary || evidence.progress.length >= 512) { evidence.invalidObservation = true; return; }
  const previous = evidence.progress.at(-1);
  if (JSON.stringify(previous) !== JSON.stringify(summary)) evidence.progress.push(summary);
}
export function finishWorkEvidence(evidence: WorkEvidence, scenario: WorkScenario, workspace: string, final: unknown): void {
  evidence.artifacts = readWorkArtifacts(scenario, workspace);
  evidence.final = workSummary(final);
  if (final !== undefined && !evidence.final) evidence.invalidObservation = true;
}

export function gradeWorkEvidence(acceptance: WorkAcceptance, evidence: WorkEvidence): { passed: boolean; failure: string | null } {
  const fail = (failure: string) => ({ passed: false, failure });
  if (!evidence || typeof evidence.invalidObservation !== 'boolean' || evidence.invalidObservation
    || !Array.isArray(evidence.artifacts) || !Array.isArray(evidence.tools) || evidence.tools.length > 256
    || evidence.tools.some(tool => !tool || !WORK_TOOLS.includes(tool.name) || !['start', 'done', 'error'].includes(tool.status))
    || !Array.isArray(evidence.progress) || evidence.progress.length > 512 || evidence.progress.some(summary => !workSummary(summary))
    || (evidence.final !== null && !workSummary(evidence.final))) return fail('work_observation_invalid');
  if (acceptance.kind === 'greeting') return evidence.tools.length || evidence.progress.length || evidence.final ? fail('unexpected_work_tools') : { passed: true, failure: null };
  if (evidence.artifacts.length !== acceptance.artifactSha256.length || evidence.artifacts.some((artifact, i) => !artifact || artifact.present !== true || artifact.issue !== null || artifact.sha256 !== acceptance.artifactSha256[i]
    || !Number.isSafeInteger(artifact.bytes) || artifact.bytes! < 0 || artifact.bytes! > 16_384)) return fail('artifact_mismatch');
  if (WORK_TOOLS.some(name => !evidence.tools.some(tool => tool.name === name && tool.status === 'done'))) return fail('work_receipt_missing');
  const verified = (summary: WorkSummary | null) => summary && summary.total === acceptance.taskCount && summary.verified === acceptance.taskCount
    && summary.reported === acceptance.taskCount && summary.blocked === 0 && summary.checksPassed === acceptance.checkCount && summary.checksFailed === 0 && summary.stale !== true;
  if (!verified(evidence.final) || !verified(evidence.progress.at(-1) ?? null)) return fail('work_not_verified');
  if (acceptance.requiresFailedCheck) {
    const failed = evidence.progress.findIndex(summary => summary.checksFailed > 0);
    if (failed < 0 || !evidence.progress.slice(failed + 1).some(summary => verified(summary))) return fail('work_recovery_not_observed');
  }
  return { passed: true, failure: null };
}
