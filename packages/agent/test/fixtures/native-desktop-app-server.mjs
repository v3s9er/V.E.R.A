import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let thread = 'desktop-thread', turn = 'desktop-turn', mode = '', registered = false;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    if (!m.params.capabilities?.experimentalApi) throw Error('experimental capability missing');
    return send({ id: m.id, result: {} });
  }
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    registered = !!m.params.dynamicTools?.some(t => t.name === 'desktop_windows' && t.type === 'function');
    return send({ id: m.id, result: { thread: { id: thread } } });
  }
  if (m.method === 'turn/start') {
    mode = m.params.input[0].text;
    if (!registered) throw Error('no desktop tools');
    const call = { id: 'host-request', method: 'item/tool/call', params: {
      threadId: mode.includes('WRONG_THREAD') ? 'other-thread' : thread,
      turnId: mode.includes('WRONG_TURN') ? 'other-turn' : turn, callId: 'desktop-call', namespace: mode.includes('NAMESPACE') ? 'wrong' : null,
      tool: mode.includes('UNKNOWN') ? 'shell_exec' : 'desktop_windows', arguments: {},
    } };
    if (mode.includes('EARLY')) { send(call); setTimeout(() => send({ id: m.id, result: { turn: { id: turn } } }), 30); }
    else { send({ id: m.id, result: { turn: { id: turn } } }); send(call); }
    if (mode.includes('DUPLICATE')) send(call);
    return;
  }
  if (m.method === 'turn/interrupt') return send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'interrupted' } } });
  if (m.id === 'host-request' && m.result) {
    if (mode.includes('IMAGE') && m.result.contentItems[1]?.type !== 'inputImage') throw Error('actual image not returned');
    send({ method: 'item/completed', params: { threadId: thread, turnId: turn, item: { id: 'answer', type: 'agentMessage', text: m.result.success ? 'desktop verified' : 'desktop error explained' } } });
    send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'completed' } } });
  }
});
