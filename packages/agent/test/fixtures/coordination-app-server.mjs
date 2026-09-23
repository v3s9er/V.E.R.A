import { createInterface } from 'node:readline';

const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const threadId = 'coordination-thread';
const turnId = 'coordination-turn';
let registered = false;
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (!message.params.capabilities?.experimentalApi) throw new Error('dynamic capability must be explicit');
    send({ id: message.id, result: {} });
  } else if (message.method === 'thread/start') {
    const { sandbox, dynamicTools } = message.params;
    if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('unexpected native authority');
    registered = dynamicTools.some(tool => tool.name === 'agent_spawn') && dynamicTools.every(tool => tool.name.startsWith('agent_'));
    if (!registered) throw new Error('expected only registered coordination tools');
    send({ id: message.id, result: { thread: { id: threadId } } });
  } else if (message.method === 'turn/start') {
    if (!registered) throw new Error('tools must be registered before requests');
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ id: 'spawn-request', method: 'item/tool/call', params: {
      threadId, turnId, callId: 'spawn-call', namespace: null, tool: 'agent_spawn', arguments: { task: 'Review only the mock fixture.' },
    } });
  } else if (message.id === 'spawn-request' && message.result) {
    if (!message.result.success) throw new Error('spawn was denied');
    const { agentId } = JSON.parse(message.result.contentItems[0].text);
    send({ id: 'wait-request', method: 'item/tool/call', params: {
      threadId, turnId, callId: 'wait-call', namespace: null, tool: 'agent_wait', arguments: { agentIds: [agentId] },
    } });
  } else if (message.id === 'wait-request' && message.result) {
    const output = JSON.parse(message.result.contentItems[0].text);
    if (!message.result.success || output.agents[0].result !== 'mock isolated result') throw new Error('worker result was not delivered');
    send({ method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: { total: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 } } } });
    send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'final-message', type: 'agentMessage', phase: 'final_answer', text: 'Native transport synthesis.' } } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
  } else if (message.method === 'turn/interrupt') {
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'interrupted' } } });
  }
});
