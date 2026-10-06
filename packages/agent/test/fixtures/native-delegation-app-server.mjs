import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const config = new Map(process.argv.slice(2).filter((v, i, all) => all[i - 1] === '-c').map(v => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)]));
let thread = '', turn = '', count = 0, scenario = '', cwd = '', step = 0;
const childId = 'native-owned-child';
function collab(tool, id, state = 'completed', fields = {}) {
  send({ method: 'item/completed', params: { threadId: thread, turnId: turn, item: {
    type: 'collabAgentToolCall', id, senderThreadId: thread, receiverThreadIds: [childId],
    status: 'completed', tool, agentsStates: { [childId]: { status: state, message: 'CHILD_PRIVATE_RESULT' } },
    model: 'fixture', reasoningEffort: 'high', prompt: 'CHILD_PRIVATE_PROMPT', ...fields,
  } } });
}
function finish() {
  const item = { id: 'final', type: 'agentMessage', phase: 'final_answer', text: `answer ${process.pid} ${count}` };
  send({ method: 'item/started', params: { threadId: thread, turnId: turn, item: { ...item, text: '' } } });
  send({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId: turn, itemId: item.id, delta: item.text } });
  send({ method: 'thread/tokenUsage/updated', params: { threadId: thread, tokenUsage: { total: { inputTokens: count * 100, outputTokens: count * 20, cachedInputTokens: count * 10 } } } });
  send({ method: 'item/completed', params: { threadId: thread, turnId: turn, item } });
  send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'completed' } } });
}
function deniedChildThenParent() {
  const target = step === 0 ? childId : step === 1 ? 'not-owned-child' : thread;
  send({ id: 700 + step, method: 'item/tool/call', params: { threadId: target, turnId: turn, callId: `tool-${step}`, tool: 'safe_parent_tool', arguments: {} } });
}
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({ id: m.id, result: {} });
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    if (m.params.approvalPolicy !== 'never') throw Error('approval boundary');
    cwd = m.params.cwd;
    thread = m.params.threadId ?? `fixture-${process.pid}`;
    return send({ id: m.id, result: { thread: { id: thread } } });
  }
  if (m.method === 'turn/interrupt') return send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'interrupted' } } });
  if (!m.method && m.id === 700 + step && scenario === 'CHILD_HOST') {
    if (step < 2 ? !m.error : m.result?.success !== true) throw Error('child host denial or parent preservation failed');
    step++;
    if (step < 3) deniedChildThenParent();
    else { collab('wait', 'wait'); finish(); }
    return;
  }
  if (m.method !== 'turn/start') return;
  scenario = m.params.input[0].text.match(/CASE:([A-Z_]+)/)?.[1] ?? 'BASIC';
  if (config.get('agents.enabled') !== (scenario.startsWith('DISABLED') ? 'false' : 'true')) throw Error('modern enable config mismatch');
  if (!scenario.startsWith('DISABLED') && (config.get('agents') !== '{}' || config.get('agents.max_concurrent_threads_per_session') !== '2'
    || config.get('agents.max_depth') !== '1'
    || config.get('agents.default_subagent_model') !== '"fixture"'
    || config.get('agents.default_subagent_reasoning_effort') !== JSON.stringify(m.params.effort))) throw Error('agent scope config mismatch');
  turn = `turn-${++count}`;
  if (scenario === 'CHILD_HOST') send({ method: 'thread/started', params: { thread: { id: childId, parentThreadId: thread, model: 'fixture' } } });
  send({ id: m.id, result: { turn: { id: turn } } });
  if (['BASIC', 'DISABLED'].includes(scenario)) return finish();
  if (scenario === 'MODERN' || scenario === 'MODERN_OVERRIDE') {
    send({ method: 'rawResponseItem/completed', params: { threadId: thread, turnId: turn,
      item: { type: 'function_call', call_id: 'modern-spawn', name: 'spawn_agent', arguments: JSON.stringify({ prompt: 'PRIVATE_HELPER_PROMPT',
        ...(scenario === 'MODERN_OVERRIDE' ? { model: 'other' } : {}) }) } } });
    for (const kind of ['started', 'completed']) for (const method of ['item/started', 'item/completed']) {
      send({ method, params: { threadId: thread, turnId: turn, item: { id: `activity:${kind}`, type: 'subAgentActivity',
        agentThreadId: childId, agentPath: '/root/private-helper-label', kind } } });
    }
    finish(); return;
  }
  if (['RETIRE', 'UNSETTLED', 'HANG'].includes(scenario)) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    writeFileSync(join(cwd, 'fixture-child-pid.txt'), String(child.pid));
  }
  collab('spawnAgent', 'spawn', 'running', scenario === 'MODEL_MISMATCH' ? { model: 'other-model' }
    : scenario === 'SENDER_MISMATCH' ? { senderThreadId: 'other-parent' } : {});
  if (scenario === 'ACTUAL_MODEL_MISMATCH') send({ method: 'thread/started', params: { thread: { id: childId, parentThreadId: thread, model: 'other-model' } } });
  if (scenario === 'BAD_PARENT_TURN') send({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId: 'other-turn', itemId: 'spoof', delta: 'BAD_PARENT_TEXT' } });
  send({ method: 'item/agentMessage/delta', params: { threadId: childId, turnId: 'child-turn', itemId: 'private', delta: 'CHILD_PRIVATE_OUTPUT' } });
  send({ method: 'thread/tokenUsage/updated', params: { threadId: childId, tokenUsage: { total: { inputTokens: 999999, outputTokens: 999999 } } } });
  if (scenario === 'CHILD_HOST') return deniedChildThenParent();
  if (scenario === 'HANG') return;
  if (scenario !== 'UNSETTLED') collab('wait', 'wait');
  finish();
});
