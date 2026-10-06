import { executionPresentation, runPresentation, runTimeline, timelineStateLabel, type ChatRunState, type RoutingExecutionMode } from '@mr-robot/shared';
import './AgentSurface.css';

/** An answer placeholder backed by the current conversation's execution events. */
export function RunTimeline({ run, busy, compact = false, executionMode }: { run: Partial<ChatRunState>; busy: boolean; compact?: boolean; executionMode?: RoutingExecutionMode }) {
  const view = runPresentation({ ...run, busy });
  const rows = runTimeline(run, compact ? 3 : 6);
  const execution = executionPresentation(executionMode, run.agents, run.activity);
  return <section className={`run-timeline${compact ? ' compact' : ''}`} aria-label="실시간 작업 로그">
    <div className="timeline-heading"><span aria-hidden="true">✦</span><b>{view.heading}</b><small>실행 기록</small></div>
    <div className="timeline-route" aria-label="선택한 실행 방식과 실제 보조 작업"><b>{execution.selected}</b><span>{execution.detail}</span><span>{execution.observed}</span></div>
    <ol aria-label="도구·보조 작업 현황">{rows.map(row => <li key={row.id} className={row.state}>
      <span className="timeline-dot" aria-hidden="true">{row.state === 'done' ? '✓' : row.state === 'error' ? '!' : row.state === 'cancelled' ? '−' : '·'}</span>
      <span>{row.label}</span>
      <small>{timelineStateLabel(row.state, view.terminal)}</small>
    </li>)}</ol>
    <p role="status">{view.detail}</p>
    {view.workNotice && <p role="note">{view.workNotice}</p>}
    {!rows.length && <small className="timeline-note">아직 도구·보조 실행 이벤트가 없습니다.</small>}
  </section>;
}
