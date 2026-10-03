import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pooledCodexText, closeTextWorkers } from '../src/ai/cli-text-pool.js';
import { waitForCliRetirements } from '../src/ai/cli-process-retirement.js';
import type { ChatRequest, ProviderTiming } from '../src/ai/provider.js';
const call=(req:Partial<ChatRequest>={})=>pooledCodexText({command:process.execPath,prefixArgs:[fileURLToPath(new URL('./fixtures/plain-text-app-server.mjs',import.meta.url))],env:process.env,providerId:'fixture',model:'exact-strong-model',req:{textOnly:true,tools:[],turns:[{role:'user',content:'hello'}],...req}});
test('plain isolated text streams immediately, completes the suffix once, and resumes only verified history',async()=>{
 try{
  let text='',settled=false,early=false;const timings:ProviderTiming[]=[];
  const turns:ChatRequest['turns']=[{role:'user',content:'hello'}];
  const req={turns,promptCacheKey:'private-session',onTiming:(t:ProviderTiming)=>timings.push(t)};
  const a=await call({...req,onEvent:e=>{if(e.type==='text'){text+=e.text;early ||=!settled;assert.equal(text.includes('PRIVATE_REASONING'),false);}}}).then(r=>{settled=true;return r;});
  assert.equal(early,true);assert.equal(a.text,text);assert.equal(text,'답변 1: 안녕 👋');assert.deepEqual(a.toolCalls,[]);
  assert.ok(timings.find(t=>t.stage==='firstText')!.elapsedMs<timings.find(t=>t.stage==='completed')!.elapsedMs);
  assert.ok(timings.every(t=>Number.isFinite(t.elapsedMs)&&t.elapsedMs>=0));
  const next=[...turns,{role:'assistant' as const,content:a.text},{role:'user' as const,content:'next'}];
  assert.equal((await call({...req,turns:next})).text,'답변 2: 안녕 👋');
  assert.ok(timings.some(t=>t.reused));
  const fresh:ProviderTiming[]=[];
  assert.equal((await call({...req,promptCacheKey:'different-user',onTiming:t=>fresh.push(t)})).text,'답변 1: 안녕 👋');
  assert.ok(!fresh.some(t=>t.stage==='initialized'),'new isolated thread reuses transport, not initialization or history');
  assert.ok(fresh.some(t=>t.stage==='thread'&&!t.reused),'fresh thread is mandatory');
  assert.equal((await call({...req,system:'new permissions',turns:next})).text,'답변 1: 안녕 👋');
  let fallback='';const b=await call({turns:[{role:'user',content:'NO_DELTA'}],onEvent:e=>{if(e.type==='text')fallback+=e.text;}});assert.equal(fallback,b.text);
  let multi='';const c=await call({turns:[{role:'user',content:'MULTI'}],onEvent:e=>{if(e.type==='text')multi+=e.text;}});assert.equal(multi,c.text);assert.equal(multi,'답변 1: 안녕 👋next!');
  for(const mode of ['ATTACK','MISMATCH','FOREIGN','FAIL','PARTIAL'])await assert.rejects(call({turns:[{role:'user',content:mode}]}));
  await assert.rejects(call({turns:[{role:'user',content:'WAIT'}],signal:AbortSignal.timeout(250)}),/중지/);
  closeTextWorkers();await waitForCliRetirements(process.env);
  await call({promptCacheKey:'reset-from',system:'DENY_UNSUBSCRIBE'});
  await assert.rejects(call({promptCacheKey:'reset-to'}),/연결 해제/);
  closeTextWorkers();await waitForCliRetirements(process.env);
  let initialized=0;
  for(let n=0;n<18;n++){
    const result=await call({promptCacheKey:`bounded-${n}`,onTiming:t=>{if(t.stage==='initialized')initialized++;}});
    assert.equal(result.text,'답변 1: 안녕 👋');
  }
  assert.equal(initialized,2,'bounded thread recycling eventually retires the process');
 }finally{closeTextWorkers();await waitForCliRetirements(process.env);}
});

test('changing retained evidence preserves one text session and explicitly clears removed context', async () => {
 try {
  const req: ChatRequest = { system: 'stable instructions', promptCacheKey: 'context-update', context: 'CONTEXT_OLD', turns: [{ role: 'user', content: 'first' }] };
  let answer = await call(req);
  for (const [input, context, count] of [['EXPECT_CONTEXT_NEW', 'CONTEXT_NEW', 2], ['EXPECT_CONTEXT_UNCHANGED', 'CONTEXT_NEW', 3], ['EXPECT_CONTEXT_CLEAR', undefined, 4]] as const) {
   req.turns.push({ role: 'assistant', content: answer.text }, { role: 'user', content: input }); req.context = context;
   answer = await call(req); assert.equal(answer.text, `답변 ${count}: 안녕 👋`);
  }
 } finally { closeTextWorkers(); await waitForCliRetirements(process.env); }
});
