import assert from 'node:assert/strict';
import test from 'node:test';
import { reasoningEffortsForModel } from '../../shared/src/model-capabilities.js';
import type { ProviderInfo } from '../../shared/src/protocol.js';

const provider: ProviderInfo = { id: 'codex', type: 'codex-cli', label: 'Codex', model: 'model-a', baseUrl: '', hasKey: false, isDefault: true, source: 'subscription', costTier: 0,
  supportedReasoning: ['auto', 'high', 'max'], modelCapabilities: {
    'model-a': { supportedReasoningEfforts: ['low', 'ultra'], defaultReasoningEffort: 'low' },
    'model-b': { supportedReasoningEfforts: ['low', 'max'] },
  } };

test('selected model uses only its discovered options, not provider-wide defaults', () => {
  assert.deepEqual(reasoningEffortsForModel(provider), ['auto', 'low', 'ultra']);
  assert.deepEqual(reasoningEffortsForModel(provider, 'model-b'), ['auto', 'low', 'max']);
  assert.deepEqual(reasoningEffortsForModel(provider, 'unknown'), ['auto']);
  assert.deepEqual(reasoningEffortsForModel(provider, 'constructor'), ['auto']);
});

test('older server or missing model metadata is unknown and auto only', () => {
  assert.deepEqual(reasoningEffortsForModel({ ...provider, modelCapabilities: undefined }), ['auto']);
  assert.deepEqual(reasoningEffortsForModel(undefined), ['auto']);
  assert.deepEqual(reasoningEffortsForModel({ ...provider, modelCapabilities: { 'model-a': { supportedReasoningEfforts: [] } } }), ['auto']);
});

test('non-Codex providers retain explicit advertised options and inputs are not mutated', () => {
  const before = structuredClone(provider);
  assert.deepEqual(reasoningEffortsForModel({ ...provider, type: 'anthropic' }), ['auto', 'high', 'max']);
  const values = reasoningEffortsForModel(provider);
  values.push('none');
  assert.deepEqual(provider, before);
});
