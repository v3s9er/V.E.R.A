import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop, type RunOptions } from '../src/ai/loop.js';
import { SINGLE_AGENT_HARNESS, SINGLE_AGENT_CLAUDE_ARGS } from '../src/ai/single-agent-harness.js';
import { safeCliExtraArgs, cliSubscriptionEnvironment } from '../src/ai/cli.js';
import type { AiProvider, ProviderResult } from '../src/ai/provider.js';

const answer=(text='done',toolCalls:ProviderResult['toolCalls']=[]):ProviderResult=>({text,toolCalls,usage:{promptTokens:2,completionTokens:1}});
const tool=(name:string,args:unknown)=>({id:name,name,args:JSON.stringify(args)});
const provider=(overrides:Partial<AiProvider>={}):AiProvider=>({id:'selected',model:'chosen-model',type:'openai-compatible',baseUrl:'',label:'Selected',supportsTools:true,supportedReasoning:['auto','high','xhigh'],chat:async()=>answer(),ping:async()=>({ok:true}),models:async()=>[],...overrides});
async function workspace(fn:(path:string)=>Promise<void>){
 const directory=mkdtempSync(join(tmpdir(),'vera-single-harness-'));
 try {await fn(directory);} finally {rmSync(directory,{recursive:true,force:true});}
}
const harnessTools=[{name:'harness_recall',description:'Retrieve scoped evidence',parameters:{type:'object'}},{name:'harness_verify',description:'Verify scoped artifacts',parameters:{type:'object'}}];

test('single runtime policy is immutable and CLI custom args cannot override agent/model controls',()=>{
 assert.equal(SINGLE_AGENT_HARNESS.hostDelegation,false); assert.equal(SINGLE_AGENT_HARNESS.nativeDelegation,false);
 assert.equal(Object.isFrozen(SINGLE_AGENT_HARNESS),true);
 assert.deepEqual(SINGLE_AGENT_CLAUDE_ARGS.slice(0,2),['--disallowedTools','Agent,Task']);
 assert.deepEqual(JSON.parse(SINGLE_AGENT_CLAUDE_ARGS[3]),{fallbackModel:[],switchModelsOnFlag:false});
 assert.equal(cliSubscriptionEnvironment('claude-cli',{CLAUDE_CODE_DISABLE_ADVISOR_TOOL:'0'}).CLAUDE_CODE_DISABLE_ADVISOR_TOOL,'1');
 assert.deepEqual(safeCliExtraArgs('claude-cli',['--fallback-model','other','--tools','Agent','--disallowedTools','Bash','--autocompact','true']),['--autocompact','true']);
 assert.deepEqual(safeCliExtraArgs('codex-cli',['-c','agents.enabled=true','--enable','multi_agent']),[]);
});

for(const native of [false,true]) test(`trusted deterministic services use the same ${native?'native':'API'} coordinator`,()=>workspace(async directory=>{
 const executed:string[]=[]; let calls=0;
 const p=provider({...(native?{type:'codex-cli' as const,supportsTools:false,runAgent:async req=>{
  calls++; assert.equal(req.nativeDelegation,undefined); assert.equal(req.reasoningEffort,'high');
  const host=req.hostTools!; assert.ok(host.tools.some(t=>t.name==='harness_recall'));
  assert.equal(host.timeoutMs!('harness_verify'),150000);
  assert.equal(host.authorize!('harness_recall','read-only'),false);
  assert.equal(host.authorize!('harness_recall','workspace'),true);
  assert.equal((await host.execute('harness_recall',{query:'fixture'},req.signal!)).success,true);
  return answer();
 }}:{chat:async req=>{
  calls++; assert.ok(req.tools!.some(t=>t.name==='harness_recall'));
  assert.ok(!req.tools!.some(t=>/agent_spawn|Agent|Task/.test(t.name)));
  if(calls===1) return answer('',[tool('harness_recall',{query:'fixture'})]);
  assert.equal(req.turns.at(-1)!.toolResults![0].content,'scoped receipt'); return answer();
 }})});
 const output=await new AgentLoop({default:()=>p} as any,{execute:async()=>{throw Error('Trusted capability must bypass generic executor');}} as any).run([], 'Inspect this workspace and verify evidence',{},[],{
  workspacePath:directory,permissionMode:'workspace',reasoningEffort:'high',tokenPolicy:'audit-only',cacheKey:'scope',nativeSessionDirectory:directory,
  harnessCapabilities:{tools:harnessTools,execute:async(name,_input,signal)=>{signal.throwIfAborted();executed.push(name);return 'scoped receipt';}},
 });
 assert.equal(output.text,'done'); assert.deepEqual(executed,['harness_recall']); assert.equal(calls,native?1:2);
}));

for(const native of [false,true]) test(`queued ${native?'native':'API'} harness tools recheck authority and abort without a repair call`,()=>workspace(async directory=>{
 let revoked=false,calls=0; const executed:string[]=[];
 const p=provider(native?{type:'codex-cli',supportsTools:false,runAgent:async req=>{
  calls++;
  await req.hostTools!.execute('harness_recall',{},req.signal!);
  await req.hostTools!.execute('harness_verify',{},req.signal!);
  throw Error('Revoked second tool must not complete');
 }}:{chat:async()=>{calls++;return answer('',[tool('harness_recall',{}),tool('harness_verify',{})]);}});
 await assert.rejects(new AgentLoop({default:()=>p} as any,{} as any).run([], 'Verify these project files',{
  beforeToolCall(){if(revoked) throw Error('authority revoked');},
 },[],{
  workspacePath:directory,permissionMode:'workspace',cacheKey:'authority',nativeSessionDirectory:directory,tokenPolicy:'audit-only',
  harnessCapabilities:{tools:harnessTools,execute:async name=>{executed.push(name);revoked=true;return 'first receipt';}},
 }),/authority revoked/);
 assert.equal(calls,1);assert.deepEqual(executed,['harness_recall']);
}));

test('generic and isolated broker tools also recheck host authority before dispatch',async()=>{
 for(const broker of [false,true]) {
  let calls=0,executions=0;
  const p=provider(broker?{type:'codex-cli',supportsTools:false,chatIsolated:async()=>{throw Error('No fallback');},runBrokerAgent:async req=>{
   calls++;await req.executeTool('artifact_read',{},req.signal!);return answer();
  }}:{chat:async()=>{calls++;return answer('',[tool('read_file',{path:'fixture.txt'})]);}});
  await assert.rejects(new AgentLoop({default:()=>p} as any,{execute:async()=>{executions++;return '{}';}} as any).run([], 'Read project file',{
   beforeToolCall(){throw Error('tool authority changed');},
  },[],broker?{tokenPolicy:'audit-only',isolation:{tools:[{name:'artifact_read',description:'fixture',parameters:{type:'object'}}],execute:async()=>{executions++;return '{}';}}}:{}),/tool authority changed/);
  assert.equal(calls,1);assert.equal(executions,0);
 }
});

test('archived premium node cap does not truncate legitimate same-agent tool turns',()=>workspace(async directory=>{
 let calls=0,admissions=0,settlements=0;
 const p=provider({chat:async req=>{
  calls++; assert.equal(req.reasoningEffort,'high');
  return calls===1?answer('',[tool('harness_recall',{})]):answer('finished same model');
 }});
 const output=await new AgentLoop({default:()=>p} as any,{} as any).run([], 'Inspect project and summarize evidence',{
  reserveModelCall(){admissions++;return {finish:()=>{settlements++;return true;}};},
 },[],{
  workspacePath:directory,permissionMode:'workspace',reasoningEffort:'high',
  routing:{mode:'quality',executionMode:'pipeline',maxPremiumCalls:1,roles:{},escalationEnabled:true,graph:{nodes:[],edges:[]}},
  harnessCapabilities:{tools:harnessTools,execute:async()=>'{"evidence":[]}'},
 });
 assert.equal(output.text,'finished same model');assert.equal(calls,2);assert.equal(admissions,2);assert.equal(settlements,2);
}));

for(const scope of ['discord','isolation','read-only','self-contained'] as const) test(`harness services remain unavailable in ${scope}`,()=>workspace(async directory=>{
 const p=provider({chat:async req=>{assert.ok(!req.tools?.some(t=>t.name.startsWith('harness_')));return answer();}});
 const options:RunOptions={workspacePath:directory,permissionMode:'workspace',harnessCapabilities:{tools:harnessTools,execute:async()=>{throw Error('Private scope escaped');}}};
 if(scope==='discord') options.singleModelOnly=true;
 if(scope==='isolation') options.isolation={tools:[],execute:async()=>{throw Error('Unexpected isolation tool');}};
 if(scope==='read-only') options.permissionMode='read-only';
 await new AgentLoop({default:()=>p} as any,{} as any).run([],scope==='self-contained'?'안녕':'Inspect workspace files',{},[],options);
}));

test('harness registration rejects reserved names and duplicate schemas before any model call',()=>workspace(async directory=>{
 const p=provider({chat:async()=>{throw Error('No model call');}});
 for(const tools of [[{...harnessTools[0],name:'agent_spawn'}],[harnessTools[0],harnessTools[0]]]) {
  await assert.rejects(new AgentLoop({default:()=>p} as any,{} as any).run([], 'Inspect project files',{},[],{workspacePath:directory,permissionMode:'workspace',harnessCapabilities:{tools,execute:async()=>''}}),/하네스 도구/);
 }
}));

test('legacy scenario never overrides explicit Discord model and effort assignment',()=>workspace(async directory=>{
 const selected=provider({model:'per-user-astra',chat:async req=>{assert.equal(req.reasoningEffort,'xhigh');assert.ok(!req.tools?.some(t=>t.name.startsWith('agent_')));return answer();}});
 const registry={prepareModelCapabilities:async(id:string,routing:unknown)=>{assert.equal(id,'selected');assert.equal(routing,null);},getForModel:(id:string,model:string)=>{assert.equal(id,'selected');assert.equal(model,'per-user-astra');return selected;},default:()=>{throw Error('No assignment fallback');}} as any;
 const options:RunOptions={providerId:'selected',providerModel:'per-user-astra',reasoningEffort:'xhigh',singleModelOnly:true,workspacePath:directory,permissionMode:'workspace',routing:{mode:'quality',executionMode:'vote',maxPremiumCalls:0,roles:{},escalationEnabled:true,graph:{nodes:[],edges:[]}}};
 const before=JSON.stringify(options);
 await new AgentLoop(registry,{} as any).run([], 'Analyze this project and verify detailed evidence',{},[],options);
 assert.equal(JSON.stringify(options),before);
}));

for(const native of [false,true]) test(`Discord greeting keeps administrator xhigh assignment in the ${native?'native text':'API'} lane`,()=>workspace(async directory=>{
 let calls=0;
 const p=provider({model:'assigned-model',supportedReasoning:['auto','low','high','xhigh'],
  ...(native?{type:'codex-cli' as const,supportsTools:false,runAgent:async()=>{throw Error('Greeting must not launch PC tools');}}:{}),
  chat:async req=>{calls++;assert.equal(req.reasoningEffort,'xhigh');assert.match(req.context!,/xhigh/);return answer();},
 });
 const registry={default:()=>p,getForModel:(id:string,model:string)=>{assert.equal(id,'selected');assert.equal(model,'assigned-model');return p;}} as any;
 await new AgentLoop(registry,{} as any).run([], 'hello',{},[],{
  providerId:'selected',providerModel:'assigned-model',reasoningEffort:'xhigh',singleModelOnly:true,
  workspacePath:directory,permissionMode:'full',tokenPolicy:'audit-only',cacheKey:'discord-greeting',nativeSessionDirectory:directory,
 });
 assert.equal(calls,1);
}));

test('Discord unsupported assigned effort fails before calling a model instead of silently downgrading',async()=>{
 const p=provider({supportedReasoning:['auto','low'],chat:async()=>{throw Error('No model should run');}});
 await assert.rejects(new AgentLoop({default:()=>p} as any,{} as any).run([], 'hello',{},[],{singleModelOnly:true,reasoningEffort:'xhigh'}),/추론 단계의 지원/);
});

test('API final acceptance repair is bounded to one continuation and never swaps models',()=>workspace(async directory=>{
 let calls=0; const plan={tasks:[{id:'artifact',title:'file',checks:[{id:'content',kind:'contains',path:'output.txt',expected:'right'}]}]};
 const p=provider({chat:async req=>{
  calls++;
  if(calls===1) return answer('',[tool('work_plan',plan)]);
  if(calls===2) return answer('',[tool('work_check',{id:'artifact'})]);
  if(calls===3) return answer('claimed completion');
  assert.equal(calls,4); assert.match(String(req.turns.at(-1)!.content),/observed failures/);return answer('blocked honestly');
 }});
 writeFileSync(join(directory,'output.txt'),'wrong');
 const output=await new AgentLoop({default:()=>p} as any,{} as any).run([], 'Verify the project file',{},[],{workspacePath:directory,permissionMode:'workspace'});
 assert.equal(calls,4);assert.equal(output.text,'blocked honestly');assert.equal(output.usage.promptTokens,8);
}));

test('trusted read-only recall does not invalidate an already observed file receipt',()=>workspace(async directory=>{
 let latest:{verified:number;stale?:boolean}|undefined;
 writeFileSync(join(directory,'output.txt'),'right');
 const p=provider({type:'codex-cli',supportsTools:false,runAgent:async req=>{
  const host=req.hostTools!;
  await host.execute('work_plan',{tasks:[{id:'artifact',title:'file',checks:[{id:'content',kind:'contains',path:'output.txt',expected:'right'}]}]},req.signal!);
  await host.execute('work_update',{id:'artifact',status:'completed'},req.signal!);
  await host.execute('work_check',{id:'artifact'},req.signal!);
  assert.equal(latest!.verified,1);
  req.onTool!({name:'harness_recall',callId:'recall',input:{},status:'start'});
  await host.execute('harness_recall',{},req.signal!);
  assert.equal(latest!.verified,1); assert.notEqual(latest!.stale,true);
  return answer();
 }});
 await new AgentLoop({default:()=>p} as any,{} as any).run([], 'Verify this workspace artifact', {onWorkUpdate:s=>latest=s}, [], {
  workspacePath:directory,permissionMode:'workspace',tokenPolicy:'audit-only',cacheKey:'recall',nativeSessionDirectory:directory,
  harnessCapabilities:{tools:harnessTools,isReadOnly:name=>name==='harness_recall',execute:async()=>'{"evidence":[]}'},
 });
}));
