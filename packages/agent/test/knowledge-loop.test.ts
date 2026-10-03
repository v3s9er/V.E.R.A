import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../src/ai/loop.js';
import type { AiProvider, ProviderResult } from '../src/ai/provider.js';
const result = (text = '', toolCalls: ProviderResult['toolCalls'] = []): ProviderResult => ({text, toolCalls, usage:{promptTokens:1,completionTokens:1,reportStatus:'reported'}});
const provider = (overrides: Partial<AiProvider> = {}): AiProvider => ({id:'fixture',type:'openai-compatible',label:'fixture',model:'fixture',baseUrl:'',supportsTools:true,supportedReasoning:['auto','medium'],chat:async()=>result('done'),ping:async()=>({ok:true}),models:async()=>['fixture'],...overrides});
const registry = (p: AiProvider) => ({default:()=>p}) as any;

test('API lookup returns scoped evidence without touching the computer executor', async () => {
  let calls = 0, lookups = 0;
  const p = provider({chat:async req => {
    assert.ok(req.tools?.some(t=>t.name==='knowledge_lookup'));
    if (++calls === 1) return result('', [{id:'k',name:'knowledge_lookup',args:'{"query":"component"}'}]);
    assert.match(req.turns.at(-1)!.toolResults![0].content,/scoped evidence/);
    return result('supported answer');
  }});
  const answer = await new AgentLoop(registry(p), {execute:()=>{throw Error('must not invoke computer')}} as any).run([], 'Analyze component dependencies', {}, [], {
    knowledgeLookup:q=>{assert.equal(q,'component');lookups++;return 'scoped evidence';},permissionMode:'read-only',
  });
  assert.equal(answer.text,'supported answer');assert.equal(lookups,1);
});
test('native read-only and full both get query-only host capability, with a per-run ceiling', async () => {
  for (const permissionMode of ['read-only','full'] as const) {
    let lookups = 0;
    const p = provider({type:'codex-cli',runAgent:async req=>{
      const host=req.hostTools!;assert.ok(host.tools.some(t=>t.name==='knowledge_lookup'));
      assert.equal(host.authorize!('knowledge_lookup',permissionMode),true);
      await assert.rejects(host.execute('knowledge_lookup',{query:'x',workspaceId:'other'},new AbortController().signal));
      for(let i=0;i<6;i++) assert.match((await host.execute('knowledge_lookup',{query:'x'},new AbortController().signal)).contentItems[0].type,/inputText/);
      await assert.rejects(host.execute('knowledge_lookup',{query:'x'},new AbortController().signal),/6회/);
      return result('native done');
    }});
    const answer=await new AgentLoop(registry(p),{} as any).run([],'Analyze component dependencies',{},[],{
      workspacePath:process.cwd(),permissionMode,knowledgeLookup:()=>{lookups++;return 'scoped evidence';},
    });
    assert.equal(answer.text,'native done');assert.equal(lookups,6);
  }
});
test('isolated Discord never receives the private knowledge tool or its callback', async () => {
  const p=provider({chat:async req=>{assert.ok(!req.tools?.some(t=>t.name==='knowledge_lookup'));return result('isolated');}});
  await new AgentLoop(registry(p),{} as any).run([],'Analyze component dependencies',{},[],{
    knowledgeLookup:()=>{throw Error('private memory leaked');},isolation:{tools:[],execute:async()=>{throw Error('no isolated tool requested');}},
  });
});
test('greeting stays tool-free; knowledge does not force a text-only model to change providers', async () => {
  for(const supportsTools of [true,false]) {
    const p=provider({supportsTools,chat:async req=>{assert.equal(req.tools?.length??0,0);return result('hello');}});
    const answer=await new AgentLoop(registry(p),{} as any).run([],'안녕',{},[],{knowledgeLookup:()=>{throw Error('no lookup for greeting')}});
    assert.equal(answer.text,'hello');
  }
});
