import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import type { MrRobotClient } from '../rpc';
import type { ChatConfirmRequest, ConversationDetail, ConversationSummary, PermissionMode, ProviderInfo, ReasoningEffort, RoutingPreset, SavedPc, ToolEvent, WorkspaceInfo } from '../types';
import { colors, radius } from '../theme';

interface UiTool {
  key: string;
  name: string;
  summary: string;
  status: 'start' | 'done' | 'error';
}

interface UiMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tools: UiTool[];
  done: boolean;
  error?: string;
}

let uid = 1;
const nextId = (): string => `m${uid++}`;

function describe(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 70 ? `${s.slice(0, 70)}…` : s;
  } catch {
    return '';
  }
}

const baseOf = (pc: SavedPc): string => `http://${pc.activeHost ?? pc.host}:${pc.port}`;

export function ChatScreen({ client, pc }: { client: MrRobotClient; pc: SavedPc }) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<UiMsg[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [routingPresets, setRoutingPresets] = useState<RoutingPreset[]>([]);
  const [commandMode, setCommandMode] = useState<'pc' | 'scenario'>('pc');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ChatConfirmRequest | null>(null);
  const [showModels, setShowModels] = useState(false);
  const [showScenarios, setShowScenarios] = useState(false);
  const [showWorkspaces, setShowWorkspaces] = useState(false);
  const [showAccess, setShowAccess] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const toolCounter = useRef(0);
  const activeId = useRef<string | null>(null);

  const loadConversation = useCallback(async (id: string): Promise<void> => {
    const detail = await client.call('conversations.get', { id }) as ConversationDetail;
    activeId.current = id;
    setConversation(detail);
    setCommandMode(detail.routingPresetId ? 'scenario' : 'pc');
    setMessages(detail.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ id: nextId(), role: m.role as 'user' | 'assistant', content: m.content, tools: [], done: true })));
  }, [client]);

  const refreshConversations = useCallback(async (): Promise<void> => {
    const list = await client.call('conversations.list', { status: 'active' }) as ConversationSummary[];
    setConversations(list);
    if (activeId.current && list.some((c) => c.id === activeId.current)) return;
    if (list[0]) await loadConversation(list[0].id);
    else {
      const created = await client.call('conversations.create', {}) as ConversationDetail;
      setConversations([created]);
      activeId.current = created.id;
      setConversation(created);
      setMessages([]);
    }
  }, [client, loadConversation]);

  const refreshProviders = useCallback(async (): Promise<void> => {
    const list = await client.call('providers.list', {}) as ProviderInfo[];
    setProviders(list);
    const entries = await Promise.all(list.map(async (provider): Promise<[string, string[]]> => {
      try {
        const discovered = await client.call('providers.models', { id: provider.id }) as string[];
        return [provider.id, [...new Set([provider.model, ...discovered])]];
      } catch {
        return [provider.id, [provider.model]];
      }
    }));
    setProviderModels(Object.fromEntries(entries));
  }, [client]);

  useEffect(() => {
    void refreshConversations();
    void refreshProviders();
    void client.call('routing.presets.list', {}).then((value) => setRoutingPresets(value as RoutingPreset[])).catch(() => setRoutingPresets([]));
    void client.call('workspaces.list', {}).then((value) => setWorkspaces(value as WorkspaceInfo[])).catch(() => setWorkspaces([]));
  }, [client, refreshConversations, refreshProviders]);

  useEffect(() => {
    const offs = [
      client.on('chat.delta', (data) => {
        if ((data as { conversationId?: string }).conversationId !== activeId.current) return;
        const text = (data as { text: string }).text ?? '';
        setMessages((msgs) => {
          const copy = [...msgs];
          const last = copy[copy.length - 1];
          if (last && last.role === 'assistant') last.content += text;
          return copy;
        });
      }),
      client.on('chat.tool', (data) => {
        if ((data as { conversationId?: string }).conversationId !== activeId.current) return;
        const info = data as ToolEvent;
        setMessages((msgs) => {
          const copy = [...msgs];
          const last = copy[copy.length - 1];
          if (!last || last.role !== 'assistant') return copy;
          if (info.status === 'start') {
            toolCounter.current += 1;
            last.tools = [...last.tools, { key: `${info.name}#${toolCounter.current}`, name: info.name, summary: describe(info.input), status: 'start' }];
          } else {
            const idx = [...last.tools].reverse().findIndex((t) => t.name === info.name && t.status === 'start');
            if (idx >= 0) {
              const realIdx = last.tools.length - 1 - idx;
              last.tools[realIdx] = { ...last.tools[realIdx], status: info.status };
            }
          }
          return copy;
        });
      }),
      client.on('chat.done', (data) => {
        if ((data as { conversationId?: string }).conversationId !== activeId.current) return;
        const d = data as { text: string; conversation?: ConversationDetail };
        setMessages((msgs) => {
          const copy = [...msgs];
          const last = copy[copy.length - 1];
          if (last && last.role === 'assistant') {
            if (!last.content && d.text) last.content = d.text;
            last.done = true;
          }
          return copy;
        });
        setBusy(false);
        if (d.conversation) setConversation(d.conversation);
        void refreshConversations();
      }),
      client.on('chat.error', (data) => {
        if ((data as { conversationId?: string }).conversationId !== activeId.current) return;
        const d = data as { message: string };
        setMessages((msgs) => {
          const copy = [...msgs];
          const last = copy[copy.length - 1];
          if (last && last.role === 'assistant') {
            last.done = true;
            last.error = d.message;
          }
          return copy;
        });
        setBusy(false);
      }),
      client.on('chat.confirm', (data) => setConfirm(data as ChatConfirmRequest)),
      client.on('providers.changed', () => { void refreshProviders(); }),
    ];
    return () => offs.forEach((off) => off());
  }, [client, refreshConversations, refreshProviders]);

  useEffect(() => {
    const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(t);
  }, [messages]);

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || !conversation) return;
    if (busy) {
      await client.call('chat.steer', { conversationId: conversation.id, text });
      setInput('');
      return;
    }
    setInput('');
    setBusy(true);
    setMessages((msgs) => [
      ...msgs,
      { id: nextId(), role: 'user', content: text, tools: [], done: true },
      { id: nextId(), role: 'assistant', content: '', tools: [], done: false },
    ]);
    try {
      await client.call('chat.start', { text, conversationId: conversation.id, reasoningEffort: conversation.reasoningEffort, providerId: conversation.providerId, providerModel: conversation.providerModel, routingPresetId: commandMode === 'scenario' ? conversation.routingPresetId : undefined, workspaceId: conversation.workspaceId }, 10 * 60_000);
    } catch (err) {
      setMessages((msgs) => {
        const copy = [...msgs];
        const last = copy[copy.length - 1];
        if (last && last.role === 'assistant') {
          last.done = true;
          last.error = err instanceof Error ? err.message : String(err);
        }
        return copy;
      });
      setBusy(false);
    }
  };

  const respondConfirm = async (approve: boolean): Promise<void> => {
    if (!confirm) return;
    const requestId = confirm.requestId;
    setConfirm(null);
    try {
      await client.call('chat.confirmResponse', { requestId, approve });
    } catch {
      /* ignore */
    }
  };

  const createConversation = async (): Promise<void> => {
    const created = await client.call('conversations.create', {}) as ConversationDetail;
    setConversations((list) => [created, ...list]);
    activeId.current = created.id;
    setConversation(created);
    setMessages([]);
  };

  const cycleEffort = async (): Promise<void> => {
    if (!conversation || busy) return;
    const efforts: ReasoningEffort[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
    const next = efforts[(efforts.indexOf(conversation.reasoningEffort) + 1) % efforts.length];
    const updated = await client.call('conversations.update', { id: conversation.id, reasoningEffort: next }) as ConversationDetail;
    setConversation(updated);
  };

  const selectModel = async (providerId?: string, providerModel?: string): Promise<void> => {
    if (!conversation || busy) return;
    const updated = await client.call('conversations.update', {
      id: conversation.id,
      providerId: providerId ?? null,
      providerModel: providerModel ?? null,
      routingPresetId: null,
    }) as ConversationDetail;
    setConversation(updated);
    setConversations((list) => list.map((item) => item.id === updated.id ? updated : item));
    setShowModels(false);
  };

  const switchCommandMode = async (mode: 'pc' | 'scenario'): Promise<void> => {
    setCommandMode(mode);
    if (mode === 'pc' && conversation?.routingPresetId) {
      const updated = await client.call('conversations.update', { id: conversation.id, routingPresetId: null }) as ConversationDetail;
      setConversation(updated);
    }
  };

  const selectScenario = async (routingPresetId?: string): Promise<void> => {
    if (!conversation || busy) return;
    const updated = await client.call('conversations.update', { id: conversation.id, routingPresetId: routingPresetId ?? null }) as ConversationDetail;
    setConversation(updated);
    setConversations((list) => list.map((item) => item.id === updated.id ? updated : item));
    setCommandMode('scenario');
    setShowScenarios(false);
    if (!routingPresetId) setShowModels(true);
  };

  const selectWorkspace = async (workspaceId?: string): Promise<void> => {
    if (!conversation || busy) return;
    const updated = await client.call('conversations.update', { id: conversation.id, workspaceId: workspaceId ?? null }) as ConversationDetail;
    setConversation(updated); setShowWorkspaces(false);
  };

  const selectAccess = async (permissionMode: PermissionMode): Promise<void> => {
    if (!conversation || busy) return;
    const updated = await client.call('conversations.update', { id: conversation.id, permissionMode }) as ConversationDetail;
    setConversation(updated); setShowAccess(false);
  };

  const togglePin = async (target: ConversationSummary): Promise<void> => {
    if (busy) return;
    const updated = await client.call('conversations.update', { id: target.id, pinned: !target.pinned }) as ConversationDetail;
    if (conversation?.id === updated.id) setConversation(updated);
    await refreshConversations();
  };

  const attachFile = async (): Promise<void> => {
    const workspace = workspaces.find((item) => item.id === conversation?.workspaceId) ?? workspaces.find((item) => item.isDefault);
    if (!workspace || uploading) { setShowWorkspaces(true); return; }
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (picked.canceled) return;
    const file = picked.assets[0]; const relativePath = `.mr-robot-uploads/${Date.now()}-${file.name.replace(/[\\/:*?"<>|]/g, '_')}`;
    setUploading(true);
    try {
      const result = await FileSystem.uploadAsync(`${baseOf(pc)}/api/workspaces/upload?workspaceId=${encodeURIComponent(workspace.id)}&path=${encodeURIComponent(relativePath)}`, file.uri, {
        httpMethod: 'PUT', uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: { 'content-type': file.mimeType ?? 'application/octet-stream', 'x-mr-robot-token': pc.secret },
      });
      if (result.status < 200 || result.status >= 300) throw new Error(`업로드 실패 (HTTP ${result.status})`);
      setInput((value) => `${value}${value ? '\n' : ''}[첨부 파일: ${workspace.path}\\${relativePath.replaceAll('/', '\\')}]`);
    } finally { setUploading(false); }
  };

  const archiveConversation = async (): Promise<void> => {
    if (!conversation || busy) return;
    await client.call('conversations.update', { id: conversation.id, status: 'archived' });
    activeId.current = null;
    await refreshConversations();
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.modeBar}>
        <TouchableOpacity style={[styles.modeBtn, commandMode === 'pc' && styles.modeBtnOn]} onPress={() => void switchCommandMode('pc')}><Text style={[styles.modeText, commandMode === 'pc' && styles.modeTextOn]}>PC 기본 명령</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.modeBtn, commandMode === 'scenario' && styles.modeBtnOn]} onPress={() => setShowScenarios(true)}><Text style={[styles.modeText, commandMode === 'scenario' && styles.modeTextOn]}>단일·복합 트리</Text></TouchableOpacity>
      </View>
      <View style={styles.conversationBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.conversationChips}>
          <TouchableOpacity style={styles.newChat} onPress={() => void createConversation()}><Text style={styles.newChatText}>＋</Text></TouchableOpacity>
          {conversations.map((c) => (
            <TouchableOpacity key={c.id} style={[styles.conversationChip, conversation?.id === c.id && styles.conversationChipOn]} onPress={() => void loadConversation(c.id)} onLongPress={() => void togglePin(c)}>
              <Text style={styles.conversationChipText} numberOfLines={1}>{c.pinned ? '📌 ' : ''}{c.title}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <TouchableOpacity style={styles.effortBtn} onPress={() => setShowModels(true)} disabled={busy}>
          <Text style={styles.effortText} numberOfLines={1}>
            {conversation?.providerId
              ? `${providers.find((provider) => provider.id === conversation.providerId)?.label ?? '모델'} · ${conversation.providerModel ?? '기본'}`
              : '자동 모델'}
          </Text>
        </TouchableOpacity>
        {commandMode === 'scenario' && <TouchableOpacity style={styles.effortBtn} onPress={() => setShowScenarios(true)} disabled={busy}><Text style={styles.effortText} numberOfLines={1}>{routingPresets.find((preset) => preset.id === conversation?.routingPresetId)?.name ?? '단일 모델'}</Text></TouchableOpacity>}
        <TouchableOpacity style={styles.effortBtn} onPress={() => setShowWorkspaces(true)} disabled={busy}><Text style={styles.effortText} numberOfLines={1}>📁 {workspaces.find((workspace) => workspace.id === conversation?.workspaceId)?.name ?? workspaces.find((workspace) => workspace.isDefault)?.name ?? '작업 폴더'}</Text></TouchableOpacity>
        <TouchableOpacity style={styles.effortBtn} onPress={() => setShowAccess(true)} disabled={busy}><Text style={styles.effortText}>🔐 {conversation?.permissionMode === 'read-only' ? '읽기' : conversation?.permissionMode === 'workspace' ? '폴더' : conversation?.permissionMode === 'full' ? '전체' : '확인'}</Text></TouchableOpacity>
        <TouchableOpacity style={styles.effortBtn} onPress={() => void cycleEffort()}><Text style={styles.effortText}>추론 {conversation?.reasoningEffort ?? 'auto'}</Text></TouchableOpacity>
        <TouchableOpacity style={styles.effortBtn} onPress={() => conversation && void togglePin(conversation)}><Text style={styles.effortText}>{conversation?.pinned ? '📌' : '고정'}</Text></TouchableOpacity>
        <TouchableOpacity style={styles.effortBtn} onPress={() => void archiveConversation()}><Text style={styles.effortText}>보관</Text></TouchableOpacity>
      </View>
      <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {messages.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>✦</Text>
            <Text style={styles.emptyTitle}>무엇을 도와드릴까요?</Text>
            <Text style={styles.emptyText}>모바일 요청을 PC 에이전트에 위임합니다.{`\n`}파일 찾기·앱 실행·작업 수행까지.</Text>
          </View>
        )}
        {messages.map((m) => (
          <View key={m.id} style={[styles.row, m.role === 'user' && styles.rowUser]}>
            <View style={[styles.bubble, m.role === 'user' && styles.bubbleUser]}>
              {m.content ? <Text style={styles.bubbleText}>{m.content}</Text> : !m.done ? <ActivityIndicator color={colors.accent2} size="small" /> : null}
              {m.error ? <Text style={styles.errorText}>⚠️ {m.error}</Text> : null}
            </View>
            {m.tools.length > 0 && (
              <View style={styles.tools}>
                {m.tools.map((t) => (
                  <View key={t.key} style={[styles.toolChip, t.status === 'done' && styles.toolDone, t.status === 'error' && styles.toolErr]}>
                    <Text style={styles.toolText} numberOfLines={1}>
                      🔧 {t.name} {t.summary}
                    </Text>
                    <Text style={styles.toolStatus}>{t.status === 'start' ? '…' : t.status === 'done' ? '✓' : '✕'}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        ))}
      </ScrollView>

      <View style={styles.inputBar}>
        <TouchableOpacity style={styles.toolBtn} onPress={() => void attachFile()} disabled={uploading}><Text style={styles.toolBtnText}>{uploading ? '…' : '＋'}</Text></TouchableOpacity>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={busy ? '실행 중인 작업에 추가 명령…' : 'PC에 시킬 일을 입력하세요…'}
          placeholderTextColor={colors.faint}
          multiline
        />
        {busy ? (
          <View style={styles.busyActions}><TouchableOpacity style={styles.sendBtn} onPress={() => void send()} disabled={!input.trim()}><Text style={styles.sendText}>끼워넣기</Text></TouchableOpacity><TouchableOpacity style={[styles.sendBtn, styles.cancelBtn]} onPress={() => void client.call('chat.cancel', { conversationId: conversation?.id }).catch(() => undefined)}><Text style={styles.sendText}>중지</Text></TouchableOpacity></View>
        ) : (
          <TouchableOpacity style={[styles.sendBtn, !input.trim() && { opacity: 0.5 }]} onPress={() => void send()} disabled={!input.trim()}>
            <Text style={styles.sendText}>보내기</Text>
          </TouchableOpacity>
        )}
      </View>

      <Modal visible={showModels} transparent animationType="fade" onRequestClose={() => setShowModels(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>이 대화에서 사용할 모델</Text>
            <ScrollView style={styles.modelList}>
              <TouchableOpacity style={styles.modelChoice} onPress={() => void selectModel()}>
                <Text style={styles.modelProvider}>자동 라우팅</Text>
                <Text style={styles.faintChoice}>요청에 맞춰 Mr.Robot이 선택</Text>
              </TouchableOpacity>
              {providers.flatMap((provider) => (providerModels[provider.id] ?? [provider.model]).map((modelName) => (
                <TouchableOpacity key={`${provider.id}:${modelName}`} style={styles.modelChoice} onPress={() => void selectModel(provider.id, modelName)}>
                  <Text style={styles.modelProvider}>{provider.label}</Text>
                  <Text style={styles.modelName}>{modelName}</Text>
                </TouchableOpacity>
              )))}
            </ScrollView>
            <TouchableOpacity style={styles.bigBtn} onPress={() => setShowModels(false)}><Text style={styles.bigBtnText}>닫기</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={showScenarios} transparent animationType="fade" onRequestClose={() => setShowScenarios(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>모바일 실행 방식</Text>
            <Text style={styles.modalText}>단일 모델 또는 PC에 저장된 복합 트리를 이 대화에 적용합니다.</Text>
            <ScrollView style={styles.modelList}>
              <TouchableOpacity style={styles.modelChoice} onPress={() => void selectScenario()}>
                <Text style={styles.modelProvider}>단일 모델</Text><Text style={styles.faintChoice}>모델을 하나 선택해 바로 실행</Text>
              </TouchableOpacity>
              {routingPresets.map((preset) => <TouchableOpacity key={preset.id} style={styles.modelChoice} onPress={() => void selectScenario(preset.id)}>
                <Text style={styles.modelProvider}>{preset.name}</Text>
                <Text style={styles.modelName}>{preset.executionMode === 'vote' ? '의견 교환·투표' : preset.executionMode === 'pipeline' ? '순차 검증' : preset.executionMode === 'hybrid' ? '분류·회의·검증' : '단일 라우팅'} · {preset.graph?.nodes.length ?? 0}노드</Text>
                <Text style={styles.faintChoice}>{preset.description}</Text>
              </TouchableOpacity>)}
            </ScrollView>
            <TouchableOpacity style={styles.bigBtn} onPress={() => setShowScenarios(false)}><Text style={styles.bigBtnText}>닫기</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={showWorkspaces} transparent animationType="fade" onRequestClose={() => setShowWorkspaces(false)}>
        <View style={styles.modalBackdrop}><View style={styles.modal}><Text style={styles.modalTitle}>작업 폴더</Text><Text style={styles.modalText}>Codex·Claude 네이티브 에이전트와 첨부 파일이 이 폴더 안에서 작업합니다.</Text><ScrollView style={styles.modelList}><TouchableOpacity style={styles.modelChoice} onPress={() => void selectWorkspace()}><Text style={styles.modelProvider}>선택 안 함</Text></TouchableOpacity>{workspaces.map((workspace) => <TouchableOpacity key={workspace.id} style={styles.modelChoice} onPress={() => void selectWorkspace(workspace.id)}><Text style={styles.modelProvider}>{workspace.isDefault ? '기본 · ' : ''}{workspace.name}</Text><Text style={styles.faintChoice}>{workspace.path}</Text></TouchableOpacity>)}</ScrollView><TouchableOpacity style={styles.bigBtn} onPress={() => setShowWorkspaces(false)}><Text style={styles.bigBtnText}>닫기</Text></TouchableOpacity></View></View>
      </Modal>

      <Modal visible={showAccess} transparent animationType="fade" onRequestClose={() => setShowAccess(false)}>
        <View style={styles.modalBackdrop}><View style={styles.modal}><Text style={styles.modalTitle}>이 대화의 액세스</Text><Text style={styles.modalText}>Codex처럼 대화마다 저장됩니다. PC에 등록된 이 기기의 권한 상한은 넘을 수 없습니다.</Text><ScrollView style={styles.modelList}>
          {([
            ['read-only', '읽기 전용', '파일과 상태만 읽고 변경은 모두 차단'],
            ['ask', '변경 전 확인', '파일·명령 변경 직전에 모바일에서 승인'],
            ['workspace', '작업 폴더 자동', '선택한 작업 폴더 안 변경만 자동 실행'],
            ['full', '전체 허용', '이 기기 권한 상한 안에서 확인 없이 실행'],
          ] as Array<[PermissionMode, string, string]>).map(([value, label, description]) => <TouchableOpacity key={value} style={styles.modelChoice} onPress={() => void selectAccess(value)}><Text style={styles.modelProvider}>{conversation?.permissionMode === value ? '✓ ' : ''}{label}</Text><Text style={styles.faintChoice}>{description}</Text></TouchableOpacity>)}
        </ScrollView><TouchableOpacity style={styles.bigBtn} onPress={() => setShowAccess(false)}><Text style={styles.bigBtnText}>닫기</Text></TouchableOpacity></View></View>
      </Modal>

      <Modal visible={confirm !== null} transparent animationType="fade" onRequestClose={() => void respondConfirm(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>작업 승인 필요</Text>
            <Text style={styles.modalText}>AI가 다음 작업을 실행하려고 합니다.</Text>
            {confirm && (
              <View style={styles.confirmCmd}>
                <Text style={styles.confirmTool}>🔧 {confirm.tool}</Text>
                <Text style={styles.confirmSummary}>{confirm.summary}</Text>
              </View>
            )}
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.bigBtn, styles.denyBtn]} onPress={() => void respondConfirm(false)}>
                <Text style={styles.bigBtnText}>거부</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.bigBtn} onPress={() => void respondConfirm(true)}>
                <Text style={styles.bigBtnText}>허용</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  modeBar: { flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingTop: 8 },
  modeBtn: { flex: 1, alignItems: 'center', paddingVertical: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.inputBg },
  modeBtnOn: { borderColor: colors.accent, backgroundColor: 'rgba(124,92,255,0.2)' },
  modeText: { color: colors.faint, fontSize: 11.5, fontWeight: '700' },
  modeTextOn: { color: colors.text },
  conversationBar: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  conversationChips: { gap: 6, alignItems: 'center' },
  newChat: { width: 32, height: 32, borderRadius: 10, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  newChatText: { color: '#fff', fontWeight: '800', fontSize: 18 },
  conversationChip: { maxWidth: 130, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: colors.inputBg },
  conversationChipOn: { borderColor: colors.accent, backgroundColor: 'rgba(124,92,255,0.22)' },
  conversationChipText: { color: colors.dim, fontSize: 11.5, fontWeight: '600' },
  effortBtn: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 8 },
  effortText: { color: colors.dim, fontSize: 10.5, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, gap: 14 },
  empty: { alignItems: 'center', marginTop: 70 },
  emptyIcon: { fontSize: 42, color: colors.accent, textShadowColor: 'rgba(124,92,255,0.8)', textShadowRadius: 20 },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 10 },
  emptyText: { color: colors.faint, textAlign: 'center', lineHeight: 21, marginTop: 6 },
  row: { flexDirection: 'column', alignItems: 'flex-start', gap: 6 },
  rowUser: { alignItems: 'flex-end' },
  bubble: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
    maxWidth: '86%',
    minWidth: 60,
  },
  bubbleUser: { backgroundColor: 'rgba(124,92,255,0.25)', borderColor: 'rgba(124,92,255,0.45)' },
  bubbleText: { color: colors.text, fontSize: 14.5, lineHeight: 21 },
  errorText: { color: colors.err, fontSize: 12.5, marginTop: 6 },
  tools: { gap: 4, maxWidth: '92%', alignSelf: 'flex-start' },
  toolChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  toolDone: { borderColor: 'rgba(52,211,153,0.4)' },
  toolErr: { borderColor: 'rgba(248,113,113,0.4)' },
  toolText: { color: colors.dim, fontSize: 12, flexShrink: 1 },
  toolStatus: { color: colors.ok, fontSize: 12, fontWeight: '700' },
  inputBar: { flexDirection: 'row', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: colors.border, paddingBottom: 20 },
  toolBtn: { width: 40, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.inputBg },
  toolBtnText: { color: colors.text, fontSize: 17, fontWeight: '800' },
  input: {
    flex: 1,
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14.5,
    maxHeight: 110,
  },
  sendBtn: { backgroundColor: colors.accent, borderRadius: radius.md, paddingHorizontal: 16, justifyContent: 'center' },
  cancelBtn: { backgroundColor: 'rgba(248,113,113,0.25)' },
  busyActions: { flexDirection: 'row', gap: 5 },
  sendText: { color: '#fff', fontWeight: '700' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(4,6,12,0.7)', justifyContent: 'center', padding: 24 },
  modal: { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 22, gap: 12 },
  modalTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  modalText: { color: colors.dim, fontSize: 14 },
  modelList: { maxHeight: 420 },
  modelChoice: { backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, marginBottom: 8 },
  modelProvider: { color: colors.text, fontWeight: '700', fontSize: 13 },
  modelName: { color: colors.accent2, fontSize: 12.5, marginTop: 3 },
  faintChoice: { color: colors.faint, fontSize: 12, marginTop: 3 },
  confirmCmd: { backgroundColor: colors.inputBg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 12, gap: 4 },
  confirmTool: { color: '#a78bfa', fontWeight: '700', fontSize: 13 },
  confirmSummary: { color: colors.text, fontSize: 13, lineHeight: 19 },
  modalActions: { flexDirection: 'row', gap: 10 },
  bigBtn: { flex: 1, backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: 13, alignItems: 'center' },
  denyBtn: { backgroundColor: 'rgba(248,113,113,0.25)' },
  bigBtnText: { color: '#fff', fontWeight: '700' },
});
