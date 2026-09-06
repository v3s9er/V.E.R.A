import assert from 'node:assert/strict';
import { AgentLoop } from '../src/ai/loop.js';
import { assertDiscordModelAllowed, discordModelAllowed, parseDiscordModelCeiling } from '../src/plugins/discord-model-policy.js';

const ceilings = ['spark', 'mini', 'luna', 'terra', 'sol', 'astra'] as const;
const models = ['gpt-5.3-codex-spark', 'gpt-5.4-mini', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-astra'];
for (const [i, ceiling] of ceilings.entries()) {
  for (const [j, model] of models.entries()) assert.equal(discordModelAllowed(ceiling, model), j <= i);
  for (const unknown of ['sol', 'astra', 'gpt-6-astra-sol', 'gpt-5.6-sol-preview', 'gpt-5.6-sol ', 'Gpt-5.6-sol', 'sonnet', '__proto__', '', null]) assert.equal(discordModelAllowed(ceiling, unknown), false);
}
for (const invalid of ['all', '', null, 0, undefined, '__proto__']) assert.throws(() => parseDiscordModelCeiling(invalid));
assert.equal(discordModelAllowed('unlimited', 'sonnet'), true);

// Real loop integration: enforcement runs before either an API or native call.
for (const native of [false, true]) {
  let invoked = 0;
  const result = { text: 'fixture', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 } };
  const provider: any = { id: 'fixture', label: 'Fixture', model: 'gpt-6-astra', supportsTools: true, supportedReasoning: ['auto'], chat: async () => { invoked++; return result; } };
  if (native) provider.runAgent = async () => { invoked++; return result; };
  const registry: any = { default: () => provider, getForModel: () => provider, costTier: () => 1, list: () => [provider] };
  const loop = new AgentLoop(registry, {} as any);
  const beforeModelCall = ({ model }: { model: string }) => assertDiscordModelAllowed('sol', model);
  await assert.rejects(loop.run([], 'hello', { beforeModelCall }, [], { routing: null }), /모델 상한/);
  assert.equal(invoked, 0, `${native ? 'native' : 'API'} provider must not execute above cap`);
  provider.model = 'gpt-5.6-sol';
  await loop.run([], 'hello', { beforeModelCall }, [], { routing: null });
  assert.equal(invoked, 1, 'allowed provider executes normally');
}
console.log('Discord model policy passed: exact tier ordering, unknown/alias rejection, actual API/native pre-call enforcement');
