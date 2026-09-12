import { useEffect, useState } from 'react';
import './RunActivityPanel.css';
import type { ChatRunActivity, ChatRunPhase } from '@mr-robot/shared';

const LABELS: Record<ChatRunPhase, string> = {
  starting: '요청 준비', working: '도구로 작업 중', answering: '답변 작성 중', approval: '승인이 필요해요',
  cancelling: '작업을 안전하게 중지하는 중', completed: '작업 완료', failed: '확인이 필요한 오류', cancelled: '작업 중지됨',
};
const TOOLS: Record<string, string> = { read_file: '파일 읽기', list_files: '폴더 확인', shell_exec: '명령 실행',
  write_file: '파일 수정', native_agent: '네이티브 에이전트', screenshot: '화면 확인', mouse_click: '화면 조작',
  'orca.computer.observe': '앱 화면 읽기', 'orca.computer.act': '앱 조작',
  desktop_open_browser: '브라우저 열기', desktop_windows: '앱 창 확인', desktop_observe: '화면 읽기', desktop_act: '화면 조작' };
export function RunActivityPanel({ phase, activity = [], startedAt, busy, fallback }: {
  phase?: ChatRunPhase; activity?: ChatRunActivity[]; startedAt?: number; busy: boolean; fallback?: string;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!busy) return; setNow(Date.now()); const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [busy]);
  if (!busy && !phase && !activity.length) return null;
  const state = phase ?? (busy ? 'working' : 'completed');
  const hasErrors = state === 'completed' && activity.some(item => item.state === 'error');
  const heading = hasErrors ? '응답 완료 · 실행 오류 확인' : LABELS[state];
  const elapsed = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const count = activity.filter(item => item.state === 'done').length;
  return <details className={`run-panel phase-${state}${hasErrors ? ' has-errors' : ''}`}>
    <summary><span className="run-panel-indicator" aria-hidden="true">{hasErrors ? '!' : state === 'completed' ? '✓' : ['failed', 'cancelled'].includes(state) ? '!' : state === 'approval' ? '◇' : '✦'}</span>
      <span className="run-panel-heading"><b role="status">{heading}</b><small>{activity.length ? `도구 ${count}/${activity.length} 완료` : fallback || '진행 상태를 확인하고 있습니다'}{startedAt ? ` · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}` : ''}</small></span><span className="run-panel-chevron">⌄</span>
    </summary>
    <ol aria-label="실제 작업 기록">{activity.length ? activity.map(item => <li key={item.id} className={item.state}>
      <span aria-hidden="true">{item.state === 'done' ? '✓' : item.state === 'error' ? '!' : '·'}</span><span>{TOOLS[item.label] ?? item.label}</span>
      <small>{item.finishedAt ? `${Math.max(0, (item.finishedAt - item.startedAt) / 1000).toFixed(1)}초` : '진행 중'}</small>
    </li>) : <li>{fallback || '아직 도구 실행 기록이 없습니다.'}</li>}</ol>
    <p>실제 실행 이벤트만 표시합니다. 모델 내부 추론은 표시하지 않습니다.</p>
  </details>;
}
