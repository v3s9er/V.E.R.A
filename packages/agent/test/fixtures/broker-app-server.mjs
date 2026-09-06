import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const threadId = 'fixture-broker', turnId = 'turn-broker';
let mode = '';
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({ id: m.id, result: {} });
  if (m.method === 'skills/list') return send({ id: m.id, result: { data: [{ cwd: m.params.cwds[0], skills: [], errors: [] }] } });
  if (m.method === 'thread/start') {
    if (m.params.environments.length || m.params.dynamicTools.length !== 1 || m.params.config.features.shell_tool !== false) throw Error('bad boundary');
    return send({ id: m.id, result: { thread: { id: threadId }, instructionSources: [] } });
  }
  if (m.method === 'turn/start') {
    if (m.params.environments.length || m.params.outputSchema) throw Error('unexpected native env/schema');
    mode = m.params.input[0].text;
    send({ id: m.id, result: { turn: { id: turnId } } });
    if (mode.includes('native')) return send({ method: 'item/started', params: { threadId, turnId, item: { type: 'commandExecution' } } });
    const p = { threadId, turnId, callId: 'call-1', namespace: null, tool: 'public_search', arguments: { query: 'fixture' } };
    if (mode.includes('other-thread')) p.threadId = 'other';
    if (mode.includes('other-turn')) p.turnId = 'other';
    if (mode.includes('forbidden')) p.tool = 'shell_exec';
    if (mode.includes('namespace')) p.namespace = 'skills';
    send({ id: 90, method: 'item/tool/call', params: p });
    if (mode.includes('duplicate')) send({ id: 91, method: 'item/tool/call', params: p });
  }
  if (m.id === 90 && m.result) {
    send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'answer', delta: 'finished' } });
    send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: 'answer', text: 'finished' } } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
  }
});
