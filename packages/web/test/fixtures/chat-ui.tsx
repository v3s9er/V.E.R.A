// Development-only visual fixture. No real credentials, network, AI or PC actions.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MrRobotContext } from '../../src/state';
import { ChatView } from '../../src/views/ChatView';
import '../../src/styles.css';
const model = 'gpt-5.6-sol';
let conversation: any = { id: 'fixture', title: '프로젝트 작업', status: 'active', updatedAt: Date.now(), messageCount: 2, permissionMode: 'ask', tokenPolicy: 'adaptive', providerId: 'p', providerModel: model, workspaceId: 'w', reasoningEffort: 'high', messages: [{ role: 'user', content: '프로젝트 구조를 정리하고 개선할 부분을 알려줘.' }, { role: 'assistant', content: '프로젝트를 확인했습니다.\n\n작업 폴더의 구조와 의존성을 먼저 확인한 뒤, 테스트와 UI 개선을 진행할 수 있어요.\n\n필요한 설정은 입력창 옆에서 바로 바꿀 수 있습니다.' }] };
const provider = { id: 'p', label: 'Codex', type: 'codex-cli', model, isDefault: true, supportedReasoning: ['auto', 'low', 'medium', 'high'] };
const pc: any = { id: 'fixture-pc', name: '내 컴퓨터', host: '127.0.0.1', port: 1 };
const client: any = {
  isAdmin: true, permissionCap: 'full', canUseAuditOnly: true,
  on: () => () => {},
  call: async (method: string, params: any = {}) => {
    if (method === 'conversations.list') return [conversation];
    if (method === 'conversations.get') return conversation;
    if (method === 'conversations.update') return conversation = { ...conversation, ...params };
    if (method === 'conversations.create') return conversation = { ...conversation, id: `fixture-${Date.now()}`, title: '새 대화', messages: [] };
    if (method === 'providers.list') return [provider];
    if (method === 'providers.models') return [model, 'gpt-5.6-terra', 'gpt-6-astra'];
    if (method === 'workspaces.list') return [{ id: 'w', name: 'Mr.Robot', path: 'fixture-workspace', isDefault: true }];
    if (method === 'routing.presets.list') return [{ id: 'preset', name: '순차 실행·검증', executionMode: 'pipeline' }];
    if (method === 'chat.start') return { ok: true, text: 'UI 테스트 응답입니다. 실제 AI는 호출하지 않았습니다.' };
    return [];
  },
};
createRoot(document.getElementById('root')!).render(<MrRobotContext.Provider value={{ client }}><ChatView activePc={pc} executionPcs={[pc]} /></MrRobotContext.Provider>);
