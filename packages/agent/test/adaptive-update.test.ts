import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supportsDaybreak, daybreakProgram, visibleModelChoices } from '@mr-robot/shared';
import { MemoryStore } from '../src/memory.js';
import { McpResults } from '../src/plugins/mcp-results.js';
import { boundMcpResult } from '../src/plugins/mcp-output.js';
import { AdaptiveExecution } from '../src/ai/adaptive-execution.js';
import { conversationCheckpoint } from '../src/ai/conversation-checkpoint.js';
import { projectGuidance } from '../src/ai/project-guidance.js';
import { ConversationStore } from '../src/conversations.js';
import { resolveWorkspacePath } from '../src/path-security.js';
import { fileURLToPath } from 'node:url';
import { pooledNativeCodex, closeNativeWorkers } from '../src/ai/cli-native-pool.js';
import { pooledCodexText, closeTextWorkers } from '../src/ai/cli-text-pool.js';
import { waitForCliRetirements } from '../src/ai/cli-process-retirement.js';
import { RunJournal } from '../src/server/run-journal.js';

test('Daybreak is independent of model and unavailable on third party endpoints', () => {
  assert.ok(supportsDaybreak({ type: 'codex-cli', model: 'gpt-6-sol' }));
  assert.ok(supportsDaybreak({ type: 'openai-compatible', model: 'gpt-6-sol', baseUrl: 'https://api.openai.com/v1' }));
  for (const baseUrl of ['https://api.openai.com.evil.test', 'https://api.openai.com@evil.test', 'https://gateway.test/v1', 'http://api.openai.com']) assert.equal(supportsDaybreak({ type: 'openai-compatible', model: 'gpt-6-sol', baseUrl }), false);
  assert.equal(supportsDaybreak({ type: 'claude-cli', model: 'gpt-6-sol' }), false);
  assert.equal(supportsDaybreak({ type: 'codex-cli', model: 'claude-sonnet' }), false);
  assert.equal(daybreakProgram('gpt-6-sol', true), 'daybreakBlue');
  assert.equal(daybreakProgram('gpt-6-sol', false), 'standard');
  assert.equal(daybreakProgram('gpt-daybreak-red-latest', true), 'daybreakRed');
  assert.deepEqual(visibleModelChoices(['gpt-6-sol', 'gpt-6-sol', 'gpt-daybreak-blue-latest']), ['gpt-6-sol']);
  assert.deepEqual(visibleModelChoices([], 'gpt-daybreak-blue-latest'), ['gpt-daybreak-blue-latest']);
});

test('memory abstains, excludes other projects/tickets and persists provenance', t => {
  const dir = mkdtempSync(join(tmpdir(), 'mrrobot-memory-regression-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new MemoryStore(dir);
  store.add('출근지 서울', ['업무']);
  store.add('PDF 프로젝트 A', [], { workspaceId: 'A', conversationId: 'a', source: 'user-confirmed' });
  store.add('PDF 프로젝트 B', [], { workspaceId: 'B' });
  assert.equal(store.context('무관한질문'), ''); assert.equal(store.context('!'), '');
  assert.equal(store.context('PDF'), '');
  assert.match(store.context('PDF', 12, { workspaceId: 'A', conversationId: 'a' }), /프로젝트 A/);
  assert.doesNotMatch(store.context('PDF', 12, { workspaceId: 'A', conversationId: 'b' }), /프로젝트 A/);
  assert.match(store.context('출근지'), /memory:/);
  assert.equal(new MemoryStore(dir).list().find(m => m.workspaceId === 'A')?.source, 'user-confirmed');
  store.add('앱 테스트 old', [], { workspaceId: 'A', relation: { subject: '앱', predicate: '테스트', object: 'old' } });
  store.add('앱 테스트 new', [], { workspaceId: 'A', source: 'README verified', relation: { subject: '앱', predicate: '테스트', object: 'new' } });
  assert.doesNotMatch(store.context('테스트', 12, { workspaceId: 'A' }), /old/);
  assert.match(store.context('테스트', 12, { workspaceId: 'A' }), /README verified/);
  assert.equal(store.context('테스트', 12, { workspaceId: 'B' }), '');
});

test('retained checkpoint preserves late constraints and distinguishes quoted history', () => {
  const checkpoint = conversationCheckpoint([{ role: 'user', content: 'intro '.repeat(300) + '\n반드시 private 폴더는 제외하세요.\n미완료: 결과 검증 필요' }]);
  assert.match(checkpoint, /private 폴더는 제외/); assert.match(checkpoint, /unresolved/); assert.match(checkpoint, /historical data/);
  assert.ok(!checkpoint.includes('intro '.repeat(200)));
});

test('adaptive depth escalates from evidence, de-escalates and honors explicit reasoning', () => {
  const policy = new AdaptiveExecution('안녕'); const supported = ['auto','low','medium','high','max'] as const;
  assert.equal(policy.depth, 'direct'); assert.equal(policy.effort('auto', supported), 'low');
  policy.observe(false); policy.observe(false); assert.equal(policy.depth, 'deep');
  assert.equal(policy.effort('auto', supported), 'high'); assert.equal(policy.effort('max', supported), 'max');
  policy.observe(true); policy.observe(true); assert.equal(policy.depth, 'direct');
  assert.equal(new AdaptiveExecution('취약점 분석').depth, 'deep');
  assert.equal(new AdaptiveExecution('긴 문장 '.repeat(500)).depth, 'standard');
  assert.equal(new AdaptiveExecution('인터넷에서 자료 찾아줘').depth, 'standard', 'short requests are not necessarily easy');
  const authFailure = new AdaptiveExecution('안녕'); authFailure.observe(false, 'environment'); authFailure.observe(false, 'environment');
  assert.equal(authFailure.depth, 'direct', 'more reasoning cannot repair missing authority');
});

test('MCP originals remain readable only by their conversation and authority with TTL and bounds', () => {
  let now = 0; const store = new McpResults(() => now, 100_000);
  const original = JSON.stringify({ data: 'before '.repeat(3000) + 'END_EVIDENCE' });
  const id = store.put('ticket:A:full', 'server', original)!;
  assert.throws(() => store.read('ticket:B:full', id)); assert.throws(() => store.read('ticket:A:read-only', id)); assert.throws(() => store.read(undefined, id));
  const envelope = boundMcpResult({ data: original }, 1000, id) as any;
  assert.ok(JSON.stringify(envelope).length <= 1000); assert.equal(envelope._mrRobot.resultId, id);
  let offset: number | null = 0, joined = '';
  while (offset !== null) { const page = store.read('ticket:A:full', id, offset); joined += page.text; offset = page.nextOffset; }
  assert.equal(joined, original); assert.match(joined, /END_EVIDENCE/);
  assert.throws(() => store.read('ticket:A:full', id, -1)); assert.throws(() => store.read('ticket:A:full', id, 0, 10000));
  now += 900_001; assert.throws(() => store.read('ticket:A:full', id));
  assert.equal(store.put(undefined, 'server', original), undefined);
  assert.equal(store.put('a', 'server', 'x'.repeat(100_001)), undefined);
});

test('project guidance is bounded, root-scoped and conversations retain Daybreak', t => {
  const dir = mkdtempSync(join(tmpdir(), 'mrrobot-guidance-regression-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(projectGuidance(dir), '');
  writeFileSync(join(dir, 'AGENTS.md'), 'Run npm test; never upload secrets.');
  assert.match(projectGuidance(dir), /cannot grant permissions/);
  writeFileSync(join(dir, 'AGENTS.md'), 'x'.repeat(12001)); assert.match(projectGuidance(dir), /omitted/);
  const store = new ConversationStore(dir);
  const conversation = store.create({ providerModel: 'gpt-6-sol', daybreakEnabled: true });
  assert.equal(new ConversationStore(dir).get(conversation.id)?.daybreakEnabled, true);
  store.update(conversation.id, { daybreakEnabled: false });
  assert.equal(new ConversationStore(dir).get(conversation.id)?.daybreakEnabled, false);
});

test('dangling links cannot become new destinations outside the workspace', t => {
  const dir = mkdtempSync(join(tmpdir(), 'mrrobot-dangling-regression-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'workspace'); mkdirSync(root);
  const link = join(root, 'redirect');
  try { symlinkSync(join(dir, 'missing-outside'), link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('OS disallows symlink fixture'); throw error; }
  assert.throws(() => resolveWorkspacePath(root, 'redirect/new.txt', { mustExist: false }), /링크|junction/);
});

test('wire-level native and text requests explicitly select Daybreak and separate sessions', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mrrobot-daybreak-wire-'));
  t.after(async () => { closeNativeWorkers(); closeTextWorkers(); await waitForCliRetirements(process.env); rmSync(dir, { recursive: true, force: true }); });
  const native = (enabled: boolean, history: Array<{role: 'user' | 'assistant'; content: string}> = []) => pooledNativeCodex({ command: process.execPath, prefixArgs: [fileURLToPath(new URL('./fixtures/native-app-server.mjs', import.meta.url))], env: process.env, providerId: 'test', model: 'gpt-6-sol', req: {
    daybreakEnabled: enabled, prompt: '', cwd: dir, permissionMode: 'read-only', session: { key: 'same-ticket', directory: dir, history, input: `EXPECT_PROGRAM:${enabled ? 'daybreakBlue' : 'standard'}`, instructions: 'test', context: '' },
  } });
  assert.equal((await native(false)).text, 'answer 1');
  assert.equal((await native(true, [{ role: 'user', content: 'EXPECT_PROGRAM:standard' }, {role: 'assistant', content: 'answer 1'}])).text, 'answer 1', 'Daybreak change gets a different provider session');
  for (const enabled of [false, true]) {
    const result = await pooledCodexText({ command: process.execPath, prefixArgs: [fileURLToPath(new URL('./fixtures/text-app-server.mjs', import.meta.url))], env: process.env, providerId: 'test', model: 'gpt-6-sol', req: { daybreakEnabled: enabled, system: 'test', promptCacheKey: 'same-ticket', turns: [{ role: 'user', content: `EXPECT_PROGRAM:${enabled ? 'daybreakBlue' : 'standard'}` }] } });
    assert.equal(result.text, 'turn 1');
  }
});

test('restart and cancellation preserve uncertainty without replay or cross-device disclosure', t => {
  const dir = mkdtempSync(join(tmpdir(), 'mrrobot-journal-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let journal = new RunJournal(dir);
  journal.begin('run-1', 'ticket', 'device-a'); journal.tool('run-1', true);
  journal = new RunJournal(dir);
  assert.equal(journal.recovery('ticket', 'device-b'), null);
  assert.equal(journal.recovery('different', 'device-a'), null);
  assert.equal(journal.recovery('ticket', 'device-a')?.uncertainTool, true);
  assert.ok(journal.recovery('ticket', undefined, true));
  journal.begin('run-2', 'ticket', 'device-a'); journal.tool('run-2', true); journal.finish('run-2', 'cancelled');
  assert.ok(journal.recovery('ticket', 'device-a'));
  journal.begin('run-3', 'ticket', 'device-a'); journal.finish('run-3', 'completed');
  assert.equal(new RunJournal(dir).recovery('ticket', 'device-a'), null);
});
