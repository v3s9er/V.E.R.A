import { COMPUTER_TOOLS } from '@mr-robot/shared';
import type { ChatUsage, ModelRole, PermissionMode, ReasoningEffort, RoutingNode, RoutingPresetSettings } from '@mr-robot/shared';
import type { ProviderRegistry } from './registry.js';
import { ToolExecutor, type ConfirmFn } from './executor.js';
import { neutralTool } from './tools.js';
import { parseToolArgs, type NeutralTool, type Turn } from './provider.js';
import type { ModelRouter } from './router.js';
import type { ContextBroker } from '../context-broker.js';

export const SYSTEM_PROMPT = `You are Mr.Robot, a persistent Windows PC agent. Your job is to finish the user's request, not merely explain how it could be done.

Operating loop:
1. Understand the requested outcome and inspect the relevant existing state before changing it.
2. Form a concise internal plan, then act with the available tools. Continue through normal implementation steps without asking for permission unless the configured access policy requires it.
3. Preserve unrelated user work. Prefer targeted, reversible edits and stay inside the selected workspace unless the request clearly requires otherwise.
4. After changing anything, verify it in proportion to risk: re-read the result, run focused checks, and test the actual user-facing path when possible. If a check fails, diagnose and retry with a different approach.
5. Maintain task state across tool calls. Do not repeat completed work, abandon the task after one failed attempt, or ask the user to perform work that an available tool can do.
6. Report the concrete outcome first, then important verification evidence, changed locations, and any genuine remaining blocker. Never claim work or tests that were not performed.

Interaction rules: reply in the user's language; use concise progress updates; prefer PowerShell on Windows; never start an interactive or indefinitely blocking command; keep tool output focused; ask only when a missing high-impact choice cannot be safely inferred.`;

const NATIVE_AGENT_PROMPT = `Operate as Mr.Robot's native coding agent. Work autonomously inside the supplied workspace until the current request is genuinely complete.
- Inspect repository guidance and the existing implementation before editing.
- Preserve unrelated changes and use focused modifications.
- Implement the request, run proportionate tests/builds, inspect failures, and iterate until verified.
- Do not stop at a plan or tutorial when you can perform the work.
- Do not claim success without evidence. In the final response lead with the outcome and mention only material checks or blockers.`;

export interface LoopCallbacks {
  onText?(delta: string): void;
  onTool?(info: { name: string; input: unknown; status: 'start' | 'done' | 'error'; detail?: string }): void;
  /** Ask the human to approve a destructive tool call (safety mode: confirm). */
  confirm?: ConfirmFn;
  onStatus?(status: string): void;
  /** Abort the whole run (client disconnect / cancel). */
  signal?: AbortSignal;
  /** User instructions queued while the current run is in progress. */
  takeSteering?: () => string[];
}

export interface LoopResult {
  text: string;
  turns: Turn[];
  usage: ChatUsage;
  route?: { providerId: string; providerLabel: string; model: string; role: string; effort: ReasoningEffort; reason: string };
}

export interface RunOptions {
  providerId?: string;
  providerModel?: string;
  reasoningEffort?: ReasoningEffort;
  context?: string;
  permissionMode?: PermissionMode;
  /** null disables routing; a value applies a conversation-specific scenario. */
  routing?: RoutingPresetSettings | null;
  workspacePath?: string;
}

const MAX_STEPS = 16;
const MAX_SCENARIO_NODES = 8;

function orderedNodes(routing: RoutingPresetSettings): RoutingNode[] {
  const nodes = [...(routing.graph?.nodes ?? [])].filter((node) => node.kind === 'model');
  if (nodes.length < 2) return nodes;
  const ids = new Set(nodes.map((node) => node.id));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of routing.graph?.edges ?? []) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const byPosition = (a: RoutingNode, b: RoutingNode): number => a.x - b.x || a.y - b.y;
  const queue = nodes.filter((node) => incoming.get(node.id) === 0).sort(byPosition);
  const result: RoutingNode[] = [];
  while (queue.length) {
    const node = queue.shift() as RoutingNode;
    result.push(node);
    for (const target of outgoing.get(node.id) ?? []) {
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if (incoming.get(target) === 0) {
        const next = nodes.find((item) => item.id === target);
        if (next) queue.push(next);
        queue.sort(byPosition);
      }
    }
  }
  return (result.length === nodes.length ? result : nodes.sort(byPosition)).slice(0, MAX_SCENARIO_NODES);
}

function toolsFor(text: string): typeof COMPUTER_TOOLS {
  const names = new Set<string>();
  if (/파일|폴더|경로|문서|프로젝트|코드|file|folder|path|document|project|code/i.test(text)) ['list_files', 'read_file', 'write_file', 'delete_file', 'move_file'].forEach((name) => names.add(name));
  if (/실행|명령|터미널|파워셸|설치|빌드|테스트|command|shell|terminal|install|build|test/i.test(text)) names.add('shell_exec');
  if (/앱|프로그램|열어|브라우저|url|launch|open|app|program/i.test(text)) names.add('launch_app');
  if (/화면|스크린|마우스|클릭|입력|키보드|screen|mouse|click|type|keyboard/i.test(text)) ['get_screen_size', 'screenshot', 'mouse_move', 'mouse_click', 'mouse_scroll', 'type_text', 'key_press'].forEach((name) => names.add(name));
  return names.size ? COMPUTER_TOOLS.filter((tool) => names.has(tool.name)) : [];
}

/**
 * The tool-calling chat loop. Streams assistant text, executes requested
 * tools through the ToolExecutor (which enforces the safety policy), feeds
 * results back, and stops when the model produces a final answer.
 */
export class AgentLoop {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly executor: ToolExecutor,
    private readonly router?: ModelRouter,
    private readonly contextBroker?: ContextBroker,
  ) {}

  async run(
    history: Turn[],
    userMessage: string,
    cb: LoopCallbacks = {},
    extraTools: NeutralTool[] = [],
    options: RunOptions = {},
  ): Promise<LoopResult> {
    const decision = this.router?.decide(userMessage, options.reasoningEffort, options.providerId, options.providerModel, options.routing);
    let provider = decision?.provider ?? (options.providerId ? this.registry.getForModel(options.providerId, options.providerModel) : this.registry.default());
    const turns: Turn[] = [...history, { role: 'user', content: userMessage }];
    const usage: ChatUsage = { promptTokens: 0, completionTokens: 0 };
    const tools = [...toolsFor(userMessage).map(neutralTool), ...extraTools];
    const repeatedCalls = new Map<string, number>();

    if (!provider) {
      return {
        text: 'AI 제공자가 설정되어 있지 않습니다. 설정 화면에서 API 키를 추가해 주세요.',
        turns,
        usage,
      };
    }

    let retainedContext = options.context?.trim() ?? '';
    let routeRole: ModelRole = decision?.role ?? 'general';
    let routeEffort: ReasoningEffort = decision?.effort ?? options.reasoningEffort ?? 'auto';
    let routeReason = decision?.reason ?? '기본 모델';

    const scenario = options.routing;
    const executionMode = scenario?.executionMode ?? 'single';
    const nodes = scenario ? orderedNodes(scenario) : [];
    const providerForNode = (node: RoutingNode) => {
      const role = node.role ?? 'general';
      return this.registry.resolve(role, node.providerId, node.providerModel, scenario?.roles[role]);
    };
    const stageCall = async (node: RoutingNode, system: string, content: string, status?: string) => {
      const stageProvider = providerForNode(node);
      if (!stageProvider) return { label: node.label, model: '연결 없음', text: '사용 가능한 모델이 없어 의견을 내지 못했습니다.' };
      cb.onStatus?.(status ?? `${executionMode === 'pipeline' ? '순차 전달 중' : '회의 의견 수집 중'} · ${node.label}`);
      try {
        const response = await stageProvider.chat({
          system,
          turns: [{ role: 'user', content }],
          reasoningEffort: stageProvider.supportedReasoning.includes(routeEffort) ? routeEffort : 'auto',
          signal: cb.signal,
        });
        usage.promptTokens += response.usage.promptTokens;
        usage.completionTokens += response.usage.completionTokens;
        return { label: node.label, model: `${stageProvider.label} / ${stageProvider.model}`, text: response.text };
      } catch (error) {
        return { label: node.label, model: `${stageProvider.label} / ${stageProvider.model}`, text: `단계 실패: ${error instanceof Error ? error.message : String(error)}` };
      }
    };
    const stageAgentCall = async (node: RoutingNode, system: string, content: string, allowedTools: NeutralTool[], status: string, permissionMode = options.permissionMode) => {
      const stageProvider = providerForNode(node);
      if (!stageProvider) return { label: node.label, model: '연결 없음', text: '사용 가능한 모델이 없어 풀이에 참여하지 못했습니다.' };
      cb.onStatus?.(status);
      const localTurns: Turn[] = [{ role: 'user', content }];
      let collected = '';
      try {
        for (let step = 0; step < 4; step++) {
          const response = await stageProvider.chat({
            system,
            turns: localTurns,
            tools: stageProvider.supportsTools ? allowedTools : undefined,
            reasoningEffort: stageProvider.supportedReasoning.includes(routeEffort) ? routeEffort : 'auto',
            signal: cb.signal,
          });
          usage.promptTokens += response.usage.promptTokens;
          usage.completionTokens += response.usage.completionTokens;
          if (response.text) collected = [collected, response.text].filter(Boolean).join('\n');
          if (response.toolCalls.length === 0) break;
          localTurns.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });
          const toolResults: Array<{ id: string; name: string; content: string }> = [];
          for (const call of response.toolCalls) {
            const input = parseToolArgs(call.args);
            cb.onTool?.({ name: call.name, input, status: 'start' });
            let toolContent: string;
            try {
              if (!allowedTools.some((tool) => tool.name === call.name)) toolContent = JSON.stringify({ error: `${call.name} is not available inside this solver sandbox` });
              else toolContent = await this.executor.execute(call.name, input, cb.confirm, permissionMode);
              cb.onTool?.({ name: call.name, input, status: 'done' });
            } catch (error) {
              toolContent = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
              cb.onTool?.({ name: call.name, input, status: 'error', detail: toolContent });
            }
            toolResults.push({ id: call.id, name: call.name, content: toolContent });
          }
          localTurns.push({ role: 'tool', content: '', toolResults });
        }
        return { label: node.label, model: `${stageProvider.label} / ${stageProvider.model}`, text: collected || '도구 실행 결과만 생성했고 요약을 남기지 않았습니다.' };
      } catch (error) {
        return { label: node.label, model: `${stageProvider.label} / ${stageProvider.model}`, text: `스웜 작업자 실패: ${error instanceof Error ? error.message : String(error)}` };
      }
    };

    // A selected subscription CLI is already a complete coding-agent harness.
    // In direct mode, let it own its native tools instead of degrading it into
    // an advisor for a second API model.
    if (executionMode === 'single' && provider.runAgent && options.workspacePath) {
      const nativeProvider = provider;
      let nativePermission = options.permissionMode ?? 'ask';
      if (nativePermission === 'ask') {
        if (!cb.confirm) {
          const text = '네이티브 에이전트 실행 승인이 필요하지만 현재 승인 채널이 없습니다.';
          turns.push({ role: 'assistant', content: text });
          return { text, turns, usage };
        }
        cb.onStatus?.(`실행 승인 대기 · ${provider.label}`);
        const approved = await cb.confirm({
          tool: 'native_agent',
          input: { provider: provider.label, model: provider.model, workspace: options.workspacePath },
          summary: `${provider.label} / ${provider.model}이 이 요청 동안 ${options.workspacePath} 안의 파일을 수정하고 검증 명령을 실행하도록 허용`,
        });
        if (!approved) {
          const text = '네이티브 에이전트 실행을 취소했습니다.';
          turns.push({ role: 'assistant', content: text });
          cb.onText?.(text);
          return { text, turns, usage, route: { providerId: provider.id, providerLabel: provider.label, model: provider.model, role: routeRole, effort: routeEffort, reason: `${routeReason} · 사용자 취소` } };
        }
        nativePermission = 'workspace';
      }
      cb.onStatus?.(`네이티브 에이전트 실행 · ${provider.label} · ${options.workspacePath}`);
      const recentConversation = history
        .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
        .slice(-12)
        .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}:\n${typeof turn.content === 'string' ? turn.content : JSON.stringify(turn.content)}`)
        .join('\n\n')
        .slice(-24_000);
      const originalPrompt = [
        NATIVE_AGENT_PROMPT,
        retainedContext,
        recentConversation && `Recent conversation context:\n${recentConversation}`,
        `Current user request:\n${userMessage}`,
      ].filter(Boolean).join('\n\n');
      const runNative = (prompt: string) => nativeProvider.runAgent!({
          prompt,
          cwd: options.workspacePath!,
          permissionMode: nativePermission,
          reasoningEffort: routeEffort,
          signal: cb.signal,
          onStatus: cb.onStatus,
        });
      let native = await runNative(originalPrompt);
      usage.promptTokens += native.usage.promptTokens;
      usage.completionTokens += native.usage.completionTokens;
      // Native CLIs cannot accept stdin steering reliably in print/exec mode.
      // Consume queued instructions immediately after each run and start a
      // compact continuation with the verified result, bounded to three passes.
      for (let steeringRound = 1; steeringRound <= 3; steeringRound++) {
        const steering = cb.takeSteering?.() ?? [];
        if (steering.length === 0) break;
        cb.onStatus?.(`추가 명령 ${steering.length}개 반영 · 네이티브 후속 실행 ${steeringRound}/3`);
        native = await runNative([
          NATIVE_AGENT_PROMPT,
          `Original request:\n${userMessage}`,
          `Previous native-agent result:\n${native.text.slice(-24_000)}`,
          `The user added these instructions while the task was running. Apply them now without discarding verified work:\n${steering.map((item) => `- ${item}`).join('\n')}`,
        ].join('\n\n'));
        usage.promptTokens += native.usage.promptTokens;
        usage.completionTokens += native.usage.completionTokens;
      }
      turns.push({ role: 'assistant', content: native.text });
      cb.onText?.(native.text);
      return {
        text: native.text,
        turns,
        usage,
        route: { providerId: provider.id, providerLabel: provider.label, model: provider.model, role: routeRole, effort: routeEffort, reason: `${routeReason} · 네이티브 CLI 에이전트` },
      };
    }

    if (executionMode === 'pipeline' && nodes.length > 1) {
      const finalNode = nodes[nodes.length - 1];
      const stageResults: Array<{ label: string; model: string; text: string }> = [];
      for (const node of nodes.slice(0, -1)) {
        const prior = this.contextBroker
          ? this.contextBroker.rolePack(node.role ?? 'general', userMessage, stageResults)
          : stageResults.map((item) => `[${item.label} · ${item.model}]\n${item.text}`).join('\n\n');
        stageResults.push(await stageCall(
          node,
          `You are the "${node.label}" stage in a sequential AI workflow. Fulfill only your assigned role (${node.role ?? 'general'}). Produce concrete work for the next stage; do not claim tools were executed.`,
          [retainedContext, `Original user request:\n${userMessage}`, prior && `Previous stage output:\n${prior}`].filter(Boolean).join('\n\n').slice(-40_000),
        ));
      }
      provider = providerForNode(finalNode) ?? provider;
      routeRole = finalNode.role ?? routeRole;
      routeReason = `순차 파이프라인 · ${nodes.length}단계`;
      retainedContext = [retainedContext, 'Sequential scenario handoff:', ...stageResults.map((item) => `[${item.label} · ${item.model}]\n${item.text}`)].filter(Boolean).join('\n\n').slice(-50_000);
    } else if (executionMode === 'swarm' && nodes.length > 2) {
      const finalNode = [...nodes].reverse().find((node) => node.role === 'critic') ?? nodes[nodes.length - 1];
      const evidenceNodes = nodes.filter((node) => node.id !== finalNode.id && node.role === 'router');
      const solvers = nodes.filter((node) => node.id !== finalNode.id && !evidenceNodes.some((evidence) => evidence.id === node.id));
      const maxIterations = Math.max(1, Math.min(12, scenario?.maxIterations ?? 6));
      const sandboxTools = tools.filter((tool) => tool.name === 'ctf.inspect' || tool.name.startsWith('docker.ctf.'));
      let solverTools = sandboxTools;
      let swarmPermission = options.permissionMode;
      const needsSandboxApproval = sandboxTools.some((tool) => tool.name.startsWith('docker.ctf.'))
        && options.permissionMode !== 'full' && options.permissionMode !== 'read-only';
      if (needsSandboxApproval) {
        const approved = cb.confirm ? await cb.confirm({
          tool: 'ctf_swarm',
          input: { workers: solvers.map((node) => node.label), tools: sandboxTools.map((tool) => tool.name), workspace: options.workspacePath },
          summary: `${solvers.length}개 CTF 솔버가 선택한 작업 폴더를 Docker 격리 환경에 마운트하고 CTF 분석 명령을 실행하도록 이번 작업 동안 허용`,
        }) : false;
        if (approved) swarmPermission = 'full';
        else solverTools = sandboxTools.filter((tool) => !tool.name.startsWith('docker.ctf.'));
      }

      const evidence: Array<{ label: string; model: string; text: string }> = [];
      for (const node of evidenceNodes) {
        evidence.push(await stageAgentCall(
          node,
          `You are the shared evidence collector for a legal CTF/wargame solver swarm. Inspect the supplied challenge once, classify every plausible category, extract concrete artifacts and constraints, and publish a compact evidence board. You may use only the supplied CTF sandbox tools. Never invent command output or a flag.`,
          [retainedContext, `Authorized CTF/wargame request:\n${userMessage}`, options.workspacePath && `Selected workspace: ${options.workspacePath}`].filter(Boolean).join('\n\n').slice(-35_000),
          solverTools,
          `CTF 공유 증거 수집 · ${node.label}`,
          swarmPermission,
        ));
      }
      let sharedBoard = evidence.map((item) => `[Shared evidence · ${item.label} · ${item.model}]\n${item.text}`).join('\n\n');
      const transcript: Array<{ iteration: number; label: string; model: string; text: string }> = [];
      let verifierResult: { label: string; model: string; text: string } | undefined;
      let solved = false;
      let completedIterations = 0;

      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        if (cb.signal?.aborted) throw new Error('CTF 스웜 작업이 중지되었습니다.');
        completedIterations = iteration;
        const current = await Promise.all(solvers.map((node) => stageAgentCall(
          node,
          `You are independent competitor "${node.label}" in a tool-backed CTF solver swarm. Solve the entire challenge yourself rather than handling only a narrow specialty. Use the Docker/CTF tools to test hypotheses and produce reproducible commands. Read the shared board, reuse verified discoveries, avoid already-recorded dead ends, and publish every new artifact, command result, failed approach and candidate flag for rival solvers. Never claim success without executable evidence.`,
          [
            retainedContext,
            `Authorized CTF/wargame request:\n${userMessage}`,
            options.workspacePath && `Selected workspace: ${options.workspacePath}`,
            sharedBoard && `Shared swarm board before iteration ${iteration}:\n${sharedBoard}`,
            `This is iteration ${iteration}/${maxIterations}. Compete for the first reproducible solution while helping the board improve.`,
          ].filter(Boolean).join('\n\n').slice(-50_000),
          solverTools,
          `CTF 경쟁 ${iteration}/${maxIterations} · ${node.label}`,
          swarmPermission,
        )));
        transcript.push(...current.map((item) => ({ iteration, ...item })));
        const currentBoard = current.map((item, index) => `[Iteration ${iteration} · Candidate ${index + 1} · ${item.label} · ${item.model}]\n${item.text}`).join('\n\n');
        sharedBoard = [sharedBoard, currentBoard].filter(Boolean).join('\n\n').slice(-65_000);

        verifierResult = await stageAgentCall(
          finalNode,
          `You are the strict CTF swarm verifier. Independently reproduce the strongest candidate inside the supplied Docker sandbox. Reject guesses, hallucinated output and non-reproducible flags. Your first line must be exactly "SOLVED: YES" only when a flag has been reproduced from the challenge, otherwise "SOLVED: NO". On success add a second line "FLAG: <exact flag>" and then the reproduction evidence. On failure list the most useful confirmed evidence and next experiments for every solver.`,
          [retainedContext, `Authorized CTF/wargame request:\n${userMessage}`, sharedBoard].filter(Boolean).join('\n\n').slice(-60_000),
          solverTools,
          `CTF 검증 ${iteration}/${maxIterations} · ${finalNode.label}`,
          swarmPermission,
        );
        const accepted = /^SOLVED:\s*YES\s*$/im.test(verifierResult.text) && /^FLAG:\s*\S+/im.test(verifierResult.text);
        if (accepted) { solved = true; break; }
        sharedBoard = [sharedBoard, `[Verifier feedback · iteration ${iteration}]\n${verifierResult.text}`].join('\n\n').slice(-65_000);
      }

      provider = providerForNode(finalNode) ?? provider;
      routeRole = finalNode.role ?? routeRole;
      routeReason = `CTF 병렬 경쟁 스웜 · ${solvers.length}솔버 · ${completedIterations}회 · ${solved ? '플래그 검증 성공' : '검증 계속 필요'}`;
      retainedContext = [
        retainedContext,
        `CTF swarm status: ${solved ? 'A reproducible flag was accepted. Report it with the shortest verified reproduction path.' : 'No flag passed strict verification within the configured retry ceiling. Continue from the board with tools; do not claim success.'}`,
        sharedBoard,
        verifierResult && `[Final verifier · ${verifierResult.model}]\n${verifierResult.text}`,
        ...transcript.slice(-Math.max(8, solvers.length * 2)).map((item) => `[Solver iteration ${item.iteration} · ${item.label} · ${item.model}]\n${item.text}`),
      ].filter(Boolean).join('\n\n').slice(-65_000);
    } else if ((executionMode === 'vote' || executionMode === 'hybrid') && nodes.length > 1) {
      const finalNode = [...nodes].reverse().find((node) => node.role === 'critic') ?? [...nodes].reverse().find((node) => node.role === 'summarizer') ?? nodes[nodes.length - 1];
      const agendaNodes = executionMode === 'hybrid' ? nodes.filter((node) => node.id !== finalNode.id && node.role === 'router') : [];
      const candidates = nodes.filter((node) => node.id !== finalNode.id && !agendaNodes.some((agenda) => agenda.id === node.id));
      const meetingRounds = Math.max(1, Math.min(3, scenario?.meetingRounds ?? 2));
      const agendaResults: Array<{ label: string; model: string; text: string }> = [];
      for (const node of agendaNodes) {
        agendaResults.push(await stageCall(
          node,
          `You are the lightweight agenda router for a hybrid AI council. Classify the task, isolate the key decisions and constraints, and create a concise agenda for the specialist groups. Do not solve the task or claim tools were executed.`,
          [retainedContext, `Original user request:\n${userMessage}`].filter(Boolean).join('\n\n').slice(-30_000),
          `혼합 분류 · ${node.label}`,
        ));
      }
      const agendaContext = agendaResults.map((item) => `[Agenda · ${item.label} · ${item.model}]\n${item.text}`).join('\n\n');
      const groupDefinitions = new Map((scenario?.graph?.groups ?? []).map((group) => [group.id, group]));
      const groups = new Map<string, RoutingNode[]>();
      for (const node of candidates) {
        const group = node.groupId?.trim() || '기본 회의';
        const members = groups.get(group) ?? [];
        members.push(node);
        groups.set(group, members);
      }
      const transcript: Array<{ group: string; round: number; label: string; model: string; text: string }> = [];
      const groupFinals = new Map<string, Array<{ label: string; model: string; text: string }>>();
      for (const [groupId, members] of groups) {
        const definition = groupDefinitions.get(groupId);
        const group = definition?.name ?? groupId;
        const discussionMode = definition?.discussionMode ?? 'collaborative';
        let previousRound: Array<{ label: string; model: string; text: string }> = [];
        for (let round = 1; round <= meetingRounds; round++) {
          const firstRound = round === 1;
          // Hide provider identities during critique to reduce prestige and
          // same-family bias. Group members run concurrently; only the final
          // compact handoff is sent to the judge.
          const sharedOpinions = previousRound.map((item, index) => `[Candidate ${index + 1}]\n${item.text}`).join('\n\n');
          const currentRound = await Promise.all(members.map((node) => stageCall(
              node,
              firstRound
                ? `You are an independent member of AI decision group "${group}" named "${node.label}" with role ${node.role ?? 'general'}. The configured meeting style is "${discussionMode}". Other members may use different roles or models. Analyze independently, propose the best answer or execution plan, identify one major risk, and finish with a confidence score from 0 to 100. Do not claim tools were executed.`
                : `You are member "${node.label}" in round ${round} of AI decision group "${group}" using the "${discussionMode}" meeting style. Read every group member's previous-round opinion. ${discussionMode === 'competitive' ? 'Compete on verifiable evidence and explicitly eliminate failed approaches.' : discussionMode === 'review' ? 'Actively search for errors, unsupported assumptions and missing validation.' : 'Combine complementary strengths while challenging weak assumptions.'} Revise your proposal, then cast one ballot. Finish with exactly "VOTE: <member label>" on its own line. You may vote for yourself only with a concrete reason. Do not claim tools were executed.`,
              [retainedContext, agendaContext, `Meeting agenda — original user request:\n${userMessage}`, !firstRound && `All previous-round opinions in group "${group}":\n${sharedOpinions}`].filter(Boolean).join('\n\n').slice(-45_000),
              `${executionMode === 'hybrid' ? '혼합 회의' : '회의'} ${round}/${meetingRounds} · ${group} · ${node.label}`,
            )));
          transcript.push(...currentRound.map((item) => ({ group, round, ...item })));
          previousRound = currentRound;
        }
        groupFinals.set(groupId, previousRound);
      }
      const crossGroupRounds = groups.size > 1 ? Math.max(0, Math.min(3, scenario?.crossGroupRounds ?? 1)) : 0;
      let groupExchange = [...groupFinals].map(([groupId, results]) => {
        const name = groupDefinitions.get(groupId)?.name ?? groupId;
        return `[Group ${name} final positions]\n${results.map((item, index) => `[Member ${index + 1}]\n${item.text}`).join('\n\n')}`;
      }).join('\n\n');
      for (let round = 1; round <= crossGroupRounds; round++) {
        const representatives = await Promise.all([...groups].map(([groupId, members]) => {
          const name = groupDefinitions.get(groupId)?.name ?? groupId;
          return stageCall(
            members[0],
            `You represent AI group "${name}" in cross-group council round ${round}. Read every group's final positions, disclose conflicts, adopt stronger external evidence, defend only what remains valid, and publish a revised group verdict. Finish with "GROUP VERDICT: <one concise decision>". Do not claim tools were executed.`,
            [retainedContext, agendaContext, `Original user request:\n${userMessage}`, groupExchange].filter(Boolean).join('\n\n').slice(-48_000),
            `그룹 간 회의 ${round}/${crossGroupRounds} · ${name}`,
          );
        }));
        transcript.push(...representatives.map((item, index) => ({ group: `그룹 대표 ${index + 1}`, round: meetingRounds + round, ...item })));
        groupExchange = representatives.map((item, index) => `[Cross-group round ${round} · Representative ${index + 1} · ${item.label}]\n${item.text}`).join('\n\n');
      }
      provider = providerForNode(finalNode) ?? provider;
      routeRole = finalNode.role ?? routeRole;
      routeReason = `${executionMode === 'hybrid' ? '분류·회의·검증 혼합' : '상호 토론·투표'} · ${groups.size}그룹 · 참가자 ${candidates.length}명 · 내부 ${meetingRounds}라운드${crossGroupRounds ? ` · 그룹 간 ${crossGroupRounds}라운드` : ''}`;
      retainedContext = [
        retainedContext,
        agendaContext,
        groupExchange && `Latest cross-group exchange:\n${groupExchange}`,
        'Full AI meeting transcript. As the final validation judge, tally the final-round VOTE lines but do not follow the majority blindly. Verify reasoning, reject factual errors and groupthink, prefer a stronger minority argument when justified, state the verdict, synthesize the strongest plan, and then complete the original user request:',
        ...transcript.map((item) => `[Group ${item.group} · Round ${item.round} · ${item.label} · ${item.model}]\n${item.text}`),
      ].filter(Boolean).join('\n\n').slice(-50_000);
    }
    if (provider && !provider.supportedReasoning.includes(routeEffort)) routeEffort = 'auto';

    let advisor: { providerLabel: string; model: string } | undefined;
    if (!provider.supportsTools && tools.length > 0) {
      cb.onStatus?.(`advisor:${provider.label}`);
      const advice = await provider.chat({
        system: 'Analyze the user request and produce a concise, concrete execution plan for another computer-use agent. Do not claim that any action has already happened.',
        turns: [{ role: 'user', content: userMessage }],
        reasoningEffort: routeEffort,
        signal: cb.signal,
      });
      usage.promptTokens += advice.usage.promptTokens;
      usage.completionTokens += advice.usage.completionTokens;
      const executorProvider = this.registry.toolCapable(provider.id);
      if (!executorProvider) {
        turns.push({ role: 'assistant', content: advice.text });
        return { text: advice.text, turns, usage, route: { providerId: provider.id, providerLabel: provider.label, model: provider.model, role: routeRole, effort: routeEffort, reason: `${routeReason} · 구독 CLI 추론 모듈 (도구 실행 모델 미설정)` } };
      }
      advisor = { providerLabel: provider.label, model: provider.model };
      retainedContext = [retainedContext, `Expert advisor plan (${provider.label} / ${provider.model}):\n${advice.text}`].filter(Boolean).join('\n\n');
      provider = executorProvider;
    }

    // Tell the model exactly what it is, so it never misidentifies itself.
    const context = retainedContext ? `\n\nRelevant retained context:\n${retainedContext}` : '';
    const system = `${SYSTEM_PROMPT}${context}\n\nYou are currently running through the provider "${provider.label}" with model "${provider.model}". When asked what model you are, answer with this exactly.`;
    const route = {
      providerId: provider.id,
      providerLabel: provider.label,
      model: provider.model,
      role: routeRole,
      effort: routeEffort,
      reason: routeReason,
      ...(advisor ? { advisor } : {}),
    };
    cb.onStatus?.(`model:${route.providerLabel}:${route.role}:${route.effort}`);

    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await provider.chat({
        system,
        turns,
        tools,
        reasoningEffort: route.effort,
        signal: cb.signal,
        onEvent: (e) => {
          if (e.type === 'text') cb.onText?.(e.text);
        },
      });
      usage.promptTokens += res.usage.promptTokens;
      usage.completionTokens += res.usage.completionTokens;

      if (res.toolCalls.length === 0) {
        turns.push({ role: 'assistant', content: res.text });
        return { text: res.text, turns, usage, route };
      }

      turns.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
      cb.onStatus?.('running tools…');

      const toolResults: Array<{ id: string; name: string; content: string }> = [];
      for (const call of res.toolCalls) {
        const input = parseToolArgs(call.args);
        cb.onTool?.({ name: call.name, input, status: 'start' });
        let content: string;
        try {
          const signature = `${call.name}:${JSON.stringify(input)}`;
          const repeats = (repeatedCalls.get(signature) ?? 0) + 1;
          repeatedCalls.set(signature, repeats);
          content = repeats > 2
            ? JSON.stringify({ error: 'same tool call repeated; change the approach or finish with the available evidence' })
            : await this.executor.execute(call.name, input, cb.confirm, options.permissionMode);
          cb.onTool?.({ name: call.name, input, status: 'done' });
        } catch (err) {
          content = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
          cb.onTool?.({ name: call.name, input, status: 'error', detail: content });
        }
        toolResults.push({ id: call.id, name: call.name, content });
      }
      turns.push({ role: 'tool', content: '', toolResults });
      const steering = cb.takeSteering?.() ?? [];
      if (steering.length) {
        turns.push({ role: 'user', content: `The user added these instructions while the task was running. Apply them now without discarding verified work:\n${steering.map((item) => `- ${item}`).join('\n')}` });
        cb.onStatus?.(`추가 명령 ${steering.length}개 반영`);
      }
    }

    return {
      text: '(도구 호출이 너무 많아 중단했습니다. 요청을 더 구체적으로 바꿔 보세요.)',
      turns,
      usage,
      route,
    };
  }
}
