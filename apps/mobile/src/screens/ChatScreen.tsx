import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import type { MrRobotClient } from '../rpc';
import type { ChatConfirmRequest, ChatRunState, ConversationDetail, ConversationSummary, PermissionMode, ProviderInfo, ReasoningEffort, RoutingPreset, SavedPc, ToolEvent, WorkspaceInfo } from '../types';
import { colors, radius } from '../theme';
import { httpBaseForPc, pcAuthenticatedHeaders } from '../pcs';

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
const appendPendingAttempt = (items: UiMsg[], text: string): UiMsg[] => {
  const assistant = items[items.length - 1];
  const user = items[items.length - 2];
  const retryingFailedTail = assistant?.role === 'assistant'
    && Boolean(assistant.error)
    && user?.role === 'user'
    && user.content === text;
  const base = retryingFailedTail ? items.slice(0, -2) : items;
  return [
    ...base,
    { id: nextId(), role: 'user', content: text, tools: [], done: true },
    { id: nextId(), role: 'assistant', content: '', tools: [], done: false },
  ];
};

const ORDERED_REASONING_EFFORTS: readonly ReasoningEffort[] = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];
const FALLBACK_REASONING_EFFORTS: readonly ReasoningEffort[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];

function reasoningEffortsFor(provider?: ProviderInfo): ReasoningEffort[] {
  const supported = provider?.supportedReasoning;
  if (!supported?.length) return [...FALLBACK_REASONING_EFFORTS];
  const supportedSet = new Set(supported);
  return ORDERED_REASONING_EFFORTS.filter((effort) => effort === 'auto' || supportedSet.has(effort));
}

function describe(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 70 ? `${s.slice(0, 70)}…` : s;
  } catch {
    return '';
  }
}

export function ChatScreen({ client, pc, keyboardVisible = false, onExecutionBusyChange }: { client: MrRobotClient; pc: SavedPc; keyboardVisible?: boolean; onExecutionBusyChange?: (busy: boolean) => void }) {
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const compact = width < 390 || fontScale > 1.25;
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<UiMsg[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [routingPresets, setRoutingPresets] = useState<RoutingPreset[]>([]);
  const [commandMode, setCommandMode] = useState<'pc' | 'scenario'>('pc');
  const [input, setInput] = useState('');
  const [runs, setRuns] = useState<Record<string, ChatRunState & { cancelling?: boolean }>>({});
  const [confirm, setConfirm] = useState<ChatConfirmRequest | null>(null);
  const [showModels, setShowModels] = useState(false);
  const [customProviderId, setCustomProviderId] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [showScenarios, setShowScenarios] = useState(false);
  const [showWorkspaces, setShowWorkspaces] = useState(false);
  const [showAccess, setShowAccess] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [savingReasoning, setSavingReasoning] = useState(false);
  const [savingConfiguration, setSavingConfiguration] = useState(false);
  const [reasoningSaveFailed, setReasoningSaveFailed] = useState(false);
  const [configurationSaveFailed, setConfigurationSaveFailed] = useState(false);
  const configurationSaveInFlightRef = useRef(false);
  const conversationRef = useRef<ConversationDetail | null>(null);
  const uploadTaskRef = useRef<FileSystem.UploadTask | null>(null);
  const uploadStopReason = useRef<'user' | 'timeout' | null>(null);
  const mountedRef = useRef(true);
  const listRef = useRef<FlatList<UiMsg>>(null);
  const toolCounter = useRef(0);
  const activeId = useRef<string | null>(null);
  const loadGeneration = useRef(0);
  const pendingDelta = useRef('');
  const deltaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const startingConversationRef = useRef<string | null>(null);
  const stickToBottom = useRef(true);
  const [unseenMessages, setUnseenMessages] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    // Keep async upload state usable when StrictMode performs its development
    // setup/cleanup/setup cycle.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      uploadStopReason.current = 'user';
      void uploadTaskRef.current?.cancelAsync().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    conversationRef.current = conversation;
  }, [conversation]);

  const activeRun = conversation ? runs[conversation.id] : undefined;
  const busy = Boolean(activeRun?.running);
  useEffect(() => {
    if (busy) onExecutionBusyChange?.(true);
  }, [busy, onExecutionBusyChange]);
  const defaultProvider = providers.find((provider) => provider.isDefault) ?? providers[0];
  const reasoningProvider = conversation?.routingPresetId
    ? undefined
    : providers.find((provider) => provider.id === conversation?.providerId) ?? defaultProvider;
  const reasoningEfforts = reasoningEffortsFor(reasoningProvider);
  const selectedReasoningEffort = conversation && reasoningEfforts.includes(conversation.reasoningEffort)
    ? conversation.reasoningEffort
    : 'auto';
  const reasoningLocked = !conversation || busy || savingConfiguration;
  const configurationLocked = busy || savingConfiguration;

  const beginConfigurationSave = (): boolean => {
    if (configurationSaveInFlightRef.current) return false;
    configurationSaveInFlightRef.current = true;
    setSavingConfiguration(true);
    setConfigurationSaveFailed(false);
    return true;
  };

  const finishConfigurationSave = (): void => {
    configurationSaveInFlightRef.current = false;
    if (mountedRef.current) setSavingConfiguration(false);
  };

  const applyConversationConfiguration = (id: string, patch: Partial<Pick<ConversationDetail,
    'reasoningEffort' | 'providerId' | 'providerModel' | 'routingPresetId' | 'workspaceId' | 'permissionMode'
  >>): void => {
    if (conversationRef.current?.id === id) conversationRef.current = { ...conversationRef.current, ...patch };
    setConversation((current) => current?.id === id ? { ...current, ...patch } : current);
    setConversations((list) => list.map((item) => item.id === id ? { ...item, ...patch } : item));
  };

  const loadConversation = useCallback(async (id: string): Promise<void> => {
    if (configurationSaveInFlightRef.current) return;
    const generation = ++loadGeneration.current;
    activeId.current = id;
    setReasoningSaveFailed(false);
    setConfigurationSaveFailed(false);
    pendingDelta.current = '';
    if (deltaTimer.current) clearTimeout(deltaTimer.current);
    deltaTimer.current = null;
    const [detail, runList] = await Promise.all([
      client.call('conversations.get', { id }) as Promise<ConversationDetail>,
      client.call('chat.runs', {}, 5000).catch(() => []) as Promise<ChatRunState[]>,
    ]);
    if (generation !== loadGeneration.current) return;
    const active = runList.find((run) => run.conversationId === id);
    const pendingConfirm = active
      ? await client.call('chat.pendingConfirm', { conversationId: id }, 5000).catch(() => null) as ChatConfirmRequest | null
      : null;
    if (generation !== loadGeneration.current) return;
    setRuns((current) => ({ ...current, ...Object.fromEntries(runList.map((run) => [run.conversationId, run])) }));
    if (pendingConfirm) setConfirm(pendingConfirm);
    setConversation(detail);
    setCommandMode(detail.routingPresetId ? 'scenario' : 'pc');
    const restored = detail.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ id: nextId(), role: m.role as 'user' | 'assistant', content: m.content, tools: [], done: true }));
    setMessages(active?.running
      ? [...restored, { id: nextId(), role: 'assistant', content: '', tools: [], done: false }]
      : restored);
    stickToBottom.current = true;
    setUnseenMessages(false);
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
      setReasoningSaveFailed(false);
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

  const refreshRuns = useCallback(async (): Promise<void> => {
    try {
      const list = await client.call('chat.runs', {}, 5000) as ChatRunState[];
      const confirmations = await Promise.all(list.map((run) => (
        client.call('chat.pendingConfirm', { conversationId: run.conversationId }, 5000)
          .catch(() => null) as Promise<ChatConfirmRequest | null>
      )));
      setRuns(Object.fromEntries(list.map((run) => [run.conversationId, run])));
      const restored = confirmations.find((item): item is ChatConfirmRequest => item !== null);
      setConfirm((current) => restored ?? (current && list.some((run) => run.conversationId === current.conversationId) ? current : null));
    } catch {
      /* 연결 복구 중에는 다음 성공 시 다시 조정한다. */
    }
  }, [client]);

  const refreshInitialData = useCallback(async (): Promise<void> => {
    setInitialLoading(true);
    setLoadError('');
    try {
      await Promise.all([
        refreshConversations(),
        refreshProviders(),
        client.call('routing.presets.list', {}).then((value) => setRoutingPresets(value as RoutingPreset[])).catch(() => setRoutingPresets([])),
        client.call('workspaces.list', {}).then((value) => setWorkspaces(value as WorkspaceInfo[])).catch(() => setWorkspaces([])),
        refreshRuns(),
      ]);
    } catch (error) {
      if (mountedRef.current) setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setInitialLoading(false);
    }
  }, [client, refreshConversations, refreshProviders, refreshRuns]);

  useEffect(() => {
    void refreshInitialData();
  }, [pc.id, refreshInitialData]);

  useEffect(() => {
    if (!keyboardVisible || !stickToBottom.current) return;
    const timer = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), Platform.OS === 'ios' ? 280 : 80);
    return () => clearTimeout(timer);
  }, [keyboardVisible]);

  useEffect(() => {
    const scrollIfFollowing = (): void => {
      if (!stickToBottom.current) { setUnseenMessages(true); return; }
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
    };
    const flushDelta = (): void => {
      if (deltaTimer.current) clearTimeout(deltaTimer.current);
      deltaTimer.current = null;
      const text = pendingDelta.current;
      pendingDelta.current = '';
      if (!text) return;
      setMessages((items) => {
        const last = items[items.length - 1];
        if (!last || last.role !== 'assistant' || last.done) return [...items, { id: nextId(), role: 'assistant', content: text, tools: [], done: false }];
        return [...items.slice(0, -1), { ...last, content: last.content + text }];
      });
      scrollIfFollowing();
    };
    const setRunFinished = (conversationId: string): void => {
      const cancelTimer = cancelTimers.current.get(conversationId);
      if (cancelTimer) clearTimeout(cancelTimer);
      cancelTimers.current.delete(conversationId);
      setRuns((current) => ({
        ...current,
        [conversationId]: { ...(current[conversationId] ?? { conversationId, steeringQueued: 0 }), running: false, cancelling: false, status: '' },
      }));
    };
    const offs = [
      client.on('chat.delta', (data) => {
        if ((data as { conversationId?: string }).conversationId !== activeId.current) return;
        pendingDelta.current += (data as { text: string }).text ?? '';
        if (!deltaTimer.current) deltaTimer.current = setTimeout(flushDelta, 50);
      }),
      client.on('chat.tool', (data) => {
        if ((data as { conversationId?: string }).conversationId !== activeId.current) return;
        const info = data as ToolEvent;
        flushDelta();
        setMessages((items) => {
          const last = items[items.length - 1];
          if (!last || last.role !== 'assistant') return items;
          let tools = last.tools;
          if (info.status === 'start') {
            toolCounter.current += 1;
            tools = [...tools, { key: `${info.name}#${toolCounter.current}`, name: info.name, summary: describe(info.input), status: 'start' }];
          } else {
            const idx = [...tools].reverse().findIndex((tool) => tool.name === info.name && tool.status === 'start');
            if (idx >= 0) {
              const realIdx = tools.length - 1 - idx;
              tools = tools.map((tool, index) => index === realIdx ? { ...tool, status: info.status } : tool);
            }
          }
          return [...items.slice(0, -1), { ...last, tools }];
        });
        scrollIfFollowing();
      }),
      client.on('chat.status', (data) => {
        const event = data as { conversationId?: string; status?: string };
        if (!event.conversationId) return;
        if (startingConversationRef.current === event.conversationId) startingConversationRef.current = null;
        setRuns((current) => ({
          ...current,
          [event.conversationId!]: { ...(current[event.conversationId!] ?? { conversationId: event.conversationId!, steeringQueued: 0 }), running: true, status: event.status ?? '' },
        }));
      }),
      client.on('chat.done', (data) => {
        const d = data as { conversationId?: string; text: string; conversation?: ConversationDetail };
        if (startingConversationRef.current === d.conversationId) startingConversationRef.current = null;
        if (d.conversationId) setRunFinished(d.conversationId);
        if (d.conversationId !== activeId.current) { void refreshConversations(); return; }
        flushDelta();
        if (d.conversation) {
          setConversation(d.conversation);
          const restored = d.conversation.messages.filter((message) => message.role === 'user' || message.role === 'assistant').map((message) => ({ id: nextId(), role: message.role as 'user' | 'assistant', content: message.content, tools: [], done: true }));
          setMessages(restored.length ? restored : [{ id: nextId(), role: 'assistant', content: d.text || '', tools: [], done: true }]);
        } else {
          setMessages((items) => {
            const last = items[items.length - 1];
            if (!last || last.role !== 'assistant' || last.done) return [...items, { id: nextId(), role: 'assistant', content: d.text || '', tools: [], done: true }];
            return [...items.slice(0, -1), { ...last, content: last.content || d.text || '', done: true }];
          });
        }
        void refreshConversations();
        scrollIfFollowing();
      }),
      client.on('chat.error', (data) => {
        const d = data as { conversationId?: string; message: string };
        if (startingConversationRef.current === d.conversationId) startingConversationRef.current = null;
        if (d.conversationId) setRunFinished(d.conversationId);
        if (d.conversationId !== activeId.current) return;
        flushDelta();
        setMessages((items) => {
          const last = items[items.length - 1];
          if (!last || last.role !== 'assistant') return items;
          return [...items.slice(0, -1), { ...last, done: true, error: d.message }];
        });
      }),
      client.on('chat.confirm', (data) => setConfirm(data as ChatConfirmRequest)),
      client.on('providers.changed', () => { void refreshProviders(); }),
    ];
    return () => {
      offs.forEach((off) => off());
      if (deltaTimer.current) clearTimeout(deltaTimer.current);
      deltaTimer.current = null;
      pendingDelta.current = '';
      for (const timer of cancelTimers.current.values()) clearTimeout(timer);
      cancelTimers.current.clear();
    };
  }, [client, refreshConversations, refreshProviders]);

  const send = async (): Promise<void> => {
    const text = input.trim();
    const currentConversation = conversationRef.current;
    if (!text || !currentConversation || configurationSaveInFlightRef.current) return;
    if (startingConversationRef.current === currentConversation.id) return;
    if (busy) {
      try {
        const result = await client.call('chat.steer', { conversationId: currentConversation.id, text }) as { queued?: number };
        setRuns((current) => ({ ...current, [currentConversation.id]: { ...current[currentConversation.id], conversationId: currentConversation.id, running: true, steeringQueued: result.queued ?? current[currentConversation.id]?.steeringQueued ?? 0, status: '추가 명령 전달됨' } }));
        setInput('');
      } catch (error) {
        setMessages((items) => [...items, { id: nextId(), role: 'assistant', content: '', tools: [], done: true, error: error instanceof Error ? error.message : String(error) }]);
      }
      return;
    }
    startingConversationRef.current = currentConversation.id;
    setInput('');
    setRuns((current) => ({ ...current, [currentConversation.id]: { conversationId: currentConversation.id, running: true, steeringQueued: 0, status: '시작 중' } }));
    stickToBottom.current = true;
    setUnseenMessages(false);
    setMessages((items) => appendPendingAttempt(items, text));
    try {
      await client.call('chat.start', { text, conversationId: currentConversation.id, reasoningEffort: currentConversation.reasoningEffort, providerId: currentConversation.providerId, providerModel: currentConversation.providerModel, routingPresetId: commandMode === 'scenario' ? currentConversation.routingPresetId : undefined, workspaceId: currentConversation.workspaceId, permissionMode: currentConversation.permissionMode }, 10 * 60_000);
    } catch (err) {
      setMessages((msgs) => {
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant') {
          return [...msgs.slice(0, -1), { ...last, done: true, error: err instanceof Error ? err.message : String(err) }];
        }
        return msgs;
      });
      setRuns((current) => ({ ...current, [currentConversation.id]: { ...current[currentConversation.id], conversationId: currentConversation.id, running: false, cancelling: false, steeringQueued: 0, status: '' } }));
    } finally {
      if (startingConversationRef.current === currentConversation.id) startingConversationRef.current = null;
      void refreshRuns();
    }
  };

  const respondConfirm = async (approve: boolean): Promise<void> => {
    if (!confirm) return;
    const { requestId, conversationId } = confirm;
    setConfirm(null);
    try {
      await client.call('chat.confirmResponse', { requestId, conversationId, approve });
    } catch {
      /* ignore */
    }
  };

  const createConversation = async (): Promise<void> => {
    if (configurationSaveInFlightRef.current) return;
    const created = await client.call('conversations.create', {}) as ConversationDetail;
    setConversations((list) => [created, ...list]);
    activeId.current = created.id;
    setConversation(created);
    setReasoningSaveFailed(false);
    setConfigurationSaveFailed(false);
    setMessages([]);
  };

  const selectReasoningEffort = async (reasoningEffort: ReasoningEffort): Promise<void> => {
    const currentConversation = conversationRef.current;
    if (!currentConversation || busy || !reasoningEfforts.includes(reasoningEffort) || currentConversation.reasoningEffort === reasoningEffort || !beginConfigurationSave()) return;
    const conversationId = currentConversation.id;
    const previousReasoningEffort = currentConversation.reasoningEffort;
    setSavingReasoning(true);
    setReasoningSaveFailed(false);
    conversationRef.current = { ...currentConversation, reasoningEffort };
    setConversation((current) => current?.id === conversationId ? { ...current, reasoningEffort } : current);
    setConversations((list) => list.map((item) => item.id === conversationId ? { ...item, reasoningEffort } : item));
    try {
      const updated = await client.call('conversations.update', { id: conversationId, reasoningEffort }) as ConversationDetail;
      if (!mountedRef.current) return;
      if (activeId.current === conversationId) {
        if (conversationRef.current?.id === conversationId) conversationRef.current = { ...conversationRef.current, reasoningEffort: updated.reasoningEffort };
        setConversation((current) => current?.id === conversationId ? { ...current, reasoningEffort: updated.reasoningEffort } : current);
      }
      setConversations((list) => list.map((item) => item.id === conversationId ? { ...item, reasoningEffort: updated.reasoningEffort } : item));
    } catch {
      if (!mountedRef.current) return;
      if (activeId.current === conversationId) {
        if (conversationRef.current?.id === conversationId && conversationRef.current.reasoningEffort === reasoningEffort) {
          conversationRef.current = { ...conversationRef.current, reasoningEffort: previousReasoningEffort };
        }
        setConversation((current) => current?.id === conversationId && current.reasoningEffort === reasoningEffort
          ? { ...current, reasoningEffort: previousReasoningEffort }
          : current);
        setReasoningSaveFailed(true);
        setConfigurationSaveFailed(true);
      }
      setConversations((list) => list.map((item) => item.id === conversationId && item.reasoningEffort === reasoningEffort
        ? { ...item, reasoningEffort: previousReasoningEffort }
        : item));
    } finally {
      if (mountedRef.current) setSavingReasoning(false);
      finishConfigurationSave();
    }
  };

  const openModelPicker = (): void => {
    if (configurationSaveInFlightRef.current) return;
    const selectedProvider = providers.find((provider) => provider.id === conversation?.providerId)
      ?? providers.find((provider) => provider.isDefault)
      ?? providers[0];
    setCustomProviderId(selectedProvider?.id ?? '');
    setCustomModel(conversation?.providerModel ?? selectedProvider?.model ?? '');
    setShowModels(true);
  };

  const selectModel = async (providerId?: string, providerModel?: string): Promise<void> => {
    if (!conversation || busy || !beginConfigurationSave()) return;
    const conversationId = conversation.id;
    const provider = providerId ? providers.find((item) => item.id === providerId) : defaultProvider;
    const supportedEfforts = reasoningEffortsFor(provider);
    const reasoningEffort = supportedEfforts.includes(conversation.reasoningEffort) ? conversation.reasoningEffort : 'auto';
    try {
      const updated = await client.call('conversations.update', {
        id: conversationId,
        providerId: providerId ?? null,
        providerModel: providerModel ?? null,
        routingPresetId: null,
        reasoningEffort,
      }) as ConversationDetail;
      applyConversationConfiguration(conversationId, {
        providerId: updated.providerId,
        providerModel: updated.providerModel,
        routingPresetId: updated.routingPresetId,
        reasoningEffort: updated.reasoningEffort,
      });
      setReasoningSaveFailed(false);
      setCommandMode(providerId ? 'scenario' : 'pc');
      setShowModels(false);
      setShowScenarios(false);
    } catch {
      if (mountedRef.current) setConfigurationSaveFailed(true);
    } finally {
      finishConfigurationSave();
    }
  };

  const switchCommandMode = async (mode: 'pc' | 'scenario'): Promise<void> => {
    if (!conversation || busy || configurationSaveInFlightRef.current) return;
    if (mode !== 'pc' || !conversation.routingPresetId) { setCommandMode(mode); return; }
    if (!beginConfigurationSave()) return;
    const conversationId = conversation.id;
    const provider = providers.find((item) => item.id === conversation.providerId) ?? defaultProvider;
    const reasoningEffort = reasoningEffortsFor(provider).includes(conversation.reasoningEffort) ? conversation.reasoningEffort : 'auto';
    try {
      const updated = await client.call('conversations.update', { id: conversationId, routingPresetId: null, reasoningEffort }) as ConversationDetail;
      applyConversationConfiguration(conversationId, {
        routingPresetId: updated.routingPresetId,
        reasoningEffort: updated.reasoningEffort,
      });
      setReasoningSaveFailed(false);
      setCommandMode(mode);
    } catch {
      if (mountedRef.current) setConfigurationSaveFailed(true);
    } finally {
      finishConfigurationSave();
    }
  };

  const selectScenario = async (routingPresetId?: string): Promise<void> => {
    if (!conversation || busy || !beginConfigurationSave()) return;
    const conversationId = conversation.id;
    const provider = providers.find((item) => item.id === conversation.providerId) ?? defaultProvider;
    const supportedEfforts = reasoningEffortsFor(routingPresetId ? undefined : provider);
    const reasoningEffort = supportedEfforts.includes(conversation.reasoningEffort) ? conversation.reasoningEffort : 'auto';
    try {
      const updated = await client.call('conversations.update', { id: conversationId, routingPresetId: routingPresetId ?? null, reasoningEffort }) as ConversationDetail;
      applyConversationConfiguration(conversationId, {
        routingPresetId: updated.routingPresetId,
        reasoningEffort: updated.reasoningEffort,
      });
      setCommandMode('scenario');
      setReasoningSaveFailed(false);
      setShowScenarios(false);
      if (!routingPresetId) setShowModels(true);
    } catch {
      if (mountedRef.current) setConfigurationSaveFailed(true);
    } finally {
      finishConfigurationSave();
    }
  };

  const selectWorkspace = async (workspaceId?: string): Promise<void> => {
    if (!conversation || busy || !beginConfigurationSave()) return;
    const conversationId = conversation.id;
    try {
      const updated = await client.call('conversations.update', { id: conversationId, workspaceId: workspaceId ?? null }) as ConversationDetail;
      applyConversationConfiguration(conversationId, { workspaceId: updated.workspaceId });
      setShowWorkspaces(false);
    } catch {
      if (mountedRef.current) setConfigurationSaveFailed(true);
    } finally {
      finishConfigurationSave();
    }
  };

  const selectAccess = async (permissionMode: PermissionMode): Promise<void> => {
    if (!conversation || busy || !beginConfigurationSave()) return;
    const conversationId = conversation.id;
    try {
      const updated = await client.call('conversations.update', { id: conversationId, permissionMode }) as ConversationDetail;
      applyConversationConfiguration(conversationId, { permissionMode: updated.permissionMode });
      setShowAccess(false);
    } catch {
      if (mountedRef.current) setConfigurationSaveFailed(true);
    } finally {
      finishConfigurationSave();
    }
  };

  const togglePin = async (target: ConversationSummary): Promise<void> => {
    if (busy || configurationSaveInFlightRef.current) return;
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
    uploadStopReason.current = null;
    const uploadUrl = `${httpBaseForPc(pc)}/api/workspaces/upload?workspaceId=${encodeURIComponent(workspace.id)}&path=${encodeURIComponent(relativePath)}`;
    const task = FileSystem.createUploadTask(uploadUrl, file.uri, {
      httpMethod: 'PUT', uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: pcAuthenticatedHeaders(pc, uploadUrl, { 'content-type': file.mimeType ?? 'application/octet-stream' }),
    });
    uploadTaskRef.current = task;
    const timeout = setTimeout(() => {
      if (uploadTaskRef.current !== task) return;
      uploadStopReason.current = 'timeout';
      void task.cancelAsync().catch(() => undefined);
    }, 120_000);
    try {
      const result = await task.uploadAsync();
      if (!result) throw new Error(uploadStopReason.current === 'timeout' ? '파일 업로드 시간이 초과되었습니다.' : '파일 업로드를 중지했습니다.');
      if (result.status < 200 || result.status >= 300) throw new Error(`업로드 실패 (HTTP ${result.status})`);
      if (mountedRef.current) setInput((value) => `${value}${value ? '\n' : ''}[첨부 파일: ${workspace.path}\\${relativePath.replaceAll('/', '\\')}]`);
    } catch (error) {
      if (mountedRef.current) setMessages((items) => [...items, { id: nextId(), role: 'assistant', content: '', tools: [], done: true, error: uploadStopReason.current === 'user' ? '파일 업로드를 중지했습니다.' : uploadStopReason.current === 'timeout' ? '파일 업로드 시간이 초과되었습니다.' : error instanceof Error ? error.message : String(error) }]);
    } finally {
      clearTimeout(timeout);
      if (uploadTaskRef.current === task) uploadTaskRef.current = null;
      uploadStopReason.current = null;
      if (mountedRef.current) setUploading(false);
    }
  };

  const cancelAttachment = async (): Promise<void> => {
    const task = uploadTaskRef.current;
    if (!task) return;
    uploadStopReason.current = 'user';
    await task.cancelAsync().catch(() => undefined);
  };

  const archiveConversation = async (): Promise<void> => {
    if (!conversation || busy || configurationSaveInFlightRef.current) return;
    await client.call('conversations.update', { id: conversation.id, status: 'archived' });
    activeId.current = null;
    await refreshConversations();
  };

  const cancelRun = async (): Promise<void> => {
    if (!conversation || !busy || activeRun?.cancelling) return;
    const conversationId = conversation.id;
    setRuns((current) => ({ ...current, [conversationId]: { ...current[conversationId], conversationId, running: true, cancelling: true, steeringQueued: current[conversationId]?.steeringQueued ?? 0, status: '중지 요청 중…' } }));
    try {
      await client.call('chat.cancel', { conversationId }, 8000);
      const previous = cancelTimers.current.get(conversationId);
      if (previous) clearTimeout(previous);
      cancelTimers.current.set(conversationId, setTimeout(() => {
        cancelTimers.current.delete(conversationId);
        void client.call('chat.runs', {}, 5000).then((value) => {
          const currentRuns = value as ChatRunState[];
          const stillRunning = currentRuns.find((run) => run.conversationId === conversationId);
          setRuns((current) => ({
            ...Object.fromEntries(currentRuns.map((run) => [run.conversationId, run])),
            ...(!stillRunning ? { [conversationId]: { ...current[conversationId], conversationId, running: false, cancelling: false, steeringQueued: 0, status: '중지됨' } } : {}),
          }));
          if (!stillRunning && activeId.current === conversationId) {
            setMessages((items) => {
              const last = items[items.length - 1];
              if (!last || last.role !== 'assistant' || last.done) return items;
              return [...items.slice(0, -1), { ...last, done: true, error: '사용자가 작업을 중지했습니다.' }];
            });
          }
        }).catch(() => refreshRuns());
      }, 2500));
    } catch (error) {
      setRuns((current) => ({ ...current, [conversationId]: { ...current[conversationId], conversationId, running: true, cancelling: false, steeringQueued: current[conversationId]?.steeringQueued ?? 0, status: '중지 요청 실패' } }));
      setMessages((items) => [...items, { id: nextId(), role: 'assistant', content: '', tools: [], done: true, error: error instanceof Error ? error.message : String(error) }]);
    }
  };

  const onMessageScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const following = contentSize.height - contentOffset.y - layoutMeasurement.height < 96;
    stickToBottom.current = following;
    if (following && unseenMessages) setUnseenMessages(false);
  };

  const jumpToLatest = (): void => {
    stickToBottom.current = true;
    setUnseenMessages(false);
    listRef.current?.scrollToEnd({ animated: true });
  };

  const singleModelChoices = (includeAutomatic: boolean) => (
    <>
      {includeAutomatic && <TouchableOpacity style={[styles.modelChoice, savingConfiguration && styles.disabledBtn]} disabled={savingConfiguration} onPress={() => void selectModel()}>
        <Text style={styles.modelProvider}>{!conversation?.providerId ? '✓ ' : ''}자동 라우팅</Text>
        <Text style={styles.faintChoice}>PC의 기본 라우팅이 요청에 맞는 모델을 선택</Text>
      </TouchableOpacity>}
      {providers.flatMap((provider) => (providerModels[provider.id] ?? [provider.model]).map((modelName) => {
        const selected = conversation?.providerId === provider.id && conversation.providerModel === modelName && !conversation.routingPresetId;
        return <TouchableOpacity key={`${provider.id}:${modelName}`} style={[styles.modelChoice, selected && styles.modelChoiceOn, savingConfiguration && styles.disabledBtn]} disabled={savingConfiguration} onPress={() => void selectModel(provider.id, modelName)}>
          <Text style={styles.modelProvider}>{selected ? '✓ ' : ''}{provider.label}</Text>
          <Text style={styles.modelName}>{modelName}</Text>
        </TouchableOpacity>;
      }))}
      {providers.length === 0 && <Text style={styles.modalText}>PC에 등록된 모델 공급자가 없습니다. PC 앱의 설정 → 모델에서 먼저 공급자를 추가하세요.</Text>}
      {providers.length > 0 && <View style={styles.customModelBox}>
        <Text style={styles.modelProvider}>모델 ID 직접 지정</Text>
        <Text style={styles.faintChoice}>목록에 없는 모델도 공급자를 고른 뒤 정확한 모델 ID를 입력할 수 있습니다.</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.customProviderList} keyboardShouldPersistTaps="handled">
          {providers.map((provider) => <TouchableOpacity key={provider.id} style={[styles.customProviderChip, customProviderId === provider.id && styles.customProviderChipOn, savingConfiguration && styles.disabledBtn]} disabled={savingConfiguration} onPress={() => { setCustomProviderId(provider.id); setCustomModel(provider.model); }}>
            <Text style={styles.customProviderText}>{provider.label}</Text>
          </TouchableOpacity>)}
        </ScrollView>
        <TextInput
          style={styles.customModelInput}
          value={customModel}
          onChangeText={setCustomModel}
          placeholder="예: gpt-5.6-terra"
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!savingConfiguration}
          returnKeyType="done"
          onSubmitEditing={() => { if (customProviderId && customModel.trim()) void selectModel(customProviderId, customModel.trim()); }}
        />
        <TouchableOpacity style={[styles.bigBtn, (!customProviderId || !customModel.trim() || savingConfiguration) && styles.disabledBtn]} disabled={!customProviderId || !customModel.trim() || savingConfiguration} onPress={() => void selectModel(customProviderId, customModel.trim())}>
          <Text style={styles.bigBtnText}>이 모델 사용</Text>
        </TouchableOpacity>
      </View>}
    </>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0}>
      {!keyboardVisible && <View style={styles.modeBar}>
        <TouchableOpacity style={[styles.modeBtn, commandMode === 'pc' && styles.modeBtnOn, configurationLocked && styles.disabledBtn]} disabled={configurationLocked} onPress={() => void switchCommandMode('pc')}><Text style={[styles.modeText, commandMode === 'pc' && styles.modeTextOn]}>PC 기본 명령</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.modeBtn, commandMode === 'scenario' && styles.modeBtnOn, configurationLocked && styles.disabledBtn]} disabled={configurationLocked} onPress={() => setShowScenarios(true)}><Text style={[styles.modeText, commandMode === 'scenario' && styles.modeTextOn]}>단일·복합 트리</Text></TouchableOpacity>
      </View>}
      {!keyboardVisible && <ScrollView horizontal style={styles.conversationBar} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.conversationBarContent} keyboardShouldPersistTaps="handled">
          <TouchableOpacity style={[styles.newChat, savingConfiguration && styles.disabledBtn]} disabled={savingConfiguration} onPress={() => void createConversation()}><Text style={styles.newChatText}>＋</Text></TouchableOpacity>
          {conversations.map((c) => (
            <TouchableOpacity key={c.id} style={[styles.conversationChip, conversation?.id === c.id && styles.conversationChipOn, savingConfiguration && styles.disabledBtn]} disabled={savingConfiguration} onPress={() => void loadConversation(c.id)} onLongPress={() => void togglePin(c)}>
              <Text style={styles.conversationChipText} numberOfLines={1}>{c.pinned ? '📌 ' : ''}{c.title}</Text>
            </TouchableOpacity>
          ))}
      </ScrollView>}
      {!keyboardVisible && <ScrollView horizontal style={styles.controlBar} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.controlBarContent} keyboardShouldPersistTaps="handled">
        <TouchableOpacity style={[styles.effortBtn, !conversation?.routingPresetId && conversation?.providerId && styles.effortBtnOn, configurationLocked && styles.disabledBtn]} onPress={openModelPicker} disabled={configurationLocked}>
          <Text style={styles.effortText} numberOfLines={1}>
            {conversation?.providerId
              ? `🤖 단일 모델 · ${providers.find((provider) => provider.id === conversation.providerId)?.label ?? '모델'} · ${conversation.providerModel ?? '기본'}`
              : '🤖 단일 모델 선택'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.effortBtn, conversation?.routingPresetId && styles.effortBtnOn, configurationLocked && styles.disabledBtn]} onPress={() => setShowScenarios(true)} disabled={configurationLocked}><Text style={styles.effortText} numberOfLines={1}>🧩 {routingPresets.find((preset) => preset.id === conversation?.routingPresetId)?.name ?? '복합 트리 선택'}</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.effortBtn, configurationLocked && styles.disabledBtn]} onPress={() => setShowWorkspaces(true)} disabled={configurationLocked}><Text style={styles.effortText} numberOfLines={1}>📁 {workspaces.find((workspace) => workspace.id === conversation?.workspaceId)?.name ?? workspaces.find((workspace) => workspace.isDefault)?.name ?? '작업 폴더'}</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.effortBtn, configurationLocked && styles.disabledBtn]} onPress={() => setShowAccess(true)} disabled={configurationLocked}><Text style={styles.effortText}>🔐 {conversation?.permissionMode === 'read-only' ? '읽기' : conversation?.permissionMode === 'workspace' ? '폴더' : conversation?.permissionMode === 'full' ? '전체' : '확인'}</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.effortBtn, configurationLocked && styles.disabledBtn]} disabled={configurationLocked} onPress={() => conversation && void togglePin(conversation)}><Text style={styles.effortText}>{conversation?.pinned ? '📌' : '고정'}</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.effortBtn, configurationLocked && styles.disabledBtn]} disabled={configurationLocked} onPress={() => void archiveConversation()}><Text style={styles.effortText}>보관</Text></TouchableOpacity>
      </ScrollView>}
      {loadError ? <View style={styles.loadError} accessibilityLiveRegion="assertive"><View style={styles.loadErrorCopy}><Text style={styles.loadErrorTitle}>대화 정보를 불러오지 못했습니다</Text><Text style={styles.loadErrorText} numberOfLines={2}>{loadError}</Text></View><TouchableOpacity style={styles.loadRetryBtn} onPress={() => void refreshInitialData()} accessibilityRole="button" accessibilityLabel="대화 다시 불러오기"><Text style={styles.loadRetryText}>재시도</Text></TouchableOpacity></View> : null}
      <FlatList
        ref={listRef}
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, messages.length === 0 && styles.emptyContent]}
        data={messages}
        keyExtractor={(message) => message.id}
        initialNumToRender={18}
        maxToRenderPerBatch={12}
        windowSize={9}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        onScroll={onMessageScroll}
        scrollEventThrottle={80}
        onLayout={() => { if (stickToBottom.current) requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false })); }}
        onContentSizeChange={() => { if (stickToBottom.current) listRef.current?.scrollToEnd({ animated: false }); }}
        ListEmptyComponent={(
          <View style={styles.empty}>
            {initialLoading ? <ActivityIndicator color={colors.accent2} accessibilityLabel="대화 불러오는 중" /> : <Text style={styles.emptyIcon}>✦</Text>}
            <Text style={styles.emptyTitle}>{initialLoading ? '대화를 불러오는 중…' : '무엇을 도와드릴까요?'}</Text>
            {!initialLoading && <Text style={styles.emptyText}>모바일 요청을 PC 에이전트에 위임합니다.{`\n`}파일 찾기·앱 실행·작업 수행까지.</Text>}
          </View>
        )}
        renderItem={({ item: m }) => (
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
        )}
      />

      {unseenMessages && <TouchableOpacity style={styles.latestBtn} onPress={jumpToLatest}><Text style={styles.latestText}>새 응답 보기 ↓</Text></TouchableOpacity>}
      {busy && activeRun?.status ? <View style={styles.runStatus}><ActivityIndicator color={colors.accent2} size="small" /><Text style={styles.runStatusText}>{activeRun.status}{activeRun.steeringQueued ? ` · 추가 명령 ${activeRun.steeringQueued}개` : ''}</Text></View> : null}
      <View style={[styles.inputBar, compact && styles.inputBarCompact, { paddingBottom: keyboardVisible ? 6 : Math.max(10, insets.bottom) }]}>
        <View style={styles.inputRow}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={uploading ? '파일 업로드 취소' : '파일 첨부'} accessibilityState={{ busy: uploading }} style={[styles.toolBtn, uploading && styles.toolBtnCancel]} onPress={() => uploading ? void cancelAttachment() : void attachFile()}><Text style={styles.toolBtnText}>{uploading ? '×' : '＋'}</Text></TouchableOpacity>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder={busy ? '실행 중인 작업에 추가 명령…' : 'PC에 시킬 일을 입력하세요…'}
            placeholderTextColor={colors.faint}
            multiline
            textAlignVertical="top"
            accessibilityLabel="PC 에이전트에게 보낼 명령"
          />
          {!busy && (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="명령 보내기" accessibilityState={{ disabled: !input.trim() || savingConfiguration }} style={[styles.sendBtn, (!input.trim() || savingConfiguration) && { opacity: 0.5 }]} onPress={() => void send()} disabled={!input.trim() || savingConfiguration}>
              <Text style={styles.sendText}>{savingConfiguration ? '저장 중…' : '보내기'}</Text>
            </TouchableOpacity>
          )}
        </View>
        {busy && <View style={styles.busyActions}><TouchableOpacity accessibilityRole="button" accessibilityLabel="실행 중인 작업에 추가 명령 끼워넣기" accessibilityState={{ disabled: !input.trim() || savingConfiguration }} style={[styles.sendBtn, styles.busyActionBtn, (!input.trim() || savingConfiguration) && styles.disabledBtn]} onPress={() => void send()} disabled={!input.trim() || savingConfiguration}><Text style={styles.sendText}>추가 명령 끼워넣기</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" accessibilityLabel="실행 중인 작업 중지" accessibilityState={{ busy: Boolean(activeRun?.cancelling), disabled: Boolean(activeRun?.cancelling) }} style={[styles.sendBtn, styles.busyActionBtn, styles.cancelBtn, activeRun?.cancelling && { opacity: 0.55 }]} onPress={() => void cancelRun()} disabled={activeRun?.cancelling}><Text style={styles.sendText}>{activeRun?.cancelling ? '중지 중…' : '작업 중지'}</Text></TouchableOpacity></View>}
        {!keyboardVisible && <View style={[styles.reasoningBar, compact && styles.reasoningBarCompact]}>
          <Text style={[styles.reasoningLabel, (reasoningSaveFailed || configurationSaveFailed) && styles.reasoningLabelError]}>{configurationSaveFailed ? '설정 · 저장 실패' : savingReasoning ? '추론 · 저장 중' : savingConfiguration ? '설정 저장 중' : busy ? '추론 · 실행 중 잠김' : '추론'}</Text>
          <ScrollView horizontal style={styles.reasoningScroll} contentContainerStyle={styles.reasoningChoices} showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always">
            {reasoningEfforts.map((effort) => {
              const selected = selectedReasoningEffort === effort;
              return <TouchableOpacity
                key={effort}
                accessibilityRole="button"
                accessibilityLabel={`추론 강도 ${effort}`}
                accessibilityState={{ selected, disabled: reasoningLocked }}
                style={[styles.reasoningChip, selected && styles.reasoningChipOn, reasoningLocked && styles.reasoningChipDisabled]}
                disabled={reasoningLocked}
                onPress={() => void selectReasoningEffort(effort)}
              ><Text style={[styles.reasoningChipText, selected && styles.reasoningChipTextOn]}>{effort}</Text></TouchableOpacity>;
            })}
          </ScrollView>
        </View>}
      </View>

      <Modal visible={showModels} transparent animationType="fade" onRequestClose={() => setShowModels(false)} accessibilityViewIsModal>
        <KeyboardAvoidingView style={styles.modalKeyboardAvoiding} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0}>
          <View style={[styles.modalBackdrop, { paddingTop: Math.max(12, insets.top), paddingBottom: Math.max(12, insets.bottom), paddingLeft: Math.max(12, insets.left + 8), paddingRight: Math.max(12, insets.right + 8) }]}>
            <View style={styles.modal}>
              <Text style={styles.modalTitle}>이 대화에서 사용할 모델</Text>
              <ScrollView style={styles.modelList} keyboardShouldPersistTaps="handled">
                {singleModelChoices(true)}
              </ScrollView>
              <TouchableOpacity style={styles.bigBtn} onPress={() => setShowModels(false)}><Text style={styles.bigBtnText}>닫기</Text></TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={showScenarios} transparent animationType="fade" onRequestClose={() => setShowScenarios(false)} accessibilityViewIsModal>
        <KeyboardAvoidingView style={styles.modalKeyboardAvoiding} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0}>
          <View style={[styles.modalBackdrop, { paddingTop: Math.max(12, insets.top), paddingBottom: Math.max(12, insets.bottom), paddingLeft: Math.max(12, insets.left + 8), paddingRight: Math.max(12, insets.right + 8) }]}>
            <View style={styles.modal}>
              <Text style={styles.modalTitle}>모바일 실행 방식</Text>
              <Text style={styles.modalText}>단일 모델 또는 PC에 저장된 복합 트리를 이 대화에 적용합니다.</Text>
              <ScrollView style={styles.modelList} keyboardShouldPersistTaps="handled">
                <Text style={styles.modelSectionTitle}>단일 모델</Text>
                {singleModelChoices(true)}
                <Text style={styles.modelSectionTitle}>복합 트리</Text>
                {routingPresets.map((preset) => <TouchableOpacity key={preset.id} style={[styles.modelChoice, savingConfiguration && styles.disabledBtn]} disabled={savingConfiguration} onPress={() => void selectScenario(preset.id)}>
                  <Text style={styles.modelProvider}>{preset.name}</Text>
                  <Text style={styles.modelName}>{preset.executionMode === 'vote' ? '의견 교환·투표' : preset.executionMode === 'pipeline' ? '순차 검증' : preset.executionMode === 'hybrid' ? '분류·회의·검증' : '단일 라우팅'} · {preset.graph?.nodes.length ?? 0}노드</Text>
                  <Text style={styles.faintChoice}>{preset.description}</Text>
                </TouchableOpacity>)}
              </ScrollView>
              <TouchableOpacity style={styles.bigBtn} onPress={() => setShowScenarios(false)}><Text style={styles.bigBtnText}>닫기</Text></TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={showWorkspaces} transparent animationType="fade" onRequestClose={() => setShowWorkspaces(false)} accessibilityViewIsModal>
        <View style={[styles.modalBackdrop, { paddingTop: Math.max(12, insets.top), paddingBottom: Math.max(12, insets.bottom), paddingLeft: Math.max(12, insets.left + 8), paddingRight: Math.max(12, insets.right + 8) }]}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>작업 폴더</Text>
            <Text style={styles.modalText}>Codex·Claude 네이티브 에이전트와 첨부 파일이 이 폴더 안에서 작업합니다.</Text>
            <ScrollView style={styles.modelList} keyboardShouldPersistTaps="handled">
              <TouchableOpacity style={[styles.modelChoice, savingConfiguration && styles.disabledBtn]} disabled={savingConfiguration} onPress={() => void selectWorkspace()}><Text style={styles.modelProvider}>선택 안 함</Text></TouchableOpacity>
              {workspaces.map((workspace) => <TouchableOpacity key={workspace.id} style={[styles.modelChoice, savingConfiguration && styles.disabledBtn]} disabled={savingConfiguration} onPress={() => void selectWorkspace(workspace.id)}><Text style={styles.modelProvider}>{workspace.isDefault ? '기본 · ' : ''}{workspace.name}</Text><Text style={styles.faintChoice}>{workspace.path}</Text></TouchableOpacity>)}
            </ScrollView>
            <TouchableOpacity style={styles.bigBtn} onPress={() => setShowWorkspaces(false)} accessibilityRole="button"><Text style={styles.bigBtnText}>닫기</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={showAccess} transparent animationType="fade" onRequestClose={() => setShowAccess(false)} accessibilityViewIsModal>
        <View style={[styles.modalBackdrop, { paddingTop: Math.max(12, insets.top), paddingBottom: Math.max(12, insets.bottom), paddingLeft: Math.max(12, insets.left + 8), paddingRight: Math.max(12, insets.right + 8) }]}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>이 대화의 액세스</Text>
            <Text style={styles.modalText}>Codex처럼 대화마다 저장됩니다. PC에 등록된 이 기기의 권한 상한은 넘을 수 없습니다.</Text>
            <ScrollView style={styles.modelList} keyboardShouldPersistTaps="handled">
              {([
                ['read-only', '읽기 전용', '파일과 상태만 읽고 변경은 모두 차단'],
                ['ask', '변경 전 확인', '파일·명령 변경 직전에 모바일에서 승인'],
                ['workspace', '작업 폴더 자동', '선택한 작업 폴더 안 변경만 자동 실행'],
                ['full', '전체 허용', '이 기기 권한 상한 안에서 확인 없이 실행'],
              ] as Array<[PermissionMode, string, string]>).map(([value, label, description]) => <TouchableOpacity key={value} style={[styles.modelChoice, savingConfiguration && styles.disabledBtn]} disabled={savingConfiguration} onPress={() => void selectAccess(value)}><Text style={styles.modelProvider}>{conversation?.permissionMode === value ? '✓ ' : ''}{label}</Text><Text style={styles.faintChoice}>{description}</Text></TouchableOpacity>)}
            </ScrollView>
            <TouchableOpacity style={styles.bigBtn} onPress={() => setShowAccess(false)} accessibilityRole="button"><Text style={styles.bigBtnText}>닫기</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={confirm !== null} transparent animationType="fade" onRequestClose={() => void respondConfirm(false)} accessibilityViewIsModal>
        <View style={[styles.modalBackdrop, { paddingTop: Math.max(12, insets.top), paddingBottom: Math.max(12, insets.bottom), paddingLeft: Math.max(12, insets.left + 8), paddingRight: Math.max(12, insets.right + 8) }]}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>작업 승인 필요</Text>
            <Text style={styles.modalText}>{confirm?.conversationId === activeId.current ? `현재 대화 ‘${confirm?.conversationTitle}’의 요청입니다.` : `백그라운드 대화 ‘${confirm?.conversationTitle ?? '알 수 없는 대화'}’의 요청입니다. 현재 보고 있는 대화와 다릅니다.`}</Text>
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
                <Text style={styles.bigBtnText}>이 대화 허용</Text>
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
  modeBtn: { flex: 1, minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingVertical: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.inputBg },
  modeBtnOn: { borderColor: colors.accent, backgroundColor: 'rgba(124,92,255,0.2)' },
  modeText: { color: colors.faint, fontSize: 11.5, fontWeight: '700' },
  modeTextOn: { color: colors.text },
  conversationBar: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: colors.border },
  conversationBarContent: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 8 },
  controlBar: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: 'rgba(124,92,255,.04)' },
  controlBarContent: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7 },
  loadError: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: 'rgba(248,113,113,.3)', backgroundColor: 'rgba(248,113,113,.09)' },
  loadErrorCopy: { flex: 1, minWidth: 0 },
  loadErrorTitle: { color: colors.err, fontSize: 12.5, fontWeight: '800' },
  loadErrorText: { color: colors.dim, fontSize: 10.5, lineHeight: 15, marginTop: 2 },
  loadRetryBtn: { minHeight: 40, justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(248,113,113,.4)', borderRadius: radius.sm, paddingHorizontal: 12 },
  loadRetryText: { color: colors.err, fontSize: 12, fontWeight: '800' },
  newChat: { width: 40, height: 40, borderRadius: 10, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  newChatText: { color: '#fff', fontWeight: '800', fontSize: 18 },
  conversationChip: { minHeight: 40, justifyContent: 'center', maxWidth: 150, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: colors.inputBg },
  conversationChipOn: { borderColor: colors.accent, backgroundColor: 'rgba(124,92,255,0.22)' },
  conversationChipText: { color: colors.dim, fontSize: 11.5, fontWeight: '600' },
  effortBtn: { minHeight: 40, justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.inputBg, paddingHorizontal: 9, paddingVertical: 8, maxWidth: 240 },
  effortBtnOn: { borderColor: colors.accent, backgroundColor: 'rgba(124,92,255,0.16)' },
  effortText: { color: colors.dim, fontSize: 10.5, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, gap: 14 },
  emptyContent: { flexGrow: 1 },
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
  latestBtn: { alignSelf: 'center', marginVertical: 6, borderWidth: 1, borderColor: 'rgba(34,211,238,.45)', backgroundColor: 'rgba(34,211,238,.12)', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
  latestText: { color: colors.accent2, fontSize: 11.5, fontWeight: '800' },
  runStatus: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 7, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: 'rgba(34,211,238,.05)' },
  runStatusText: { flex: 1, color: colors.dim, fontSize: 11.5 },
  inputBar: { gap: 7, padding: 12, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bg },
  inputBarCompact: { paddingHorizontal: 8, paddingTop: 8 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  toolBtn: { width: 44, minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.inputBg },
  toolBtnCancel: { borderColor: 'rgba(248,113,113,.5)', backgroundColor: 'rgba(248,113,113,.16)' },
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
    minHeight: 44,
    maxHeight: 110,
  },
  sendBtn: { minHeight: 44, backgroundColor: colors.accent, borderRadius: radius.md, paddingHorizontal: 16, justifyContent: 'center', alignItems: 'center' },
  cancelBtn: { backgroundColor: 'rgba(248,113,113,0.25)' },
  busyActions: { flexDirection: 'row', gap: 7 },
  busyActionBtn: { flex: 1 },
  sendText: { color: '#fff', fontWeight: '700' },
  reasoningBar: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: 7 },
  reasoningBarCompact: { alignItems: 'flex-start' },
  reasoningLabel: { color: colors.faint, fontSize: 10.5, fontWeight: '800', flexShrink: 0 },
  reasoningLabelError: { color: colors.err },
  reasoningScroll: { flex: 1 },
  reasoningChoices: { alignItems: 'center', gap: 5, paddingRight: 4 },
  reasoningChip: { minHeight: 26, justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: 999, backgroundColor: colors.inputBg, paddingHorizontal: 9, paddingVertical: 4 },
  reasoningChipOn: { borderColor: colors.accent, backgroundColor: 'rgba(124,92,255,0.22)' },
  reasoningChipDisabled: { opacity: 0.5 },
  reasoningChipText: { color: colors.dim, fontSize: 10.5, fontWeight: '700' },
  reasoningChipTextOn: { color: colors.text },
  modalKeyboardAvoiding: { flex: 1 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(4,6,12,0.7)', justifyContent: 'center', paddingHorizontal: 12 },
  modal: { width: '100%', maxWidth: 560, maxHeight: '92%', alignSelf: 'center', backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 18, gap: 12 },
  modalTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  modalText: { color: colors.dim, fontSize: 14 },
  modelList: { maxHeight: 420, flexShrink: 1, minHeight: 0 },
  modelChoice: { backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, marginBottom: 8 },
  modelChoiceOn: { borderColor: colors.accent, backgroundColor: 'rgba(124,92,255,0.16)' },
  modelProvider: { color: colors.text, fontWeight: '700', fontSize: 13 },
  modelName: { color: colors.accent2, fontSize: 12.5, marginTop: 3 },
  faintChoice: { color: colors.faint, fontSize: 12, marginTop: 3 },
  modelSectionTitle: { color: colors.accent2, fontSize: 12, fontWeight: '800', marginTop: 4, marginBottom: 8, letterSpacing: 0.4 },
  customModelBox: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, marginTop: 4, marginBottom: 8, gap: 9, backgroundColor: 'rgba(255,255,255,.025)' },
  customProviderList: { flexDirection: 'row', gap: 6, paddingVertical: 2 },
  customProviderChip: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: colors.inputBg },
  customProviderChipOn: { borderColor: colors.accent, backgroundColor: 'rgba(124,92,255,0.18)' },
  customProviderText: { color: colors.dim, fontSize: 11.5, fontWeight: '700' },
  customModelInput: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.inputBg, color: colors.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13 },
  disabledBtn: { opacity: 0.5 },
  confirmCmd: { backgroundColor: colors.inputBg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 12, gap: 4 },
  confirmTool: { color: '#a78bfa', fontWeight: '700', fontSize: 13 },
  confirmSummary: { color: colors.text, fontSize: 13, lineHeight: 19 },
  modalActions: { flexDirection: 'row', gap: 10 },
  bigBtn: { flex: 1, minHeight: 44, justifyContent: 'center', backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: 13, alignItems: 'center' },
  denyBtn: { backgroundColor: 'rgba(248,113,113,0.25)' },
  bigBtnText: { color: '#fff', fontWeight: '700' },
});
