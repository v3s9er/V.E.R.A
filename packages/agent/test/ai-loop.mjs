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
const mock = createServer((req, res) => {
  if (!req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const sse = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const done = () => {
      res.write('data: [DONE]\n\n');
      res.end();
    };
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
await new Promise((r) => mock.listen(9999, '127.0.0.1', r));

// ---- run the loop --------------------------------------------------------
const { AgentServer } = await import(pathToFileURL('./packages/agent/dist/server/server.js').href);
const { AgentLoop } = await import(pathToFileURL('./packages/agent/dist/ai/loop.js').href);
const server = new AgentServer();
const provider = server.providersAdd({
  label: 'mock',
  type: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:9999/v1',
  model: 'mock-model',
  apiKey: 'test-key',
});

const events = { texts: [], tools: [] };
const result = await server.loop.run([], '명령 실행해줘', {
  confirm: async () => true, // approve destructive shell_exec
  onText: (t) => events.texts.push(t),
  onTool: (i) => events.tools.push(i),
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

// Safety: destructive tool must be cancelled when the user denies.
const denied = await server.loop.run([], '위험한거 해줘', { confirm: async () => false });
check('deny -> destructive tool cancelled', denied.turns.some((t) => t.role === 'tool' && JSON.stringify(t.toolResults).includes('cancelled')));

const node = (id, role, x) => ({ id, kind: 'model', label: id, role, providerId: provider.id, providerModel: 'mock-model', x, y: 20 });
const pipeline = await server.loop.run([], '파이프라인 테스트', { confirm: async () => true }, [], {
  routing: {
    mode: 'balanced', executionMode: 'pipeline', roles: {}, maxPremiumCalls: 3, escalationEnabled: true,
    graph: { nodes: [node('stage-1', 'router', 10), node('stage-2', 'reasoning', 200), node('stage-3', 'summarizer', 400)], edges: [{ id: 'p1', from: 'stage-1', to: 'stage-2' }, { id: 'p2', from: 'stage-2', to: 'stage-3' }] },
  },
});
check('three-node pipeline called both handoff stages', pipelineStageCalls === 2, String(pipelineStageCalls));
check('pipeline route reports three stages', pipeline.route?.reason.includes('3단계'), pipeline.route?.reason);

const vote = await server.loop.run([], '회의 테스트', { confirm: async () => true }, [], {
  routing: {
    mode: 'quality', executionMode: 'vote', meetingRounds: 2, roles: {}, maxPremiumCalls: 5, escalationEnabled: true,
    graph: { nodes: [node('expert-a', 'general', 20), node('expert-b', 'reasoning', 20), node('judge', 'critic', 400)], edges: [{ id: 'v1', from: 'expert-a', to: 'judge' }, { id: 'v2', from: 'expert-b', to: 'judge' }] },
  },
});
check('vote scenario exchanged opinions across two rounds', voteOpinionCalls === 4, String(voteOpinionCalls));
check('validation judge reports participants and rounds', vote.route?.reason.includes('참가자 2명 · 내부 2라운드'), vote.route?.reason);

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
check('group representatives exchange final positions', crossGroupCalls === 2 && crossGroupVote.route?.reason.includes('그룹 간 1라운드'), `${crossGroupCalls} / ${crossGroupVote.route?.reason}`);

const swarm = await server.loop.run([], '허가된 CTF 테스트', { confirm: async () => true }, [], {
  routing: {
    mode: 'quality', executionMode: 'swarm', meetingRounds: 2, maxIterations: 3, roles: {}, maxPremiumCalls: 8, escalationEnabled: true,
    graph: {
      nodes: [node('solver-a', 'coding', 20), node('solver-b', 'reasoning', 20), node('solver-c', 'general', 20), node('verifier', 'critic', 400)],
      groups: [{ id: 'swarm', name: '경쟁 스웜', discussionMode: 'competitive' }],
      edges: [{ id: 's1', from: 'solver-a', to: 'verifier' }, { id: 's2', from: 'solver-b', to: 'verifier' }, { id: 's3', from: 'solver-c', to: 'verifier' }],
    },
  },
});
check('CTF swarm runs every solver concurrently before verification', swarmSolverCalls === 3, String(swarmSolverCalls));
check('CTF swarm stops after verifier accepts a reproduced flag', swarmVerifierCalls === 1 && swarm.route?.reason.includes('플래그 검증 성공'), swarm.route?.reason);

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
}, [], { workspacePath: process.env.MR_ROBOT_HOME, permissionMode: 'ask' });
check('native ask mode requests explicit approval', nativeApprovals === 1, String(nativeApprovals));
check('approved native run is scoped to workspace mode', nativeCalls.every((call) => call.permissionMode === 'workspace'));
check('native steering starts bounded continuation', nativeCalls.length === 2 && nativeCalls[1].prompt.includes('검증도 추가해줘'), String(nativeCalls.length));
check('native continuation returns latest result and aggregates usage', nativeResult.text === 'native-2' && nativeResult.usage.promptTokens === 6);

// Cleanup
await server.stop();
mock.closeAllConnections?.();
await new Promise((r) => mock.close(r));
rmSync(process.env.MR_ROBOT_HOME, { recursive: true, force: true });
console.log(failures === 0 ? 'AI LOOP TEST PASSED' : `${failures} FAILURES`);
// Natural exit (process.exit can hit a libuv teardown assertion on Node 24
// when undici's fetch handles are still closing).
process.exitCode = failures === 0 ? 0 : 1;
