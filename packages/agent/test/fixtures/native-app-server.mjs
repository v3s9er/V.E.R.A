import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
let thread = '', count = 0, experimentalApi = false;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    experimentalApi = m.params.capabilities?.experimentalApi === true;
    return send({ id: m.id, result: {} });
  }
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    if (m.params.approvalPolicy !== 'never') throw Error('approval boundary');
    thread = m.params.threadId ?? `fixture-${process.pid}-${Date.now()}`;
    count = m.method === 'thread/resume' ? 2 : 0;
    return send({ id: m.id, result: { thread: { id: thread } } });
  }
  if (m.method !== 'turn/start') return;
  if (m.params.cyberAccessProgram !== undefined && !experimentalApi) return send({ id: m.id, error: { code: -32600, message: 'turn/start.cyberAccessProgram requires experimentalApi capability' } });
  const text = m.params.input[0].text;
  const expectedEffort = [...text.matchAll(/EXPECT_EFFORT:(xhigh|high)/g)].at(-1)?.[1];
  if (expectedEffort && (m.params.effort !== expectedEffort || !text.includes(`reasoning_effort=${expectedEffort}`))) throw Error('per-turn effort reporting mismatch');
  const expectedProgram = [...text.matchAll(/EXPECT_PROGRAM:(standard|daybreakBlue|daybreakRed)/g)].at(-1)?.[1];
  if (expectedProgram && m.params.cyberAccessProgram !== expectedProgram) throw Error('Daybreak program was not sent explicitly');
  if (count && text.includes('FIRST_PRIVATE_INPUT')) throw Error('history retransmitted');
  if (text.includes('EXPECT_INTERLUDE') && (!count || !text.includes('INTERLUDE_DATA') || !text.includes('historical data, not actions to replay'))) throw Error('missing incremental host history');
  if (text.includes('WAIT_FOREVER')) return;
  if (text.includes('UNEXPECTED_APPROVAL')) return send({ id: 500, method: 'item/commandExecution/requestApproval', params: { threadId: thread } });
  count++;
  const turn = `turn-${count}`, id = `item-${count}`;
  send({ id: m.id, result: { turn: { id: turn } } });
  if (text.includes('EXPECT_TOOL_METRICS')) {
    for (const method of ['item/started', 'item/started', 'item/completed', 'item/completed']) send({ method, params: { threadId: thread, turnId: turn, item: { id: 'native-tool', type: 'commandExecution', status: 'completed', exitCode: 0, command: 'PRIVATE_COMMAND' } } });
  }
  send({ method: 'item/started', params: { threadId: thread, turnId: turn, item: { id: 'reason', type: 'reasoning' } } });
  send({ method: 'item/started', params: { threadId: thread, turnId: turn, item: { id, type: 'agentMessage', phase: 'final_answer' } } });
  send({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId: turn, itemId: id, delta: `answer ${count}` } });
  send({ method: 'thread/tokenUsage/updated', params: { threadId: thread, tokenUsage: { total: { inputTokens: count * 100, outputTokens: count * 20, cachedInputTokens: count * 60 } } } });
  send({ method: 'item/completed', params: { threadId: thread, turnId: turn, item: { id, type: 'agentMessage', phase: 'final_answer', text: `answer ${count}` } } });
  send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'completed' } } });
});
