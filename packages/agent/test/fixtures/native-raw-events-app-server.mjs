// Synthetic structural notifications only: no task, reasoning, code or tool output.
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const mode = process.env.MRROBOT_RAW_FIXTURE ?? 'normal';
let thread = '', turnNumber = 0, rawEnabled = false, starts = 0;
const raw = (turnId, item, threadId = thread) => send({ method: 'rawResponseItem/completed', params: { threadId, turnId, item } });
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    starts++;
    if (mode === 'unrelated-error') return send({ id: message.id, error: { code: -32602, message: 'Unsupported model parameter' } });
    if (mode === 'unsupported' && message.params.experimentalRawEvents) return send({ id: message.id,
      error: { code: -32602, message: 'Unknown field experimentalRawEvents' } });
    if (message.method === 'thread/resume' && message.params.experimentalRawEvents !== undefined) throw Error('resume has no raw opt-in field');
    rawEnabled = message.params.experimentalRawEvents === true;
    thread = message.params.threadId ?? `raw-fixture-${process.pid}`;
    turnNumber = message.method === 'thread/resume' ? 1 : 0;
    return send({ id: message.id, result: { thread: { id: thread, turns: turnNumber ? [{ id: 'turn-1', status: 'completed' }] : [] } } });
  }
  if (message.method !== 'turn/start') return;
  if (mode === 'unsupported' && starts !== 2) throw Error('unsupported opt-in needs one pre-turn fallback');
  const turnId = `turn-${++turnNumber}`, call = `exec-${turnNumber}`;
  if (mode.startsWith('host-')) {
    // Host labels are carried only by ordinary correlated item events.
    for (const [index, tool] of ['browser_open', 'unregistered'].entries()) {
      for (const method of ['item/started', 'item/completed']) send({ method, params: {
        threadId: mode === 'host-other-thread' ? 'other-thread' : thread,
        turnId: mode === 'host-other-turn' ? 'other-turn' : turnId,
        item: { id: `host-${index}`, type: 'dynamicToolCall', tool, arguments: 'PRIVATE_ARGUMENTS', contentItems: ['PRIVATE_RESULT'] },
      } });
    }
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: 'item/completed', params: { threadId: thread, turnId, item: { id: `answer-${turnNumber}`, type: 'agentMessage', phase: 'final_answer', text: 'host fixture answer' } } });
    send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turnId, status: 'completed' } } });
    return;
  }
  if (rawEnabled) {
    if (turnNumber > 1) raw('turn-1', { type: 'custom_tool_call', call_id: 'stale', name: 'exec' });
    raw(turnId, { type: 'reasoning' });
    raw(turnId, { type: 'custom_tool_call', call_id: 'unknown', name: 'unregistered' });
    raw(turnId, { type: 'custom_tool_call_output', call_id: call }); // Deliberately before call/turn reply.
    raw(mode === 'other-turn' ? 'other-turn' : turnId, { type: 'custom_tool_call', call_id: call, name: 'exec' }, mode === 'other-thread' ? 'other-thread' : thread);
  }
  send({ id: message.id, result: { turn: { id: turnId } } });
  if (rawEnabled) {
    for (let i = 0; i < 2; i++) {
      raw(turnId, { type: 'custom_tool_call', call_id: call, name: 'exec' });
      raw(turnId, { type: 'custom_tool_call_output', call_id: call });
      send({ method: 'item/completed', params: { threadId: thread, turnId, item: { id: call, type: 'customToolCall', status: 'completed' } } });
    }
    send({ method: 'item/completed', params: { threadId: thread, turnId, item: { id: `nested-${turnNumber}`, type: 'commandExecution', status: 'failed', exitCode: 1 } } });
    if (mode === 'cancel') {
      raw(turnId, { type: 'custom_tool_call', call_id: 'pending', name: 'exec' });
      return;
    }
  }
  for (let i = 0; i < 3; i++) send({ method: 'thread/tokenUsage/updated', params: { threadId: thread, turnId,
    tokenUsage: { total: { inputTokens: turnNumber * 100, outputTokens: turnNumber * 20, cachedInputTokens: turnNumber * 60 } } } });
  send({ method: 'item/completed', params: { threadId: thread, turnId, item: { id: `answer-${turnNumber}`, type: 'agentMessage', phase: 'final_answer', text: `answer ${turnNumber}` } } });
  send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turnId, status: 'completed' } } });
});
