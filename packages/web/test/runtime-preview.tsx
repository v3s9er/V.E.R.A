// Manual UI regression fixture. Never connects to a PC, provider or real files.
// Production Vite build only includes index.html, not this test entry point.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import { ChatView } from '../src/views/ChatView';
import { ProfileMenu } from '../src/components/ProfileMenu';
import { MrRobotContext } from '../src/state';
import type { MrRobotClient } from '../src/rpc';
import type { ConversationDetail, WorkspaceInfo } from '@mr-robot/shared';
const listeners = new Map<string, Set<(data: unknown) => void>>();
const fixtureParams = new URLSearchParams(location.search);
const rpcDelayMs = Math.min(10000, Math.max(0, Number(fixtureParams.get('rpcDelayMs')) || 0));
const cancelDelayMs = Math.min(10000, Math.max(0, Number(fixtureParams.get('cancelDelayMs')) || 0));
let runsUnavailable = fixtureParams.has('unavailableRuns');
const observedCalls: string[] = [];
const calls: Array<{ method: string; params: Record<string, any> }> = [];
const getDelays = new Map<string, number>();
let createDelayMs = 0;
(window as any).runtimeFixture = { observedCalls, calls, restoreRuns: () => { runsUnavailable = false; }, setGetDelay: (id: string, ms: number) => getDelays.set(id, ms), setCreateDelay: (ms: number) => { createDelayMs = ms; } };
let configureGate: Promise<void> | undefined;
let releaseConfigure: (() => void) | undefined;
(window as any).runtimeFixture.holdConfigure = () => { configureGate = new Promise<void>(resolve => { releaseConfigure = resolve; }); };
(window as any).runtimeFixture.releaseConfigure = () => { releaseConfigure?.(); configureGate = undefined; releaseConfigure = undefined; };
const emit = (event: string, data: unknown) => listeners.get(event)?.forEach(fn => fn(data));
const projects: WorkspaceInfo[] = [{ id: 'design', name: '앱 리뉴얼', path: 'C:\\Fixture\\Design', isDefault: true, createdAt: 1 }, { id: 'docs', name: '사용 가이드', path: 'C:\\Fixture\\Docs', isDefault: false, createdAt: 2 }];
const makeChat = (id: string, workspaceId?: string): ConversationDetail => ({ id, workspaceId, routingPresetId: fixtureParams.has('adaptiveRoute') ? 'adaptive-fixture' : undefined, title: '프로젝트 흐름 정리', status: 'active', pinned: false, createdAt: 1, updatedAt: Date.now(), messageCount: 2, reasoningEffort: 'medium', providerId: 'demo', permissionMode: 'ask', tokenPolicy: 'adaptive', compactedMessages: 0, usage: { promptTokens: 0, completionTokens: 0 }, messages: [ { role: 'user', content: '프로젝트별로 대화를 나누고 작업 진행 상황을 확인하고 싶어.' }, { role: 'assistant', content: '프로젝트에 작업 폴더를 연결하고 대화를 이어가세요.\n\n각 대화는 별도 세션을 유지합니다. 실행 기록은 입력창 위에서 펼쳐볼 수 있고, 작업 중에는 지시를 추가하거나 정지할 수 있어요.\n\n### 이번 작업\n\n- 프로젝트와 작업 폴더 연결\n- 대화별 실행 상태 복원\n- 도구 결과와 오류를 구분해서 표시' } ] });
const chats = [makeChat('chat-design', 'design'), makeChat('chat-docs', 'docs')];
if (fixtureParams.has('longHistory')) chats.push(...Array.from({ length: 60 }, (_, i) => makeChat(`history-${i}`, 'design')));
// A separate, deterministic navigation dataset leaves existing runtime tests unchanged.
if (fixtureParams.has('sidebarFixture')) {
  projects.push({ id: 'empty', name: '빈 프로젝트', path: 'C:\\Fixture\\Empty', isDefault: false, createdAt: 3 });
  chats[0].title = '처음 선택한 이전 대화'; chats[0].updatedAt = 100;
  chats[1].title = '사용 가이드 초안'; chats[1].updatedAt = 200;
  chats.push(...Array.from({ length: 20 }, (_, index) => ({
    ...makeChat(`sidebar-${index + 1}`, 'design'),
    title: `화면 검증 대화 ${String(index + 1).padStart(2, '0')}${index === 7 ? ' 아주 긴 제목으로 잘림과 가로 스크롤을 확인합니다 '.repeat(4) : ''}`,
    updatedAt: 20000 - index * 100,
    pinned: index === 19,
  })));
  chats.push(
    { ...makeChat('sidebar-unassigned'), title: '프로젝트 없는 대화', updatedAt: 300 },
    { ...makeChat('sidebar-orphan', 'removed-project'), title: '연결 해제된 프로젝트 대화', updatedAt: 250 },
    { ...makeChat('sidebar-archived', 'design'), title: '보관된 디자인 대화', status: 'archived', updatedAt: 400 },
    { ...makeChat('sidebar-discord', 'design'), title: 'Discord 지원 티켓', origin: 'discord', updatedAt: 500 },
    { ...makeChat('sidebar-discord-archived', 'design'), title: 'Discord 보관 티켓', origin: 'discord', status: 'archived', updatedAt: 450 },
  );
}
for (const chat of chats) {
  chat.messages.unshift(...Array.from({ length: 42 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `보관 기록 ${index + 1} · 화면 검증용 메시지입니다. 실제 대화가 아닙니다.` })));
  chat.messageCount = chat.messages.length;
}
const helperStates = [
  { agentId: 'review', label: '프로젝트 구조 검토', providerId: 'demo', model: 'demo-balanced', state: 'completed' as const, sequence: 3, turns: 1, status: '검토 완료', usage: { promptTokens: 1200, completionTokens: 280 } },
  { agentId: 'tests', label: '테스트 범위 확인', providerId: 'demo', model: 'demo-balanced', state: 'running' as const, sequence: 4, turns: 1, status: '프로젝트 파일 읽는 중', usage: { promptTokens: 840, completionTokens: 160 } },
];
interface PendingRun { id: string; runId: string; text: string; finish: (value: unknown) => void; steering: number; effectiveConfig: Record<string, unknown>; pendingConfig?: boolean }
let pending: PendingRun | undefined;
const pendingRuns = new Map<string, PendingRun>();
if (fixtureParams.has('sidebarFixture')) {
  pendingRuns.set('sidebar-19', { id: 'sidebar-19', runId: 'sidebar-running-fixture', text: '오래된 대화의 실행 상태 검증', finish: () => {}, steering: 0, effectiveConfig: { providerId: 'demo', providerModel: 'gpt-6-sol', permissionMode: 'ask' } });
}
(window as any).runtimeFixture.activeIds = () => [...pendingRuns.keys()];
(window as any).runtimeFixture.setObservationLimited = (hadErrors = false) => {
  if (!pending) return;
  emit('chat.status', { conversationId: pending.id, status: '도구 관측 제한 · 이 연결에서는 일부 코드 실행이 집계되지 않을 수 있습니다.' });
  emit('chat.progress', { conversationId: pending.id, observationLimited: true, activityHadErrors: hadErrors, activityTruncated: false });
  emit('chat.status', { conversationId: pending.id, status: '모델 처리 중 · FIXTURE_PRIVATE_STATUS' });
};
(window as any).runtimeFixture.setHelperState = (state: 'queued' | 'running' | 'completed') => {
  if (!pending) return;
  emit('chat.progress', { conversationId: pending.id, phase: 'working', activity: [], agents: helperStates.map(agent => ({ ...agent, state })) });
  emit('chat.status', { conversationId: pending.id, status: state === 'completed' ? '최종 검증 시작 · FIXTURE_PRIVATE_NODE' : '모델 처리 중' });
};
let steering = 0;
const done = (cancelled = false, id = pending?.id) => {
  const run = id ? pendingRuns.get(id) : undefined;
  if (!run) return; pendingRuns.delete(run.id); pending = [...pendingRuns.values()].at(-1);
  const text = cancelled ? '테스트 작업을 중지했습니다.' : `요청을 처리했습니다.\n\n이것은 실제 AI를 호출하지 않는 UI 테스트 결과입니다. 추가 지시 ${steering}개를 유지했습니다.`;
  const conversation = chats.find(c => c.id === run.id)!;
  conversation.messages.push({ role: 'user', content: run.text }, { role: 'assistant', content: text }); conversation.messageCount = conversation.messages.length;
  emit('chat.progress', { conversationId: run.id, phase: cancelled ? 'cancelled' : 'completed', activity: [], steeringQueued: steering, agents: helperStates.map(a => ({ ...a, state: cancelled ? 'cancelled' : 'completed' })) });
  emit('chat.done', { conversationId: run.id, text, conversation });
  setTimeout(() => run.finish(fixtureParams.has('lateFailure') ? { ok: false, error: 'LATE_OLD_REPLY' } : { ok: true, text }), rpcDelayMs);
  emit('conversations.changed', chats);
};
(window as any).runtimeFixture.complete = (id: string) => done(false, id);
const runSnapshot = (run: PendingRun) => ({ conversationId: run.id, runId: run.runId, running: true, phase: 'working', steeringQueued: run.steering, partialText: '테스트 출력 복원', activity: [], effectiveConfig: run.effectiveConfig, pendingConfig: run.pendingConfig });
const mock = {
  isAdmin: true, permissionCap: 'full', canUseAuditOnly: true,
  on(event: string, fn: (data: unknown) => void) { const set = listeners.get(event) ?? new Set(); set.add(fn); listeners.set(event, set); return () => { set.delete(fn); }; },
  async call(method: string, params: Record<string, any> = {}): Promise<unknown> {
    observedCalls.push(method);
    calls.push({ method, params: structuredClone(params) });
    if (method === 'conversations.list') return chats.filter(c => c.status === (params.status ?? 'active'));
    if (method === 'conversations.get') {
      const chat = chats.find(c => c.id === params.id)!;
      const end = params.before ? Number(params.before) : chat.messages.length;
      const start = Math.max(0, end - 16);
      const detail = structuredClone({ ...chat, messages: chat.messages.slice(start, end), history: { hasMore: start > 0, nextCursor: start > 0 ? String(start) : undefined, archivedTurns: chat.messages.length, missingMessages: 0 } });
      if (getDelays.get(params.id)) await new Promise(resolve => setTimeout(resolve, getDelays.get(params.id)));
      return detail;
    }
    if (method === 'conversations.create') { if (fixtureParams.has('sidebarFixture') && params.workspaceId && !projects.some(project => project.id === params.workspaceId)) throw Error('작업 폴더를 찾을 수 없습니다.'); if (createDelayMs) await new Promise(resolve => setTimeout(resolve, createDelayMs)); const chat = makeChat(crypto.randomUUID(), params.workspaceId); chat.messages = []; chat.messageCount = 0; chat.title = '새 대화'; chats.unshift(chat); return chat; }
    if (method === 'conversations.update') { const chat = chats.find(c => c.id === params.id)!; Object.assign(chat, params); emit('conversations.changed', chats); return chat; }
    if (method === 'conversations.delete') { chats.splice(chats.findIndex(c => c.id === params.id), 1); emit('conversations.changed', chats); return { ok: true }; }
    if (method === 'workspaces.list' || method === 'projects.list') return projects;
    if (method === 'projects.create' || method === 'projects.update') { const project = method.endsWith('create') ? { id: crypto.randomUUID(), path: params.path || 'C:\\Fixture\\NewProject', createdAt: Date.now(), isDefault: false } : projects.find(p => p.id === params.id)!; Object.assign(project, { name: params.name, instructions: params.instructions }); if (method.endsWith('create')) projects.push(project as WorkspaceInfo); emit('workspaces.changed', [...projects]); return project; }
    if (method === 'projects.delete') { projects.splice(projects.findIndex(p => p.id === params.id), 1); emit('workspaces.changed', [...projects]); return { ok: true }; }
    if (method === 'providers.list') return [{ id: 'demo', label: 'Codex 구독', type: 'codex-cli', model: 'gpt-6-sol', enabled: true, isDefault: true, supportedReasoning: ['auto', 'low', 'medium', 'high'] }, { id: 'claude', label: 'Claude 구독', type: 'claude-cli', model: 'claude-sonnet', enabled: true, isDefault: false, supportedReasoning: ['auto', 'high'] }];
    if (method === 'providers.catalog') return { models: params.id === 'claude' ? ['claude-sonnet', 'claude-opus'] : ['gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-daybreak-blue-latest'], state: 'fresh', source: 'provider', modelCapabilities: params.id === 'claude' ? undefined : {
      'gpt-6-sol': { supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoningEffort: 'medium' },
      'gpt-6-astra': { supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoningEffort: 'medium' },
      'gpt-6-luna': { supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'medium' },
    } };
    if (method === 'chat.recovery') return null;
    if (method === 'routing.presets.list') return fixtureParams.has('adaptiveRoute') ? [{ id: 'adaptive-fixture', name: '필요할 때 협업', mode: 'balanced', executionMode: 'adaptive', roles: {}, maxPremiumCalls: 2, escalationEnabled: false, builtin: true, createdAt: 1, updatedAt: 1 }] : [];
    if (method === 'chat.runs') { if (runsUnavailable) throw Error('temporary network loss'); return [...pendingRuns.values()].map(runSnapshot); }
    if (method === 'chat.pendingConfirm') return null;
    if (method === 'chat.configure') {
      if (configureGate) await configureGate;
      const conversation = chats.find(c => c.id === params.conversationId)!;
      let run = pendingRuns.get(conversation.id);
      if (params.apply === 'stop-current' && run) {
        if (params.expectedRunId !== run.runId) throw Error('stale run');
        done(true, run.id); run = undefined;
      }
      Object.assign(conversation, params.patch);
      if (run) run.pendingConfig = true;
      emit('conversations.changed', chats);
      return structuredClone({ conversation, application: params.apply === 'stop-current' ? 'stopped' : run ? 'pending' : 'saved', run: run ? runSnapshot(run) : undefined });
    }
    if (method === 'chat.start') return new Promise(resolve => {
      if (pendingRuns.has(params.conversationId)) throw Error('conversation already running');
      const run: PendingRun = { id: params.conversationId, runId: crypto.randomUUID(), text: params.text, finish: resolve, steering: 0, effectiveConfig: { providerId: params.providerId, providerModel: params.providerModel ?? 'gpt-6-sol', permissionMode: params.permissionMode ?? 'ask' } };
      pending = run; pendingRuns.set(run.id, run); steering = 0;
      setTimeout(() => { if (!pendingRuns.has(run.id)) return; emit('chat.progress', { ...runSnapshot(run), startedAt: Date.now(), agents: helperStates, activity: [{ id: 'read', label: 'read_file', state: 'done', startedAt: Date.now()-200, finishedAt: Date.now() }] }); emit('chat.tool', { conversationId: run.id, callId: 'a', name: 'read_file', status: 'start' }); emit('chat.tool', { conversationId: run.id, callId: 'a', name: 'read_file', status: 'done' }); }, 60);
    });
    if (method === 'chat.steer') { const run = pendingRuns.get(params.conversationId); if (run) run.steering++; steering++; return { ok: true }; }
    if (method === 'chat.cancel') { const run = pendingRuns.get(params.conversationId); setTimeout(() => { if (run && pendingRuns.get(run.id) === run) done(true, run.id); }, cancelDelayMs); return { ok: true }; }
    throw Error(`Unmocked method: ${method}`);
  },
};
const embedded = new URLSearchParams(location.search).has('embedded');
function Preview() {
  const [size, setSize] = React.useState([1280, 800]);
  if (!embedded) return <div style={{padding:12}}><div style={{display:'flex',gap:8,marginBottom:12,flexWrap:'wrap'}}><b>UI fixture · 실제 AI 호출 없음</b>{[[1280,800],[820,650],[390,780],[390,430]].map(s => <button key={s.join('x')} onClick={()=>setSize(s)}>{s.join(' × ')}</button>)}</div><iframe title="V.E.R.A 테스트 화면" src="/test/runtime-preview.html?embedded" style={{width:size[0],height:size[1],border:'1px solid #ffffff22',maxWidth:'none'}} /></div>;
  return <div style={{height:'100%',display:'flex',flexDirection:'column'}}><div style={{height:28,flexShrink:0,fontSize:11,padding:4,background:'#172321',display:'flex',justifyContent:'space-between'}}>테스트 화면 · PC/AI 연결 없음 <button onClick={()=>done()}>테스트 응답 완료</button></div><MrRobotContext.Provider value={{client: mock as unknown as MrRobotClient}}><ChatView profile={fixtureParams.has('sidebarFixture') ? <ProfileMenu standalone embedded view="chat" deviceName="검증 PC" connected pcs={[]} onChange={() => {}} onSwitchPc={() => {}} onDisconnect={() => {}} onManagePcs={() => {}} /> : undefined} /></MrRobotContext.Provider></div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Preview /></React.StrictMode>);
