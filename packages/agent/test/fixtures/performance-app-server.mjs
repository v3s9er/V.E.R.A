// Deterministic synthetic stdio source, no network, accounts, filesystem or real model.
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let thread = 'synthetic-thread', turn = '', count = 0, timers = [];
const event = (method, params) => send({ method, params: { threadId: thread, turnId: turn, ...params } });
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({ id: m.id, result: {} });
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    if (m.params.approvalPolicy !== 'never' || m.params.sandbox !== 'read-only') throw Error('fixture permission invariant');
    thread = m.params.threadId ?? thread;
    return send({ id: m.id, result: { thread: { id: thread } } });
  }
  if (m.method === 'turn/interrupt') {
    timers.forEach(clearTimeout); timers = [];
    send({ id: m.id, result: {} });
    return event('turn/completed', { turn: { id: turn, status: 'interrupted' } });
  }
  if (m.method !== 'turn/start') return;
  count++; turn = `turn-${count}`;
  send({ id: m.id, result: { turn: { id: turn } } });
  event('item/started', { item: { id: 'reason', type: 'reasoning', text: 'SYNTHETIC_PRIVATE_REASONING' } });
  if (m.params.input[0].text.includes('CANCEL_FIXTURE')) return;
  const item = { id: `reply-${count}`, type: 'agentMessage', text: 'synthetic answer' };
  timers.push(setTimeout(() => {
    event('item/started', { item: { id: item.id, type: 'agentMessage' } });
    event('item/agentMessage/delta', { itemId: item.id, delta: item.text });
  }, 5));
  timers.push(setTimeout(() => {
    event('item/completed', { item });
    event('turn/completed', { turn: { id: turn, status: 'completed' } });
  }, 20));
});
