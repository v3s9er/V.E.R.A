import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
const mode = process.env.MRROBOT_MODEL_FIXTURE;
if (process.argv.includes('--version')) {
  if (mode === 'version-timeout') { setInterval(() => {}, 1000); }
  else { process.stdout.write(mode === 'private-version' ? 'private-fixture-value' : 'codex-cli 0.153.4\n'); process.exit(0); }
} else {
assert(process.argv.includes('app-server'));
assert(process.argv.includes('--strict-config'));
assert(process.argv.includes('features.hooks=false'));
assert(process.argv.includes('features.plugins=false'));
assert(!process.argv.includes('--help'));
if (mode === 'unsupported') { process.stderr.write("error: unexpected argument '--strict-config' private-fixture-value"); process.exit(2); }
}
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialized') return;
  if (m.method === 'initialize') {
    send({ id: m.id, result: { userAgent: 'mrrobot_models/1.0.0 (private-fixture-value)' } }); return;
  }
  if (m.method !== 'model/list') process.exit(42);
  assert.equal(m.params.includeHidden, false);
  assert.equal(m.params.limit, 100);
  if (mode === 'timeout') return;
  if (mode === 'request') { send({ id: 99, method: 'item/commandExecution/requestApproval', params: {} }); return; }
  if (mode === 'error') { process.stderr.write('private-fixture-value'); send({ id: m.id, error: { message: 'private-fixture-value' } }); return; }
  if (mode === 'missing-method') { send({ id: m.id, error: { code: -32601, message: 'private-fixture-value' } }); return; }
  if (mode === 'invalid') { process.stdout.write('invalid JSON\n'); return; }
  if (mode === 'cycle') { send({ id: m.id, result: { data: [], nextCursor: 'same' } }); return; }
  if (mode === 'empty') { send({ id: m.id, result: { data: [], nextCursor: null } }); return; }
  if (mode === 'capability-edge') { send({ id: m.id, result: { data: [
    { model: 'missing-capabilities', defaultReasoningEffort: 'ultra' },
    { model: 'empty-capabilities', supportedReasoningEfforts: [], defaultReasoningEffort: 'high' },
    { model: 'unknown-capabilities', supportedReasoningEfforts: [{ reasoningEffort: 'future' }, { reasoningEffort: 'auto' }, 'high', null, 2], defaultReasoningEffort: 'future' },
    { model: 'constructor', supportedReasoningEfforts: [{ reasoningEffort: 'none' }], defaultReasoningEffort: 'none' },
  ], nextCursor: null } }); return; }
  if (!m.params.cursor) send({ id: m.id, result: { data: [
    { model: 'gpt-6-astra', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'ultra', description: 'private-fixture-value' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'future' }], defaultReasoningEffort: 'medium' },
    { model: 'gpt-new-catalog-model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'max' }], defaultReasoningEffort: 'low' },
    { model: 'hidden-model', hidden: true, supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }] },
    { model: '--config=unsafe' }, { model: 'bad\nname' },
  ], nextCursor: 'page2' } });
  else send({ id: m.id, result: { data: [{ model: 'gpt-daybreak-blue-latest', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }], defaultReasoningEffort: 'high' }, { id: 'catalog-second-model' }, { model: 'gpt-new-catalog-model' }], nextCursor: null } });
});
