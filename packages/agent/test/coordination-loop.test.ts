import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentLoop, toolsFor, type LoopCallbacks } from '../src/ai/loop.js';
import { ToolExecutor } from '../src/ai/executor.js';
import { pooledNativeCodex, closeNativeWorkers } from '../src/ai/cli-native-pool.js';
import { waitForCliRetirements } from '../src/ai/cli-process-retirement.js';
import { coordinationTools, executeCoordination } from '../src/ai/coordination-tools.js';
import { SubagentManager } from '../src/ai/subagents.js';
import type { AiProvider, ChatRequest, ProviderResult, ProviderUsage, Turn } from '../src/ai/provider.js';
import type { SubagentSnapshot } from '../src/ai/subagents.js';

const result = (text = '', toolCalls: ProviderResult['toolCalls'] = [], promptTokens = 3, completionTokens = 2): ProviderResult => ({
  text, toolCalls, usage: { promptTokens, completionTokens, reportStatus: 'reported' },
});
const tool = (id: string, name: string, args: unknown) => ({ id, name, args: JSON.stringify(args) });
function provider(overrides: Partial<AiProvider> = {}): AiProvider {
  return { id: 'selected-provider', label: 'Selected', type: 'openai-compatible', baseUrl: '', model: 'selected-model',
    supportedReasoning: ['auto', 'high'], supportsTools: true, chat: async () => result('done'),
    ping: async () => ({ ok: true }), models: async () => ['selected-model'], ...overrides };
}
function registry(selected: AiProvider) {
  return { default: () => selected, getForModel: (id: string, model: string) => {
    assert.equal(id, selected.id); assert.equal(model, selected.model); return selected;
  } } as any;
}
function lastTools(req: ChatRequest) { return req.turns.at(-1)?.toolResults ?? []; }
test('English tool hints do not match substrings in ordinary questions', () => {
  for (const text of ['Find the greatest possible value.', 'What is the latest result?', 'Describe a happy archetype.', 'Explain a profile in psychology.']) assert.deepEqual(toolsFor(text), []);
  for (const text of ['Run tests', 'TEST the change', 'Run a shell command', '명령 실행해', '테스트해줘']) assert.ok(toolsFor(text).some(t=>t.name==='shell_exec'));
  assert.ok(toolsFor('Read files in this project').some(t=>t.name==='read_file'));
  assert.ok(toolsFor('Open the app').some(t=>t.name==='launch_app'));
  assert.ok(toolsFor('Type with the keyboard').some(t=>t.name==='type_text'));
});

test('mathematics vote stays on the selected text model without an accidental tool executor', async () => {
  let calls=0;
  const selected=provider({type:'codex-cli',model:'gpt-6-sol',supportsTools:false,chat:async req=>{
    calls++; assert.equal(req.tools?.length??0,0); return result('Answer: 1');
  }});
  const reg={default:()=>selected,resolve:()=>selected,costTier:()=>0,
    toolCapable:()=>{ throw new Error('must not switch models for greatest'); }} as any;
  const nodes=['a','b','judge'].map((id,i)=>({id,kind:'model' as const,label:id,role:i===2?'critic' as const:'reasoning' as const,providerId:selected.id,providerModel:selected.model,x:i*100,y:0}));
  const answer=await new AgentLoop(reg,{} as any).run([],'Find the greatest possible value.',{},[],{
    reasoningEffort:'high',permissionMode:'workspace',routing:{mode:'quality',executionMode:'vote',meetingRounds:1,crossGroupRounds:0,maxPremiumCalls:12,escalationEnabled:false,roles:{},graph:{nodes,edges:[]}},
  });
  assert.equal(calls,3); assert.equal(answer.route?.model,selected.model);
});
function instrument() {
  let admitted = 0, settled = 0, live = 0;
  const deltas: ProviderUsage[] = [];
  const kinds: string[] = [];
  const callbacks: LoopCallbacks = {
    reserveModelCall: kind => {
      admitted++; live++; kinds.push(kind);
      let finished = false, accountedTokens = 0;
      return { get accountedTokens() { return accountedTokens; }, finish: usage => {
        assert.equal(finished, false, 'a provider lease must settle exactly once');
        finished = true; settled++; live--;
        accountedTokens = usage ? usage.promptTokens + usage.completionTokens : 1;
        return true;
      } };
    },
    onModelUsage: usage => deltas.push(usage),
  };
  return { callbacks, deltas, kinds, counts: () => ({ admitted, settled, live }) };
}
async function workspace<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'mrrobot-coordination-loop-'));
  try { writeFileSync(join(directory, 'alpha.txt'), 'alpha fixture'); writeFileSync(join(directory, 'beta.txt'), 'beta fixture'); return await run(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const native of [false, true]) test(`Discord direct ${native ? 'native' : 'API'} execution has no helpers or PC preset`, () => workspace(async directory => {
  let calls = 0;
  const selected = provider({ type: native ? 'codex-cli' : 'openai-compatible', supportsTools: !native,
    chat: async req => {
      calls++; assert.ok(!req.tools?.some(t => t.name.startsWith('agent_')));
      return result('single direct response');
    },
    chatIsolated: async () => { throw new Error('No helper may execute'); },
    ...(native ? { runAgent: async (req: any) => {
      calls++; assert.ok(!req.hostTools?.tools.some((t: any) => t.name.startsWith('agent_')));
      assert.ok(!req.session?.instructions.includes('agent_spawn'));
      assert.equal(req.session.key, 'discord-ticket');
      return result('single direct response');
    } } : {}),
  });
  const loop = new AgentLoop(registry(selected), {} as any);
  const output = await loop.run([], 'Review this workspace', {}, [], {
    workspacePath: directory, permissionMode: 'read-only', tokenPolicy: 'audit-only',
    cacheKey: 'discord-ticket', nativeSessionDirectory: directory, singleModelOnly: true,
    routing: { mode: 'quality', executionMode: 'vote', maxPremiumCalls: 12, escalationEnabled: false, roles: {}, graph: { nodes: [], edges: [] } },
  });
  assert.equal(calls, 1);
  assert.equal(output.text, 'single direct response');
}));

test('Discord direct text-only model cannot hand tools off to another model', () => workspace(async directory => {
  const selected = provider({ supportsTools: false, chat: async () => { throw new Error('No advisor call'); } });
  await assert.rejects(new AgentLoop(registry(selected), {} as any).run([], 'Read files in this workspace', {}, [], {
    workspacePath: directory, permissionMode: 'read-only', singleModelOnly: true,
  }), /다른 모델로 전환하지 않았습니다/);
}));

test('API main delegates two same-model isolated readers, receives bounded results, and owns final synthesis', () => workspace(async directory => {
  const accounting = instrument();
  const reads: Array<{ path: string; maximum: number }> = [];
  const helperKeys = new Set<string>();
  const snapshots: Array<Omit<SubagentSnapshot, 'result' | 'error'>> = [];
  let mainCalls = 0, helperCalls = 0;
  const selected = provider({ chat: async req => {
    mainCalls++;
    assert.ok(req.tools?.some(t => t.name === 'agent_spawn'));
    if (mainCalls === 1) return result('', [
      tool('spawn-alpha', 'agent_spawn', { task: 'Read alpha.txt', context: 'Only verify alpha.', label: 'Alpha' }),
      tool('spawn-beta', 'agent_spawn', { task: 'Read beta.txt', context: 'Only verify beta.', label: 'Beta' }),
    ]);
    if (mainCalls === 2) {
      const ids = lastTools(req).map(item => JSON.parse(item.content).agentId);
      assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1]);
      return result('', ids.map((id, index) => tool(`wait-${index}`, 'agent_wait', { agentIds: [id] })));
    }
    const agents = lastTools(req).flatMap(item => JSON.parse(item.content).agents);
    assert.equal(agents.length, 2); assert.ok(agents.every(agent => agent.state === 'completed'));
    assert.ok(agents.every(agent => agent.result.startsWith('Verified ')));
    req.onEvent?.({ type: 'text', text: 'Main synthesis of two verified files.' });
    return result('Main synthesis of two verified files.');
  }, chatIsolated: async req => {
    helperCalls++;
    assert.equal(req.reasoningEffort, 'high');
    assert.deepEqual(req.tools?.map(t => t.name).sort(), ['list_files', 'read_file']);
    assert.ok(!JSON.stringify(req).includes('PARENT_PRIVATE_CONTEXT'));
    assert.ok(req.system?.includes('selected-model'));
    helperKeys.add(req.promptCacheKey!);
    req.onEvent?.({ type: 'text', text: 'PRIVATE_HELPER_STREAM' });
    if (req.turns.at(-1)?.role !== 'tool') {
      const path = req.turns.at(-1)!.content.includes('alpha') ? 'alpha.txt' : 'beta.txt';
      return result('', [tool(`read-${path}`, 'read_file', { path, maxBytes: 1_000_000 })]);
    }
    const observation = JSON.parse(lastTools(req)[0].content);
    return result(`Verified ${observation}`);
  } });
  const executor = new ToolExecutor({ safety: () => ({ mode: 'full', maxReadBytes: 10000, maxShellBytes: 10000 }), computer: {
    fs: { read: async (path: string, maximum: number) => { reads.push({ path, maximum }); return path.endsWith('alpha.txt') ? 'alpha fixture' : 'beta fixture'; } },
  } as any });
  const loop = new AgentLoop(registry(selected), executor);
  const streamed: string[] = [];
  const history: Turn[] = [{ role: 'user', content: 'PARENT_PRIVATE_CONTEXT' }, { role: 'assistant', content: 'Prior task done.' }];
  const output = await loop.run(history, 'Review the two fixture files', { ...accounting.callbacks,
    onText: text => streamed.push(text), onAgentUpdate: agent => snapshots.push(agent),
  }, [], { workspacePath: directory, permissionMode: 'full', reasoningEffort: 'high', tokenPolicy: 'standard',
    providerId: selected.id, providerModel: selected.model, cacheKey: 'private-parent' });
  assert.equal(output.text, 'Main synthesis of two verified files.');
  assert.deepEqual(streamed, ['Main synthesis of two verified files.']);
  assert.equal(mainCalls, 3); assert.equal(helperCalls, 4); assert.equal(helperKeys.size, 2);
  assert.ok([...helperKeys].every(key => key.startsWith('private-parent:helper:')));
  assert.equal(reads.length, 2); assert.ok(reads.every(read => read.path.startsWith(directory) && read.maximum === 8000));
  assert.ok(snapshots.every(snapshot => !('result' in snapshot) && !('error' in snapshot)));
  const completed = snapshots.filter(snapshot => snapshot.state === 'completed');
  assert.equal(completed.length, 2); assert.ok(completed.every(snapshot => snapshot.usage.promptTokens === 6 && snapshot.usage.completionTokens === 4));
  assert.deepEqual(accounting.counts(), { admitted: 7, settled: 7, live: 0 });
  assert.ok(accounting.kinds.every(kind => kind === 'api'));
  assert.equal(accounting.deltas.length, 7);
  assert.equal(output.usage.promptTokens, 21); assert.equal(output.usage.completionTokens, 14);
  assert.equal(output.turns.at(-1)?.content, output.text);
}));

for (const mode of ['read-only', 'workspace'] as const) test(`native audit-only enables registered coordination at ${mode} without desktop capability`, () => workspace(async directory => {
  const accounting = instrument();
  let nativeCalls = 0, helperCalls = 0;
  const selected = provider({ type: 'codex-cli', supportsTools: false,
    chat: async () => { throw new Error('native parent must not enter ordinary chat'); },
    chatIsolated: async req => {
      helperCalls++; assert.deepEqual(req.tools?.map(t => t.name).sort(), ['list_files', 'read_file']);
      return result('isolated helper result');
    }, runAgent: async req => {
      nativeCalls++;
      assert.equal(req.permissionMode, mode);
      assert.ok(req.hostTools?.tools.some(t => t.name === 'agent_spawn'));
      assert.ok(!req.hostTools?.tools.some(t => t.name.startsWith('desktop_') || t.name.startsWith('mcp_')));
      assert.equal(req.hostTools?.authorize?.('agent_spawn', mode), true);
      assert.equal(req.hostTools?.authorize?.('desktop_act', mode), false);
      assert.equal(req.hostTools?.timeoutMs?.('agent_wait'), 65_000, 'native bridge must outlast a maximum 60-second long poll');
      assert.equal(req.hostTools?.timeoutMs?.('agent_list'), 25_000, 'other helper tools keep their original deadline');
      assert.ok(req.session?.instructions.includes('agent_spawn'));
      const spawned = await req.hostTools!.execute('agent_spawn', { task: 'bounded native helper' }, req.signal!);
      const id = JSON.parse((spawned.contentItems[0] as { text: string }).text).agentId;
      const waited = await req.hostTools!.execute('agent_wait', { agentIds: [id] }, req.signal!);
      assert.equal(JSON.parse((waited.contentItems[0] as { text: string }).text).agents[0].result, 'isolated helper result');
      return result('native final');
    },
  });
  const loop = new AgentLoop(registry(selected), {} as any);
  const output = await loop.run([], 'Review this workspace', accounting.callbacks, [], { workspacePath: directory,
    permissionMode: mode, tokenPolicy: 'audit-only', cacheKey: 'native-parent', nativeSessionDirectory: directory });
  assert.equal(output.text, 'native final'); assert.equal(nativeCalls, 1); assert.equal(helperCalls, 1);
  assert.deepEqual(accounting.kinds, ['native', 'api']);
  assert.deepEqual(accounting.counts(), { admitted: 2, settled: 2, live: 0 });
  assert.equal(output.usage.promptTokens, 6);
}));

for (const tokenPolicy of ['adaptive', 'economy', 'standard', 'quality'] as const) test(`finite native ${tokenPolicy} never lends its whole-run reservation to helpers`, () => workspace(async directory => {
  const selected = provider({ type: 'codex-cli', supportsTools: false,
    chatIsolated: async () => { throw new Error('finite native helper must not run'); },
    runAgent: async req => {
      assert.equal(req.hostTools, undefined); assert.ok(!req.session?.instructions.includes('agent_spawn'));
      return result('single native execution');
    },
  });
  const output = await new AgentLoop(registry(selected), {} as any).run([], 'Explain the workspace', {}, [], {
    workspacePath: directory, permissionMode: 'read-only', tokenPolicy, cacheKey: 'finite-parent', nativeSessionDirectory: directory,
  });
  assert.equal(output.text, 'single native execution');
}));

for (const mode of ['read-only', 'workspace'] as const) test(`native app-server gateway dispatches only registered coordination capabilities under ${mode}`, () => workspace(async directory => {
  const fixture = fileURLToPath(new URL('./fixtures/coordination-app-server.mjs', import.meta.url));
  const selected = provider({ type: 'codex-cli', supportsTools: false,
    chatIsolated: async () => result('mock isolated result'),
    runAgent: req => pooledNativeCodex({ command: process.execPath, prefixArgs: [fixture], env: process.env,
      providerId: 'fixture', model: 'fixture', req }),
  });
  try {
    const output = await new AgentLoop(registry(selected), {} as any).run([], 'Review the mock fixture', {}, [], {
      workspacePath: directory, permissionMode: mode, tokenPolicy: 'audit-only', cacheKey: 'mock-native', nativeSessionDirectory: directory,
    });
    assert.equal(output.text, 'Native transport synthesis.');
    assert.equal(output.usage.promptTokens, 13); assert.equal(output.usage.completionTokens, 7);
  } finally { closeNativeWorkers(); await waitForCliRetirements(process.env); }
}));

test('Discord isolation never acquires parent coordination, workspace reads, or native authority', () => workspace(async directory => {
  const allowed = [{ name: 'public_search', description: 'public information only', parameters: { type: 'object' } }];
  let isolatedCalls = 0;
  const selected = provider({ type: 'codex-cli', supportsTools: false,
    chat: async () => { throw new Error('isolated request must not enter ordinary chat'); },
    runAgent: async () => { throw new Error('isolated request must not enter native execution'); },
    chatIsolated: async req => {
      isolatedCalls++; assert.deepEqual(req.tools, allowed); assert.ok(!req.system?.includes('agent_spawn'));
      return result('isolated public response');
    },
  });
  const output = await new AgentLoop(registry(selected), {} as any).run([], 'Summarize public information', {}, [], {
    workspacePath: directory, permissionMode: 'full', tokenPolicy: 'standard',
    isolation: { tools: allowed, execute: async () => { throw new Error('unexpected broker operation'); } },
  });
  assert.equal(output.text, 'isolated public response'); assert.equal(isolatedCalls, 1);
  assert.equal(allowed.length, 1);
}));

for (const denied of ['shell', 'outside-path'] as const) test(`helper ${denied} requests never cross the read-only workspace boundary`, () => workspace(async directory => {
  let mainCalls = 0, helperCalls = 0, computerReads = 0;
  let finalWorker: SubagentSnapshot | undefined;
  const selected = provider({ chat: async req => {
    mainCalls++;
    if (mainCalls === 1) return result('', [tool('spawn', 'agent_spawn', { task: 'inspect a fixture' })]);
    if (mainCalls === 2) return result('', [tool('wait', 'agent_wait', { agentIds: [JSON.parse(lastTools(req)[0].content).agentId] })]);
    finalWorker = JSON.parse(lastTools(req)[0].content).agents[0];
    return result('boundary respected');
  }, chatIsolated: async req => {
    helperCalls++;
    if (helperCalls === 1) return result('', [denied === 'shell'
      ? tool('denied', 'shell_exec', { command: 'not executed' })
      : tool('denied', 'read_file', { path: join(directory, '..', 'outside.txt') })]);
    assert.match(lastTools(req)[0].content, /작업 폴더 밖/);
    return result('outside path denied');
  } });
  const executor = new ToolExecutor({ safety: () => ({ mode: 'full', maxReadBytes: 10000, maxShellBytes: 10000 }), computer: {
    fs: { read: async () => { computerReads++; throw new Error('must not reach filesystem outside scope'); } },
    shell: async () => { throw new Error('must not reach shell'); },
  } as any });
  await new AgentLoop(registry(selected), executor).run([], 'Review a fixture', {}, [], { workspacePath: directory, permissionMode: 'full' });
  assert.equal(computerReads, 0);
  assert.equal(finalWorker?.state, denied === 'shell' ? 'failed' : 'completed');
  assert.equal(finalWorker?.usage.promptTokens, denied === 'shell' ? 3 : 6);
}));

test('parent finalization cancels and drains detached helper calls before returning aggregate usage', () => workspace(async directory => {
  const accounting = instrument();
  let mainCalls = 0, helperStarted = false, helperAborted = false;
  const selected = provider({ chat: async () => {
    mainCalls++;
    return mainCalls === 1 ? result('', [tool('spawn', 'agent_spawn', { task: 'unneeded helper' })]) : result('main completed independently');
  }, chatIsolated: req => new Promise(resolve => {
    helperStarted = true;
    req.signal!.addEventListener('abort', () => { helperAborted = true; resolve(result('late helper text', [], 7, 4)); }, { once: true });
  }) });
  const output = await new AgentLoop(registry(selected), {} as any).run([], 'Finish a bounded review', accounting.callbacks, [], {
    workspacePath: directory, permissionMode: 'read-only', tokenPolicy: 'standard',
  });
  assert.equal(helperStarted, true); assert.equal(helperAborted, true);
  assert.equal(output.text, 'main completed independently');
  assert.deepEqual(accounting.counts(), { admitted: 3, settled: 3, live: 0 });
  assert.equal(accounting.deltas.length, 3);
  assert.equal(output.usage.promptTokens, 13); assert.equal(output.usage.completionTokens, 8);
  assert.ok(!JSON.stringify(output.turns).includes('late helper text'));
}));

test('coordination dispatch preserves explicit assignment identity for default and configured workers', async () => {
  for (const workers of [[], [{ id: 'review', label: 'Review', providerId: 'fixture', model: 'fixture' }]]) {
    const schema = coordinationTools(workers).find(tool => tool.name === 'agent_spawn')!.parameters as any;
    assert.equal(schema.properties.assignmentKey.maxLength, 128);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const manager = new SubagentManager({ providerId: 'fixture', model: 'fixture', workers, execute: async () => {
      calls++; await gate; return { text: 'Independent result' };
    } });
    const signal = new AbortController().signal;
    try {
      const input = { task: 'Check the same source', assignmentKey: 'retry-this-assignment', workerId: workers[0]?.id };
      const first = JSON.parse(await executeCoordination(manager, 'agent_spawn', input, signal));
      const retry = JSON.parse(await executeCoordination(manager, 'agent_spawn', input, signal));
      assert.equal(retry.agentId, first.agentId); assert.equal(retry.reused, true);
      const independent = JSON.parse(await executeCoordination(manager, 'agent_spawn', { ...input, assignmentKey: 'independent-review' }, signal));
      assert.notEqual(independent.agentId, first.agentId);
      release(); await manager.drained(); assert.equal(calls, 2);
    } finally { release(); manager.dispose(); await manager.drained(); }
  }
});

test('coordination cursor strips repeated result bodies and repeated waits cannot create budget progress', async () => {
  const manager = new SubagentManager({ providerId: 'fixture', model: 'fixture', execute: async () => ({ text: 'completed evidence' }) });
  const signal = new AbortController().signal;
  try {
    manager.spawn({ task: 'bounded fixture' }); await manager.drained();
    const initial = JSON.parse(await executeCoordination(manager, 'agent_wait', {}, signal));
    assert.equal(initial.progress, true); assert.equal(initial.agents[0].result, 'completed evidence');
    const unchanged = JSON.parse(await executeCoordination(manager, 'agent_wait', { afterSequence: initial.sequence, timeoutMs: 0 }, signal));
    assert.equal(unchanged.progress, false); assert.equal(unchanged.agents[0].result, undefined);
    const repeated = JSON.parse(await executeCoordination(manager, 'agent_wait', {}, signal));
    assert.equal(repeated.progress, false, 'omitting a model-controlled cursor cannot manufacture verified progress');
    assert.equal(repeated.agents[0].result, undefined, 'host delivery state also bounds output without a cursor');
    const stale = JSON.parse(await executeCoordination(manager, 'agent_wait', { afterSequence: 0 }, signal));
    assert.equal(stale.progress, false, 'replaying a stale cursor cannot manufacture verified progress');
    assert.equal(stale.agents[0].result, undefined);
  } finally { manager.dispose(); await manager.drained(); }
});

test('waiting for one child cannot hide undelivered sibling evidence behind a global cursor', async () => {
  const manager = new SubagentManager({ providerId: 'fixture', model: 'fixture', execute: async input => ({ text: `Evidence for ${input.task}` }) });
  const signal = new AbortController().signal;
  try {
    const first = manager.spawn({ task: 'first source' }), second = manager.spawn({ task: 'second source' });
    await manager.drained();
    const selected = JSON.parse(await executeCoordination(manager, 'agent_wait', { agentIds: [second.agentId] }, signal));
    assert.equal(selected.agents[0].result, 'Evidence for second source');
    const unread = JSON.parse(await executeCoordination(manager, 'agent_wait', { agentIds: [first.agentId], afterSequence: selected.sequence }, signal));
    assert.equal(unread.agents[0].result, 'Evidence for first source');
    assert.equal(unread.progress, true);
    assert.ok(unread.waitedMs < 1000, 'already available unread evidence must not wait for the long-poll deadline');
    const repeated = JSON.parse(await executeCoordination(manager, 'agent_wait', { timeoutMs: 0 }, signal));
    assert.ok(repeated.agents.every((agent: any) => agent.result === undefined));
    assert.equal(repeated.progress, false);
  } finally { manager.dispose(); await manager.drained(); }
});

test('concurrent waits deliver a completion once and a later follow-up only after it finishes', async () => {
  let finish: ((value: { text: string }) => void) | undefined;
  let calls = 0;
  const manager = new SubagentManager({ providerId: 'fixture', model: 'fixture', execute: async () => {
    if (++calls === 1) return { text: 'First evidence' };
    return new Promise(resolve => { finish = resolve; });
  } });
  const signal = new AbortController().signal;
  try {
    const { agentId } = manager.spawn({ task: 'first source' }); await manager.drained();
    const waits = await Promise.all(Array.from({ length: 8 }, async () => JSON.parse(await executeCoordination(manager, 'agent_wait', { agentIds: [agentId] }, signal))));
    assert.equal(waits.filter(wait => wait.progress).length, 1);
    assert.equal(waits.filter(wait => wait.agents[0].result === 'First evidence').length, 1);
    manager.message({ agentId, message: 'Check the changed source' });
    const running = JSON.parse(await executeCoordination(manager, 'agent_wait', { agentIds: [agentId], timeoutMs: 0 }, signal));
    assert.equal(running.agents[0].result, undefined, 'a follow-up must not present the previous result as current evidence');
    await new Promise(resolve => setImmediate(resolve));
    finish!({ text: 'New evidence' }); await manager.drained();
    const final = JSON.parse(await executeCoordination(manager, 'agent_wait', { agentIds: [agentId], afterSequence: Number.MAX_SAFE_INTEGER }, signal));
    assert.equal(final.agents[0].result, 'New evidence'); assert.equal(final.progress, true);
  } finally { finish?.({ text: 'cleanup' }); manager.dispose(); await manager.drained(); }
});

test('unread failures survive cursors without manufacturing evidence progress', async () => {
  const manager = new SubagentManager({ providerId: 'fixture', model: 'fixture', execute: async () => { throw new Error('read failed'); } });
  const signal = new AbortController().signal;
  try {
    manager.spawn({ task: 'read a missing source' }); await manager.drained();
    const failed = JSON.parse(await executeCoordination(manager, 'agent_wait', { afterSequence: Number.MAX_SAFE_INTEGER }, signal));
    assert.equal(failed.agents[0].error, 'read failed'); assert.equal(failed.progress, false);
    const repeated = JSON.parse(await executeCoordination(manager, 'agent_wait', { timeoutMs: 0 }, signal));
    assert.equal(repeated.agents[0].error, undefined);
  } finally { manager.dispose(); await manager.drained(); }
});
