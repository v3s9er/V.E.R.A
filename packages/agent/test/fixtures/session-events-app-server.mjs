// Synthetic ordering fixture. No files, network, accounts or native tools.
import { createInterface } from 'node:readline';
const mode = process.env.MRROBOT_SESSION_FIXTURE || 'early';
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const threadId = 'lifecycle-thread';
let n = 0;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({ id: m.id, result: {} });
  if (m.method === 'skills/list') return send({ id: m.id, result: { data: [{ cwd: m.params.cwds[0], skills: [], errors: [] }] } });
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    send({ method: 'warning', params: { threadId, message: 'Synthetic startup notice' } });
    send({ method: 'thread/status/changed', params: { threadId: mode === 'other-startup' ? 'other-thread' : threadId, status: { type: 'idle' } } });
    send({ method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: { total: { inputTokens: 999, outputTokens: 999 } } } });
    send({ method: 'thread/goal/cleared', params: { threadId } });
    if (mode === 'early-tool') send({ id: 88, method: 'item/tool/call', params: { threadId, turnId: 'turn-1', tool: 'fixture_tool', arguments: {} } });
    return send({ id: m.id, result: { thread: { id: threadId }, instructionSources: [] } });
  }
  if (m.method !== 'turn/start') return;
  n++;
  const turnId = 'turn-' + n, text = 'answer ' + n;
  const p = { threadId: mode === 'other-thread' ? 'other-thread' : threadId, turnId };
  // Notifications may precede the matching turn/start response.
  send({ method: 'turn/started', params: { ...p, turn: { id: turnId } } });
  if (n > 1) send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-' + (n - 1), status: 'completed' } } });
  send({ method: 'item/agentMessage/delta', params: { ...p, itemId: 'answer-' + n, delta: text } });
  setTimeout(() => {
    send({ id: m.id, result: { turn: { id: mode === 'other-turn' ? 'different-turn' : turnId } } });
    if (mode === 'wait') return;
    send({ method: 'item/completed', params: { ...p, item: { type: 'agentMessage', id: 'answer-' + n, text } } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
  }, 20);
});
