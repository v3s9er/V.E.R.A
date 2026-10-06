import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../src/ai/loop.js';
import { RunProgress } from '../src/server/run-progress.js';
import { runPresentation, executionPresentation } from '../../shared/src/run-presentation.js';
import type { AiProvider, ProviderResult } from '../src/ai/provider.js';
import type { WorkOntologySummary } from '@mr-robot/shared';

const result = (text = 'done', toolCalls: ProviderResult['toolCalls'] = []): ProviderResult => ({ text, toolCalls, usage: { promptTokens: 1, completionTokens: 1, reportStatus: 'reported' } });
const provider = (extra: Partial<AiProvider> = {}): AiProvider => ({ id: 'fixture', type: 'codex-cli', label: 'Fixture', model: 'fixture-model', baseUrl: '', supportsTools: false,
  supportedReasoning: ['auto', 'high'], chat: async () => result(), chatIsolated: async () => result(), ping: async () => ({ ok: true }), models: async () => ['fixture-model'], ...extra });
const plan = { tasks: [{ id: 'artifact', title: 'Create the artifact', checks: [{ id: 'content', kind: 'contains', path: 'result.txt', expected: 'expected fixture' }] }] };
async function fixture(fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'vera-work-loop-'));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('default native has one coordinator and work checks are actual host file observations', () => fixture(async dir => {
  const updates: WorkOntologySummary[] = [];
  const p = provider({ runAgent: async req => {
    assert.deepEqual(req.nativeDelegation, { maxAgents: 2 });
    assert.ok(!req.hostTools!.tools.some(t => t.name.startsWith('agent_')));
    const host = req.hostTools!, signal = req.signal!;
    assert.equal(host.authorize!('work_plan', 'read-only'), true);
    await host.execute('work_plan', plan, signal);
    await host.execute('work_update', { id: 'artifact', status: 'completed' }, signal);
    assert.equal(updates.at(-1)!.verified, 0);
    await host.execute('work_check', { id: 'artifact' }, signal);
    assert.equal(updates.at(-1)!.checksFailed, 1);
    writeFileSync(join(dir, 'result.txt'), 'expected fixture');
    req.onTool!({ name: 'native_file_change', callId: 'change', input: {}, status: 'start' });
    req.onTool!({ name: 'native_file_change', callId: 'change', input: {}, status: 'done' });
    await host.execute('work_check', { id: 'artifact' }, signal);
    assert.equal(updates.at(-1)!.verified, 1);
    // A later change must be caught even if its tool event was not available.
    writeFileSync(join(dir, 'result.txt'), 'changed after check');
    return result();
  } });
  await new AgentLoop({ default: () => p } as any, {} as any).run([], 'Create and check a project file', { onWorkUpdate: s => updates.push(s) }, [], {
    workspacePath: dir, permissionMode: 'workspace', tokenPolicy: 'audit-only', cacheKey: 'fixture', nativeSessionDirectory: dir,
  });
  assert.equal(updates.at(-1)!.verified, 0);
  assert.equal(updates.at(-1)!.checksFailed, 1);
}));

test('single-model Discord and isolated requests never receive work or native delegation', () => fixture(async dir => {
  for (const native of [true, false]) {
    const p = provider({ type: native ? 'codex-cli' : 'openai-compatible', supportsTools: !native,
      runAgent: async req => { assert.equal(req.nativeDelegation, undefined); assert.ok(!req.hostTools?.tools.some(t => t.name.startsWith('work_'))); return result(); },
      chat: async req => { assert.ok(!req.tools?.some(t => t.name.startsWith('work_'))); return result(); },
    });
    await new AgentLoop({ default: () => p } as any, {} as any).run([], 'Inspect the project files', { onWorkUpdate: () => assert.fail('no private work ledger') }, [], {
      singleModelOnly: true, workspacePath: dir, permissionMode: 'read-only', tokenPolicy: 'audit-only', cacheKey: 'fixture', nativeSessionDirectory: dir,
    });
  }
  const p = provider({ type: 'openai-compatible', supportsTools: true, chat: async req => { assert.ok(!req.tools?.some(t => t.name.startsWith('work_'))); return result(); } });
  await new AgentLoop({ default: () => p } as any, {} as any).run([], 'Inspect the project files', {}, [], {
    workspacePath: dir, isolation: { tools: [], execute: async () => 'not used' },
  });
}));

test('greeting does not construct a work graph or enter native workspace runtime', () => fixture(async dir => {
  const p = provider({ supportsTools: true, chat: async req => { assert.equal(req.tools?.length ?? 0, 0); return result('hello'); }, runAgent: async () => { throw Error('no native launch'); } });
  const answer = await new AgentLoop({ default: () => p } as any, {} as any).run([], '안녕', { onWorkUpdate: () => assert.fail() }, [], {
    workspacePath: dir, permissionMode: 'workspace', tokenPolicy: 'audit-only', cacheKey: 'fixture', nativeSessionDirectory: dir,
  });
  assert.equal(answer.text, 'hello');
}));

test('native child usage uncertainty survives positive aggregate counters', () => fixture(async dir => {
  const p = provider({ runAgent: async () => ({ ...result(), usage: { promptTokens: 100, completionTokens: 10, reportStatus: 'missing' } }) });
  const answer = await new AgentLoop({ default: () => p } as any, {} as any).run([], 'Inspect the project files', {}, [], {
    workspacePath: dir, permissionMode: 'workspace', tokenPolicy: 'audit-only', cacheKey: 'fixture', nativeSessionDirectory: dir,
  });
  assert.equal(answer.usage.promptTokens, 100);
  assert.equal(answer.usage.completionTokens, 10);
  assert.equal(answer.usage.reportStatus, 'missing');
}));

test('progress projects only counts, separates reported work and checks, and invalidates cancellation', () => {
  const progress = new RunProgress();
  progress.workUpdate({ total: 2, reported: 2, verified: 1, blocked: 1, checksPassed: 1, checksFailed: 0, privatePath: 'PRIVATE_VALUE' } as any);
  assert.doesNotMatch(JSON.stringify(progress.snapshot()), /PRIVATE_VALUE|privatePath/);
  let view = runPresentation({ ...progress.snapshot(), busy: true });
  assert.match(view.workNotice, /모델 완료 보고 2\/2/); assert.match(view.workNotice, /파일 조건 확인 1\/2/);
  progress.workUpdate({ total: 2, reported: 2, verified: 9, blocked: 0, checksPassed: 0, checksFailed: 0 });
  assert.equal(progress.snapshot().work!.verified, 1);
  const copy = progress.snapshot(); copy.work!.verified = 0; assert.equal(progress.snapshot().work!.verified, 1);
  progress.transition('cancelled');
  assert.equal(progress.snapshot().work!.verified, 0);
  view = runPresentation({ ...progress.snapshot(), busy: false });
  assert.match(view.workNotice, /재확인 필요/);
  assert.match(executionPresentation('single', [], [{ id: '1', label: 'native_agent_spawn', state: 'done', startedAt: 1 }]).observed, /내부 보조 실행 관측/);
});

test('API work checks can retry after repairs without granting endless unchanged-status progress', () => fixture(async dir => {
  let step = 0;
  const updates: WorkOntologySummary[] = [];
  const schedule = [
    ['work_plan', plan], ['work_update', { id: 'artifact', status: 'completed' }], ['work_check', { id: 'artifact' }],
    ['write_file', { content: 'first repair still wrong' }], ['work_check', { id: 'artifact' }],
    ['write_file', { content: 'expected fixture' }], ['work_check', { id: 'artifact' }], ['work_status', {}],
  ] as const;
  const p = provider({ type: 'openai-compatible', supportsTools: true, chat: async req => {
    const call = schedule[step++];
    if (!call) { assert.equal(updates.at(-1)!.verified, 1); return result('fixed'); }
    if (step === 8) assert.ok(!req.turns.at(-1)!.toolResults![0].content.includes('same tool call repeated'));
    return result('', [{ id: `call-${step}`, name: call[0], args: JSON.stringify(call[1]) }]);
  } });
  const executor = { execute: async (_name: string, input: { content: string }) => { writeFileSync(join(dir, 'result.txt'), input.content); return '{"ok":true}'; } } as any;
  const answer = await new AgentLoop({ default: () => p } as any, executor).run([], 'Write a project file and verify it', { onWorkUpdate: s => updates.push(s) }, [], { workspacePath: dir, permissionMode: 'workspace' });
  assert.equal(answer.text, 'fixed'); assert.equal(updates.at(-1)!.verified, 1);
}));

test('final work receipts are checked after detached helpers finish cancellation settlement', () => fixture(async dir => {
  writeFileSync(join(dir, 'result.txt'), 'expected fixture');
  const updates: WorkOntologySummary[] = [];
  const order: string[] = [];
  let step = 0, helperAborted = false, helperSettled = false;
  let markStarted!: () => void;
  const helperStarted = new Promise<void>(resolve => { markStarted = resolve; });
  const schedule = [
    ['work_plan', plan],
    ['work_update', { id: 'artifact', status: 'completed' }],
    ['agent_spawn', { task: 'Review the bounded fixture independently' }],
    ['work_check', { id: 'artifact' }],
  ] as const;
  const p = provider({ type: 'openai-compatible', supportsTools: true,
    chat: async req => {
      const call = schedule[step++];
      if (call?.[0] === 'work_check') await helperStarted;
      if (!call) {
        const receipt = JSON.parse(req.turns.at(-1)!.toolResults![0].content);
        assert.equal(receipt.summary.verified, 1, 'the main agent really checked the original file');
        assert.equal(helperSettled, false, 'the helper is still detached when the main model returns');
        order.push('main-check-passed');
        return result('main completed independently');
      }
      return result('', [{ id: `settle-${step}`, name: call[0], args: JSON.stringify(call[1]) }]);
    },
    chatIsolated: req => new Promise(resolve => {
      markStarted();
      req.signal!.addEventListener('abort', () => {
        helperAborted = true;
        order.push('helper-aborted');
        // Simulate a provider's in-flight side effect completing while it
        // settles cancellation. Merely requesting abort must not be enough.
        setImmediate(() => {
          writeFileSync(join(dir, 'result.txt'), 'changed during helper cancellation');
          helperSettled = true;
          order.push('helper-settled');
          resolve(result('late helper result'));
        });
      }, { once: true });
    }),
  });
  const answer = await new AgentLoop({ default: () => p } as any, {} as any).run([], 'Review the project file and verify its acceptance conditions', {
    onWorkUpdate: summary => {
      updates.push(summary);
      if (summary.checksFailed) order.push('final-check-failed');
    },
  }, [], { workspacePath: dir, permissionMode: 'read-only', tokenPolicy: 'standard' });
  assert.equal(helperAborted, true);
  assert.equal(helperSettled, true);
  assert.equal(answer.text, 'main completed independently');
  assert.equal(updates.at(-1)!.verified, 0);
  assert.equal(updates.at(-1)!.checksPassed, 0);
  assert.equal(updates.at(-1)!.checksFailed, 1);
  assert.deepEqual(order, ['main-check-passed', 'helper-aborted', 'helper-settled', 'final-check-failed']);
  assert.ok(!JSON.stringify(answer.turns).includes('late helper result'));
}));
