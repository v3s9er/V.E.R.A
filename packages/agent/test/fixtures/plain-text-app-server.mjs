import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
let threadId = '',generation=0,count=0,denyUnsubscribe=false;
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')return send({id:m.id,result:{}});
 if(m.method==='skills/list')return send({id:m.id,result:{data:[{cwd:m.params.cwds[0],skills:[],errors:[]}]}});
 if(m.method==='thread/start'){
  if(m.params.environments.length||m.params.runtimeWorkspaceRoots.length||m.params.dynamicTools.length||!m.params.ephemeral||m.params.allowProviderModelFallback!==false)throw Error('isolation');
  count=0;threadId=`plain-${process.pid}-${++generation}`;
  denyUnsubscribe=m.params.baseInstructions.includes('DENY_UNSUBSCRIBE');
  return send({id:m.id,result:{thread:{id:threadId},instructionSources:[]}});
 }
 if(m.method==='thread/unsubscribe'){
  if(m.params.threadId!==threadId)throw Error('wrong unsubscribe');
  send({method:'item/agentMessage/delta',params:{threadId,turnId:`turn-${count}`,itemId:'retired',delta:'OTHER_USER'}});
  return send({id:m.id,result:{status:denyUnsubscribe?'unknown':'unsubscribed'}});
 }
 if(m.method!=='turn/start')return;
 if(m.params.outputSchema||m.params.environments.length||m.params.runtimeWorkspaceRoots.length)throw Error('plain boundary');
 const mode=m.params.input[0].text;const turnId=`turn-${++count}`;const itemId=`message-${count}`;
 if(!mode.includes('Execute current_user_request as the user\'s active request')||!mode.includes('"current_user_request":'))throw Error('active task must not be labelled history data');
 if(mode.includes('EXPECT_CONTEXT_NEW') && (!mode.includes('CONTEXT_NEW') || mode.includes('CONTEXT_OLD')))throw Error('stale context');
 if(mode.includes('EXPECT_CONTEXT_UNCHANGED') && mode.includes('Current retained context'))throw Error('unchanged context duplicated');
 if(mode.includes('EXPECT_CONTEXT_CLEAR') && !mode.includes('"(none)"'))throw Error('removed context not cleared');
 const p={threadId,turnId};
 send({id:m.id,result:{turn:{id:turnId}}});
 if(mode.includes('PARTIAL')){
  send({method:'item/agentMessage/delta',params:{...p,itemId,delta:'unfinished'}});
  return send({method:'turn/completed',params:{...p,turn:{id:turnId,status:'completed'}}});
 }
 if(mode.includes('ATTACK'))return send({method:'item/started',params:{...p,item:{type:'commandExecution'}}});
 if(mode.includes('WAIT'))return;
 send({method:'item/reasoning/textDelta',params:{...p,delta:'PRIVATE_REASONING'}});
 const first=`답변 ${count}: `,last='안녕 👋';
 if(!mode.includes('NO_DELTA'))send({method:'item/agentMessage/delta',params:{...p,itemId,delta:first}});
 setTimeout(()=>{
  if(mode.includes('FOREIGN'))return send({method:'item/agentMessage/delta',params:{...p,threadId:'foreign',itemId,delta:'OTHER_USER'}});
  send({method:'item/completed',params:{...p,item:{id:itemId,type:'agentMessage',text:mode.includes('MISMATCH')?'different':first+last}}});
  if(mode.includes('MULTI')){
   send({method:'item/completed',params:{...p,item:{id:itemId,type:'agentMessage',text:first+last}}});
   send({method:'item/agentMessage/delta',params:{...p,itemId:'second',delta:'next'}});
   send({method:'item/completed',params:{...p,item:{id:'second',type:'agentMessage',text:'next!'}}});
  }
  send({method:'turn/completed',params:{...p,turn:{id:turnId,status:mode.includes('FAIL')?'failed':'completed'}}});
 },70);
});
