import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { NativeRunScheduler } from '../src/ai/native-run-scheduler.js';
import { pooledNativeCodex, closeNativeWorkers } from '../src/ai/cli-native-pool.js';
import { waitForCliRetirements } from '../src/ai/cli-process-retirement.js';
import { ChatSession } from '../src/server/chat.js';
import { AgentLoop } from '../src/ai/loop.js';
import type { NativeAgentRequest, Turn } from '../src/ai/provider.js';
import { nativeHistory } from '../src/ai/native-history.js';

const fixture = fileURLToPath(new URL('./fixtures/native-control-app-server.mjs', import.meta.url));
async function withSyntheticCleanup(body: () => Promise<void>, retire: () => Promise<void>, cleanup: () => void) {
  const failures: Error[] = [];
  const capture = async (phase: string, action: () => void | Promise<void>) => {
    try { await action(); return true; }
    catch (cause) { failures.push(new Error(`Synthetic native fixture ${phase} failed`, { cause })); return false; }
  };
  // A previous 5s retirement timeout was inconclusive: the old finally could
  // replace a body failure. Preserve both causes and identify each phase;
  // never remove the workspace until the existing retirement guard succeeds.
  await capture('body', body);
  if (await capture('retirement', retire)) await capture('directory cleanup', cleanup);
  if (failures.length > 1) throw new AggregateError(failures, 'Synthetic native fixture failed in multiple phases', { cause: failures[0] });
  if (failures.length) throw failures[0];
}
async function sandbox(fn: (base: NativeAgentRequest, call: (req: NativeAgentRequest) => ReturnType<typeof pooledNativeCodex>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'mrrobot-control-test-'));
  const base: NativeAgentRequest = { prompt: 'fixture', cwd: dir, permissionMode: 'read-only',
    session: { key: 'fixture-ticket', directory: dir, history: [], input: 'hello', instructions: 'fixture only', context: '' } };
  const call = (req: NativeAgentRequest) => pooledNativeCodex({ command: process.execPath, prefixArgs: [fixture], env: process.env, providerId: 'fixture', model: 'fixture', req });
  await withSyntheticCleanup(() => fn(base, call), async () => {
    closeNativeWorkers(); await waitForCliRetirements(process.env);
  }, () => {
    const target = resolve(dir), parent = resolve(tmpdir()) + sep;
    assert.ok(target.startsWith(parent) && target.slice(parent.length).startsWith('mrrobot-control-test-'));
    rmSync(target, { recursive: true, force: true });
  });
}

test('synthetic cleanup preserves a body failure while completing confirmed retirement', async () => {
  const bodyFailure = new Error('synthetic body failure'), phases: string[] = [];
  await assert.rejects(withSyntheticCleanup(async () => { phases.push('body'); throw bodyFailure; },
    async () => { phases.push('retirement'); }, () => { phases.push('cleanup'); }), (error: Error) => {
    assert.match(error.message, /fixture body failed/); assert.equal(error.cause, bodyFailure); return true;
  });
  assert.deepEqual(phases, ['body', 'retirement', 'cleanup']);
});

test('synthetic cleanup retains both body and retirement failures and does not remove a live workspace', async () => {
  const bodyFailure = new Error('synthetic body failure'), retirementFailure = new Error('synthetic retirement timeout');
  await assert.rejects(withSyntheticCleanup(async () => { throw bodyFailure; }, async () => { throw retirementFailure; },
    () => { assert.fail('unconfirmed retirement must not permit directory removal'); }), (error: AggregateError) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(item => item.cause), [bodyFailure, retirementFailure]);
    assert.match(error.errors[0].message, /fixture body failed/);
    assert.match(error.errors[1].message, /fixture retirement failed/);
    assert.equal(error.cause, error.errors[0]); return true;
  });
});

test('synthetic cleanup distinguishes a retirement-only failure from a failed test body', async () => {
  const retirementFailure = new Error('synthetic retirement timeout');
  await assert.rejects(withSyntheticCleanup(async () => {}, async () => { throw retirementFailure; },
    () => { assert.fail('unconfirmed retirement must not permit directory removal'); }), (error: Error) => {
    assert.match(error.message, /fixture retirement failed/); assert.equal(error.cause, retirementFailure); return true;
  });
});

test('synthetic cleanup preserves body and directory-removal failures without changing successful cleanup', async () => {
  const bodyFailure = new Error('synthetic body failure'), cleanupFailure = new Error('synthetic removal failure');
  await assert.rejects(withSyntheticCleanup(async () => { throw bodyFailure; }, async () => {}, () => { throw cleanupFailure; }),
    (error: AggregateError) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors.map(item => item.cause), [bodyFailure, cleanupFailure]);
      assert.match(error.errors[1].message, /fixture directory cleanup failed/); return true;
    });
  const phases: string[] = [];
  await withSyntheticCleanup(async () => { phases.push('body'); }, async () => { phases.push('retirement'); }, () => { phases.push('cleanup'); });
  assert.deepEqual(phases, ['body', 'retirement', 'cleanup']);
});

test('scheduler is FIFO, bounded, cancel-aware and rejects duplicate ownership', async () => {
  const scheduler = new NativeRunScheduler(1, 2);
  const release = await scheduler.acquire('a');
  const abort = new AbortController(); const positions: number[] = [];
  const b = scheduler.acquire('b', abort.signal);
  const c = scheduler.acquire('c', undefined, p => positions.push(p));
  await assert.rejects(scheduler.acquire('a'), /같은 대화/);
  await assert.rejects(scheduler.acquire('overflow'), /가득/);
  abort.abort(); await assert.rejects(b, /중지/);
  assert.equal(positions.at(-1), 1);
  release(); release(); const releaseC = await c;
  let dStarted = false;
  const d = scheduler.acquire('d').then(done => { dStarted = true; return done; });
  await delay(10); assert.equal(dStarted, false, 'idempotent release cannot grant extra slots');
  releaseC(); (await d)();
});

test('scheduler shutdown clears queued jobs and listeners without starting them', async () => {
  const scheduler = new NativeRunScheduler(1);
  const release = await scheduler.acquire('a');
  const pending = scheduler.acquire('b');
  scheduler.cancelPending(); await assert.rejects(pending, /종료/);
  release(); (await scheduler.acquire('b'))();
});

test('detached queue progress consumers cannot leak execution slots', async () => {
  const scheduler = new NativeRunScheduler(1);
  const release = await scheduler.acquire('a');
  const queued = scheduler.acquire('b', undefined, () => { throw Error('disconnected UI'); });
  release(); (await queued)(); (await scheduler.acquire('c'))();
});

test('steering queue never silently drops an unacknowledged instruction', () => {
  const session = new ChatSession(); session.begin();
  let events = 0; const unsubscribe = session.nativeSteering.subscribe(() => events++);
  for (let i = 0; i < 20; i++) session.steer(`input ${i}`);
  assert.throws(() => session.steer('overflow'), /20개/);
  assert.equal(session.nativeSteering.peek()[0], 'input 0');
  assert.equal(session.nativeSteering.commit(['wrong']), false);
  assert.equal(session.nativeSteering.commit(['input 0']), true);
  unsubscribe(); session.steer('input 20'); assert.equal(events, 20);
  session.end(); assert.equal(session.steeringQueued, 0);
  assert.throws(() => session.steer('after end'), /실행 중인 작업/);
  session.begin(); session.cancel(); assert.throws(() => session.steer('after stop'), /실행 중인 작업/); session.end();
});

for (const mode of ['STREAM', 'STREAM_NO_START']) test(`public text streams before completion when phase is absent: ${mode}`, () => sandbox(async (base, call) => {
  let first = 0, settled = false, text = ''; const started = performance.now();
  let firstDelta!: () => void; const delta = new Promise<void>(resolve => { firstDelta = resolve; });
  const pending = call({ ...base, session: { ...base.session!, input: mode }, onText: chunk => {
    if (!first) first = performance.now(); text += chunk; firstDelta();
  } }).then(result => { settled = true; return result; });
  await delta; assert.equal(settled, false, 'first output must not wait for item/completed');
  const result = await pending;
  assert.equal(text, result.text); assert.equal(text.includes('PRIVATE_REASONING'), false);
  console.log(`[synthetic ${mode}] first text ${Math.round(first - started)}ms; complete ${Math.round(performance.now() - started)}ms`);
}));

test('multiple final messages match streamed output, persisted history and warm follow-up', () => sandbox(async (base, call) => {
  let text = ''; const timings: any[] = [];
  const req = { ...base, session: { ...base.session!, input: 'MULTI_FINAL' }, onText: (t: string) => text += t, onTiming: (t: any) => timings.push(t) };
  const result = await call(req);
  assert.equal(result.text, 'first\n\nsecond'); assert.equal(text, result.text);
  const history: Turn[] = [{ role: 'user', content: 'MULTI_FINAL' }, { role: 'assistant', content: result.text }];
  const followTimings: any[] = [];
  assert.equal((await call({ ...base, session: { ...base.session!, history, input: 'next' }, onTiming: t => followTimings.push(t) })).text, 'answer 2');
  assert.deepEqual(timings.map(t => t.stage), ['queue', 'retirement', 'worker', 'initialized', 'thread', 'submitted', 'accepted', 'firstDelta', 'firstText', 'completed']);
  assert.ok(timings.every((t, i) => t.transport === 'codex-native' && (!i || t.elapsedMs >= timings[i - 1].elapsedMs)));
  assert.equal(followTimings.find(t => t.stage === 'worker').reused, true);
  assert.ok(!JSON.stringify(timings).includes('first\\n'));
}));

for (const mode of ['BAD_DUPLICATE', 'LATE_DELTA', 'PARTIAL_FINAL', 'INTERLEAVED_FINAL', 'AGGREGATE_LIMIT']) test(`native malformed or incomplete output fails closed: ${mode}`, () => sandbox(async (base, call) => {
  const timings: any[] = [];
  await assert.rejects(call({ ...base, session: { ...base.session!, input: mode }, onTiming: t => timings.push(t) }), /네이티브/);
  assert.equal(timings.at(-1).stage, 'failed');
  assert.equal(timings.some(t => t.stage === 'completed'), false);
  assert.equal((await call(base)).text, 'answer 1', 'failed partial output must not be checkpointed');
}));

test('history packing preserves valid records, newest groups, tool pairs and explicit omissions', () => {
  const history: Turn[] = [{ role: 'user', content: 'old'.repeat(20_000) }, { role: 'assistant', content: 'old reply' },
    { role: 'user', content: 'latest request' }, { role: 'assistant', content: '', toolCalls: [{ id: 't', name: 'read', args: '{}' }] },
    { role: 'tool', content: '', toolResults: [{ id: 't', name: 'read', content: 'result' }] }, { role: 'assistant', content: 'recent reply' }];
  const packed = nativeHistory(history); assert.ok(packed.length <= 48_000);
  assert.deepEqual(JSON.parse(packed), { omittedEarlierRecords: 2, records: history.slice(2) });
  const huge: Turn[] = [{ role: 'user', content: `HEAD-${'한😀'.repeat(30_000)}-TAIL` }, { role: 'assistant', content: 'recent answer' }];
  for (const limit of [512, 1024, 48_000]) {
    const p = nativeHistory(huge, limit); assert.ok(p.length <= limit);
    const value = JSON.parse(p); assert.equal(value.incompleteRecords, true);
    assert.match(value.records[0].content, /HEAD/); assert.match(value.records[0].content, /TAIL/);
    assert.ok([...value.records[0].content as string].every(c => c.codePointAt(0)! < 0xd800 || c.codePointAt(0)! > 0xdfff), 'no broken Unicode code points');
    assert.equal(value.records.at(-1).content, 'recent answer');
  }
  assert.deepEqual(JSON.parse(nativeHistory([])), { omittedEarlierRecords: 0, records: [] });
});

test('long history is sent to native transport as valid data records', () => sandbox(async (base, call) => {
  const history: Turn[] = [{ role: 'user', content: 'old'.repeat(20_000) }, { role: 'assistant', content: 'old' }, { role: 'user', content: 'recent' }, { role: 'assistant', content: 'recent reply' }];
  assert.equal((await call({ ...base, session: { ...base.session!, history, input: 'CHECK_HISTORY' } })).text, 'history valid');
}));

test('throwing native timing consumer cannot break an otherwise valid run', () => sandbox(async (base, call) => {
  assert.equal((await call({ ...base, onTiming: () => { throw Error('UI disconnected'); } })).text, 'answer 1');
}));

for (const mode of ['LIVE_STEER', 'LATE_ACK']) test(`active-turn steering commits once and preserves warm session: ${mode}`, () => sandbox(async (base, call) => {
  const session = new ChatSession(); session.begin(); let sent = false; const applied: string[] = [];
  const req = { ...base, session: { ...base.session!, input: mode }, steering: session.nativeSteering,
    onSteeringApplied: (inputs: readonly string[]) => applied.push(...inputs),
    onStatus: (status: string) => { if (status.includes('요청을 검토') && !sent) { sent = true; session.steer('keep existing work'); } },
  };
  const result = await call(req);
  assert.equal(result.text, 'steered 1: keep existing work');
  assert.deepEqual(applied, ['keep existing work']); assert.equal(session.steeringQueued, 0);
  const history: Turn[] = [{ role: 'user', content: mode }, { role: 'user', content: applied[0] }, { role: 'assistant', content: result.text }];
  const next = await call({ ...base, session: { ...base.session!, history, input: 'next' } });
  assert.equal(next.text, 'answer 2', 'acknowledged steering must not invalidate next-turn reuse');
  session.end();
}));

test('definitive steering rejection retains input for fallback without interrupting the turn', () => sandbox(async (base, call) => {
  const session = new ChatSession(); session.begin(); session.steer('follow up'); let applied = false;
  const result = await call({ ...base, session: { ...base.session!, input: 'REJECT_STEER' }, steering: session.nativeSteering,
    onSteeringApplied: () => { applied = true; } });
  assert.equal(result.text, 'answer 1'); assert.equal(applied, false);
  assert.deepEqual(session.takeSteering(), ['follow up']); session.end();
}));

test('wrong steering acknowledgement fails closed without consuming host input', () => sandbox(async (base, call) => {
  const session = new ChatSession(); session.begin(); session.steer('follow up');
  await assert.rejects(call({ ...base, session: { ...base.session!, input: 'WRONG_STEER' }, steering: session.nativeSteering }), /검증/);
  assert.deepEqual(session.takeSteering(), ['follow up']); session.end();
}));

for (const mode of ['INTERRUPT_ACTIVE', 'IGNORE_INTERRUPT']) test(`cancellation uses protocol interrupt and bounded retirement: ${mode}`, () => sandbox(async (base, call) => {
  const abort = new AbortController(); let at = 0;
  const pending = call({ ...base, signal: abort.signal, session: { ...base.session!, input: mode },
    onStatus: status => { if (status.includes('요청을 검토') && !at) { at = performance.now(); abort.abort(); } },
    onText: () => { assert.fail('no output after cancellation'); },
  });
  await assert.rejects(pending, /중지/);
  // Caller admission now waits for confirmed process closure, rather than
  // returning before Windows taskkill finishes: 1.5s interrupt + <=5s drain.
  assert.ok(performance.now() - at < 8000, 'unresponsive CLI must finish bounded retirement before releasing admission');
  assert.match(readFileSync(join(base.cwd, 'interrupt-observed.txt'), 'utf8'), /interrupt/);
  assert.equal((await call(base)).text, 'answer 1', 'cancelled partial turn is not resumed');
}));

test('worker capacity queues a fifth conversation instead of failing', () => sandbox(async (base, call) => {
  const queued: string[] = [];
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => call({ ...base,
    session: { ...base.session!, key: `ticket-${i}`, input: 'SLOW_SLOT' }, onStatus: status => { if (status.includes('실행 대기')) queued.push(status); },
  })));
  assert.equal(results.length, 5); assert.ok(queued.length > 0);
}));

test('shutdown between admission and process launch does not spawn a new worker', () => sandbox(async (base, call) => {
  const pending = call(base); closeNativeWorkers(); await assert.rejects(pending, /종료/);
}));

test('native loop uses one selected-provider invocation and persists live instructions for reuse', () => sandbox(async (base, call) => {
  const session = new ChatSession(); session.begin(); let sent = false, calls = 0, policyChecks = 0;
  const native = {
    id: 'fixture', label: 'Fixture', type: 'codex-cli', model: 'fixture', supportedReasoning: ['auto', 'high'], supportsTools: false,
    chat() { throw Error('single native mode must not call a coordinator model'); },
    async runAgent(req: NativeAgentRequest) { calls++; assert.equal(req.reasoningEffort, 'high'); return call(req); },
  };
  const loop = new AgentLoop({ default: () => native } as any, { execute: async () => '{}' } as any);
  const callbacks = { nativeSteering: session.nativeSteering, takeSteering: () => session.takeSteering(),
    beforeModelCall: () => { policyChecks++; },
    onStatus: (status: string) => { if (status.includes('요청을 검토') && !sent) { sent = true; session.steer('keep work'); } },
  };
  const options = { workspacePath: base.cwd, cacheKey: 'fixture', nativeSessionDirectory: base.session!.directory,
    permissionMode: 'read-only' as const, reasoningEffort: 'high' as const };
  const first = await loop.run([], 'LIVE_STEER', callbacks, [], options);
  assert.equal(calls, 1); assert.equal(policyChecks, 1);
  assert.deepEqual(first.turns.map(t => t.content), ['LIVE_STEER', 'keep work', 'steered 1: keep work']);
  const second = await loop.run(first.turns, 'next', callbacks, [], options);
  assert.equal(second.text, 'answer 2'); assert.equal(calls, 2); assert.equal(policyChecks, 2);
  session.end();
}));

test('print-CLI continuation persists the full verified transcript, not only the final answer', async () => {
  let calls = 0, steeringReads = 0;
  const provider = {
    id: 'fixture', label: 'Fixture', type: 'codex-cli', model: 'fixture', supportedReasoning: ['auto'], supportsTools: false,
    runAgent: async () => ({ text: `answer ${++calls}`, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } }),
  };
  const loop = new AgentLoop({ default: () => provider } as any, {} as any);
  const result = await loop.run([], 'original', { takeSteering: () => ++steeringReads === 1 ? ['follow-up'] : [] }, [],
    { workspacePath: tmpdir(), permissionMode: 'read-only' });
  assert.deepEqual(result.turns.map(t => t.content), ['original', 'answer 1', 'follow-up', 'answer 2']);
});

test('simple text preserves queued task steering and re-enters native work with the selected depth', async () => {
  let textCalls=0, nativeCalls=0, steeringReads=0;
  const provider={id:'fixture',label:'Fixture',type:'codex-cli',model:'same-model',supportedReasoning:['auto','low','high'],supportsTools:false,
    chat:async (req:any)=>{textCalls++;assert.equal(req.reasoningEffort,'low');assert.deepEqual(req.tools,[]);req.onEvent?.({type:'text',text:'Hello'});return {text:'Hello',toolCalls:[],usage:{promptTokens:1,completionTokens:1}};},
    runAgent:async (req:NativeAgentRequest)=>{nativeCalls++;assert.equal(req.reasoningEffort,'high');assert.equal(req.permissionMode,'read-only');assert.match(req.prompt,/Hello/);assert.match(req.prompt,/프로젝트 분석/);return {text:'Task done',toolCalls:[],usage:{promptTokens:1,completionTokens:1}};},
  };
  const loop=new AgentLoop({default:()=>provider} as any,{} as any);
  const result=await loop.run([],'ㅎㅇ',{takeSteering:()=>++steeringReads===1?['프로젝트 분석']:[]},[],{workspacePath:tmpdir(),permissionMode:'read-only',reasoningEffort:'high'});
  assert.equal(textCalls,1);assert.equal(nativeCalls,1);assert.equal(result.route?.model,'same-model');assert.equal(result.route?.effort,'high');
  assert.deepEqual(result.turns.map(t=>t.content),['ㅎㅇ','Hello','프로젝트 분석','Task done']);
  assert.equal(result.usage.promptTokens,2);
});

test('trivial answer echo keeps text-session history and real work restores native high effort', async () => {
  let textCalls=0,nativeCalls=0;
  const provider={id:'fixture',label:'Fixture',type:'codex-cli',model:'same-model',supportedReasoning:['auto','low','high'],supportsTools:false,
    chat:async(req:any)=>{textCalls++;assert.equal(req.reasoningEffort,'low');assert.deepEqual(req.tools,[]);
      if(textCalls===2)assert.deepEqual(req.turns.map((t:any)=>t.content),['2 + 2 =','2 + 2 = 4','방금 계산한 식과 답을 다시 말해줘.']);
      return {text:'2 + 2 = 4',toolCalls:[],usage:{promptTokens:1,completionTokens:1}};},
    runAgent:async(req:NativeAgentRequest)=>{nativeCalls++;assert.equal(req.reasoningEffort,'high');assert.equal(req.permissionMode,'read-only');assert.match(req.prompt,/2 \+ 2 = 4/);return {text:'Task done',toolCalls:[],usage:{promptTokens:1,completionTokens:1}};},
  };
  const loop=new AgentLoop({default:()=>provider} as any,{} as any);
  const options={workspacePath:tmpdir(),permissionMode:'read-only' as const,reasoningEffort:'high' as const};
  const first=await loop.run([],'2 + 2 =',{},[],options);
  const echo=await loop.run(first.turns,'방금 계산한 식과 답을 다시 말해줘.',{},[],options);
  assert.equal(textCalls,2);assert.equal(nativeCalls,0);assert.equal(echo.route?.effort,'low');assert.equal(echo.route?.model,'same-model');
  await loop.run(echo.turns,'프로젝트 분석',{},[],options);
  assert.equal(nativeCalls,1);assert.equal(textCalls,2);
});

test('cancelled simple text cannot continue queued native work', async () => {
  const abort=new AbortController();let nativeCalls=0;
  const provider={id:'fixture',label:'Fixture',type:'codex-cli',model:'same-model',supportedReasoning:['auto','low','high'],supportsTools:false,
    chat:async (req:any)=>{abort.abort(new Error('owned cancellation'));req.signal.throwIfAborted();},
    runAgent:async ()=>{nativeCalls++;throw Error('must not run');},
  };
  const loop=new AgentLoop({default:()=>provider} as any,{} as any);
  await assert.rejects(loop.run([],'ㅎㅇ',{takeSteering:()=>['파일 수정'],signal:abort.signal},[],{workspacePath:tmpdir(),permissionMode:'read-only',reasoningEffort:'high'}),/owned cancellation/);
  assert.equal(nativeCalls,0);
});
