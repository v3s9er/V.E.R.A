// Real installed Codex protocol, synthetic loopback provider: no account inference.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pooledCodexText, closeTextWorkers } from '../src/ai/cli-text-pool.js';
import { waitForCliRetirements } from '../src/ai/cli-process-retirement.js';
import { resolveCliInvocation, cliSubscriptionEnvironment } from '../src/ai/cli.js';
import type { ProviderTiming } from '../src/ai/provider.js';
const home=mkdtempSync(join(tmpdir(),'mrrobot-plain-protocol-'));
const bodies:any[]=[];
const server=createServer((req,res)=>{
 let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
  bodies.push(JSON.parse(raw));const n=bodies.length,text=`reply ${n}`;
  const item={id:`msg_${n}`,type:'message',role:'assistant',content:[{type:'output_text',text,annotations:[]}]};
  const response={id:`resp_${n}`,object:'response',created_at:1,status:'completed',output:[item],usage:{input_tokens:100,output_tokens:20,total_tokens:120,input_tokens_details:{cached_tokens:0}}};
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const event of [{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,content:[]}},{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:text},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}])res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
 });
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const invocation=resolveCliInvocation('codex-cli','codex');
const env={...cliSubscriptionEnvironment('codex-cli'),CODEX_HOME:home,MRROBOT_FIXTURE_PORT:String((server.address() as any).port),MRROBOT_FIXTURE_COMMAND:invocation.command,MRROBOT_FIXTURE_PREFIX:JSON.stringify(invocation.prefixArgs)};
try{
 for(let n=1;n<=6;n++){
  const timings:ProviderTiming[]=[];let streamed='';
  const result=await pooledCodexText({command:process.execPath,prefixArgs:[fileURLToPath(new URL('./fixtures/codex-fixture-proxy.mjs',import.meta.url))],env,providerId:'synthetic-only',model:'gpt-6-astra',req:{textOnly:true,tools:[],promptCacheKey:`user-${n}`,system:`Only user ${n} context`,turns:[{role:'user',content:`PRIVATE_USER_${n}_ONLY`}],signal:AbortSignal.timeout(25000),onTiming:t=>timings.push(t),onEvent:e=>{if(e.type==='text')streamed+=e.text;}}});
  assert.equal(result.text,`reply ${n}`);assert.equal(streamed,result.text);
  assert.equal(timings.some(t=>t.stage==='initialized'),n===1);
  const body=bodies.at(-1);assert.deepEqual(body.tools??[],[]);
  assert.notEqual(body.text?.format?.type,'json_schema');
  const inputs=JSON.stringify(body.input);
  assert.ok(inputs.includes(`PRIVATE_USER_${n}_ONLY`));
  for(let other=1;other<n;other++)assert.ok(!inputs.includes(`PRIVATE_USER_${other}_ONLY`),'previous user input leaked');
 }
 assert.equal(bodies.length,6);
 console.log('Installed Codex: six fresh isolated threads, one initialized process, no tools, no cross-user input, streamed answers verified (synthetic HTTP only).');
}finally{
 closeTextWorkers();await waitForCliRetirements(env);server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
 // Antivirus/CLI child handle release on Windows can trail the proxy close.
 for(let attempt=0;attempt<20;attempt++){
  try{rmSync(home,{recursive:true,force:true});break;}
  catch(error){if(attempt===19)throw error;await new Promise(r=>setTimeout(r,100));}
 }
}
