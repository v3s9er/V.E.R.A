import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkOntology, type WorkOntologySummary } from '../src/ai/work-ontology.js';
import { WORK_ONTOLOGY_TOOLS, WORK_ONTOLOGY_GUIDANCE, isWorkOntologyTool } from '../src/ai/work-ontology-tools.js';

const signal = () => new AbortController().signal;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const fileTask = (id: string, path = `${id}.txt`, expected = 'ready') => ({ id, title: `Prepare ${id}`, checks: [{ id: `${id}_content`, kind: 'contains', path, expected }] });
async function call(ledger: WorkOntology, name: string, args: unknown, abort = signal()) { return JSON.parse(await ledger.execute(name, args, abort)); }
async function fixture(run: (root: string, ledger: WorkOntology, progress: WorkOntologySummary[]) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'vera-work-ontology-'));
  const progress: WorkOntologySummary[] = [];
  try { await run(root, new WorkOntology({ workspacePath: root, onChange: value => progress.push(value) }), progress); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('completed is only a claim; real checks verify only declared file conditions', async () => fixture(async (root, ledger) => {
  assert.equal(ledger.context(), '');
  writeFileSync(join(root, 'a.txt'), 'ready');
  await call(ledger, 'work_plan', { tasks: [fileTask('a'), { id: 'manual', title: 'External acceptance' }] });
  await call(ledger, 'work_update', { id: 'a', status: 'completed' });
  await call(ledger, 'work_update', { id: 'manual', status: 'completed' });
  assert.deepEqual(ledger.summary(), { total: 2, reported: 2, verified: 0, blocked: 0, checksPassed: 0, checksFailed: 0 });
  const checked = await call(ledger, 'work_check', { id: 'a' });
  assert.equal(checked.scope, 'declared-file-checks');
  assert.equal(checked.tasks[0].acceptance, 'verified');
  assert.deepEqual(checked.tasks[0].checks, [{ id: 'a_content', status: 'passed', sha256: digest('ready') }]);
  assert.equal(checked.tasks[1].acceptance, 'reported');
  await call(ledger, 'work_check', { id: 'manual' });
  assert.equal(ledger.summary().verified, 1, 'no-check tasks cannot become verified');
  await call(ledger, 'work_update', { id: 'a', status: 'running' });
  assert.equal(ledger.summary().verified, 0, 'passing checks do not invent a completion claim');
}));

test('plan validation is atomic for cycles, dangling edges, duplicates and unknown properties', async () => fixture(async (_root, ledger) => {
  await call(ledger, 'work_plan', { tasks: [fileTask('original')] });
  const before = await ledger.execute('work_status', {}, signal());
  const cases = [
    { tasks: [{ ...fileTask('a'), dependsOn: ['b'] }, { ...fileTask('b'), dependsOn: ['a'] }] },
    { tasks: [{ ...fileTask('a'), dependsOn: ['missing'] }] },
    { tasks: [fileTask('a'), fileTask('a')] },
    { tasks: [{ ...fileTask('a'), dependsOn: ['a'] }] },
    { tasks: [{ ...fileTask('a'), status: 'verified' }] },
    { tasks: [{ ...fileTask('a'), checks: [{ id: 'c', kind: 'exists', path: 'a', verified: true }] }] },
    { tasks: [fileTask('a')], verified: true },
    { tasks: [{ ...fileTask('a'), checks: [{ id: 'c', kind: 'exists', path: 'a' }, { id: 'c', kind: 'exists', path: 'b' }] }] },
  ];
  for (const input of cases) {
    await assert.rejects(ledger.execute('work_plan', input, signal()));
    assert.equal(await ledger.execute('work_status', {}, signal()), before);
  }
  for (const input of [{ id: 'original', status: 'verified' }, { id: 'original', status: 'completed', verified: true }, { id: 'original', status: 'done' }]) {
    await assert.rejects(ledger.execute('work_update', input, signal()));
  }
  await assert.rejects(ledger.execute('work_status', { receipt: { verified: true } }, signal()));
  await assert.rejects(ledger.execute('work_check', { id: 'original', passed: true }, signal()));
  assert.equal(await ledger.execute('work_status', {}, signal()), before);
}));

test('each check recursively rereads prerequisites; changed evidence revokes downstream acceptance', async () => fixture(async (root, ledger) => {
  for (const id of ['a', 'b', 'c']) writeFileSync(join(root, `${id}.txt`), 'ready');
  await call(ledger, 'work_plan', { tasks: [fileTask('a'), { ...fileTask('b'), dependsOn: ['a'] }, { ...fileTask('c'), dependsOn: ['b'] }] });
  for (const id of ['a', 'b', 'c']) await call(ledger, 'work_update', { id, status: 'completed' });
  await call(ledger, 'work_check', { id: 'c' });
  assert.equal(ledger.summary().verified, 3);
  writeFileSync(join(root, 'a.txt'), 'wrong');
  const checked = await call(ledger, 'work_check', { id: 'c' });
  assert.equal(ledger.summary().verified, 0);
  assert.equal(ledger.summary().checksFailed, 1);
  assert.equal(ledger.summary().blocked, 3);
  assert.equal(checked.tasks[0].checks[0].sha256, digest('wrong'));
  assert.equal(checked.tasks[0].checks[0].reason, 'mismatch');
  writeFileSync(join(root, 'a.txt'), 'ready');
  await ledger.recheck(signal());
  assert.equal(ledger.summary().verified, 3);
}));

test('failed acceptance checks block completed claims and exact SHA-256 is checked', async () => fixture(async (root, ledger) => {
  writeFileSync(join(root, 'artifact.txt'), 'ready');
  await call(ledger, 'work_plan', { tasks: [{ id: 'build', title: 'Artifact', checks: [
    { id: 'present', kind: 'exists', path: 'artifact.txt' },
    { id: 'identity', kind: 'sha256', path: 'artifact.txt', expected: digest('ready').toUpperCase() },
    { id: 'content', kind: 'contains', path: 'artifact.txt', expected: 'not there' },
  ] }] });
  await call(ledger, 'work_update', { id: 'build', status: 'completed' });
  const result = await call(ledger, 'work_check', { id: 'build' });
  assert.equal(result.tasks[0].acceptance, 'blocked');
  assert.equal(result.summary.checksPassed, 2);
  assert.equal(result.summary.checksFailed, 1);
  await assert.rejects(ledger.execute('work_plan', { tasks: [{ id: 'bad', title: 'Bad', checks: [{ id: 'hash', kind: 'sha256', path: 'a', expected: 'fake' }] }] }, signal()));
}));

test('invalidations remove receipts and final recheck touches only previously requested checks', async () => fixture(async (root, ledger) => {
  writeFileSync(join(root, 'a.txt'), 'ready');
  writeFileSync(join(root, 'b.txt'), 'ready');
  await call(ledger, 'work_plan', { tasks: [fileTask('a'), fileTask('b')] });
  for (const id of ['a', 'b']) await call(ledger, 'work_update', { id, status: 'completed' });
  await ledger.recheck(signal());
  assert.equal(ledger.summary().checksPassed, 0);
  await call(ledger, 'work_check', { id: 'a' });
  ledger.invalidate();
  assert.equal(ledger.summary().verified, 0);
  assert.equal(ledger.summary().stale, true);
  assert.equal(ledger.summary().checksPassed, 0);
  writeFileSync(join(root, 'a.txt'), 'changed');
  await ledger.recheck(signal());
  assert.equal(ledger.summary().checksFailed, 1);
  assert.equal(ledger.summary().stale, undefined);
  const status = await call(ledger, 'work_status', {});
  assert.equal(status.tasks[1].checks[0].status, 'unchecked');
  await call(ledger, 'work_plan', { tasks: [fileTask('b')] });
  await ledger.recheck(signal());
  assert.equal(ledger.summary().checksPassed, 0, 'new plans do not retain previously checked roots');
}));

test('cancellation does not commit partial evidence or reflect a private abort reason', async () => fixture(async (root) => {
  const controller = new AbortController();
  let abortDuringCheck = false;
  const ledger = new WorkOntology({ workspacePath: root, onChange: value => {
    if (abortDuringCheck && value.stale) controller.abort('PRIVATE_ABORT_CONTENT');
  } });
  writeFileSync(join(root, 'a.txt'), 'ready');
  const preAborted = new AbortController(); preAborted.abort('PRIVATE_ABORT_CONTENT');
  await assert.rejects(ledger.execute('work_plan', { tasks: [fileTask('a')] }, preAborted.signal), error => error instanceof Error && error.name === 'AbortError' && !error.message.includes('PRIVATE'));
  assert.equal(ledger.summary().total, 0);
  await call(ledger, 'work_plan', { tasks: [fileTask('a')] });
  await call(ledger, 'work_update', { id: 'a', status: 'completed' });
  abortDuringCheck = true;
  await assert.rejects(ledger.execute('work_check', { id: 'a' }, controller.signal), error => error instanceof Error && error.name === 'AbortError' && !error.message.includes('PRIVATE'));
  assert.equal(ledger.summary().verified, 0);
  assert.equal(ledger.summary().checksPassed, 0);
}));

test('workspace scope rejects outside paths, symlinks, alternate streams and directories without leaks', async () => fixture(async (root, ledger) => {
  const outside = mkdtempSync(join(tmpdir(), 'vera-work-outside-'));
  try {
    writeFileSync(join(outside, 'PRIVATE_NAME.txt'), 'PRIVATE_FILE_CONTENT');
    symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const paths = [join(outside, 'PRIVATE_NAME.txt'), '../PRIVATE_NAME.txt', 'link/PRIVATE_NAME.txt', 'file.txt:PRIVATE_STREAM', '.'];
    for (const path of paths) {
      await call(ledger, 'work_plan', { tasks: [{ id: 'scope', title: 'PRIVATE_TITLE', checks: [{ id: 'c', kind: 'exists', path }] }] });
      await call(ledger, 'work_update', { id: 'scope', status: 'completed' });
      const output = await ledger.execute('work_check', { id: 'scope' }, signal());
      assert.ok(!output.includes('PRIVATE'));
      assert.ok(!output.includes(outside));
      assert.equal(ledger.summary().verified, 0);
      assert.equal(ledger.summary().checksFailed, 1);
    }
    const result = await call(ledger, 'work_status', {});
    assert.equal(result.tasks[0].checks[0].reason, 'not_regular');
  } finally { rmSync(outside, { recursive: true, force: true }); }
}));

test('bounded files, check counts and input fields cannot leak contents into receipts or UI', async () => fixture(async (root, ledger, progress) => {
  const secret = 'PRIVATE_FILE_CONTENT_1234';
  writeFileSync(join(root, 'PRIVATE_FILE.txt'), secret);
  writeFileSync(join(root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 120));
  await call(ledger, 'work_plan', { tasks: [fileTask('a', 'PRIVATE_FILE.txt', secret), { id: 'large', title: 'PRIVATE_TITLE', checks: [{ id: 'size', kind: 'exists', path: 'large.txt' }] }] });
  for (const id of ['a', 'large']) { await call(ledger, 'work_update', { id, status: 'completed' }); await call(ledger, 'work_check', { id }); }
  const output = await ledger.execute('work_status', {}, signal());
  assert.equal(JSON.parse(output).tasks[1].checks[0].reason, 'too_large');
  for (const value of [output, ledger.context(), JSON.stringify(progress)]) {
    assert.ok(!value.includes('PRIVATE'));
    assert.ok(!value.includes(root));
    assert.ok(!value.includes('large.txt'));
  }
  for (const event of progress) {
    assert.ok(Object.keys(event).every(key => ['total', 'reported', 'verified', 'blocked', 'checksPassed', 'checksFailed', 'stale'].includes(key)));
    assert.ok(Object.values(event).every(value => typeof value === 'number' || typeof value === 'boolean'));
  }
  assert.deepEqual(readdirSync(root).sort(), ['PRIVATE_FILE.txt', 'large.txt'], 'ledger never persists files');
  await assert.rejects(ledger.execute('work_plan', { tasks: Array.from({ length: 13 }, (_, i) => fileTask(`t${i}`)) }, signal()));
  await assert.rejects(ledger.execute('work_plan', { tasks: [{ id: 'too_many', title: 'a', checks: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, kind: 'exists', path: 'a' })) }] }, signal()));
  await assert.rejects(ledger.execute('work_plan', { tasks: Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, title: 'a', checks: Array.from({ length: 4 }, (_, j) => ({ id: `c${j}`, kind: 'exists', path: 'a' })) })) }, signal()));
  await assert.rejects(ledger.execute('work_plan', { tasks: [fileTask('a', 'a', 'x'.repeat(2049))] }, signal()));
  await assert.rejects(ledger.execute('work_plan', { tasks: [fileTask('a', 'x'.repeat(2049))] }, signal()));
  await assert.rejects(ledger.execute('shell_exec', {}, signal()));
}));

test('concurrent host invalidation cannot publish in-flight receipts', async () => fixture(async (root, ledger) => {
  writeFileSync(join(root, 'a.txt'), 'ready');
  await call(ledger, 'work_plan', { tasks: [fileTask('a')] });
  await call(ledger, 'work_update', { id: 'a', status: 'completed' });
  const checking = ledger.execute('work_check', { id: 'a' }, signal());
  ledger.invalidate();
  await assert.rejects(checking, /changed during verification/);
  assert.equal(ledger.summary().verified, 0);
  assert.equal(ledger.summary().checksPassed, 0);
}));

test('run ownership keeps plans isolated and fresh checks notice replacement files', async () => fixture(async (root, ledger) => {
  writeFileSync(join(root, 'a.txt'), 'ready');
  await call(ledger, 'work_plan', { tasks: [fileTask('a')] });
  await call(ledger, 'work_update', { id: 'a', status: 'completed' });
  await call(ledger, 'work_check', { id: 'a' });
  assert.equal(new WorkOntology({ workspacePath: root }).summary().total, 0);
  rmSync(join(root, 'a.txt'));
  mkdirSync(join(root, 'a.txt'));
  await ledger.recheck(signal());
  assert.equal(ledger.summary().verified, 0);
  assert.equal(ledger.summary().checksFailed, 1);
}));

test('tools are closed schemas, bounded, and distinguish declared verification from execution', () => {
  assert.deepEqual(WORK_ONTOLOGY_TOOLS.map(tool => tool.name), ['work_plan', 'work_update', 'work_check', 'work_status']);
  assert.ok(WORK_ONTOLOGY_TOOLS.every(tool => tool.parameters.additionalProperties === false));
  assert.equal(isWorkOntologyTool('work_status'), true);
  assert.equal(isWorkOntologyTool('constructor'), false);
  assert.ok(WORK_ONTOLOGY_GUIDANCE.includes('not overall') || WORK_ONTOLOGY_GUIDANCE.includes('never overall correctness'));
});
