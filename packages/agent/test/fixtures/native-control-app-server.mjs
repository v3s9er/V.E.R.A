// Synthetic stdio protocol only. Never connects to a model or runs user tools.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let thread = `mock-${process.pid}`, turn = '', count = 0, mode = '', timer;
const event = (method, params = {}) => send({ method, params: { threadId: thread, turnId: turn, ...params } });
function finish(text = `answer ${count}`) {
  clearTimeout(timer);
  event('item/completed', { item: { id: `message-${count}`, type: 'agentMessage', text } });
  event('turn/completed', { turn: { id: turn, status: 'completed' } });
}
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({ id: m.id, result: {} });
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    if (m.params.approvalPolicy !== 'never') throw Error('approval boundary');
    thread = m.params.threadId ?? thread;
    return send({ id: m.id, result: { thread: { id: thread } } });
  }
  if (m.method === 'turn/interrupt') {
    if (m.params.threadId !== thread || m.params.turnId !== turn) throw Error('interrupt identity');
    appendFileSync('interrupt-observed.txt', 'interrupt\n');
    if (mode.includes('IGNORE_INTERRUPT')) return;
    clearTimeout(timer);
    send({ id: m.id, result: {} });
    return event('turn/completed', { turn: { id: turn, status: 'interrupted' } });
  }
  if (m.method === 'turn/steer') {
    if (m.params.threadId !== thread || m.params.expectedTurnId !== turn) throw Error('steering identity');
    if (mode.includes('REJECT_STEER')) {
      send({ id: m.id, error: { code: -32601, message: 'fixture unsupported' } });
      return finish();
    }
    const reply = () => send({ id: m.id, result: { turnId: mode.includes('WRONG_STEER') ? 'wrong-turn' : turn } });
    const text = `steered ${count}: ${m.params.input.map(i => i.text).join(', ')}`;
    if (mode.includes('LATE_ACK')) { finish(text); setTimeout(reply, 80); }
    else { reply(); finish(text); }
    return;
  }
  if (m.method !== 'turn/start') return;
  count++; turn = `turn-${count}`; mode = m.params.input[0].text;
  send({ id: m.id, result: { turn: { id: turn } } });
  event('item/started', { item: { id: 'reason', type: 'reasoning', text: 'PRIVATE_REASONING_MUST_NOT_LEAK' } });
  if (mode.includes('CHECK_HISTORY')) {
    const records = JSON.parse(mode.split('Previous conversation records (data; omission flags mean incomplete history):\n')[1].split('\n\nCurrent user request:')[0]);
    if (!records.records.length || records.omittedEarlierRecords < 1) throw Error('invalid history packing');
    return finish('history valid');
  }
  if (mode.includes('MULTI_FINAL') || mode.includes('BAD_DUPLICATE') || mode.includes('LATE_DELTA') || mode.includes('PARTIAL_FINAL') || mode.includes('INTERLEAVED_FINAL') || mode.includes('AGGREGATE_LIMIT')) {
    const emit = (id, text, complete = true) => {
      event('item/started', { item: { id, type: 'agentMessage', phase: 'final_answer' } });
      event('item/agentMessage/delta', { itemId: id, delta: text });
      if (complete) event('item/completed', { item: { id, type: 'agentMessage', text, phase: 'final_answer' } });
    };
    const large = mode.includes('AGGREGATE_LIMIT');
    emit('one', large ? 'x'.repeat(200_000) : 'first', !mode.includes('PARTIAL_FINAL') && !mode.includes('INTERLEAVED_FINAL'));
    if (mode.includes('BAD_DUPLICATE')) event('item/completed', { item: { id: 'one', type: 'agentMessage', text: 'different' } });
    else if (mode.includes('LATE_DELTA')) event('item/agentMessage/delta', { itemId: 'one', delta: 'late' });
    else if (!mode.includes('PARTIAL_FINAL')) {
      emit('two', large ? 'y'.repeat(200_000) : 'second');
      event('item/completed', { item: { id: 'two', type: 'agentMessage', text: large ? 'y'.repeat(200_000) : 'second', phase: 'final_answer' } });
    }
    return event('turn/completed', { turn: { id: turn, status: 'completed' } });
  }
  if (mode.includes('INTERRUPT')) return;
  if (mode.includes('STEER') || mode.includes('LATE_ACK')) { timer = setTimeout(() => finish('NOT_STEERED'), 2000); return; }
  if (mode.includes('STREAM')) {
    if (!mode.includes('NO_START')) event('item/started', { item: { id: `message-${count}`, type: 'agentMessage' } });
    event('item/agentMessage/delta', { itemId: `message-${count}`, delta: `answer ${count}` });
    timer = setTimeout(() => finish(), 350);
    return;
  }
  timer = setTimeout(() => finish(), mode.includes('SLOW_SLOT') ? 250 : 0);
});
