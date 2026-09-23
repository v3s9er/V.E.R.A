import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCliFailure, CliFailure } from '../src/ai/cli-failure.js';
test('provider failures identify actionable causes without revealing provider text', () => {
  for (const [message, code] of [
    ["The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.", 'model_unavailable'],
    ['You have hit your usage limit', 'usage_limit'], ['Rate limit reached', 'usage_limit'],
    ['Authentication required', 'authentication'], ['Not logged in', 'authentication'],
    ['Maximum context length exceeded', 'context_limit'],
  ]) {
    const error = classifyCliFailure({ message: `${message} private-value-do-not-echo` });
    assert.ok(error instanceof CliFailure); assert.equal(error.code, code);
    assert.equal(error.message.includes('private-value'), false);
    assert.equal(error.stack?.includes('private-value'), false);
  }
});
test('unknown or malformed failures remain bounded and never echo raw values', () => {
  for (const value of [null, undefined, 7, 'private-value', { message: { secret: true } }, { message: 'private-value'.repeat(10000) }]) {
    assert.equal(classifyCliFailure(value).code, 'turn_failed');
    assert.equal(classifyCliFailure(value).message.includes('private-value'), false);
  }
  assert.equal(classifyCliFailure({}, 'request_rejected').code, 'request_rejected');
  assert.equal(classifyCliFailure({ code: 'model_not_found' }).code, 'model_unavailable');
});
