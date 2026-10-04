import assert from 'node:assert/strict';
import { AgentLoop } from '../src/ai/loop.js';
import { assertDiscordModelAllowed, discordModelAllowed, discordModelPolicy, parseDiscordModelCeiling, parseDiscordModelPolicy } from '../src/plugins/discord-model-policy.js';

const ceilings = ['spark', 'mini', 'luna', 'terra', 'sol', 'astra'] as const;
const models = [['gpt-5.3-codex-spark', 0], ['gpt-5.4-mini', 1], ['gpt-5.6-luna', 2], ['gpt-5.6-terra', 3], ['gpt-5.6-sol', 4], ['gpt-6-sol', 4], ['gpt-6-astra', 5]] as const;
for (const [i, ceiling] of ceilings.entries()) {
  for (const [model, tier] of models) assert.equal(discordModelAllowed(ceiling, model), tier <= i);
  for (const unknown of ['sol', 'astra', 'gpt-6-astra-sol', 'gpt-6-sol-preview', 'gpt-5.6-sol-preview', 'gpt-5.6-sol ', 'Gpt-5.6-sol', 'sonnet', '__proto__', '', null]) assert.equal(discordModelAllowed(ceiling, unknown), false);
}
for (const invalid of ['all', '', null, 0, undefined, '__proto__']) assert.throws(() => parseDiscordModelCeiling(invalid));
assert.equal(discordModelAllowed('unlimited', 'sonnet'), true);
assert.equal(parseDiscordModelPolicy('default'), 'default');
assert.throws(() => parseDiscordModelCeiling('default'), 'implicit default must not become a stored explicit grant');
for (const model of ['gpt-6-sol', 'gpt-6-astra', 'gpt-6-sol-preview', 'gpt-6sol', 'Gpt-6-Sol', 'openai/gpt-6-astra', 'gpt-7-sol', 'gpt-10-sol', 'sol', 'astra']) assert.equal(discordModelAllowed('default', model), false);
for (const model of ['gpt-5.6-sol', 'gpt-5.4', 'claude-sonnet-4-6', 'local-provider-model']) assert.equal(discordModelAllowed('default', model), true, 'legacy models/providers do not lose access');
const limits = { 'guild:user': 'sol', 'guild:unlimited': 'unlimited' };
assert.equal(discordModelPolicy(false, limits, 'guild:user'), 'sol');
assert.equal(discordModelPolicy(true, limits, 'guild:user'), 'sol', 'explicit cap applies even to administrator');
assert.equal(discordModelPolicy(false, limits, 'other-guild:user'), 'default');
assert.equal(discordModelPolicy(true, limits, 'other-guild:user'), 'unlimited');
assert.equal(discordModelPolicy(false, limits, 'guild:unlimited'), 'unlimited');
assert.throws(() => discordModelPolicy(false, { 'guild:user': 'corrupt' }, 'guild:user'));

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
  provider.model = 'gpt-6-sol';
  await loop.run([], 'hello', { beforeModelCall }, [], { routing: null });
  assert.equal(invoked, 2, 'Sol ceiling explicitly permits GPT-6 Sol');
  await assert.rejects(loop.run([], 'hello', { beforeModelCall: ({ model }) => assertDiscordModelAllowed('default', model) }, [], { routing: null }), /허가/);
  assert.equal(invoked, 2, 'ungranted advanced model never reaches API or native provider');
}
console.log('Discord model policy passed: exact tier ordering, unknown/alias rejection, actual API/native pre-call enforcement');
