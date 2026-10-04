import type { ChatRunActivity, ChatRunPhase, RoutingExecutionMode } from './protocol.js';
import type { CoordinationAgent } from './coordination.js';

const PHASES: Record<ChatRunPhase, string> = {
  starting: '요청 준비', working: '도구로 작업 중', answering: '답변 작성 중',
  approval: '승인이 필요해요', cancelling: '작업을 안전하게 중지하는 중',
  completed: '응답 완료', failed: '확인이 필요한 오류', cancelled: '작업 중지됨',
};
/** Preserve the authoritative terminal event when a late RPC completion arrives. */
export function terminalRunUpdate(run: { phase?: ChatRunPhase; updatedAt?: number } | undefined, phase: ChatRunPhase, now = Date.now()) {
  return run?.phase && ['completed', 'failed', 'cancelled'].includes(run.phase)
    ? { phase: run.phase, updatedAt: run.updatedAt ?? now } : { phase, updatedAt: now };
}
/** Exact host-owned protocol notice; never infer limits from arbitrary provider text. */
export function isObservationLimitedStatus(status?: string): boolean {
  return status === '도구 관측 제한 · 이 연결에서는 일부 코드 실행이 집계되지 않을 수 있습니다.';
}
const TOOLS: Record<string, string> = {
  read_file: '파일 읽기', list_files: '폴더 확인', shell_exec: '명령 실행', write_file: '파일 수정',
  native_agent: '네이티브 에이전트', native_command: '명령 실행', native_file_change: '파일 변경',
  native_web_search: '웹 검색', native_image_view: '이미지 확인', native_mcp: 'MCP 도구',
  native_host_tool: '연결 도구', native_function: '도구 호출', native_custom_tool: '코드 실행',
  screenshot: '화면 확인', mouse_click: '화면 조작',
  desktop_open_browser: '브라우저 열기', desktop_windows: '앱 창 확인', desktop_observe: '화면 읽기', desktop_act: '화면 조작',
  web_search: '웹 검색', web_fetch: '웹 문서 읽기',
};
export const AGENT_STATE_LABELS: Record<CoordinationAgent['state'], string> = {
  queued: '대기', running: '작업 중', completed: '완료', failed: '오류', cancelled: '중지',
};
function currentAgents(agents: CoordinationAgent[]): CoordinationAgent[] {
  const latest = new Map<string, CoordinationAgent>();
  for (const agent of agents) {
    if (!latest.has(agent.agentId) || agent.sequence >= latest.get(agent.agentId)!.sequence) latest.set(agent.agentId, agent);
  }
  return [...latest.values()];
}

export function agentActivityLabel(label: string): string {
  const text = label.trim().replace(/\s+/g, ' ');
  return /^[\p{L}\p{N} _./·():-]{1,80}$/u.test(text) ? text : '보조 작업';
}

type TimelineState = ChatRunActivity['state'] | 'queued' | 'cancelled';
export function timelineStateLabel(state: TimelineState, terminal = false): string {
  return state === 'done' ? '완료' : state === 'error' ? '오류' : state === 'cancelled' ? '중지'
    : terminal ? '완료 미확인' : state === 'queued' ? '실행 대기' : '실행 중';
}

/** Tool events stay chronological; timestamp-free helper snapshots follow as current status. */
export function runTimeline(run: { activity?: ChatRunActivity[]; agents?: CoordinationAgent[] }, limit = 6) {
  const latestTools = new Map((run.activity ?? []).map(item => [item.id, item]));
  const rows: Array<{ id: string; label: string; state: TimelineState; at?: number }> = [...latestTools.values()].map(item => ({
    id: `tool:${item.id}`, label: activityLabel(item.label),
    state: item.state, at: item.startedAt,
  }));
  rows.sort((a, b) => a.at! - b.at!);
  const agents = currentAgents(run.agents ?? []).sort((a, b) =>
    Number(['queued', 'running'].includes(a.state)) - Number(['queued', 'running'].includes(b.state)));
  rows.push(...agents.map(agent => ({
    id: `agent:${agent.agentId}`, label: agentActivityLabel(agent.label),
    state: agent.state === 'completed' ? 'done' as const : agent.state === 'failed' ? 'error' as const : agent.state,
  })));
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(12, Math.trunc(limit))) : 6;
  return rows.slice(-boundedLimit);
}

const EXECUTION_MODES: Record<RoutingExecutionMode, { label: string; detail: string }> = {
  single: { label: '단일 모델', detail: '선택한 모델로 시작합니다.' },
  adaptive: { label: '적응형 협업', detail: '주 모델이 필요할 때 보조 작업을 요청합니다.' },
  pipeline: { label: '순차 검증', detail: '설정한 모델 단계를 순서대로 진행합니다.' },
  vote: { label: '병렬 검토·투표', detail: '후보 의견을 모아 최종 담당자가 검토합니다.' },
  hybrid: { label: '혼합 협업', detail: '분류·병렬 검토·최종 확인을 조합합니다.' },
  swarm: { label: '경쟁 풀이', detail: '여러 풀이를 비교하고 검증 결과에 따라 진행합니다.' },
};

/** Selection is a policy, not evidence that helpers ran or that verification succeeded. */
export function executionPresentation(mode: RoutingExecutionMode | undefined, agents: CoordinationAgent[] = []) {
  const selected = mode ? EXECUTION_MODES[mode] : undefined;
  const current = currentAgents(agents);
  const counts = (state: CoordinationAgent['state']) => current.filter(agent => agent.state === state).length;
  const observed = [
    counts('running') ? `${counts('running')}개 ${counts('running') > 1 ? '병렬 실행' : '실행 중'}` : '',
    counts('queued') ? `${counts('queued')}개 실행 대기` : '',
    counts('completed') ? `${counts('completed')}개 완료` : '',
    counts('failed') ? `${counts('failed')}개 오류` : '',
    counts('cancelled') ? `${counts('cancelled')}개 중지` : '',
  ].filter(Boolean).join(' · ');
  return {
    selected: selected ? `선택: ${selected.label}` : '선택한 실행 방식 확인 중',
    detail: selected?.detail ?? '저장된 시나리오를 불러오고 있어요.',
    observed: observed ? `관측된 보조 작업: ${observed}` : '보조 실행 이벤트 없음',
  };
}
/** Only host-owned identifiers, never raw arguments, responses, or hidden reasoning. */
export function activityLabel(label: string): string {
  return TOOLS[label] ?? (/^[a-zA-Z][\w./:-]{0,99}$/.test(label) ? label : '도구 작업');
}
/** Pure, replay-safe reducer. React may evaluate a state updater twice. */
export function mergeToolActivity<T extends { key: string; callId?: string; name: string; status: 'start' | 'done' | 'error' }>(items: T[], event: T): T[] {
  if (event.status === 'start') {
    if (event.callId && items.some(item => item.callId === event.callId)) return items;
    return [...items.slice(-63), event];
  }
  // An explicit failure can correct a provisional native completion for the
  // same call. Never replay its start or let a late done erase the error.
  const index = items.findIndex(item => (event.callId ? item.callId === event.callId : item.name === event.name)
    && (item.status === 'start' || (!!event.callId && event.status === 'error' && item.status === 'done')));
  return index < 0 ? items : items.map((item, i) => i === index ? { ...item, status: event.status } : item);
}
export function runPresentation(run: {
  phase?: ChatRunPhase; activity?: ChatRunActivity[]; agents?: CoordinationAgent[];
  activityTruncated?: boolean; activityHadErrors?: boolean; observationLimited?: boolean;
  startedAt?: number; updatedAt?: number; busy: boolean; status?: string;
}, now = Date.now()) {
  const state = run.phase ?? (run.busy ? 'starting' : 'completed');
  const terminal = ['completed', 'failed', 'cancelled'].includes(state);
  const activity = run.activity ?? [], agents = currentAgents(run.agents ?? []);
  const toolErrors = activity.filter(item => item.state === 'error').length;
  const errors = toolErrors + agents.filter(agent => agent.state === 'failed').length;
  const hasErrors = errors > 0 || run.activityHadErrors === true;
  const observationLimited = run.observationLimited === true || isObservationLimitedStatus(run.status);
  const observationNotice = observationLimited ? '일부 내부 도구 기록은 이 연결에서 제공되지 않습니다' : '';
  // Legacy hosts omit the flags. A full 32-row tail cannot establish that no
  // older work/errors existed, so never present it as complete run accounting.
  const partial = run.activityTruncated === true || (run.activityTruncated === undefined && activity.length >= 32);
  const historyNotice = run.activityTruncated === true ? '전체 내역 일부 생략' : partial ? '전체 도구 내역 확인 불가' : '';
  const hiddenErrorNotice = run.activityHadErrors === true && !toolErrors ? '표시되지 않은 도구 오류 있음' : '';
  const running = activity.filter(item => item.state === 'running');
  const finished = activity.filter(item => item.state === 'done').length;
  const runningAgents = agents.filter(agent => agent.state === 'running').length;
  const queuedAgents = agents.filter(agent => agent.state === 'queued').length;
  // Recognize only this host-emitted stage marker; never reflect free-form status text.
  const verifying = !terminal && ['starting', 'working'].includes(state) && /^최종 검증 시작(?: ·|$)/.test(run.status ?? '');
  const heading = state === 'completed' && hasErrors ? '응답 완료 · 실행 오류 확인'
    : verifying ? '최종 결과 검토 중'
    : ['starting', 'working'].includes(state) && !running.length
      ? runningAgents ? (runningAgents > 1 ? '보조 작업 병렬 실행 중' : '보조 작업 실행 중')
        : queuedAgents ? '보조 작업 실행 대기' : state === 'working' ? '모델 응답 대기' : PHASES[state]
      : PHASES[state];
  const detail = terminal
    ? [activity.length ? `${partial ? '최근 ' : observationLimited ? '관측된 ' : ''}도구 ${finished}/${activity.length} 완료` : partial || hiddenErrorNotice ? '표시된 도구 기록 없음' : observationLimited ? '관측된 도구 기록 없음' : '도구 실행 없음',
      agents.length ? `보조 작업 ${agents.filter(agent => agent.state === 'completed').length}/${agents.length} 완료` : '',
      errors ? `${partial || hiddenErrorNotice ? '표시된 ' : ''}오류 ${errors}개` : '', hiddenErrorNotice, historyNotice].filter(Boolean).join(' · ')
    : state === 'approval' ? '승인 또는 거절을 기다리고 있어요'
    : state === 'cancelling' ? '실제 실행이 종료될 때까지 기다리고 있어요'
    : verifying ? '최종 담당자가 결과를 검토하고 있어요. 검증 완료 여부는 아직 확인되지 않았습니다.'
    : running.length ? `${activityLabel(running.at(-1)!.label)}${running.length > 1 ? ` · ${running.length}개 실행 중` : ''}`
    : runningAgents ? `보조 작업 ${runningAgents}개 실행 중${queuedAgents ? ` · ${queuedAgents}개 실행 대기` : ''}`
    : queuedAgents ? `보조 작업 ${queuedAgents}개가 실행 순서를 기다리고 있어요`
    : state === 'answering' ? '답변을 실시간으로 받고 있어요'
    : activity.length ? '도구 결과를 받은 뒤 다음 응답을 기다리고 있어요' : '모델 응답을 기다리고 있어요';
  // Never keep adding time after the terminal event; unknown end time stays unknown.
  const end = terminal ? run.updatedAt : now;
  const seconds = run.startedAt && end ? Math.max(0, Math.floor((end - run.startedAt) / 1000)) : undefined;
  const elapsed = seconds === undefined ? '' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return { state, terminal, errors, hasErrors, historyNotice, observationNotice, heading,
    detail: !terminal && hiddenErrorNotice ? `${detail} · ${hiddenErrorNotice}` : detail, elapsed };
}
