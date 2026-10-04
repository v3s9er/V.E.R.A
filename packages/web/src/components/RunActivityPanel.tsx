import { useEffect, useState } from 'react';
import './RunActivityPanel.css';
import { activityLabel, agentActivityLabel, AGENT_STATE_LABELS, executionPresentation, runPresentation } from '@mr-robot/shared';
import type { ChatRunActivity, ChatRunPhase, CoordinationAgent, RoutingExecutionMode } from '@mr-robot/shared';

export function RunActivityPanel({ phase, activity = [], activityTruncated, activityHadErrors, observationLimited, queued, agents = [], startedAt, updatedAt, busy, status, executionMode }: {
  phase?: ChatRunPhase; activity?: ChatRunActivity[]; agents?: CoordinationAgent[]; startedAt?: number; updatedAt?: number; busy: boolean; status?: string; executionMode?: RoutingExecutionMode;
  activityTruncated?: boolean; activityHadErrors?: boolean; observationLimited?: boolean; queued?: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!busy) return; setNow(Date.now()); const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [busy]);
  if (!busy && !phase && !activity.length && !agents.length) return null;
  const view = runPresentation({ phase, activity, activityTruncated, activityHadErrors, observationLimited, queued, agents, startedAt, updatedAt, busy, status }, now);
  const execution = executionPresentation(executionMode, agents);
  const { state, heading } = view;
  const hasErrors = view.hasErrors;
  return <details className={`run-panel phase-${state}${hasErrors ? ' has-errors' : ''}`}>
    <summary aria-label="작업 진행 기록 펼치기"><span className="run-panel-indicator" aria-hidden="true">{hasErrors ? '!' : state === 'completed' ? '✓' : ['failed', 'cancelled'].includes(state) ? '!' : state === 'approval' ? '◇' : '✦'}</span>
      <span className="run-panel-heading"><b role="status">{heading}</b><small>{view.detail}</small>{view.observationNotice && <small className="run-observation-notice" role="note">{view.observationNotice}</small>}</span>{view.elapsed && <time className="run-panel-time" aria-label={`경과 ${view.elapsed}`}>{view.elapsed}</time>}<span className="run-panel-chevron">⌄</span>
    </summary>
    <div className="run-panel-content">
    <p>{execution.selected} · {execution.detail}<br />{execution.observed}</p>
    {agents.length > 0 && <ol className="run-agent-list" aria-label="에이전트별 작업 진행">
      {agents.map(agent => <li key={agent.agentId} className={`run-agent ${agent.state}`}>
        <span aria-hidden="true">{agent.state === 'completed' ? '✓' : agent.state === 'failed' ? '!' : agent.state === 'cancelled' ? '−' : '·'}</span>
        <div className="run-agent-detail"><span>{agentActivityLabel(agent.label)}</span><small>{agent.model || '모델 확인 중'}</small><small>{agent.usage.promptTokens + agent.usage.completionTokens > 0 ? `입력 ${agent.usage.promptTokens.toLocaleString()} · 출력 ${agent.usage.completionTokens.toLocaleString()} 토큰` : '토큰 사용량 미보고'}</small></div>
        <small>{AGENT_STATE_LABELS[agent.state]}</small>
      </li>)}
    </ol>}
    <ol aria-label="실제 작업 기록">{activity.length ? activity.map(item => <li key={item.id} className={item.state}>
      <span aria-hidden="true">{item.state === 'done' ? '✓' : item.state === 'error' ? '!' : '·'}</span><span>{activityLabel(item.label)}</span>
      <small>{item.state === 'error' ? '오류 · ' : ''}{item.finishedAt ? `${Math.max(0, (item.finishedAt - item.startedAt) / 1000).toFixed(1)}초` : view.terminal ? '완료 미확인' : '진행 중'}</small>
    </li>) : !agents.length && <li>{view.terminal ? '도구 실행 기록이 없습니다.' : view.detail}</li>}</ol>
    <p>{view.historyNotice && `${view.historyNotice}. `}실제 실행 이벤트입니다. 응답 종료가 결과 검증을 뜻하지는 않습니다.</p>
    </div>
  </details>;
}
