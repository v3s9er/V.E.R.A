import type { NeutralTool } from './provider.js';

export const WORK_ONTOLOGY_GUIDANCE = `For multi-step work with concrete workspace deliverables, optionally use work_plan to declare a small dependency graph and objective file checks. You own the plan; no extra planner runs. Use work_update to report progress; completed is only your claim. work_check reads bounded workspace files and recursively rechecks prerequisites. Only completed tasks with passing declared checks and verified prerequisites become verified. A task without checks stays reported. Verification covers only the declared file conditions, never overall correctness, test execution or authorization. Choose checks from the user's acceptance criteria, not merely convenient markers. Finish in this order: actual work, work_update(completed), one final work_check, then answer. work_check already returns the current ledger; do not routinely follow it with redundant work_status or work_update calls. Repeat checks after actual changes or repairs, not in a loop just to clear stale: stale means conservative invalidation, not an observed mismatch. The host rechecks requested file conditions once more after native helpers settle; report only your observed results, never assume that final recheck will pass. Use work_status only when its state is needed. This ledger is private to the current run and is not saved.`;

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
const id = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,47}$', maxLength: 48 };
const check = object({
  id,
  kind: { type: 'string', enum: ['exists', 'contains', 'sha256'] },
  path: { type: 'string', minLength: 1, maxLength: 2048, description: 'A file inside the selected workspace; no links or outside paths.' },
  expected: { type: 'string', minLength: 1, maxLength: 2048, description: 'Required for contains (literal UTF-8 substring) or sha256 (exact 64 hexadecimal digits); forbidden for exists.' },
}, ['id', 'kind', 'path']);

export const WORK_ONTOLOGY_TOOLS: NeutralTool[] = [
  { name: 'work_plan', description: 'Declare or replace the current run plan atomically; clears previous claims/checks. At most 12 tasks, 4 checks per task, 32 total. Dependencies must form a complete acyclic graph. No shell, files written or extra model.', parameters: object({ tasks: { type: 'array', minItems: 1, maxItems: 12, items: object({ id, title: { type: 'string', minLength: 1, maxLength: 160 }, dependsOn: { type: 'array', maxItems: 11, uniqueItems: true, items: id }, checks: { type: 'array', maxItems: 4, items: check } }, ['id', 'title']) } }, ['tasks']) },
  { name: 'work_update', description: 'Report one task state. completed is a model claim, not verified evidence. Checks and prerequisites decide acceptance separately.', parameters: object({ id, status: { type: 'string', enum: ['planned', 'running', 'completed', 'blocked'] } }, ['id', 'status']) },
  { name: 'work_check', description: 'Actually read this task’s declared files and every prerequisite’s files again (max 2 MiB each). Returns check IDs, status, SHA-256 and fixed failure codes; never raw file contents. Does not run code or tests.', parameters: object({ id }, ['id']) },
  { name: 'work_status', description: 'Get compact run-local claims and actual check receipts. verified means only declared file checks and prerequisites passed. No raw contents or filenames.', parameters: object({}) },
];

export function isWorkOntologyTool(name: string): boolean { return WORK_ONTOLOGY_TOOLS.some(tool => tool.name === name); }
