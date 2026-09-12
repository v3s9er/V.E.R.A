// Manual UI regression fixture. Never connects to a PC, provider or real files.
// Production Vite build only includes index.html, not this test entry point.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import { ChatView } from '../src/views/ChatView';
import { MrRobotContext } from '../src/state';
import type { MrRobotClient } from '../src/rpc';
import type { ConversationDetail, WorkspaceInfo } from '@mr-robot/shared';
const listeners = new Map<string, Set<(data: unknown) => void>>();
const emit = (event: string, data: unknown) => listeners.get(event)?.forEach(fn => fn(data));
const projects: WorkspaceInfo[] = [{ id: 'design', name: '앱 리뉴얼', path: 'C:\\Fixture\\Design', isDefault: true, createdAt: 1 }, { id: 'docs', name: '사용 가이드', path: 'C:\\Fixture\\Docs', isDefault: false, createdAt: 2 }];
const makeChat = (id: string, workspaceId?: string): ConversationDetail => ({ id, workspaceId, title: '프로젝트 흐름 정리', status: 'active', pinned: false, createdAt: 1, updatedAt: Date.now(), messageCount: 2, reasoningEffort: 'medium', providerId: 'demo', permissionMode: 'ask', tokenPolicy: 'adaptive', compactedMessages: 0, usage: { promptTokens: 0, completionTokens: 0 }, messages: [ { role: 'user', content: '프로젝트별로 대화를 나누고 작업 진행 상황을 확인하고 싶어.' }, { role: 'assistant', content: '프로젝트에 작업 폴더를 연결하고 대화를 이어가세요.\n\n각 대화는 별도 세션을 유지합니다. 실행 기록은 입력창 위에서 펼쳐볼 수 있고, 작업 중에는 지시를 추가하거나 정지할 수 있어요.\n\n### 이번 작업\n\n- 프로젝트와 작업 폴더 연결\n- 대화별 실행 상태 복원\n- 도구 결과와 오류를 구분해서 표시' } ] });
const chats = [makeChat('chat-design', 'design'), makeChat('chat-docs', 'docs')];
let pending: { id: string; text: string; finish: (value: unknown) => void } | undefined;
let steering = 0;
const done = (cancelled = false) => {
  if (!pending) return; const run = pending; pending = undefined;
  const text = cancelled ? '테스트 작업을 중지했습니다.' : `요청을 처리했습니다.\n\n이것은 실제 AI를 호출하지 않는 UI 테스트 결과입니다. 추가 지시 ${steering}개를 유지했습니다.`;
  const conversation = chats.find(c => c.id === run.id)!;
  conversation.messages.push({ role: 'user', content: run.text }, { role: 'assistant', content: text }); conversation.messageCount = conversation.messages.length;
  emit('chat.progress', { conversationId: run.id, phase: cancelled ? 'cancelled' : 'completed', activity: [], steeringQueued: steering });
  emit('chat.done', { conversationId: run.id, text, conversation }); run.finish({ ok: true, text }); emit('conversations.changed', chats);
};
const mock = {
  isAdmin: true, permissionCap: 'full', canUseAuditOnly: true,
  on(event: string, fn: (data: unknown) => void) { const set = listeners.get(event) ?? new Set(); set.add(fn); listeners.set(event, set); return () => { set.delete(fn); }; },
  async call(method: string, params: Record<string, any> = {}): Promise<unknown> {
    if (method === 'conversations.list') return chats.filter(c => c.status === (params.status ?? 'active'));
    if (method === 'conversations.get') return structuredClone(chats.find(c => c.id === params.id));
    if (method === 'conversations.create') { const chat = makeChat(crypto.randomUUID(), params.workspaceId); chat.messages = []; chat.messageCount = 0; chat.title = '새 대화'; chats.unshift(chat); return chat; }
    if (method === 'conversations.update') { const chat = chats.find(c => c.id === params.id)!; Object.assign(chat, params); emit('conversations.changed', chats); return chat; }
    if (method === 'conversations.delete') { chats.splice(chats.findIndex(c => c.id === params.id), 1); emit('conversations.changed', chats); return { ok: true }; }
    if (method === 'workspaces.list' || method === 'projects.list') return projects;
    if (method === 'projects.create' || method === 'projects.update') { const project = method.endsWith('create') ? { id: crypto.randomUUID(), path: params.path || 'C:\\Fixture\\NewProject', createdAt: Date.now(), isDefault: false } : projects.find(p => p.id === params.id)!; Object.assign(project, { name: params.name, instructions: params.instructions }); if (method.endsWith('create')) projects.push(project as WorkspaceInfo); emit('workspaces.changed', [...projects]); return project; }
    if (method === 'projects.delete') { projects.splice(projects.findIndex(p => p.id === params.id), 1); emit('workspaces.changed', [...projects]); return { ok: true }; }
    if (method === 'providers.list') return [{ id: 'demo', label: '테스트 공급자', model: 'demo-balanced', enabled: true, isDefault: true, kind: 'openai', supportedReasoning: ['low', 'medium', 'high'] }];
    if (method === 'providers.catalog') return { models: ['demo-balanced', 'demo-fast'], state: 'fresh', source: 'provider' };
    if (method === 'routing.presets.list') return [];
    if (method === 'chat.runs') return pending ? [{ conversationId: pending.id, running: true, phase: 'working', steeringQueued: steering, partialText: '테스트 출력 복원', activity: [] }] : [];
    if (method === 'chat.pendingConfirm') return null;
    if (method === 'chat.start') return new Promise(resolve => { pending = { id: params.conversationId, text: params.text, finish: resolve }; steering = 0; setTimeout(() => { if (!pending) return; emit('chat.progress', { conversationId: pending.id, runId: 'fixture', phase: 'working', startedAt: Date.now(), activity: [{ id: 'read', label: 'read_file', state: 'done', startedAt: Date.now()-200, finishedAt: Date.now() }] }); emit('chat.tool', { conversationId: pending.id, callId: 'a', name: 'read_file', status: 'start' }); emit('chat.tool', { conversationId: pending.id, callId: 'a', name: 'read_file', status: 'done' }); }, 60); });
    if (method === 'chat.steer') { steering++; return { ok: true }; }
    if (method === 'chat.cancel') { done(true); return { ok: true }; }
    throw Error(`Unmocked method: ${method}`);
  },
};
const embedded = new URLSearchParams(location.search).has('embedded');
function Preview() {
  const [size, setSize] = React.useState([1280, 800]);
  if (!embedded) return <div style={{padding:12}}><div style={{display:'flex',gap:8,marginBottom:12,flexWrap:'wrap'}}><b>UI fixture · 실제 AI 호출 없음</b>{[[1280,800],[820,650],[390,780],[390,430]].map(s => <button key={s.join('x')} onClick={()=>setSize(s)}>{s.join(' × ')}</button>)}</div><iframe title="Mr.Robot 테스트 화면" src="/test/runtime-preview.html?embedded" style={{width:size[0],height:size[1],border:'1px solid #ffffff22',maxWidth:'none'}} /></div>;
  return <div style={{height:'100%',display:'flex',flexDirection:'column'}}><div style={{height:28,flexShrink:0,fontSize:11,padding:4,background:'#172321',display:'flex',justifyContent:'space-between'}}>테스트 화면 · PC/AI 연결 없음 <button onClick={()=>done()}>테스트 응답 완료</button></div><MrRobotContext.Provider value={{client: mock as unknown as MrRobotClient}}><ChatView /></MrRobotContext.Provider></div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Preview /></React.StrictMode>);
