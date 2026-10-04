import type { ChatRunActivity, ChatRunPhase } from './protocol.js';
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
const TOOLS: Record<string, string> = {
  read_file: '파일 읽기', list_files: '폴더 확인', shell_exec: '명령 실행', write_file: '파일 수정',
  native_agent: '네이티브 에이전트', screenshot: '화면 확인', mouse_click: '화면 조작',
  desktop_open_browser: '브라우저 열기', desktop_windows: '앱 창 확인', desktop_observe: '화면 읽기', desktop_act: '화면 조작',
  web_search: '웹 검색', web_fetch: '웹 문서 읽기',
};
export const AGENT_STATE_LABELS: Record<CoordinationAgent['state'], string> = {
  queued: '대기', running: '작업 중', completed: '완료', failed: '오류', cancelled: '중지',
};
/** Bounded public event feed. Never include tool arguments, output or model reasoning. */
export function runTimeline(run: { activity?: ChatRunActivity[]; agents?: CoordinationAgent[] }, limit = 6) {
  const rows = (run.activity ?? []).map(item => ({
    id: `tool:${item.id}`, label: activityLabel(item.label),
    state: item.state, at: item.startedAt,
  }));
  return rows.sort((a, b) => a.at - b.at).slice(-Math.max(1, Math.min(12, limit)));
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
  const index = items.findIndex(item => (event.callId ? item.callId === event.callId : item.name === event.name) && item.status === 'start');
  return index < 0 ? items : items.map((item, i) => i === index ? { ...item, status: event.status } : item);
}
export function runPresentation(run: {
  phase?: ChatRunPhase; activity?: ChatRunActivity[]; agents?: CoordinationAgent[];
  startedAt?: number; updatedAt?: number; busy: boolean;
}, now = Date.now()) {
  const state = run.phase ?? (run.busy ? 'starting' : 'completed');
  const terminal = ['completed', 'failed', 'cancelled'].includes(state);
  const activity = run.activity ?? [], agents = run.agents ?? [];
  const errors = activity.filter(item => item.state === 'error').length + agents.filter(agent => agent.state === 'failed').length;
  const running = activity.filter(item => item.state === 'running');
  const finished = activity.filter(item => item.state === 'done').length;
  const heading = state === 'completed' && errors ? '응답 완료 · 실행 오류 확인' : PHASES[state];
  const detail = terminal
    ? [activity.length ? `도구 ${finished}/${activity.length} 완료` : '도구 실행 없음', errors ? `오류 ${errors}개` : ''].filter(Boolean).join(' · ')
    : state === 'approval' ? '승인 또는 거절을 기다리고 있어요'
    : state === 'cancelling' ? '실제 실행이 종료될 때까지 기다리고 있어요'
    : running.length ? `${activityLabel(running.at(-1)!.label)}${running.length > 1 ? ` · ${running.length}개 실행 중` : ''}`
    : agents.some(a => a.state === 'running') ? `보조 에이전트 ${agents.filter(a => a.state === 'running').length}개 작업 중`
    : state === 'answering' ? '답변을 실시간으로 받고 있어요'
    : activity.length ? '도구 결과를 받은 뒤 다음 응답을 기다리고 있어요' : '모델 응답을 기다리고 있어요';
  // Never keep adding time after the terminal event; unknown end time stays unknown.
  const end = terminal ? run.updatedAt : now;
  const seconds = run.startedAt && end ? Math.max(0, Math.floor((end - run.startedAt) / 1000)) : undefined;
  const elapsed = seconds === undefined ? '' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return { state, terminal, errors, heading, detail, elapsed };
}
