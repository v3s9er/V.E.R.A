import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelTuningCapabilities, ModelTuningProfile } from '@mr-robot/shared';
import { displayLatency, profileFromDraft, replaceTuningProfile, tuningDraft } from '../src/model-tuning-form.js';

const caps: ModelTuningCapabilities = { reasoningEfforts: ['auto', 'none', 'high'], maxOutputTokens: true, temperature: { supported: true, min: 0, max: 2, requiresReasoningNone: true }, weightTraining: 'external-only', notes: [] };
const profile: ModelTuningProfile = { id: 'one', name: '빠른 답변', reasoningEffort: 'none', temperature: 0, maxOutputTokens: 500, contextTokenLimit: 2048, maxParallelHelpers: 1, responseStyle: 'concise', helperMode: 'off' };

test('UI draft round-trips an explicit zero and every independent knob', () => {
  assert.equal(tuningDraft(profile).temperature, '0');
  assert.deepEqual(profileFromDraft(tuningDraft(profile), caps), profile);
  assert.deepEqual(profileFromDraft({ ...tuningDraft(undefined, 'fresh'), name: 'New' }, caps), { id: 'fresh', name: 'New' });
});

test('UI rejects incompatible settings rather than silently changing effort or deleting values', () => {
  const draft = { ...tuningDraft(profile), reasoningEffort: 'high' };
  assert.throws(() => profileFromDraft(draft, caps), /none/);
  assert.equal(draft.temperature, '0');
  assert.equal(draft.reasoningEffort, 'high');
  assert.throws(() => profileFromDraft(tuningDraft(profile), { ...caps, maxOutputTokens: false }), /출력/);
  assert.throws(() => profileFromDraft(tuningDraft(profile), { ...caps, temperature: { supported: false, min: 0, max: 2 } }), /temperature/);
  for (const extra of [{ maxOutputTokens: 'NaN' }, { contextTokenLimit: '-1' }, { temperature: 'Infinity' }, { maxParallelHelpers: '1.5' }, { reasoningEffort: 'unknown' }]) assert.throws(() => profileFromDraft({ ...tuningDraft(profile), ...extra }, caps));
});

test('saving never activates a profile without an explicit apply action', () => {
  const empty = { profiles: [] };
  assert.deepEqual(replaceTuningProfile(empty, profile), { profiles: [profile] });
  const active = replaceTuningProfile(empty, profile, true);
  assert.equal(active.activeProfileId, profile.id);
  const another = { ...profile, id: 'two', name: 'Second' };
  assert.equal(replaceTuningProfile(active, another).activeProfileId, profile.id);
  assert.equal(replaceTuningProfile(active, another, true).activeProfileId, 'two');
  assert.deepEqual(empty, { profiles: [] });
});

test('profile limits and missing measurements are explicit', () => {
  const full = { profiles: Array.from({ length: 16 }, (_, index) => ({ ...profile, id: String(index) })) };
  assert.throws(() => replaceTuningProfile(full, profile), /16/);
  assert.equal(displayLatency(null), '측정 없음');
  assert.equal(displayLatency(undefined), '측정 없음');
  assert.equal(displayLatency(NaN), '측정 없음');
  assert.equal(displayLatency(0), '0 ms');
  assert.equal(displayLatency(1200), '1.2초');
});
