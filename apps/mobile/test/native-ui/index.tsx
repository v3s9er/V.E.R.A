// Separate .uitest application; never imported by App.tsx or the release entry.
import { registerRootComponent } from 'expo';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { HomeScreen } from '../../src/screens/HomeScreen';
import type { MrRobotClient } from '../../src/rpc';
import type { SavedPc } from '../../src/types';
const pc: SavedPc = { id: 'ui-test', name: 'UI test PC', host: 'example.invalid', port: 443, protocol: 'https', secret: '', addedAt: 0 };
const conversation: any = { id: 'fixture', title: 'Native keyboard audit', permissionMode: 'ask', reasoningEffort: 'auto', tokenPolicy: 'adaptive', providerId: 'fixture', providerModel: 'Test model', messages: Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `UI test message ${i + 1}. No network or AI calls.` })) };
const client = {
  authed: true, permissionCap: 'full', on: (event: string, handler: (data: unknown) => void) => {
    // Real delta/status delivery while the instrumentation repeatedly opens IME.
    const timer = event === 'chat.delta' || event === 'chat.status' ? setInterval(() => handler(event === 'chat.delta'
      ? { conversationId: 'fixture', text: '\nStreaming response after keyboard resize.\nVISIBLE_REPLY_END' }
      : { conversationId: 'fixture', status: '파일 확인 → 실행 결과 검증 중' }), 1000) : null;
    return () => { if (timer) clearInterval(timer); };
  },
  call: async (method: string, params: any = {}) => {
    if (method === 'conversations.list') return [conversation];
    if (method === 'conversations.get' || method === 'conversations.create') return conversation;
    if (method === 'conversations.update') { Object.assign(conversation, params); return { ...conversation }; }
    if (method === 'providers.list') return [{ id: 'fixture', name: 'Fixture', model: 'Test model', isDefault: true, supportedReasoning: ['auto', 'low', 'high'] }];
    if (method === 'providers.models') return ['Test model'];
    if (method === 'chat.pendingConfirm') return null;
    if (method === 'chat.runs') return process.env.EXPO_PUBLIC_MR_ROBOT_UI_BUSY === '1' ? [{ conversationId: 'fixture', running: true, steeringQueued: 0, status: 'Fixture task in progress' }] : [];
    if (['routing.presets.list', 'workspaces.list'].includes(method)) return [];
    throw new Error(`UI fixture refuses unexpected RPC: ${method}`);
  },
} as unknown as MrRobotClient;
function NativeUiAudit() {
  return <SafeAreaProvider initialMetrics={initialWindowMetrics}><HomeScreen client={client} pc={pc} pcs={[pc]} connectionState="connected" onRetryConnection={() => {}} onSelectPc={() => {}} onManagePcs={() => {}} /></SafeAreaProvider>;
}
registerRootComponent(NativeUiAudit);
