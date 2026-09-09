import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
let count = 0;
const threadId = 'fixture-' + process.pid;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({ id: m.id, result: {} });
  if (m.method === 'skills/list') return send({ id: m.id, result: { data: [{ cwd: m.params.cwds[0], skills: [], errors: [] }] } });
  if (m.method === 'thread/start') {
    if (m.params.environments.length || !m.params.ephemeral || m.params.dynamicTools.length) throw Error('boundary failed');
    return send({ id: m.id, result: { thread: { id: threadId }, instructionSources: [] } });
  }
  if (m.method !== 'turn/start') return;
  if (m.params.environments.length || m.params.threadId !== threadId) throw Error('turn boundary failed');
  const prompt = m.params.input[0].text;
  if (count && prompt.includes('FIRST_PRIVATE_TEXT')) throw Error('history retransmitted');
  send({ id: m.id, result: { turn: { id: `turn-${count + 1}` } } });
  if (prompt.includes('WAIT_FOREVER')) return;
  if (prompt.includes('NATIVE_ATTACK')) return send({ method: 'item/started', params: { threadId, item: { type: 'commandExecution' } } });
  count++;
  send({ method: 'item/started', params: { threadId, item: { type: 'reasoning' } } });
  send({ method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: { last: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60 }, total: { inputTokens: count * 100, outputTokens: count * 20, cachedInputTokens: count * 60 } } } });
  send({ method: 'item/completed', params: { threadId, item: { type: 'agentMessage', text: JSON.stringify({ text: `turn ${count}`, toolCalls: [] }) } } });
  send({ method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } });
});
