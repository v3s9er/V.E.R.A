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
    assert.equal(req.nativeDelegation, undefined);
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

test('failed final file receipt gets one same-session correction, without another coordinator', () => fixture(async dir => {
 let calls=0;
 const updates: WorkOntologySummary[]=[];
 const p=provider({runAgent:async req=>{
   calls++; assert.equal(req.nativeDelegation,undefined);
   assert.equal(req.session!.key,'repair');
   if(calls===1) {
     await req.hostTools!.execute('work_plan',plan,req.signal!);
     writeFileSync(join(dir,'result.txt'),'expected fixture');
     await req.hostTools!.execute('work_update',{id:'artifact',status:'completed'},req.signal!);
     await req.hostTools!.execute('work_check',{id:'artifact'},req.signal!);
     writeFileSync(join(dir,'result.txt'),'invalidated after reported success');
     return result('claimed done');
   }
   assert.equal(calls,2); assert.match(req.session!.input,/observed failures/);
   assert.equal(req.session!.history.at(-1)!.content,'claimed done');
   writeFileSync(join(dir,'result.txt'),'expected fixture');
   return result('verified repair');
 }});
 const output=await new AgentLoop({default:()=>p} as any,{} as any).run([], 'Create and check project file', {onWorkUpdate:s=>updates.push(s)}, [], {
  workspacePath:dir,permissionMode:'workspace',tokenPolicy:'audit-only',cacheKey:'repair',nativeSessionDirectory:dir,
 });
 assert.equal(calls,2); assert.equal(output.text,'verified repair'); assert.equal(updates.at(-1)!.verified,1);
 assert.equal(output.usage.promptTokens,2);
}));
