import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HarnessVerifier, HARNESS_VERIFIER_LIMITS, type ArtifactSchema, type CommandVerificationRequest, type SandboxVerificationExecutor } from '../src/harness-verifier.js';

const signal = () => new AbortController().signal;
const contract: ArtifactSchema = { type: 'object', properties: { ok: { type: 'boolean', const: true }, values: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1 } }, required: ['ok', 'values'], additionalProperties: false };
async function fixture(body: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'vera-harness-verifier-'));
  try { writeFileSync(join(root, 'source.txt'), 'revision one'); await body(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
function command(code = 'process.stdout.write("ok");'): CommandVerificationRequest {
  return { id: 'tests', command: { executable: process.execPath, args: ['-e', code] }, approved: true,
    permission: 'full', sourcePaths: ['source.txt'], timeoutMs: 10_000 };
}
const fakeSandbox = (body: SandboxVerificationExecutor['execute']): SandboxVerificationExecutor => ({ kind: 'workspace-sandbox', execute: body });
const success = () => ({ exitCode: 0, stdout: 'tests passed', stderr: '', settled: true });

test('JSON contract validates artifact bytes, never a model completion claim', async () => fixture(async root => {
  const verifier = new HarnessVerifier({ workspacePath: root });
  writeFileSync(join(root, 'result.json'), JSON.stringify({ ok: true, values: [1, 2] }));
  const result = await verifier.verifyArtifact({ id: 'result', path: 'result.json', schema: contract }, signal());
  assert.equal(result.status, 'passed'); assert.equal(result.execution, 'none'); assert.equal(result.exitCode, null);
  assert.match(result.artifactHash!, /^[a-f0-9]{64}$/); assert.match(result.schemaHash!, /^[a-f0-9]{64}$/);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  assert.ok(!JSON.stringify(result).includes(root)); assert.ok(!JSON.stringify(result).includes('values'));
  writeFileSync(join(root, 'result.json'), JSON.stringify({ ok: true, values: [-1] }));
  assert.equal((await verifier.verifyArtifact({ id: 'result', path: 'result.json', schema: contract }, signal())).failure, 'schema_mismatch');
  await assert.rejects(verifier.verifyArtifact({ id: 'result', path: 'result.json', schema: contract, passed: true } as any, signal()));
}));

test('JSON contract rejects unsupported keywords, malformed JSON, extras, and unsafe numeric results', async () => fixture(async root => {
  const verifier = new HarnessVerifier({ workspacePath: root });
  for (const [body, schema, reason] of [
    ['{"ok":true,"values":[1],"extra":0}', contract, 'schema_mismatch'],
    ['{"ok":', contract, 'invalid_json'],
    ['1e999', { type: 'number' }, 'schema_mismatch'],
    ['1', { type: 'integer', pattern: '.*' }, 'invalid_request'],
    ['1', { type: 'integer', const: undefined }, 'invalid_schema'],
    ['1', { type: 'integer', minimum: 5, maximum: 2 }, 'invalid_schema'],
  ] as Array<[string, any, string]>) {
    writeFileSync(join(root, 'result.json'), body);
    assert.equal((await verifier.verifyArtifact({ id: 'result', path: 'result.json', schema }, signal())).failure, reason);
  }
}));

test('artifact bounds and escaped paths fail closed without revealing content', async () => fixture(async root => {
  const verifier = new HarnessVerifier({ workspacePath: root });
  const outside = join(root, '..', 'outside-private-' + root.slice(-6) + '.json');
  writeFileSync(outside, '{"private":"DO_NOT_REPORT"}');
  try {
    for (const path of [outside, '../' + outside.split(/[\\/]/).at(-1), 'source.txt:stream']) {
      const result = await verifier.verifyArtifact({ id: 'result', path, schema: { type: 'object' } }, signal());
      assert.notEqual(result.status, 'passed'); assert.ok(!JSON.stringify(result).includes('DO_NOT_REPORT'));
    }
    writeFileSync(join(root, 'large.json'), ' '.repeat(HARNESS_VERIFIER_LIMITS.fileBytes + 1));
    assert.equal((await verifier.verifyArtifact({ id: 'result', path: 'large.json', schema: { type: 'object' } }, signal())).failure, 'file_limit');
  } finally { rmSync(outside, { force: true }); }
}));

test('junction escape is denied for verification reads', async () => fixture(async root => {
  const outside = mkdtempSync(join(tmpdir(), 'vera-verifier-outside-'));
  try {
    writeFileSync(join(outside, 'private.json'), '{}');
    symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await new HarnessVerifier({ workspacePath: root }).verifyArtifact({ id: 'result', path: 'link/private.json', schema: { type: 'object' } }, signal());
    assert.equal(result.failure, 'path_denied');
  } finally { rmSync(outside, { recursive: true, force: true }); }
}));

test('read-only and workspace without sandbox never start explicit commands', async () => fixture(async root => {
  const verifier = new HarnessVerifier({ workspacePath: root }), request = command('require("node:fs").writeFileSync("unexpected", "bad")');
  assert.equal((await verifier.runCommand({ ...request, approved: false }, signal())).failure, 'approval_required');
  assert.equal((await verifier.runCommand({ ...request, permission: 'read-only' }, signal())).failure, 'execution_denied');
  assert.equal((await verifier.runCommand({ ...request, permission: 'workspace' }, signal())).failure, 'sandbox_required');
  assert.throws(() => readFileSync(join(root, 'unexpected')));
}));

test('actual full-permission command receipt binds workspace, command, and source revision', async () => fixture(async root => {
  const verifier = new HarnessVerifier({ workspacePath: root });
  const result = await verifier.runCommand(command(), signal());
  assert.equal(result.status, 'passed'); assert.equal(result.exitCode, 0); assert.equal(result.stdout, 'ok');
  assert.equal(result.execution, 'local-full-not-isolated'); assert.equal(result.sourceRevision, result.afterRevision);
  assert.match(result.commandHash!, /^[a-f0-9]{64}$/); assert.equal(result.sourceCount, 1);
  const different = await verifier.runCommand(command('process.exitCode=7'), signal());
  assert.equal(different.status, 'failed'); assert.equal(different.exitCode, 7); assert.equal(different.failure, 'exit_nonzero');
  assert.notEqual(different.commandHash, result.commandHash);
  writeFileSync(join(root, 'source.txt'), 'revision two');
  const changed = await verifier.runCommand(command(), signal());
  assert.equal(changed.status, 'passed'); assert.notEqual(changed.sourceRevision, result.sourceRevision);
}));

test('exit zero cannot pass when approved source bytes changed during execution', async () => fixture(async root => {
  const result = await new HarnessVerifier({ workspacePath: root }).runCommand(command('require("node:fs").writeFileSync("source.txt", "changed");'), signal());
  assert.equal(result.exitCode, 0); assert.equal(result.failure, 'source_changed'); assert.equal(result.status, 'failed');
  assert.notEqual(result.sourceRevision, result.afterRevision);
}));

test('write-and-restore of a source is still a changed revision', async () => fixture(async root => {
  const result = await new HarnessVerifier({ workspacePath: root }).runCommand(command('const fs=require("node:fs");const old=fs.readFileSync("source.txt");fs.writeFileSync("source.txt","temporary");fs.writeFileSync("source.txt",old);'), signal());
  assert.equal(result.exitCode, 0); assert.equal(result.failure, 'source_changed'); assert.equal(readFileSync(join(root, 'source.txt'), 'utf8'), 'revision one');
}));

test('stdout and stderr are byte-bounded, and ambient credentials are not inherited', async () => fixture(async root => {
  const saved = process.env.VERA_VERIFIER_TEST_SECRET; process.env.VERA_VERIFIER_TEST_SECRET = 'DO_NOT_INHERIT';
  try {
    const result = await new HarnessVerifier({ workspacePath: root }).runCommand(command('process.stdout.write("가".repeat(30000)); process.stderr.write("x".repeat(30000)); if(process.env.VERA_VERIFIER_TEST_SECRET)process.exitCode=9;'), signal());
    assert.equal(result.status, 'passed'); assert.ok(Buffer.byteLength(result.stdout) <= HARNESS_VERIFIER_LIMITS.outputBytes);
    assert.ok(Buffer.byteLength(result.stderr) <= HARNESS_VERIFIER_LIMITS.outputBytes); assert.equal(result.stdoutTruncated, true); assert.equal(result.stderrTruncated, true);
    assert.ok(!JSON.stringify(result).includes('DO_NOT_INHERIT'));
  } finally { if (saved === undefined) delete process.env.VERA_VERIFIER_TEST_SECRET; else process.env.VERA_VERIFIER_TEST_SECRET = saved; }
}));

test('timeout retires a running owned command and never emits a passing receipt', async () => fixture(async root => {
  const started = performance.now();
  const result = await new HarnessVerifier({ workspacePath: root }).runCommand({ ...command('setInterval(()=>{},1000);'), timeoutMs: 100 }, signal());
  assert.equal(result.status, 'timed-out'); assert.equal(result.failure, 'timeout'); assert.ok(performance.now() - started < 7000);
}));

test('cancellation is effective before and during execution without leaking abort reason', async () => fixture(async root => {
  const verifier = new HarnessVerifier({ workspacePath: root });
  const before = new AbortController(); before.abort('PRIVATE_ABORT');
  assert.equal((await verifier.runCommand(command(), before.signal)).status, 'cancelled');
  const during = new AbortController(); const timer = setTimeout(() => during.abort('PRIVATE_ABORT'), 100);
  try {
    const result = await verifier.runCommand(command('setInterval(()=>{},1000);'), during.signal);
    assert.equal(result.status, 'cancelled'); assert.ok(!JSON.stringify(result).includes('PRIVATE_ABORT'));
  } finally { clearTimeout(timer); }
}));

test('timeout retires a spawned owned descendant, not just the direct process', async () => fixture(async root => {
  const descendant = 'process.stdout.write(String(process.pid));setInterval(()=>{},1000);';
  const code = 'const cp=require("node:child_process");cp.spawn(process.execPath,["-e",' + JSON.stringify(descendant) + '],{stdio:["ignore","inherit","inherit"]});setInterval(()=>{},1000);';
  const result = await new HarnessVerifier({ workspacePath: root }).runCommand({ ...command(code), timeoutMs: 1000 }, signal());
  assert.equal(result.status, 'timed-out');
  const pid = Number(result.stdout); assert.ok(Number.isSafeInteger(pid) && pid > 0, 'descendant must actually have started');
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
}));

test('workspace executor gets exact bounded command and must confirm settlement', async () => fixture(async root => {
  let calls = 0;
  const verifier = new HarnessVerifier({ workspacePath: root, sandboxExecutor: fakeSandbox(async request => {
    calls++; assert.equal(request.workspacePath, root); assert.deepEqual(request.command, command().command);
    assert.equal(request.maxOutputBytes, HARNESS_VERIFIER_LIMITS.outputBytes); return success();
  }) });
  const result = await verifier.runCommand({ ...command(), permission: 'workspace' }, signal());
  assert.equal(result.status, 'passed'); assert.equal(result.execution, 'workspace-sandbox'); assert.equal(calls, 1);
  const unsafe = new HarnessVerifier({ workspacePath: root, sandboxExecutor: fakeSandbox(async () => ({ ...success(), settled: false })) });
  assert.equal((await unsafe.runCommand({ ...command(), permission: 'workspace' }, signal())).failure, 'retirement_unconfirmed');
  assert.equal((await unsafe.runCommand(command(), signal())).failure, 'retirement_unconfirmed');
}));

test('sandbox cancellation waits for executor settlement and ignores forged completion claims', async () => fixture(async root => {
  let settled = false; const controller = new AbortController();
  const verifier = new HarnessVerifier({ workspacePath: root, sandboxExecutor: fakeSandbox(async request => {
    await new Promise<void>(resolveDone => request.signal.addEventListener('abort', () => setTimeout(() => { settled = true; resolveDone(); }, 20), { once: true }));
    return { ...success(), aborted: true };
  }) });
  const timer = setTimeout(() => controller.abort(), 100);
  try { assert.equal((await verifier.runCommand({ ...command(), permission: 'workspace' }, controller.signal)).status, 'cancelled'); assert.equal(settled, true); }
  finally { clearTimeout(timer); }
  await assert.rejects(verifier.runCommand({ ...command(), verified: true } as any, signal()));
}));

test('command input and sources have strict limits before executor dispatch', async () => fixture(async root => {
  let calls = 0; const verifier = new HarnessVerifier({ workspacePath: root, sandboxExecutor: fakeSandbox(async () => { calls++; return success(); }) });
  const base = { ...command(), permission: 'workspace' as const };
  for (const request of [
    { ...base, sourcePaths: [] }, { ...base, sourcePaths: Array(33).fill('source.txt') }, { ...base, sourcePaths: ['source.txt', './source.txt'] },
    { ...base, timeoutMs: 120001 }, { ...base, command: { executable: 'node', args: [] } },
    { ...base, command: { executable: process.execPath, args: ['\0'] } },
  ]) assert.notEqual((await verifier.runCommand(request, signal())).status, 'passed');
  assert.equal(calls, 0);
}));

test('one verifier does not overlap commands; missing sources cannot prove a pass', async () => fixture(async root => {
  let release!: () => void; let ready!: () => void; const entered = new Promise<void>(r => { ready = r; });
  const verifier = new HarnessVerifier({ workspacePath: root, sandboxExecutor: fakeSandbox(async () => { ready(); await new Promise<void>(r => { release = r; }); return success(); }) });
  const first = verifier.runCommand({ ...command(), permission: 'workspace' }, signal()); await entered;
  assert.equal((await verifier.runCommand(command(), signal())).failure, 'verification_busy'); release(); assert.equal((await first).status, 'passed');
  assert.equal((await verifier.runCommand({ ...command(), sourcePaths: ['missing'] }, signal())).status, 'rejected');
}));
