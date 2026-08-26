import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../dist/config.js';
import { ProviderRegistry } from '../dist/ai/registry.js';
import { ModelRouter } from '../dist/ai/router.js';

const home = mkdtempSync(join(tmpdir(), 'mr-robot-routing-'));
const config = new ConfigStore(home);

const builtins = config.routingPresets.filter((preset) => preset.builtin);
if (builtins.length !== 11) throw new Error(`expected 11 built-in routing presets, got ${builtins.length}`);
if (builtins.some((preset) => preset.graph?.nodes.some((node) => node.kind !== 'model' || !node.role))) throw new Error('built-in routing graph contains a non-model or role-less node');
for (const preset of builtins) {
  const nodes = preset.graph?.nodes ?? [];
  const edges = preset.graph?.edges ?? [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const invalidEdges = edges.filter((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to);
  if (invalidEdges.length) throw new Error(`${preset.id} contains ${invalidEdges.length} invalid graph edge(s)`);
  const connected = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const isolated = nodes.filter((node) => nodes.length > 1 && !connected.has(node.id));
  if (isolated.length) throw new Error(`${preset.id} contains isolated node(s): ${isolated.map((node) => node.id).join(', ')}`);
  if (nodes.length > 1) {
    const reachable = new Set([nodes[0].id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges) {
        if (reachable.has(edge.from) && !reachable.has(edge.to)) { reachable.add(edge.to); changed = true; }
        if (reachable.has(edge.to) && !reachable.has(edge.from)) { reachable.add(edge.from); changed = true; }
      }
    }
    if (reachable.size !== nodes.length) throw new Error(`${preset.id} graph is split into disconnected components`);
  }
}

config.applyRoutingPreset('builtin:quality');
if (config.routing.mode !== 'quality' || config.routing.activePresetId !== 'builtin:quality') throw new Error('built-in routing preset did not apply');

const saved = config.saveRoutingPreset('내 트리');
config.updateRouting({ maxPremiumCalls: 7 });
if (config.routing.activePresetId !== undefined) throw new Error('manual routing edit did not clear active preset');
config.saveRoutingPreset('내 트리 수정', '', saved.id);
config.applyRoutingPreset(saved.id);
if (config.routing.maxPremiumCalls !== 7 || config.routing.activePresetId !== saved.id) throw new Error('custom routing preset did not persist/apply');
if (!config.deleteRoutingPreset(saved.id)) throw new Error('custom routing preset did not delete');

let responseStatus = 401;
let lastPath = '';
const fake = createServer((req, res) => {
  lastPath = req.url ?? '';
  res.statusCode = responseStatus;
  res.setHeader('content-type', 'application/json');
  res.end(responseStatus === 200 ? JSON.stringify({ data: [{ id: 'switchable-model' }], models: [] }) : JSON.stringify({ error: 'unauthorized' }));
});
await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
const address = fake.address();
if (!address || typeof address === 'string') throw new Error('fake provider failed to bind');

const registry = new ProviderRegistry(config);
const added = registry.add({ label: '무료 연결', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}`, model: 'first', source: 'free', costTier: 5 });
if (added.costTier !== 0) throw new Error('free provider cost was not forced to zero');
const rejected = await registry.test(added.id);
if (rejected.ok || !rejected.error?.includes('401')) throw new Error('authentication failure was incorrectly reported as connected');
responseStatus = 200;
if (!(await registry.test(added.id)).ok) throw new Error('healthy free provider did not connect');
const updated = registry.updateModel(added.id, 'switchable-model');
if (updated.model !== 'switchable-model') throw new Error('registered provider model could not be changed');
config.applyRoutingPreset('builtin:efficient-quality');
const efficientNodes = config.routing.graph?.nodes ?? [];
if (!efficientNodes.length || efficientNodes.some((node) => node.providerId !== added.id || !node.providerModel)) throw new Error('efficient-quality preset did not adapt to the active provider');
const conversationModel = registry.getForModel(added.id, 'conversation-only-model');
if (conversationModel?.model !== 'conversation-only-model' || registry.get(added.id)?.model !== 'switchable-model') throw new Error('conversation model override mutated the provider default');
config.updateRouting({ graph: { nodes: [{ id: 'coder', kind: 'model', label: '구현 담당', role: 'coding', providerId: added.id, providerModel: 'node-only-model', x: 10, y: 10 }], edges: [] } });
const graphDecision = new ModelRouter(registry, config).decide('코드를 구현해줘');
if (graphDecision.provider?.model !== 'node-only-model') throw new Error('routing model node override was not applied');
const directDecision = new ModelRouter(registry, config).decide('코드를 구현해줘', 'auto', undefined, undefined, null);
if (directDecision.provider?.model !== 'switchable-model' || directDecision.reason !== '대화 단일 모델') throw new Error('no-scenario conversation did not bypass the routing graph');
const debate = config.routingForPreset('builtin:debate');
if (debate?.executionMode !== 'vote' || debate.meetingRounds !== 2 || (debate.graph?.nodes.length ?? 0) < 4) throw new Error('meeting/vote preset was not resolved');

const efficientVote = config.routingForPreset('builtin:efficient-vote');
if (efficientVote?.executionMode !== 'vote' || efficientVote.meetingRounds !== 2 || !efficientVote.graph?.nodes.some((node) => node.groupId === '핵심 회의') || !efficientVote.graph?.nodes.some((node) => node.role === 'critic')) throw new Error('efficient vote preset was not resolved');

const sequential = config.routingForPreset('builtin:sequential-validation');
if (sequential?.executionMode !== 'pipeline' || sequential.graph?.nodes.at(-1)?.role !== 'critic') throw new Error('sequential validation preset was not resolved');

const hybrid = config.routingForPreset('builtin:hybrid-council');
if (hybrid?.executionMode !== 'hybrid' || hybrid.meetingRounds !== 2 || !hybrid.graph?.nodes.some((node) => node.groupId === '전문가 회의') || !hybrid.graph?.nodes.some((node) => node.role === 'critic')) throw new Error('hybrid council preset was not resolved');
if (!debate.graph?.nodes.some((node) => node.role === 'critic' && node.label.includes('판정'))) throw new Error('meeting preset has no final validation judge');
const smart = config.routingForPreset('builtin:smart-cascade');
if (smart?.executionMode !== 'single' || !smart.escalationEnabled || smart.maxPremiumCalls !== 1) throw new Error('smart cascade preset was not resolved');
const ctf = config.routingForPreset('builtin:ctf-autopilot');
if (ctf?.executionMode !== 'swarm' || ctf.maxIterations !== 12 || (ctf.graph?.nodes.filter((node) => node.groupId === 'ctf-solver-swarm').length ?? 0) < 4 || !ctf.graph?.groups?.some((group) => group.discussionMode === 'competitive') || !ctf.graph?.nodes.some((node) => node.integrationId === 'docker-sandbox')) throw new Error('CTF competitive swarm preset was not resolved');

const ollama = registry.add({ label: 'Ollama', type: 'ollama', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'local', source: 'local' });
await registry.test(ollama.id);
if (lastPath !== '/api/tags') throw new Error(`Ollama /v1 base was not normalized: ${lastPath}`);

await new Promise((resolve, reject) => fake.close((error) => error ? reject(error) : resolve()));
rmSync(home, { recursive: true, force: true });
console.log('ROUTING PRESET + PROVIDER CONNECTION TEST PASSED');
