import { runPresentation, runTimeline, type ChatRunState } from '@mr-robot/shared';
import './AgentSurface.css';

/** An answer placeholder backed by the current conversation's execution events. */
export function RunTimeline({ run, busy, compact = false }: { run: Partial<ChatRunState>; busy: boolean; compact?: boolean }) {
  const view = runPresentation({ ...run, busy });
  const rows = runTimeline(run, compact ? 3 : 6);
  return <section className={`run-timeline${compact ? ' compact' : ''}`} aria-label="실시간 작업 로그">
    <div className="timeline-heading"><span aria-hidden="true">✦</span><b>{view.heading}</b><small>실행 기록</small></div>
    <ol aria-label="최근 실행 이벤트">{rows.map(row => <li key={row.id} className={row.state}>
      <span className="timeline-dot" aria-hidden="true">{row.state === 'done' ? '✓' : row.state === 'error' ? '!' : '·'}</span>
      <span>{row.label}</span>
      <small>{row.state === 'done' ? '완료' : row.state === 'error' ? '오류' : view.terminal ? '완료 미확인' : '실행 중'}</small>
    </li>)}</ol>
    <p role="status">{view.detail}</p>
    {!rows.length && <small className="timeline-note">아직 도구 실행 이벤트가 없습니다.</small>}
  </section>;
}
