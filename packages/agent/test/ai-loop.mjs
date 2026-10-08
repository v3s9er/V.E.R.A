/**
 * End-to-end AI loop test against a MOCK OpenAI-compatible server.
 * Verifies: provider streaming/SSE parsing, tool-call extraction, executor
 * (real shell run), safety confirmation, and the multi-turn loop.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

process.env.MR_ROBOT_HOME = mkdtempSync(join(tmpdir(), 'mr-robot-ai-'));

// ---- mock OpenAI-compatible server ---------------------------------------
let pipelineStageCalls = 0;
let voteOpinionCalls = 0;
let crossGroupCalls = 0;
let swarmSolverCalls = 0;
let swarmVerifierCalls = 0;
let premiumBudgetCalls = 0;
let freeBudgetCalls = 0;
const freeBudgetSystems = [];
const mock = createServer((req, res) => {
  if (!req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    // This fixture tests model/tool orchestration, not pooled HTTP sockets.
    // Close explicitly: slow Windows shell tests can cross the keepalive expiry.
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const sse = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const done = () => {
      res.write('data: [DONE]\n\n');
      res.end();
    };
    const parsed = JSON.parse(body);
    if (parsed.model === 'premium-budget' || parsed.model === 'free-budget') {
      if (parsed.model === 'premium-budget') premiumBudgetCalls++;
      else {
        freeBudgetCalls++;
        freeBudgetSystems.push(parsed.messages?.find((message) => message.role === 'system')?.content ?? '');
      }
      const round = premiumBudgetCalls + freeBudgetCalls;
      if (round <= 3) {
        sse({ choices: [{ delta: { role: 'assistant', content: '' } }] });
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: `budget_call_${round}`, function: { name: 'shell_exec', arguments: `{"command":"echo budget-${round}","shell":"cmd"}` } }] } }] });
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        sse({ choices: [{ delta: { content: 'BUDGET-COMPLETE' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
      }
      done();
      return;
    }
    if (body.includes('sequential AI workflow')) {
      pipelineStageCalls++;
      sse({ choices: [{ delta: { content: `PIPELINE-STAGE-${pipelineStageCalls}` } }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
      done();
      return;
    }
    if (body.includes('cross-group council round')) {
      crossGroupCalls++;
      sse({ choices: [{ delta: { content: `GROUP-VERDICT-${crossGroupCalls}` } }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
      done();
      return;
    }
    if (body.includes('AI decision meeting') || body.includes('AI decision group')) {
      voteOpinionCalls++;
      sse({ choices: [{ delta: { content: `VOTE-OPINION-${voteOpinionCalls} confidence 80` } }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
      done();
      return;
    }
    if (body.includes('strict CTF swarm verifier')) {
      swarmVerifierCalls++;
      sse({ choices: [{ delta: { content: 'SOLVED: YES\nFLAG: DH{verified-swarm}\nreproduced in sandbox' } }], usage: { prompt_tokens: 4, completion_tokens: 3 } });
      done();
      return;
    }
    if (body.includes('tool-backed CTF solver swarm')) {
      swarmSolverCalls++;
      sse({ choices: [{ delta: { content: `SWARM-CANDIDATE-${swarmSolverCalls}\ncommand evidence` } }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
      done();
      return;
    }
    if (body.includes('"role":"tool"')) {
      // Second turn: answer with final text.
      sse({ choices: [{ delta: { content: 'AI-완료' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      done();
    } else {
      // First turn: request a shell_exec tool call.
      sse({ choices: [{ delta: { role: 'assistant', content: '' } }] });
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'shell_exec', arguments: '{"command":"echo ai-tool-ok","shell":"cmd"}' },
                },
              ],
            },
          },
        ],
      });
      sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      done();
    }
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockBaseUrl = `http://127.0.0.1:${mock.address().port}/v1`;

// ---- run the loop --------------------------------------------------------
const { AgentServer } = await import(pathToFileURL('./packages/agent/dist/server/server.js').href);
const { AgentLoop, ModelBudgetExceededError } = await import(pathToFileURL('./packages/agent/dist/ai/loop.js').href);
const server = new AgentServer();
const provider = server.providersAdd({
  label: 'mock',
  type: 'openai-compatible',
  baseUrl: mockBaseUrl,
  model: 'mock-model',
  apiKey: 'test-key',
});

const events = { texts: [], tools: [] };
const progressKinds = [];
const result = await server.loop.run([], '명령 실행해줘', {
  confirm: async () => true, // approve destructive shell_exec
  onText: (t) => events.texts.push(t),
  onTool: (i) => events.tools.push(i),
  noteModelProgress: (kind) => progressKinds.push(kind),
});

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name} ${detail}`);
  }
};

check('provider added', Boolean(provider.id));
check('final text from mock', result.text.includes('AI-완료'), result.text);
check('tool call executed (real shell)', events.tools.some((t) => t.name === 'shell_exec' && t.status === 'done'));
check('tool result contained stdout', result.turns.some((t) => t.role === 'tool' && JSON.stringify(t.toolResults).includes('ai-tool-ok')));
check('loop turns well-formed', result.turns.filter((t) => t.role === 'assistant').length === 2);
check('one completed tool round emits one adaptive progress signal', progressKinds.length === 1 && progressKinds[0] === 'tool');

// Safety: destructive tool must be cancelled when the user denies.
let deniedApprovals = 0;
const denied = await server.loop.run([], '명령 실행해줘', { confirm: async () => { deniedApprovals++; return false; } });
check('deny -> destructive tool cancelled after a real approval request', deniedApprovals === 1 && denied.turns.some((t) => t.role === 'tool' && JSON.stringify(t.toolResults).includes('cancelled')));

const node = (id, role, x) => ({ id, kind: 'model', label: id, role, providerId: provider.id, providerModel: 'mock-model', x, y: 20 });
let pipelineBudgetProfile;
const pipeline = await server.loop.run([], '파이프라인 테스트', {
  confirm: async () => true,
  configureModelBudget: (profile) => { pipelineBudgetProfile = profile; },
}, [], {
  routing: {
    mode: 'balanced', executionMode: 'pipeline', roles: {}, maxPremiumCalls: 3, escalationEnabled: true,
    graph: { nodes: [node('stage-1', 'router', 10), node('stage-2', 'reasoning', 200), node('stage-3', 'summarizer', 400)], edges: [{ id: 'p1', from: 'stage-1', to: 'stage-2' }, { id: 'p2', from: 'stage-2', to: 'stage-3' }] },
  },
});
check('archived pipeline never calls handoff models', pipelineStageCalls === 0, String(pipelineStageCalls));
check('archived pipeline keeps the selected primary', pipeline.route?.model === 'mock-model', pipeline.route?.model);
check('archived pipeline budget profile plans one primary execution', pipelineBudgetProfile?.executionMode === 'single' && pipelineBudgetProfile?.plannedModelCalls === 1);

const vote = await server.loop.run([], '회의 테스트', { confirm: async () => true }, [], {
  routing: {
    mode: 'quality', executionMode: 'vote', meetingRounds: 2, roles: {}, maxPremiumCalls: 5, escalationEnabled: true,
    graph: { nodes: [node('expert-a', 'general', 20), node('expert-b', 'reasoning', 20), node('judge', 'critic', 400)], edges: [{ id: 'v1', from: 'expert-a', to: 'judge' }, { id: 'v2', from: 'expert-b', to: 'judge' }] },
  },
});
check('archived vote performs no model voting', voteOpinionCalls === 0, String(voteOpinionCalls));
check('archived vote does not claim unperformed participant rounds', !vote.route?.reason.includes('라운드') && vote.route?.model === 'mock-model', vote.route?.reason);

const crossGroupVote = await server.loop.run([], '그룹 간 회의 테스트', { confirm: async () => true }, [], {
  routing: {
    mode: 'quality', executionMode: 'vote', meetingRounds: 1, crossGroupRounds: 1, roles: {}, maxPremiumCalls: 5, escalationEnabled: true,
    graph: {
      nodes: [{ ...node('expert-a2', 'general', 20), groupId: 'group-a' }, { ...node('expert-b2', 'reasoning', 20), groupId: 'group-b' }, node('judge-2', 'critic', 400)],
      groups: [{ id: 'group-a', name: 'A 그룹' }, { id: 'group-b', name: 'B 그룹' }],
      edges: [{ id: 'cg1', from: 'expert-a2', to: 'judge-2' }, { id: 'cg2', from: 'expert-b2', to: 'judge-2' }],
    },
  },
});
check('archived groups do not spawn representatives', crossGroupCalls === 0 && crossGroupVote.route?.model === 'mock-model', `${crossGroupCalls} / ${crossGroupVote.route?.reason}`);

let swarmBudgetProfile;
const swarm = await server.loop.run([], '보관된 스웜 설정 테스트', {
  confirm: async () => true,
  configureModelBudget: (profile) => { swarmBudgetProfile = profile; },
}, [], {
  routing: {
    mode: 'quality', executionMode: 'swarm', meetingRounds: 2, maxIterations: 3, roles: {}, maxPremiumCalls: 8, escalationEnabled: true,
    graph: {
      nodes: [node('solver-a', 'coding', 20), node('solver-b', 'reasoning', 20), node('solver-c', 'general', 20), node('verifier', 'critic', 400)],
      groups: [{ id: 'swarm', name: '경쟁 스웜', discussionMode: 'competitive' }],
      edges: [{ id: 's1', from: 'solver-a', to: 'verifier' }, { id: 's2', from: 'solver-b', to: 'verifier' }, { id: 's3', from: 'solver-c', to: 'verifier' }],
    },
  },
});
check('archived swarm never runs competing solver agents', swarmSolverCalls === 0, String(swarmSolverCalls));
check('archived swarm does not claim an unperformed model verification', swarmVerifierCalls === 0 && !swarm.route?.reason.includes('검증 성공'), swarm.route?.reason);
check('archived swarm budget plans only the primary model', swarmBudgetProfile?.executionMode === 'single' && swarmBudgetProfile?.plannedModelCalls === 1);

// Only host-owned admission is an active call budget. An archived scenario's
// coordinator-node ceiling cannot silently become a one-turn tool-loop limit.
const premiumBudgetProvider = server.providersAdd({
  label: 'Premium Budget', type: 'openai-compatible', baseUrl: mockBaseUrl,
  model: 'premium-budget', apiKey: 'test-key', source: 'api', costTier: 2,
});
server.providersAdd({
  label: 'Free Budget', type: 'openai-compatible', baseUrl: mockBaseUrl,
  model: 'free-budget', apiKey: 'test-key', source: 'free', costTier: 0,
});
let budgetAdmissionError, budgetAdmissions = 0, budgetSettlements = 0;
try {
  await server.loop.run([], '명령 실행하고 세 번 검증해줘', {
    confirm: async () => true,
    reserveModelCall: () => {
      if (++budgetAdmissions > 1) throw new ModelBudgetExceededError('host call admission exhausted');
      return { finish: () => { budgetSettlements++; return true; } };
    },
  }, [], {
    providerId: premiumBudgetProvider.id, providerModel: 'premium-budget', reasoningEffort: 'high',
    routing: { mode: 'balanced', executionMode: 'single', roles: {}, maxPremiumCalls: 1, escalationEnabled: true },
  });
} catch (error) { budgetAdmissionError = error; }
check('actual admission stops the second primary call before provider execution',
  budgetAdmissionError instanceof ModelBudgetExceededError && premiumBudgetCalls === 1 && budgetSettlements === 1);
check('budget exhaustion never silently substitutes a free model', freeBudgetCalls === 0 && freeBudgetSystems.length === 0);
// A single-mode scenario is a local router choice, not a fan-out. The graph
// can describe many roles while only the selected model receives the prompt.
let singleCascadeCalls = 0;
const singleCascadeProvider = {
  id: 'single-cascade', label: 'Single Cascade', type: 'openai-compatible', model: 'single-cascade',
  supportsTools: true, supportedReasoning: ['auto'],
  async chat() {
    singleCascadeCalls++;
    return { text: 'single-only', toolCalls: [], usage: { promptTokens: 2, completionTokens: 1 } };
  },
  async ping() { return { ok: true }; }, async models() { return ['single-cascade']; },
};
const singleCascadeRegistry = {
  default: () => singleCascadeProvider,
  resolve: () => singleCascadeProvider,
  costTier: () => 0,
};
const singleCascadeLoop = new AgentLoop(singleCascadeRegistry, { execute: async () => '{}' });
const singleCascadeResult = await singleCascadeLoop.run([], '짧게 답해줘', {}, [], {
  routing: {
    mode: 'balanced', executionMode: 'single', roles: {}, maxPremiumCalls: 1, escalationEnabled: true,
    graph: { nodes: [node('fast-one', 'fast', 10), node('general-one', 'general', 100), node('reasoning-one', 'reasoning', 200), node('critic-one', 'critic', 300)], edges: [] },
  },
});
check('single-mode cascade invokes only one selected model', singleCascadeCalls === 1 && singleCascadeResult.text === 'single-only', `${singleCascadeCalls} / ${singleCascadeResult.text}`);

let settledSuccessUsage;
let boundedOutputTokens = 0;
let reservedMaximum = 0;
let configuredTokenPolicy = '';
const accountedProvider = {
  ...singleCascadeProvider, id: 'accounted-provider', label: 'Accounted Provider', model: 'accounted-provider',
  async chat(req) {
    boundedOutputTokens = req.maxTokens;
    return { text: 'accounted', toolCalls: [], usage: { promptTokens: 8, completionTokens: 3 } };
  },
};
const accountedLoop = new AgentLoop({ default: () => accountedProvider }, { execute: async () => '{}' });
const accountedResult = await accountedLoop.run([], '예산 정산 테스트', {
  configureModelBudget: (profile) => { configuredTokenPolicy = profile.tokenPolicy; },
  reserveModelCall: (kind, maximumTokens) => {
    reservedMaximum = maximumTokens;
    return { accountedTokens: maximumTokens, finish: (usage) => { settledSuccessUsage = usage; return true; } };
  },
}, [], { tokenPolicy: 'audit-only' });
check('API calls reserve a conservative maximum before provider execution and cap output',
  reservedMaximum > 8 + 3 && boundedOutputTokens === 4096, `${reservedMaximum} / ${boundedOutputTokens}`);
check('successful provider usage is passed intact to admission settlement',
  settledSuccessUsage?.promptTokens === 8 && settledSuccessUsage?.completionTokens === 3);
check('conversation telemetry keeps the normalized provider report rather than the admission reservation',
  accountedResult.usage.promptTokens === 8
    && accountedResult.usage.completionTokens === 3
    && accountedResult.usage.accountedTokens === reservedMaximum);
check('conversation token policy reaches backend budget configuration', configuredTokenPolicy === 'audit-only');

const malformedUsageProvider = {
  ...singleCascadeProvider, id: 'malformed-usage', label: 'Malformed Usage', model: 'malformed-usage',
  async chat() {
    return { text: 'normalized', toolCalls: [], usage: { promptTokens: Number.POSITIVE_INFINITY, completionTokens: -4, cachedPromptTokens: 1e30 } };
  },
};
const malformedUsageLoop = new AgentLoop({ default: () => malformedUsageProvider }, { execute: async () => '{}' });
const normalizedUsage = await malformedUsageLoop.run([], '사용량 정규화', {
  reserveModelCall: () => ({ finish: () => true }),
});
check('loop normalizes malformed provider counters before telemetry persistence',
  normalizedUsage.usage.promptTokens === 0
    && normalizedUsage.usage.completionTokens === 0
    && normalizedUsage.usage.cachedPromptTokens === 1_000_000_000_000);

let failureProviderCalls = 0;
let failureSettlement = 'not-settled';
let failureRecordedUsage;
const failingProvider = {
  ...singleCascadeProvider, id: 'failing-provider', label: 'Failing Provider', model: 'failing-provider',
  async chat() { failureProviderCalls++; throw new Error('synthetic provider failure'); },
};
const failingLoop = new AgentLoop({ default: () => failingProvider }, { execute: async () => '{}' });
let providerFailureSurfaced = false;
try {
  await failingLoop.run([], '실패 정산 테스트', {
    reserveModelCall: () => ({
      accountedTokens: 777,
      finish: (usage) => { failureSettlement = usage === undefined ? 'fallback' : 'exact'; return true; },
    }),
    onModelUsage: (delta) => { failureRecordedUsage = delta; },
  });
} catch { providerFailureSurfaced = true; }
check('provider exceptions retain the pre-call reservation as fallback debt',
  providerFailureSurfaced
    && failureProviderCalls === 1
    && failureSettlement === 'fallback'
    && failureRecordedUsage?.promptTokens === 0
    && failureRecordedUsage?.completionTokens === 0
    && failureRecordedUsage?.accountedTokens === 777);

let rejectedProviderCalls = 0;
const rejectedProvider = {
  ...singleCascadeProvider, id: 'rejected-provider', label: 'Rejected Provider', model: 'rejected-provider',
  async chat() { rejectedProviderCalls++; return { text: 'unsafe', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } }; },
};
const rejectedLoop = new AgentLoop({ default: () => rejectedProvider }, { execute: async () => '{}' });
let reservationFailureSurfaced = false;
try {
  await rejectedLoop.run([], '동시 예산 거절 테스트', {
    reserveModelCall: () => { throw new Error('token reservation exhausted'); },
  });
} catch { reservationFailureSurfaced = true; }
check('an exhausted reservation rejects before any provider token can be spent',
  reservationFailureSurfaced && rejectedProviderCalls === 0);

let fatalStageProviderCalls = 0;
const fatalStageProvider = {
  ...singleCascadeProvider, id: 'fatal-stage', label: 'Fatal Stage', model: 'fatal-stage',
  async chat() {
    fatalStageProviderCalls++;
    return { text: 'must not become a fallback stage result', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } };
  },
};
const fatalStageRegistry = {
  default: () => fatalStageProvider,
  resolve: () => fatalStageProvider,
  costTier: () => 0,
};
const fatalStageLoop = new AgentLoop(fatalStageRegistry, { execute: async () => '{}' });
const fatalNode = (id, role, x) => ({ id, kind: 'model', label: id, role, providerId: fatalStageProvider.id, providerModel: fatalStageProvider.model, x, y: 0 });
let pipelineAdmissionError;
try {
  await fatalStageLoop.run([], 'fatal pipeline', {
    reserveModelCall: () => { throw new ModelBudgetExceededError('provider concurrency exhausted'); },
  }, [], {
    routing: {
      mode: 'quality', executionMode: 'pipeline', roles: {}, maxPremiumCalls: 4, escalationEnabled: true,
      graph: { nodes: [fatalNode('fatal-router', 'router', 0), fatalNode('fatal-judge', 'critic', 100)], edges: [{ id: 'fatal-edge', from: 'fatal-router', to: 'fatal-judge' }] },
    },
  });
} catch (error) { pipelineAdmissionError = error; }
check('stageCall rethrows typed admission failures before provider use instead of converting them to stage text',
  pipelineAdmissionError instanceof ModelBudgetExceededError && fatalStageProviderCalls === 0);

let fatalPrimaryCalls=0, fatalPrimarySettlements=0, fatalPrimaryError;
let fatalPrimaryReported=0, fatalPrimaryAccounted=0;
const fatalPrimary = {
  ...fatalStageProvider, id:'fatal-primary', model:'fatal-primary',
  async chat() {
    fatalPrimaryCalls++;
    return {text:'must not be returned as success',toolCalls:[],usage:{promptTokens:3,completionTokens:2}};
  },
};
try {
  await new AgentLoop({default:()=>fatalPrimary,costTier:()=>0}, {execute:async()=>{throw Error('No tools after failed admission');}}).run([], 'fatal legacy swarm', {
    reserveModelCall:()=>({accountedTokens:50,finish:()=>{fatalPrimarySettlements++;return false;}}),
    onModelUsage:delta=>{fatalPrimaryReported+=delta.promptTokens+delta.completionTokens;fatalPrimaryAccounted+=delta.accountedTokens??0;},
  }, [], {
    routing:{mode:'quality',executionMode:'swarm',maxIterations:1,roles:{},maxPremiumCalls:4,escalationEnabled:true,
      graph:{nodes:[fatalNode('a','coding',0),fatalNode('b','reasoning',10),fatalNode('judge','critic',100)],edges:[]}},
  });
} catch(error) { fatalPrimaryError=error; }
check('failed primary settlement aborts the single run without siblings or final model fallback',
  fatalPrimaryError instanceof ModelBudgetExceededError && fatalPrimaryCalls===1 && fatalPrimarySettlements===1);
check('failed single run reports actual and reservation-floor usage exactly once',
  fatalPrimaryReported===5 && fatalPrimaryAccounted===50, `${fatalPrimaryReported} / ${fatalPrimaryAccounted}`);

// Equivalent JSON arguments must share one repeat signature even when a model
// changes object key order. Two consecutive blocked rounds end the paid loop.
let repeatedProviderCalls = 0;
let repeatedExecutions = 0;
const repeatingProvider = {
  ...singleCascadeProvider, id: 'repeat-test', label: 'Repeat Test', model: 'repeat-test',
  async chat() {
    repeatedProviderCalls++;
    const args = repeatedProviderCalls % 2
      ? '{"command":"echo stable","shell":"cmd"}'
      : '{"shell":"cmd","command":"echo stable"}';
    return {
      text: '',
      toolCalls: [{ id: `repeat-${repeatedProviderCalls}`, name: 'shell_exec', args }],
      usage: { promptTokens: 2, completionTokens: 1 },
    };
  },
};
const repeatedLoop = new AgentLoop(
  { default: () => repeatingProvider },
  { execute: async () => { repeatedExecutions++; return '{"ok":true}'; } },
);
const repeatedResult = await repeatedLoop.run([], '명령 실행해줘');
check('canonical repeat guard ignores object key order', repeatedExecutions === 2, String(repeatedExecutions));
check('consecutive no-progress rounds stop further paid calls', repeatedProviderCalls === 4 && repeatedResult.text.includes('반복되어 작업을 중단'), `${repeatedProviderCalls} / ${repeatedResult.text}`);

let steerableRepeatCalls = 0;
let steeringPolls = 0;
const steerableRepeatProvider = {
  ...repeatingProvider, id: 'steerable-repeat', label: 'Steerable Repeat', model: 'steerable-repeat',
  async chat(req) {
    steerableRepeatCalls++;
    if (req.turns.some((turn) => turn.role === 'user' && turn.content.includes('다른 접근'))) {
      return { text: 'steering-recovered', toolCalls: [], usage: { promptTokens: 2, completionTokens: 1 } };
    }
    return {
      text: '',
      toolCalls: [{ id: `steer-repeat-${steerableRepeatCalls}`, name: 'shell_exec', args: '{"command":"echo stable","shell":"cmd"}' }],
      usage: { promptTokens: 2, completionTokens: 1 },
    };
  },
};
const steerableRepeatLoop = new AgentLoop(
  { default: () => steerableRepeatProvider },
  { execute: async () => '{"ok":true}' },
);
const steerableRepeatResult = await steerableRepeatLoop.run([], '명령 실행해줘', {
  takeSteering: () => ++steeringPolls === 4 ? ['다른 접근으로 마무리해줘'] : [],
});
check('steering at the repeat threshold is applied before automatic stop', steerableRepeatCalls === 5 && steerableRepeatResult.text === 'steering-recovered', `${steerableRepeatCalls} / ${steerableRepeatResult.text}`);

// Native subscription agents receive one explicit run approval in ask mode,
let finalSteeringCalls = 0, finalSteeringReads = 0;
const finalSteeringProvider = {
  ...steerableRepeatProvider,
  async chat(req) {
    finalSteeringCalls++;
    return { text: finalSteeringCalls === 1 ? 'initial' : 'updated', toolCalls: [], usage: { promptTokens: 2, completionTokens: 1 } };
  },
};
const finalSteeringLoop = new AgentLoop({ default: () => finalSteeringProvider }, { execute: async () => '{}' });
const finalSteeringResult = await finalSteeringLoop.run([], 'write answer', {
  takeSteering: () => ++finalSteeringReads === 1 ? ['add verification'] : [],
});
check('steering arriving during a final text response is not lost', finalSteeringCalls === 2 && finalSteeringResult.text === 'updated');

// Native subscription agents receive one explicit run approval in ask mode,
// then consume instructions queued while their non-interactive CLI was busy.
const nativeCalls = [];
const nativeProvider = {
  id: 'native-test', label: 'Native Test', type: 'codex-cli', model: 'test-model', supportsTools: false,
  supportedReasoning: ['auto', 'high'],
  async chat() { throw new Error('native branch should not call chat'); },
  async ping() { return { ok: true }; }, async models() { return ['test-model']; },
  async runAgent(req) { nativeCalls.push(req); return { text: `native-${nativeCalls.length}`, toolCalls: [], usage: { promptTokens: 3, completionTokens: 2 } }; },
};
const nativeLoop = new AgentLoop({ default: () => nativeProvider }, { execute: async () => '{}' });
let steeringReads = 0;
let nativeApprovals = 0;
const nativeResult = await nativeLoop.run([], '파일을 수정해줘', {
  confirm: async (request) => { nativeApprovals++; return request.tool === 'native_agent'; },
  takeSteering: () => ++steeringReads === 1 ? ['검증도 추가해줘'] : [],
  }, [], { workspacePath: process.env.MR_ROBOT_HOME, permissionMode: 'ask', cacheKey: 'native-conversation-test', nativeSessionDirectory: process.env.MR_ROBOT_HOME });
check('native ask mode requests explicit approval', nativeApprovals === 1, String(nativeApprovals));
  check('approved native run is scoped to workspace mode', nativeCalls.every((call) => call.permissionMode === 'workspace'));
  check('native session receives host-scoped identity and incremental user input', nativeCalls[0].session.key === 'native-conversation-test' && nativeCalls[0].session.input === '파일을 수정해줘' && nativeCalls[0].session.history.length === 0);
  check('native steering keeps verified prior native result in session history', nativeCalls[1].session.history[1].content === 'native-1');
check('native steering starts bounded continuation', nativeCalls.length === 2 && nativeCalls[1].prompt.includes('검증도 추가해줘'), String(nativeCalls.length));
check('native continuation returns latest result and aggregates usage', nativeResult.text === 'native-2' && nativeResult.usage.promptTokens === 6);

// Native steering uses the same selected model and must pass admission again.
// Exhaustion is not permission to substitute an unrelated free provider.
const budgetedNativeCalls=[];
const premiumNative={...nativeProvider,id:'premium-native',label:'Premium Native',model:'premium-native-model',
  async runAgent(req){budgetedNativeCalls.push(req);return {text:'premium-native-result',toolCalls:[],usage:{promptTokens:2,completionTokens:1}};}};
const nativeBudgetLoop=new AgentLoop({
 default:()=>premiumNative,costTier:()=>2,freeProvider:()=>{throw Error('No implicit free-provider lookup');},
},{execute:async()=>'{"ok":true}'});
let nativeBudgetError,budgetSteeringReads=0,nativeBudgetAdmissions=0,nativeBudgetSettlements=0;
try {
 await nativeBudgetLoop.run([], '파일을 수정해줘', {
  takeSteering:()=>++budgetSteeringReads===1?['테스트를 한 번 더 실행해줘']:[],
  reserveModelCall:()=>{
   if(++nativeBudgetAdmissions>1)throw new ModelBudgetExceededError('native host admission exhausted');
   return {finish:()=>{nativeBudgetSettlements++;return true;}};
  },
 },[],{workspacePath:process.env.MR_ROBOT_HOME,permissionMode:'workspace',reasoningEffort:'high',
 routing:{mode:'balanced',executionMode:'single',roles:{},maxPremiumCalls:1,escalationEnabled:true}});
}catch(error){nativeBudgetError=error;}
check('native steering respects host admission before any extra provider execution',
 nativeBudgetError instanceof ModelBudgetExceededError&&budgetedNativeCalls.length===1&&nativeBudgetSettlements===1);
check('native selected identity effort and workspace authority remain intact',
 budgetedNativeCalls[0]?.reasoningEffort==='high'&&budgetedNativeCalls[0]?.prompt.includes('Premium Native')&&budgetedNativeCalls[0]?.permissionMode==='workspace');

// Cleanup
await server.stop();
mock.closeAllConnections?.();
await new Promise((r) => mock.close(r));
rmSync(process.env.MR_ROBOT_HOME, { recursive: true, force: true });
console.log(failures === 0 ? 'AI LOOP TEST PASSED' : `${failures} FAILURES`);
// Natural exit (process.exit can hit a libuv teardown assertion on Node 24
// when undici's fetch handles are still closing).
process.exitCode = failures === 0 ? 0 : 1;
