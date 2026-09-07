import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
let thread = '', count = 0;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({ id: m.id, result: {} });
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    if (m.params.approvalPolicy !== 'never') throw Error('approval boundary');
    thread = m.params.threadId ?? `fixture-${process.pid}-${Date.now()}`;
    count = m.method === 'thread/resume' ? 2 : 0;
    return send({ id: m.id, result: { thread: { id: thread } } });
  }
  if (m.method !== 'turn/start') return;
  const text = m.params.input[0].text;
  if (count && text.includes('FIRST_PRIVATE_INPUT')) throw Error('history retransmitted');
  if (text.includes('WAIT_FOREVER')) return;
  if (text.includes('UNEXPECTED_APPROVAL')) return send({ id: 500, method: 'item/commandExecution/requestApproval', params: { threadId: thread } });
  count++;
  const turn = `turn-${count}`, id = `item-${count}`;
  send({ id: m.id, result: { turn: { id: turn } } });
  send({ method: 'item/started', params: { threadId: thread, turnId: turn, item: { id: 'reason', type: 'reasoning' } } });
  send({ method: 'item/started', params: { threadId: thread, turnId: turn, item: { id, type: 'agentMessage', phase: 'final_answer' } } });
  send({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId: turn, itemId: id, delta: `answer ${count}` } });
  send({ method: 'thread/tokenUsage/updated', params: { threadId: thread, tokenUsage: { total: { inputTokens: count * 100, outputTokens: count * 20, cachedInputTokens: count * 60 } } } });
  send({ method: 'item/completed', params: { threadId: thread, turnId: turn, item: { id, type: 'agentMessage', phase: 'final_answer', text: `answer ${count}` } } });
  send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'completed' } } });
});
