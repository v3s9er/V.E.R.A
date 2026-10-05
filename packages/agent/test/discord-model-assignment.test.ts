import assert from 'node:assert/strict';
import { AgentLoop } from '../src/ai/loop.js';
import { parseDiscordModelAssignment, assertDiscordAssignedModel } from '../src/plugins/discord-model-assignment.js';

const assignment = { providerId: 'fixture', model: 'gpt-6-sol', effort: 'high' } as const;
assert.deepEqual(parseDiscordModelAssignment({ ...assignment, permission: 'full' }), assignment);
for (const value of [null, [], {}, { ...assignment, providerId: '' }, { ...assignment, model: ' gpt-6-sol' }, { ...assignment, model: 'a'.repeat(201) }, { ...assignment, effort: 'unlimited' }]) {
  assert.throws(() => parseDiscordModelAssignment(value));
}
for (const native of [false, true]) {
  let invoked = 0;
  const result = { text: 'fixture', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 } };
  const provider: any = { id: 'fixture', label: 'Fixture', model: 'gpt-6-astra', supportsTools: true, supportedReasoning: ['auto', 'high'], chat: async () => { invoked++; return result; } };
  if (native) provider.runAgent = async () => { invoked++; return result; };
  const registry: any = { default: () => provider, getForModel: () => provider, costTier: () => 1, list: () => [provider] };
  const loop = new AgentLoop(registry, {} as any);
  const beforeModelCall = (actual: { providerId: string; model: string }) => assertDiscordAssignedModel(assignment, actual);
  for (const model of ['gpt-6-astra', 'gpt-5.6-luna']) {
    provider.model = model;
    await assert.rejects(loop.run([], 'hello', { beforeModelCall }, [], { routing: null }), /지정한 공급자·모델/);
    assert.equal(invoked, 0);
  }
  provider.model = assignment.model;
  await loop.run([], 'hello', { beforeModelCall }, [], { routing: null });
  assert.equal(invoked, 1);
  provider.id = 'another-provider';
  await assert.rejects(loop.run([], 'hello', { beforeModelCall }, [], { routing: null }), /지정한 공급자·모델/);
  assert.equal(invoked, 1);
}
console.log('Discord administrator assignment: parser and API/native exact-call boundary passed');
