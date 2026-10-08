import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentLoop } from '../src/ai/loop.js';
import type { AiProvider, NativeAgentRequest } from '../src/ai/provider.js';
import type { RoutingSettings } from '@mr-robot/shared';

const response=(text:string)=>({text,toolCalls:[],usage:{promptTokens:3,completionTokens:2}});
async function fixture(check:(f:any)=>Promise<void>){
 const root=mkdtempSync(join(tmpdir(),'mrrobot-pipeline-route-'));
 const called:string[]=[],nativeRequests:NativeAgentRequest[]=[],status:string[]=[];
 const models=['plan-model','solve-model','judge-model'];
 const providers=Object.fromEntries(models.map(model=>[model,{
  id:'subscription',label:'Selected subscription',type:'codex-cli',model,baseUrl:'',supportsTools:false,supportedReasoning:['auto','high'],
  chat:async(req:any)=>{called.push(`chat:${model}`);assert.equal(req.tools?.length??0,0);assert.equal(req.reasoningEffort,'high');return response(`EVIDENCE_${model}`);},
  chatIsolated:async()=>{called.push(`isolated:${model}`);return response(`ISOLATED_${model}`);},
  runAgent:async(req:NativeAgentRequest)=>{called.push(`native:${model}`);nativeRequests.push(req);return response('VERIFIED_FINAL');},
  models:async()=>models,ping:async()=>({ok:true}),
 } satisfies AiProvider]));
 const registry={default:()=>providers['judge-model'],resolve:(_role:string,_id:string,model:string)=>providers[model],costTier:()=>0,
  toolCapable:()=>{throw Error('Unexpected substitution to an API executor');}};
 const routing:RoutingSettings={mode:'quality',executionMode:'pipeline',roles:{},maxPremiumCalls:12,escalationEnabled:false,
  graph:{nodes:models.map((model,i)=>({id:`n${i}`,kind:'model',label:`stage-${i}`,role:i===2?'critic':'reasoning',providerId:'subscription',providerModel:model,x:i*100,y:0})),edges:[{id:'e0',from:'n0',to:'n1'},{id:'e1',from:'n1',to:'n2'}]}};
 const options={routing,workspacePath:root,permissionMode:'read-only' as const,reasoningEffort:'high' as const,context:'SCOPED_EVIDENCE'};
 try{await check({loop:new AgentLoop(registry as any,{} as any),options,called,nativeRequests,status,providers,root});}finally{rmdirSync(root);}
}

test('pipeline keeps the exact final native model and passes prior evidence without an API advisor',()=>fixture(async f=>{
 const result=await f.loop.run([],'Analyze the supplied file data without tools.',{onStatus:(s:string)=>f.status.push(s)},[],f.options);
 assert.deepEqual(f.called,['native:judge-model']);
 assert.equal(result.route.model,'judge-model');assert.equal(result.route.effort,'high');assert.equal(result.text,'VERIFIED_FINAL');
 assert.equal(f.nativeRequests[0].permissionMode,'read-only');assert.equal(f.nativeRequests[0].cwd,f.root);
 assert.doesNotMatch(f.nativeRequests[0].prompt,/EVIDENCE_plan-model|EVIDENCE_solve-model/);assert.match(f.nativeRequests[0].prompt,/SCOPED_EVIDENCE/);
 assert.equal(result.usage.promptTokens,3);assert.equal(result.usage.completionTokens,2);
 assert.ok(f.status.some((s:string)=>s.includes('저장된 다중 모델')));
}));

test('pipeline native final still requires consent in ask mode',()=>fixture(async f=>{
 const result=await f.loop.run([],'Analyze file data.',{confirm:async()=>false},[],{...f.options,permissionMode:'ask'});
 assert.deepEqual(f.called,[]);assert.match(result.text,/취소/);
}));

test('isolated pipeline never receives a host native final executor',()=>fixture(async f=>{
 const result=await f.loop.run([],'Analyze supplied text.',{},[],{...f.options,permissionMode:'full',isolation:{tools:[],execute:async()=>{throw Error('Forbidden host tool');}}});
 assert.equal(f.nativeRequests.length,0);assert.equal(result.route.model,'judge-model');assert.equal(result.text,'ISOLATED_judge-model');
}));

test('native final failure propagates without substituting a different model',()=>fixture(async f=>{
 f.providers['judge-model'].runAgent=async()=>{throw Error('SELECTED_NATIVE_FAILED');};
 await assert.rejects(f.loop.run([],'Analyze file data.',{},[],f.options),/SELECTED_NATIVE_FAILED/);
 assert.deepEqual(f.called,[]);
}));
