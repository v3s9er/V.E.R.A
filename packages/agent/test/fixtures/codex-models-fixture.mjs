import { createInterface } from 'node:readline';
const mode = process.env.MRROBOT_MODEL_FIXTURE;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialized') return;
  if (m.method === 'initialize') { send({ id: m.id, result: {} }); return; }
  if (m.method !== 'model/list') process.exit(42);
  if (mode === 'timeout') return;
  if (mode === 'request') { send({ id: 99, method: 'item/commandExecution/requestApproval', params: {} }); return; }
  if (mode === 'error') { process.stderr.write('private-fixture-value'); send({ id: m.id, error: { message: 'private-fixture-value' } }); return; }
  if (mode === 'invalid') { process.stdout.write('invalid JSON\n'); return; }
  if (mode === 'cycle') { send({ id: m.id, result: { data: [], nextCursor: 'same' } }); return; }
  if (mode === 'empty') { send({ id: m.id, result: { data: [], nextCursor: null } }); return; }
  if (!m.params.cursor) send({ id: m.id, result: { data: [
    { model: 'gpt-new-catalog-model' }, { model: 'hidden-model', hidden: true },
    { model: '--config=unsafe' }, { model: 'bad\nname' },
  ], nextCursor: 'page2' } });
  else send({ id: m.id, result: { data: [{ id: 'catalog-second-model' }, { model: 'gpt-new-catalog-model' }], nextCursor: null } });
});
