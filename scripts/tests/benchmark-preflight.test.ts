import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertBenchmarkModelAvailable } from '../benchmark-preflight.js';
import { CliFailure } from '../../packages/agent/src/ai/cli-failure.js';
test('benchmark requires the exact requested Sol model and never falls back to Terra or aliases', () => {
  assert.doesNotThrow(() => assertBenchmarkModelAvailable('gpt-5.6-sol', ['gpt-5.6-sol']));
  for (const models of [[], ['gpt-5.6-terra'], ['gpt-5.6'], ['gpt-6-astra']]) {
    assert.throws(() => assertBenchmarkModelAvailable('gpt-5.6-sol', models), error => error instanceof CliFailure && error.code === 'model_unavailable');
  }
});
