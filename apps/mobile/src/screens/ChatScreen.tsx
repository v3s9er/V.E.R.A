import { uploadSecureFile } from '../secureFiles';
import { ChatFiles } from '../components/ChatFiles';
import { RunActivity } from '../components/RunActivity';
import { RunTimeline } from '../components/RunTimeline';
import { ToolHistory } from '../components/ToolHistory';
import { terminalRunUpdate } from '../../../../packages/shared/src/run-presentation';
import { ProjectPicker } from '../components/ProjectPicker';
import { chatFileDisplayText } from '../../../../packages/shared/src/chat-files';
import { resolveProjectWorkspace } from '../../../../packages/shared/src/projects';
import { supportsDaybreak, visibleModelChoices } from '../../../../packages/shared/src/daybreak';
import { watchChatSettlement, ChatRequestOwnership } from '../../../../packages/shared/src/chat-lifecycle';
import { reasoningEffortsForModel } from '../../../../packages/shared/src/model-capabilities';
import type { ProviderModelCatalog } from '../../../../packages/shared/src/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
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
import type { KeyboardEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import type { MrRobotClient } from '../rpc';
import type { ChatConfirmRequest, ChatRunState, ConversationDetail, ConversationSummary, ConversationTokenPolicy, PermissionMode, ProviderInfo, ReasoningEffort, RoutingPreset, SavedPc, ToolEvent, WorkspaceInfo } from '../types';
import { colors, radius } from '../theme';
import { httpBaseForPc, pcAuthenticatedHeaders } from '../pcs';
const QUESTION_LABELS: Record<ConversationTokenPolicy, string> = { adaptive: '자동', economy: '절약 6.4만', standard: '표준 25.6만', quality: '고품질 100만', 'audit-only': '무제한' };

interface UiTool {
  callId?: string;
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

const PERMISSION_ORDER: readonly PermissionMode[] = ['read-only', 'ask', 'workspace', 'full'];

function permissionWithinCap(mode: PermissionMode, cap: PermissionMode): boolean {
  return PERMISSION_ORDER.indexOf(mode) <= PERMISSION_ORDER.indexOf(cap);
}

function effectivePermissionMode(mode: PermissionMode, cap: PermissionMode): PermissionMode {
  return PERMISSION_ORDER[Math.min(PERMISSION_ORDER.indexOf(mode), PERMISSION_ORDER.indexOf(cap))] ?? 'read-only';
}

const reasoningEffortsFor = reasoningEffortsForModel;

function describe(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 70 ? `${s.slice(0, 70)}…` : s;
  } catch {
    return '';
  }
}

export function ChatScreen({ client, pc, keyboardVisible = false, onExecutionBusyChange, onSelectExecutionPc }: { client: MrRobotClient; pc: SavedPc; keyboardVisible?: boolean; onExecutionBusyChange?: (busy: boolean) => void; onSelectExecutionPc?: () => void }) {
  const insets = useSafeAreaInsets();
  const { width, height, fontScale } = useWindowDimensions();
  const compact = width < 390 || fontScale > 1.25;
  const shortKeyboardViewport = keyboardVisible && width > height;
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<UiMsg[]>([]);
  const [historyPage, setHistoryPage] = useState<{ id: string; info: ConversationDetail['history'] } | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const historyLoad = useRef<object | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [modelRefreshStatus, setModelRefreshStatus] = useState('');
  const modelRefreshInFlight = useRef(false);
  const [routingPresets, setRoutingPresets] = useState<RoutingPreset[]>([]);
  const [commandMode, setCommandMode] = useState<'pc' | 'scenario'>('pc');
  const [input, setInput] = useState('');
  const inputRef = useRef(input); inputRef.current = input;
  const drafts = useRef(new Map<string, string>());
  const [runs, setRuns] = useState<Record<string, ChatRunState & { cancelling?: boolean }>>({});
  const [confirm, setConfirm] = useState<ChatConfirmRequest | null>(null);
  const [showModels, setShowModels] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [modelProviderFilter, setModelProviderFilter] = useState('');
  const [customModelExpanded, setCustomModelExpanded] = useState(false);
  const [customProviderId, setCustomProviderId] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [showScenarios, setShowScenarios] = useState(false);
  const [showWorkspaces, setShowWorkspaces] = useState(false);
  const [showAccess, setShowAccess] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [showTokenPolicy, setShowTokenPolicy] = useState(false);
  const [showChatOptions, setShowChatOptions] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [projectScope, setProjectScope] = useState('*');
  const [showProjects, setShowProjects] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [savingReasoning, setSavingReasoning] = useState(false);
  const [savingConfiguration, setSavingConfiguration] = useState(false);
  const [reasoningSaveFailed, setReasoningSaveFailed] = useState(false);
  const [configurationSaveFailed, setConfigurationSaveFailed] = useState(false);
  const [permissionNotice, setPermissionNotice] = useState('');
  const configurationSaveInFlightRef = useRef(false);
  const conversationRef = useRef<ConversationDetail | null>(null);
  const uploadTaskRef = useRef<{ cancelAsync(): Promise<void> } | null>(null);
  const uploadStopReason = useRef<'user' | 'timeout' | null>(null);
  const mountedRef = useRef(true);
  const listRef = useRef<FlatList<UiMsg>>(null);
  const composerRef = useRef<View>(null);
  const keyboardTopRef = useRef<number | null>(null);
  const composerKeyboardLiftRef = useRef(0);
  const composerSyncTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const toolCounter = useRef(0);
  const activeId = useRef<string | null>(null);
  const loadGeneration = useRef(0);
  const pendingDelta = useRef('');
  const deltaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancellationWatches = useRef(new Map<string, AbortController>());
  const requestOwnership = useRef(new ChatRequestOwnership());
  const startingConversationRef = useRef<string | null>(null);
  const stickToBottom = useRef(true);
  const draggingMessages = useRef(false);
  const [activity, setActivity] = useState<string[]>([]);
  const [unseenMessages, setUnseenMessages] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [composerKeyboardLift, setComposerKeyboardLift] = useState(0);

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

  const applyComposerKeyboardLift = useCallback((next: number): void => {
    const normalized = Math.max(0, Math.round(next));
    composerKeyboardLiftRef.current = normalized;
    setComposerKeyboardLift((current) => current === normalized ? current : normalized);
  }, []);

  const syncComposerWithKeyboard = useCallback((): void => {
    if (Platform.OS === 'ios') {
      // KeyboardAvoidingView follows the interactive iOS keyboard frame. The
      // measured fallback is only for Android keyboards that overlay resize.
      applyComposerKeyboardLift(0);
      if (stickToBottom.current) listRef.current?.scrollToOffset({ offset: 0, animated: false });
      return;
    }
    const metrics = Keyboard.metrics();
    const keyboardTop = metrics?.screenY ?? keyboardTopRef.current ?? null;
    if (keyboardTop !== null) keyboardTopRef.current = keyboardTop;
    if (keyboardTop === null) {
      applyComposerKeyboardLift(0);
      return;
    }
    requestAnimationFrame(() => {
      composerRef.current?.measureInWindow((_x, y, _width, composerHeight) => {
        if (!mountedRef.current || keyboardTopRef.current === null) return;
        // Some Android keyboards ignore adjustResize while edge-to-edge is active.
        // Add the current lift back before calculating so measuring the lifted view
        // cannot make the correction oscillate between zero and the overlap.
        const unliftedBottom = y + composerHeight + composerKeyboardLiftRef.current;
        const overlap = unliftedBottom - keyboardTopRef.current + 6;
        const maximumSafeLift = Math.max(0, height);
        applyComposerKeyboardLift(Math.min(maximumSafeLift, Math.max(0, overlap)));
        if (stickToBottom.current) listRef.current?.scrollToOffset({ offset: 0, animated: false });
      });
    });
  }, [applyComposerKeyboardLift, height]);

  const scheduleComposerKeyboardSync = useCallback((delays: readonly number[] = [0, 90]): void => {
    for (const timer of composerSyncTimersRef.current) clearTimeout(timer);
    composerSyncTimersRef.current.clear();
    for (const delay of delays) {
      const timer = setTimeout(() => {
        composerSyncTimersRef.current.delete(timer);
        syncComposerWithKeyboard();
      }, delay);
      composerSyncTimersRef.current.add(timer);
    }
  }, [syncComposerWithKeyboard]);

  useEffect(() => {
    const keyboardShown = (event: KeyboardEvent): void => {
      keyboardTopRef.current = event.endCoordinates.screenY;
      scheduleComposerKeyboardSync([0, 90, 240]);
    };
    const keyboardFrameChanged = (event: KeyboardEvent): void => {
      keyboardTopRef.current = event.endCoordinates.screenY;
      scheduleComposerKeyboardSync([0, 90]);
    };
    const keyboardHidden = (): void => {
      keyboardTopRef.current = null;
      applyComposerKeyboardLift(0);
    };
    const shown = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', keyboardShown);
    const frame = Platform.OS === 'ios' ? Keyboard.addListener('keyboardWillChangeFrame', keyboardFrameChanged) : null;
    const hidden = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', keyboardHidden);
    return () => {
      shown.remove();
      frame?.remove();
      hidden.remove();
      for (const timer of composerSyncTimersRef.current) clearTimeout(timer);
      composerSyncTimersRef.current.clear();
    };
  }, [applyComposerKeyboardLift, scheduleComposerKeyboardSync]);

  useEffect(() => {
    conversationRef.current = conversation;
  }, [conversation]);

  useEffect(() => {
    setPermissionNotice('');
  }, [conversation?.id]);

  const activeRun = conversation ? runs[conversation.id] : undefined;
  const busy = Boolean(activeRun?.running);
  const selectedPreset = routingPresets.find(preset => preset.id === conversation?.routingPresetId);
  const selectedExecutionMode = selectedPreset ? selectedPreset.executionMode ?? 'single' : conversation?.routingPresetId ? undefined : 'single';
  useEffect(() => {
    if (busy) onExecutionBusyChange?.(true);
  }, [busy, onExecutionBusyChange]);
  const defaultProvider = providers.find((provider) => provider.isDefault) ?? providers[0];
  const reasoningProvider = conversation?.routingPresetId
    ? undefined
    : providers.find((provider) => provider.id === conversation?.providerId) ?? defaultProvider;
  const reasoningEfforts = reasoningEffortsFor(reasoningProvider, conversation?.providerModel ?? reasoningProvider?.model);
  const selectedReasoningEffort = conversation?.reasoningEffort ?? 'auto';
  const reasoningSupportUnconfirmed = !reasoningEfforts.includes(selectedReasoningEffort);
  const requestedPermissionMode = conversation?.permissionMode ?? 'ask';
  const effectiveDevicePermissionMode = effectivePermissionMode(requestedPermissionMode, client.permissionCap);
  const permissionCappedByDevice = requestedPermissionMode !== effectiveDevicePermissionMode;
  const permissionLabel = effectiveDevicePermissionMode === 'read-only'
    ? '읽기'
    : effectiveDevicePermissionMode === 'workspace'
      ? '폴더'
      : effectiveDevicePermissionMode === 'full'
        ? '전체'
        : '확인';
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
    'reasoningEffort' | 'providerId' | 'providerModel' | 'routingPresetId' | 'workspaceId' | 'permissionMode' | 'tokenPolicy' | 'daybreakEnabled'
  >>): void => {
    if (conversationRef.current?.id === id) conversationRef.current = { ...conversationRef.current, ...patch };
    setConversation((current) => current?.id === id ? { ...current, ...patch } : current);
    setConversations((list) => list.map((item) => item.id === id ? { ...item, ...patch } : item));
  };

  const loadConversation = useCallback(async (id: string): Promise<void> => {
    if (configurationSaveInFlightRef.current) return;
    const generation = ++loadGeneration.current;
    historyLoad.current = null;
    setLoadingHistory(false);
    setHistoryError('');
    if (activeId.current !== id) {
      if (activeId.current) {
        drafts.current.delete(activeId.current); drafts.current.set(activeId.current, inputRef.current);
        if (drafts.current.size > 30) drafts.current.delete(drafts.current.keys().next().value!);
      }
      const draft = drafts.current.get(id) ?? '';
      inputRef.current = draft; setInput(draft);
    }
    activeId.current = id;
    setReasoningSaveFailed(false);
    setConfigurationSaveFailed(false);
    pendingDelta.current = '';
    if (deltaTimer.current) clearTimeout(deltaTimer.current);
    deltaTimer.current = null;
    const [detail, runList, recovery] = await Promise.all([
      client.call('conversations.get', { id }) as Promise<ConversationDetail>,
      client.call('chat.runs', {}, 5000).catch(() => null) as Promise<ChatRunState[] | null>,
      client.call('chat.recovery', { conversationId: id }, 5000).catch(() => null) as Promise<{ message: string } | null>,
    ]);
    if (generation !== loadGeneration.current) return;
    const active = runList?.find((run) => run.conversationId === id && run.running);
    const pendingConfirm = active
      ? await client.call('chat.pendingConfirm', { conversationId: id }, 5000).catch(() => null) as ChatConfirmRequest | null
      : null;
    if (generation !== loadGeneration.current) return;
    setRuns((current) => ({ ...current, ...Object.fromEntries((runList ?? []).map((run) => [run.conversationId, run])),
      [id]: active ?? { conversationId: id, running: runList === null, steeringQueued: 0, status: runList === null ? 'PC 실행 상태 확인 필요' : '' } }));
    setConfirm(current => pendingConfirm ?? (current?.conversationId === id ? null : current));
    setConversation(detail);
    setHistoryError(runList === null ? '실행 상태를 확인하지 못했습니다. 새 요청을 보내지 않았습니다. 연결을 확인하고 이 대화를 다시 선택하세요.' : recovery?.message ?? '');
    setHistoryPage({ id, info: detail.history });
    setActivity([]);
    setCommandMode(detail.routingPresetId ? 'scenario' : 'pc');
    const restored = detail.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ id: nextId(), role: m.role as 'user' | 'assistant', content: m.content, tools: [], done: true }));
    setMessages(active?.running
      ? [...restored, { id: nextId(), role: 'assistant', content: `${active.partialTextTruncated ? '…이전 출력 일부 생략…\n' : ''}${active.partialText ?? ''}`, tools: [], done: false }]
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

  const refreshProviders = useCallback(async (force = false): Promise<void> => {
    if (modelRefreshInFlight.current) return;
    modelRefreshInFlight.current = true;
    setRefreshingModels(true);
    try {
    const list = await client.call('providers.list', {}) as ProviderInfo[];
    setProviders(list);
    let failed = false;
    const entries = await Promise.all(list.map(async (provider): Promise<[string, string[] | null]> => {
      try {
        let catalog: ProviderModelCatalog;
        try {
          catalog = await client.call('providers.catalog', { id: provider.id, refresh: force }) as ProviderModelCatalog;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'unknown method: providers.catalog') throw error;
          catalog = { models: await client.call('providers.models', { id: provider.id, refresh: force }) as string[],
            source: 'provider', state: 'stale', lastUpdatedAt: null, lastAttemptAt: null };
        }
        if (catalog.state !== 'fresh') failed = true;
        setProviders(current => current.map(item => item.id === provider.id && item.model === provider.model
          ? { ...item, modelCapabilities: catalog.modelCapabilities } : item));
        return [provider.id, [...new Set([provider.model, ...catalog.models])]];
      } catch {
        failed = true;
        return [provider.id, null];
      }
    }));
    setProviderModels(previous => Object.fromEntries(entries.map(([id, models]) => [id, models ?? previous[id] ?? [list.find(p => p.id === id)!.model]])));
    if (force) setModelRefreshStatus(failed ? '일부 목록 갱신 실패 · 기존 목록 유지. PC의 CLI·로그인·연결을 확인하세요.' : '목록 갱신 완료 · 선택한 모델은 유지됩니다.');
    } finally { modelRefreshInFlight.current = false; setRefreshingModels(false); }
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
    scheduleComposerKeyboardSync([0, Platform.OS === 'ios' ? 280 : 80]);
    const timer = setTimeout(() => listRef.current?.scrollToOffset({ offset: 0, animated: false }), Platform.OS === 'ios' ? 280 : 80);
    return () => clearTimeout(timer);
  }, [keyboardVisible, scheduleComposerKeyboardSync]);

  useEffect(() => {
    if (keyboardTopRef.current !== null) scheduleComposerKeyboardSync([0, 100]);
  }, [height, scheduleComposerKeyboardSync]);

  useEffect(() => {
    const scrollIfFollowing = (): void => {
      if (!stickToBottom.current) { setUnseenMessages(true); return; }
      requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: false }));
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
    const setRunFinished = (conversationId: string, phase: 'completed' | 'failed'): void => {
      requestOwnership.current.finish(conversationId);
      cancellationWatches.current.get(conversationId)?.abort();
      cancellationWatches.current.delete(conversationId);
      setConfirm(current => current?.conversationId === conversationId ? null : current);
      setRuns((current) => ({
        ...current,
        [conversationId]: { ...(current[conversationId] ?? { conversationId, steeringQueued: 0 }), ...terminalRunUpdate(current[conversationId], phase), running: false, cancelling: false, status: '' },
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
            tools = [...tools.slice(-63), { key: `${info.name}#${toolCounter.current}`, callId: info.callId, name: info.name, summary: describe(info.input), status: 'start' }];
          } else {
            const idx = [...tools].reverse().findIndex((tool) => (info.callId ? tool.callId === info.callId : tool.name === info.name) && tool.status === 'start');
            if (idx >= 0) {
              const realIdx = tools.length - 1 - idx;
              tools = tools.map((tool, index) => index === realIdx ? { ...tool, status: info.status } : tool);
            }
          }
          return [...items.slice(0, -1), { ...last, tools }];
        });
        scrollIfFollowing();
      }),
      client.on('chat.progress', (data) => {
        const event = data as Partial<ChatRunState>;
        if (!event.conversationId) return;
        setRuns(current => ({ ...current, [event.conversationId!]: {
          ...(current[event.conversationId!] ?? { conversationId: event.conversationId!, steeringQueued: 0, running: true }), ...event,
          cancelling: event.phase === 'cancelling',
        } }));
      }),
      client.on('chat.status', (data) => {
        const event = data as { conversationId?: string; status?: string };
        if (!event.conversationId) return;
        if (event.conversationId === activeId.current && event.status) {
          const line = event.status.slice(0, 1000);
          setActivity(items => items.at(-1) === line ? items : [...items.slice(-19), line]);
        }
        if (startingConversationRef.current === event.conversationId) startingConversationRef.current = null;
        setRuns((current) => ({
          ...current,
          [event.conversationId!]: { ...(current[event.conversationId!] ?? { conversationId: event.conversationId!, steeringQueued: 0 }), running: true, status: event.status ?? '' },
        }));
      }),
      client.on('chat.done', (data) => {
        const d = data as { conversationId?: string; text: string; conversation?: ConversationDetail };
        if (startingConversationRef.current === d.conversationId) startingConversationRef.current = null;
        if (d.conversationId) setRunFinished(d.conversationId, 'completed');
        if (d.conversationId !== activeId.current) { void refreshConversations(); return; }
        flushDelta();
        if (d.conversation) {
          setConversation(d.conversation);
        }
        // Keep earlier pages and stable row identities when the completed run
        // supplies only the latest transcript page.
        setMessages((items) => {
          if (!items.length && d.conversation) {
            const restored = d.conversation.messages.filter(message => message.role === 'user' || message.role === 'assistant').map(message => ({ id: nextId(), role: message.role as 'user' | 'assistant', content: message.content, tools: [], done: true }));
            if (restored.length) return restored;
          }
            const last = items[items.length - 1];
            if (!last || last.role !== 'assistant' || last.done) return [...items, { id: nextId(), role: 'assistant', content: d.text || '', tools: [], done: true }];
            return [...items.slice(0, -1), { ...last, content: d.text || last.content || '', done: true }];
        });
        void refreshConversations();
        scrollIfFollowing();
      }),
      client.on('chat.error', (data) => {
        const d = data as { conversationId?: string; message: string };
        if (startingConversationRef.current === d.conversationId) startingConversationRef.current = null;
        if (d.conversationId) setRunFinished(d.conversationId, 'failed');
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
      for (const controller of cancellationWatches.current.values()) controller.abort();
      cancellationWatches.current.clear();
      requestOwnership.current.clear();
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
        if (activeId.current === currentConversation.id && inputRef.current.trim() === text) setInput('');
      } catch (error) {
        if (activeId.current !== currentConversation.id) return;
        setMessages((items) => [...items, { id: nextId(), role: 'assistant', content: '', tools: [], done: true, error: error instanceof Error ? error.message : String(error) }]);
      }
      return;
    }
    startingConversationRef.current = currentConversation.id;
    const requestToken = requestOwnership.current.begin(currentConversation.id);
    setActivity([]);
    setInput('');
    setRuns((current) => ({ ...current, [currentConversation.id]: { conversationId: currentConversation.id, running: true, steeringQueued: 0, status: '시작 중' } }));
    stickToBottom.current = true;
    setUnseenMessages(false);
    setMessages((items) => appendPendingAttempt(items, text));
    try {
      const result = await client.call('chat.start', { text, conversationId: currentConversation.id, reasoningEffort: currentConversation.reasoningEffort, providerId: currentConversation.providerId, providerModel: currentConversation.providerModel, routingPresetId: commandMode === 'scenario' ? currentConversation.routingPresetId : undefined, workspaceId: currentConversation.workspaceId, permissionMode: currentConversation.permissionMode, tokenPolicy: client.canUseAuditOnly ? currentConversation.tokenPolicy ?? 'adaptive' : 'adaptive' }, 10 * 60_000) as { ok?: boolean; text?: string; error?: string };
      if (!requestOwnership.current.owns(currentConversation.id, requestToken)) return;
      if (result.ok === false) throw new Error(result.error || '작업 실행에 실패했습니다.');
      setConfirm(current => current?.conversationId === currentConversation.id ? null : current);
      setRuns(current => ({ ...current, [currentConversation.id]: { ...current[currentConversation.id], conversationId: currentConversation.id, running: false, ...terminalRunUpdate(current[currentConversation.id], 'completed'), steeringQueued: 0 } }));
      if (activeId.current === currentConversation.id) setMessages(items => {
        const last = items.at(-1);
        return last?.role === 'assistant' ? [...items.slice(0, -1), { ...last, content: result.text || last.content, done: true }] : items;
      });
    } catch (err) {
      if (!requestOwnership.current.owns(currentConversation.id, requestToken)) return;
      const snapshot = await client.call('chat.runs', {}, 5000).catch(() => null) as ChatRunState[] | null;
      if (!requestOwnership.current.owns(currentConversation.id, requestToken)) return;
      const active = snapshot?.find(run => run.conversationId === currentConversation.id && run.running);
      if (active || snapshot === null) {
        if (active) setRuns(current => ({ ...current, [currentConversation.id]: active }));
        if (activeId.current === currentConversation.id) setHistoryError(active ? '응답 연결이 끊겼지만 PC 작업은 계속 실행 중입니다. 중복 전송하지 말고 완료를 기다리거나 중지하세요.' : 'PC 실행 상태를 확인할 수 없습니다. 연결 복구 후 확인하세요. 작업을 자동으로 다시 보내지 않았습니다.');
        return;
      }
      setConfirm(current => current?.conversationId === currentConversation.id ? null : current);
      if (activeId.current === currentConversation.id) setMessages((msgs) => {
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant') {
          return [...msgs.slice(0, -1), { ...last, done: true, error: err instanceof Error ? err.message : String(err) }];
        }
        return msgs;
      });
      setRuns((current) => ({ ...current, [currentConversation.id]: { ...current[currentConversation.id], conversationId: currentConversation.id, running: false, ...terminalRunUpdate(current[currentConversation.id], 'failed'), cancelling: false, steeringQueued: 0, status: '' } }));
    } finally {
      if (requestOwnership.current.owns(currentConversation.id, requestToken)) {
        requestOwnership.current.finish(currentConversation.id);
        if (startingConversationRef.current === currentConversation.id) startingConversationRef.current = null;
      }
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

  const createConversation = async (projectId = projectScope): Promise<void> => {
    if (configurationSaveInFlightRef.current) return;
    const created = await client.call('conversations.create', { workspaceId: projectId === '*' ? undefined : projectId }) as ConversationDetail;
    setConversations((list) => [created, ...list]);
    activeId.current = created.id;
    setConversation(created);
    setReasoningSaveFailed(false);
    setConfigurationSaveFailed(false);
    setMessages([]);
    setInput('');
  };
  const selectProject = async (id: string): Promise<void> => {
    setProjectScope(id); setShowProjects(false); setShowChatOptions(false);
    const target = conversations.find(c => id === '*' || c.workspaceId === id);
    try { if (target) { setInput(''); await loadConversation(target.id); } else await createConversation(id); }
    catch (error) { setLoadError(error instanceof Error ? error.message : String(error)); }
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
      setShowReasoning(false);
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
    setModelSearch('');
    setModelProviderFilter('');
    setCustomModelExpanded(false);
    setShowModels(true);
    void refreshProviders().catch(() => setModelRefreshStatus('PC 연결을 확인하세요. 기존 모델 목록은 유지됩니다.'));
  };

  const selectModel = async (providerId?: string, providerModel?: string): Promise<void> => {
    if (!conversation || busy || !beginConfigurationSave()) return;
    const conversationId = conversation.id;
    const provider = providerId ? providers.find((item) => item.id === providerId) : defaultProvider;
    const supportedEfforts = reasoningEffortsFor(provider, providerModel ?? provider?.model);
    const reasoningEffort = supportedEfforts.includes(conversation.reasoningEffort) ? conversation.reasoningEffort : 'auto';
    try {
      const updated = await client.call('conversations.update', {
        id: conversationId,
        providerId: providerId ?? null,
        providerModel: providerModel ?? null,
        routingPresetId: null,
        reasoningEffort,
        daybreakEnabled: supportsDaybreak(provider, providerModel ?? provider?.model) && conversation.daybreakEnabled === true,
      }) as ConversationDetail;
      applyConversationConfiguration(conversationId, {
        providerId: updated.providerId,
        providerModel: updated.providerModel,
        routingPresetId: updated.routingPresetId,
        reasoningEffort: updated.reasoningEffort,
        daybreakEnabled: updated.daybreakEnabled,
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
    const reasoningEffort = reasoningEffortsFor(provider, conversation.providerModel ?? provider?.model).includes(conversation.reasoningEffort) ? conversation.reasoningEffort : 'auto';
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
    const supportedEfforts = reasoningEffortsFor(routingPresetId ? undefined : provider, conversation.providerModel ?? provider?.model);
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
    if (!conversation || busy) return;
    if (!permissionWithinCap(permissionMode, client.permissionCap)) {
      setPermissionNotice(`이 휴대폰은 ${client.permissionCap}까지 허용되어 있습니다. PC 앱의 원격 PC 관리에서 이 기기 권한을 먼저 높여 주세요.`);
      return;
    }
    if (!beginConfigurationSave()) return;
    const conversationId = conversation.id;
    try {
      const updated = await client.call('conversations.update', { id: conversationId, permissionMode }) as ConversationDetail;
      applyConversationConfiguration(conversationId, { permissionMode: updated.permissionMode });
      if (updated.permissionMode !== permissionMode) {
        setPermissionNotice(`PC의 전체 액세스 정책이 ${updated.permissionMode}로 제한했습니다. PC 앱의 원격 PC 관리 또는 액세스 설정에서 상한을 높여 주세요.`);
      } else {
        setPermissionNotice('');
        setShowAccess(false);
      }
    } catch {
      if (mountedRef.current) setConfigurationSaveFailed(true);
    } finally {
      finishConfigurationSave();
    }
  };

  const selectTokenPolicy = async (tokenPolicy: ConversationTokenPolicy): Promise<void> => {
    if (!client.canUseAuditOnly || !conversation || busy || !beginConfigurationSave()) return;
    const conversationId = conversation.id;
    try {
      const updated = await client.call('conversations.update', { id: conversationId, tokenPolicy }) as ConversationDetail;
      applyConversationConfiguration(conversationId, { tokenPolicy: updated.tokenPolicy });
      setShowTokenPolicy(false);
    } catch {
      if (mountedRef.current) setConfigurationSaveFailed(true);
    } finally {
      finishConfigurationSave();
    }
  };

  const toggleDaybreak = async (): Promise<void> => {
    if (!conversation || configurationLocked || !beginConfigurationSave()) return;
    const conversationId = conversation.id;
    try {
      const updated = await client.call('conversations.update', { id: conversationId, daybreakEnabled: !conversation.daybreakEnabled }) as ConversationDetail;
      applyConversationConfiguration(conversationId, { daybreakEnabled: updated.daybreakEnabled });
    } catch {
      if (mountedRef.current) setConfigurationSaveFailed(true);
    } finally { finishConfigurationSave(); }
  };

  const togglePin = async (target: ConversationSummary): Promise<void> => {
    if (busy || configurationSaveInFlightRef.current) return;
    const updated = await client.call('conversations.update', { id: target.id, pinned: !target.pinned }) as ConversationDetail;
    if (conversation?.id === updated.id) setConversation(updated);
    await refreshConversations();
  };

  const attachFile = async (): Promise<void> => {
    const workspace = resolveProjectWorkspace(workspaces, conversation?.workspaceId);
    if (uploading) return;
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (picked.canceled) return;
    const file = picked.assets[0]; const relativePath = `.mr-robot-uploads/${Date.now()}-${file.name.replace(/[\\/:*?"<>|]/g, '_')}`;
    setUploading(true);
    uploadStopReason.current = null;
    const controller = new AbortController();
    const task = { cancelAsync: async () => { controller.abort(); } };
    uploadTaskRef.current = task;
    const timeout = setTimeout(() => {
      if (uploadTaskRef.current !== task) return;
      uploadStopReason.current = 'timeout';
      void task.cancelAsync().catch(() => undefined);
    }, 120_000);
    try {
      const result = await uploadSecureFile(pc, file.uri, file.name, controller.signal);
      if (mountedRef.current) setInput((value) => value + (value ? '\n' : '') + '[첨부 파일: ' + result.absolutePath + ']');
    } catch (error) {
      if (mountedRef.current) setMessages((items) => [...items, { id: nextId(), role: 'assistant', content: '', tools: [], done: true, error: uploadStopReason.current === 'user' ? '파일 업로드를 중지했습니다.' : uploadStopReason.current === 'timeout' ? '파일 업로드 시간이 초과되었습니다.' : error instanceof Error ? error.message : String(error) }]);
    } finally {
      clearTimeout(timeout);
      if (uploadTaskRef.current === task) uploadTaskRef.current = null;
      uploadStopReason.current = null;
      if (FileSystem.cacheDirectory && file.uri.startsWith(FileSystem.cacheDirectory)) await FileSystem.deleteAsync(file.uri, { idempotent: true }).catch(() => undefined);
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
    if (cancellationWatches.current.has(conversationId)) return;
    const controller = new AbortController();
    cancellationWatches.current.set(conversationId, controller);
    setRuns((current) => ({ ...current, [conversationId]: { ...current[conversationId], conversationId, running: true, cancelling: true, steeringQueued: current[conversationId]?.steeringQueued ?? 0, status: '중지 요청 중…' } }));
    try {
      await client.call('chat.cancel', { conversationId }, 8000);
      if (controller.signal.aborted) return;
      await watchChatSettlement({ conversationId, runId: activeRun?.runId, signal: controller.signal,
        wait: () => new Promise(resolve => setTimeout(resolve, 2500)),
        loadRuns: () => client.call('chat.runs', {}, 5000),
        onRunning: () => setRuns(current => ({ ...current, [conversationId]: { ...current[conversationId], cancelling: true, status: '작업을 안전하게 중지하는 중…' } })),
        onUnavailable: () => setRuns(current => ({ ...current, [conversationId]: { ...current[conversationId], status: '연결 확인 중 · 종료 여부 확인 중' } })),
        onSettled: () => {
          requestOwnership.current.finish(conversationId);
          if (startingConversationRef.current === conversationId) startingConversationRef.current = null;
          setRuns((current) => ({
            ...current,
            [conversationId]: { ...current[conversationId], conversationId, running: false, phase: 'cancelled', cancelling: false, steeringQueued: 0, status: '중지됨' },
          }));
          setConfirm(current => current?.conversationId === conversationId ? null : current);
          if (activeId.current === conversationId) {
            setMessages((items) => {
              const last = items[items.length - 1];
              if (!last || last.role !== 'assistant' || last.done) return items;
              return [...items.slice(0, -1), { ...last, done: true, error: '사용자가 작업을 중지했습니다.' }];
            });
          }
        },
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setRuns((current) => ({ ...current, [conversationId]: { ...current[conversationId], conversationId, running: true, cancelling: false, steeringQueued: current[conversationId]?.steeringQueued ?? 0, status: '중지 요청 실패' } }));
      if (activeId.current === conversationId) setHistoryError(error instanceof Error ? error.message : String(error));
    } finally {
      if (cancellationWatches.current.get(conversationId) === controller) cancellationWatches.current.delete(conversationId);
    }
  };

  const onMessageScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset } = event.nativeEvent;
    const following = contentOffset.y < 96;
    // Only a real user gesture may disengage following, never a layout/IME resize.
    if (draggingMessages.current) stickToBottom.current = following;
    else if (following) stickToBottom.current = true;
    if (following && unseenMessages) setUnseenMessages(false);
  };

  const jumpToLatest = (): void => {
    stickToBottom.current = true;
    setUnseenMessages(false);
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  };

  const currentHistory = historyPage?.id === conversation?.id ? historyPage?.info : conversation?.history;
  const loadPreviousMessages = async (): Promise<void> => {
    const id = conversationRef.current?.id;
    const before = currentHistory?.nextCursor;
    if (!id || activeId.current !== id || !currentHistory?.hasMore || !before || historyLoad.current) return;
    const request = {};
    const generation = loadGeneration.current;
    historyLoad.current = request;
    setLoadingHistory(true);
    setHistoryError('');
    try {
      const page = await client.call('conversations.get', { id, before, limit: 160 }) as ConversationDetail;
      if (!mountedRef.current || historyLoad.current !== request || loadGeneration.current !== generation || activeId.current !== id) return;
      if (page.id !== id || (page.history?.hasMore && page.history.nextCursor === before)) throw new Error('이전 기록의 위치를 확인할 수 없습니다. 대화를 다시 열어주세요.');
      const older = page.messages.filter(message => message.role === 'user' || message.role === 'assistant').map(message => ({ id: nextId(), role: message.role as 'user' | 'assistant', content: message.content, tools: [], done: true }));
      stickToBottom.current = false;
      setMessages(items => [...older, ...items]);
      setHistoryPage({ id, info: page.history });
    } catch (error) {
      if (mountedRef.current && historyLoad.current === request && loadGeneration.current === generation && activeId.current === id) setHistoryError(error instanceof Error ? error.message : '이전 메시지를 불러오지 못했습니다.');
    } finally {
      if (historyLoad.current === request) { historyLoad.current = null; if (mountedRef.current) setLoadingHistory(false); }
    }
  };

  const singleModelChoices = (includeAutomatic: boolean) => (
    <>
      <TextInput accessibilityLabel="모델 검색" style={styles.customModelInput} value={modelSearch} onChangeText={setModelSearch} placeholder="모델 이름 검색" placeholderTextColor={colors.faint} autoCapitalize="none" autoCorrect={false} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.customProviderList} keyboardShouldPersistTaps="handled">
        {[{ id: '', label: '전체' }, ...providers].map(provider => <TouchableOpacity key={provider.id} accessibilityRole="button" accessibilityState={{ selected: modelProviderFilter === provider.id }} style={[styles.customProviderChip, modelProviderFilter === provider.id && styles.customProviderChipOn]} onPress={() => setModelProviderFilter(provider.id)}><Text style={styles.customProviderText}>{provider.label}</Text></TouchableOpacity>)}
      </ScrollView>
      {includeAutomatic && !modelSearch && !modelProviderFilter && <TouchableOpacity style={[styles.modelChoice, savingConfiguration && styles.disabledBtn]} disabled={savingConfiguration} onPress={() => void selectModel()}>
        <Text style={styles.modelProvider}>{!conversation?.providerId ? '✓ ' : ''}자동 라우팅</Text>
        <Text style={styles.faintChoice}>PC의 기본 라우팅이 요청에 맞는 모델을 선택</Text>
      </TouchableOpacity>}
      {providers.filter(provider => !modelProviderFilter || modelProviderFilter === provider.id).map(provider => {
        const choices = visibleModelChoices(providerModels[provider.id] ?? [provider.model], conversation?.providerId === provider.id ? conversation.providerModel : undefined).filter(model => `${provider.label} ${model}`.toLowerCase().includes(modelSearch.trim().toLowerCase()));
        if (!choices.length) return null;
        return <View key={provider.id}><Text style={styles.modelSectionTitle}>{provider.label}</Text>{choices.map((modelName) => {
        const selected = (conversation?.providerId ?? defaultProvider?.id) === provider.id && (conversation?.providerModel ?? provider.model) === modelName && !conversation?.routingPresetId;
        return <TouchableOpacity key={`${provider.id}:${modelName}`} style={[styles.modelChoice, selected && styles.modelChoiceOn, savingConfiguration && styles.disabledBtn]} disabled={savingConfiguration} onPress={() => void selectModel(provider.id, modelName)}>
          <Text style={styles.modelName}>{selected ? '✓ ' : ''}{modelName}</Text>
        </TouchableOpacity>;
      })}</View>; })}
      {providers.length > 0 && providers.filter(provider => !modelProviderFilter || modelProviderFilter === provider.id).every(provider => !visibleModelChoices(providerModels[provider.id] ?? [provider.model], conversation?.providerId === provider.id ? conversation.providerModel : undefined).some(model => `${provider.label} ${model}`.toLowerCase().includes(modelSearch.trim().toLowerCase()))) && <Text accessibilityLiveRegion="polite" style={styles.modalText}>일치하는 모델이 없습니다.</Text>}
      {providers.length === 0 && <Text style={styles.modalText}>PC에 등록된 모델 공급자가 없습니다. PC 앱의 설정 → 모델에서 먼저 공급자를 추가하세요.</Text>}
      {providers.length > 0 && <View style={styles.customModelBox}>
        <TouchableOpacity accessibilityRole="button" accessibilityState={{ expanded: customModelExpanded }} onPress={() => setCustomModelExpanded(value => !value)}><Text style={styles.modelProvider}>모델 ID 직접 지정 {customModelExpanded ? '⌃' : '⌄'}</Text></TouchableOpacity>
        {customModelExpanded && <>
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
          placeholder="정확한 모델 ID"
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
        </>}
      </View>}
    </>
  );

  const busyControls = busy ? (
    <View style={styles.busyActions}>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="실행 중인 작업에 추가 명령 끼워넣기" accessibilityState={{ disabled: !input.trim() || savingConfiguration }} style={[styles.sendBtn, styles.busyActionBtn, (!input.trim() || savingConfiguration) && styles.disabledBtn]} onPress={() => void send()} disabled={!input.trim() || savingConfiguration}>
        <Text style={styles.sendText} numberOfLines={1}>↑</Text>
      </TouchableOpacity>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="실행 중인 작업 중지" accessibilityState={{ busy: Boolean(activeRun?.cancelling), disabled: Boolean(activeRun?.cancelling) }} style={[styles.sendBtn, styles.cancelBtn, { width: 48, paddingHorizontal: 8 }, activeRun?.cancelling && { opacity: 0.55 }]} onPress={() => void cancelRun()} disabled={activeRun?.cancelling}>
        <Text style={styles.sendText} numberOfLines={1}>{activeRun?.cancelling ? '…' : '■'}</Text>
      </TouchableOpacity>
    </View>
  ) : null;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0}>
      {!shortKeyboardViewport && <View style={styles.chatHeader}>
        <TouchableOpacity style={styles.composerIconBtn} accessibilityRole="button" accessibilityLabel="프로젝트 선택과 관리" onPress={() => { Keyboard.dismiss(); setShowProjects(true); }}><Text style={styles.toolBtnText}>▱</Text></TouchableOpacity>
        <TouchableOpacity style={styles.chatHeading} accessibilityRole="button" accessibilityLabel="대화 목록과 추가 설정" onPress={() => { Keyboard.dismiss(); setShowChatOptions(true); }}>
          <Text style={styles.chatHeadingTitle} numberOfLines={1}>{conversation?.title || '새 대화'} ⌄</Text>
          {!keyboardVisible && <Text style={styles.chatHeadingDetail} numberOfLines={1}>{pc.name} · {workspaces.find(w => w.id === conversation?.workspaceId)?.name || 'PC 작업 공간'}</Text>}
        </TouchableOpacity>
        {onSelectExecutionPc && !keyboardVisible && <TouchableOpacity style={styles.composerIconBtn} accessibilityRole="button" accessibilityLabel="실행 PC 선택" onPress={onSelectExecutionPc}><Text style={styles.pcSelectIcon}>PC⌄</Text></TouchableOpacity>}
        <TouchableOpacity style={styles.composerIconBtn} accessibilityRole="button" accessibilityLabel="새 대화" disabled={savingConfiguration} onPress={() => void createConversation()}><Text style={styles.toolBtnText}>＋</Text></TouchableOpacity>
      </View>}
      {loadError ? <View style={styles.loadError} accessibilityLiveRegion="assertive"><View style={styles.loadErrorCopy}><Text style={styles.loadErrorTitle}>대화 정보를 불러오지 못했습니다</Text><Text style={styles.loadErrorText} numberOfLines={2}>{loadError}</Text></View><TouchableOpacity style={styles.loadRetryBtn} onPress={() => void refreshInitialData()} accessibilityRole="button" accessibilityLabel="대화 다시 불러오기"><Text style={styles.loadRetryText}>재시도</Text></TouchableOpacity></View> : null}
      <FlatList
        ref={listRef}
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, messages.length === 0 && styles.emptyContent]}
        inverted
        data={[...messages].reverse()}
        keyExtractor={(message) => message.id}
        initialNumToRender={18}
        maxToRenderPerBatch={12}
        windowSize={9}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        onScroll={onMessageScroll}
        onScrollBeginDrag={() => { draggingMessages.current = true; }}
        onScrollEndDrag={() => { draggingMessages.current = false; }}
        scrollEventThrottle={80}
        onLayout={() => { if (stickToBottom.current) requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: false })); }}
        onContentSizeChange={() => { if (stickToBottom.current) listRef.current?.scrollToOffset({ offset: 0, animated: false }); }}
        ListFooterComponent={(currentHistory?.hasMore || currentHistory?.unavailable || currentHistory?.missingMessages || currentHistory?.displayTruncated || historyError) ? <View style={{ alignItems: 'center', gap: 8, paddingVertical: 12 }}>
          {currentHistory?.hasMore && <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: loadingHistory, busy: loadingHistory }} disabled={loadingHistory} onPress={() => void loadPreviousMessages()} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 18 }}><Text style={{ color: colors.accent2 }}>{loadingHistory ? '이전 메시지 불러오는 중…' : '이전 메시지 불러오기'}</Text></TouchableOpacity>}
          {historyError ? <><Text style={{ color: colors.dim, fontSize: 12, textAlign: 'center' }}>{historyError}</Text><TouchableOpacity accessibilityRole="button" onPress={() => { if (conversation) void loadConversation(conversation.id).catch(() => setHistoryError('상태를 다시 확인하지 못했습니다. 연결을 확인하세요.')); }}><Text style={{ color: colors.accent2 }}>상태 다시 확인</Text></TouchableOpacity></> : null}
          {currentHistory?.displayTruncated ? <Text style={{ color: colors.dim, fontSize: 12, textAlign: 'center' }}>매우 긴 메시지는 일부만 표시하며 보관된 원문은 유지됩니다.</Text> : null}
          {currentHistory?.unavailable ? <Text style={{ color: colors.dim, fontSize: 12, textAlign: 'center' }}>이전 대화 보관 파일을 읽을 수 없어 현재 남아 있는 메시지를 표시합니다.</Text> : (currentHistory?.missingMessages ?? 0) > 0 ? <Text style={{ color: colors.dim, fontSize: 12, textAlign: 'center' }}>과거에 원문이 저장되지 않은 메시지 {currentHistory!.missingMessages.toLocaleString()}개는 표시할 수 없습니다.</Text> : null}
        </View> : null}
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
              {m.content ? <Text style={styles.bubbleText}>{m.role === 'assistant' ? chatFileDisplayText(m.content) : m.content}</Text> : !m.done ? <RunTimeline run={activeRun ?? null} busy={busy} executionMode={selectedExecutionMode} /> : null}
              {m.role === 'assistant' && conversation && <ChatFiles text={m.content} pc={pc} conversationId={conversation.id} />}
              {m.error ? <Text style={styles.errorText}>⚠️ {m.error}</Text> : null}
            </View>
            <ToolHistory tools={m.tools} />
          </View>
        )}
      />

      {unseenMessages && <TouchableOpacity style={styles.latestBtn} onPress={jumpToLatest}><Text style={styles.latestText}>새 응답 보기 ↓</Text></TouchableOpacity>}
      {!shortKeyboardViewport && <RunActivity key={conversation?.id} run={activeRun ?? null} busy={busy} executionMode={selectedExecutionMode} />}
      <View
        ref={composerRef}
        onLayout={() => { if (keyboardTopRef.current !== null) scheduleComposerKeyboardSync([0, 80]); }}
        style={[styles.inputBar, compact && styles.inputBarCompact, { paddingBottom: keyboardVisible ? 6 : Math.max(10, insets.bottom), marginBottom: composerKeyboardLift }]}
      >
        <View style={styles.composerCard}>
          <TextInput
            style={[styles.input, shortKeyboardViewport && { maxHeight: Math.max(44, 26 * fontScale + 14) }]}
            value={input}
            onChangeText={setInput}
            placeholder={busy ? '실행 중인 작업에 추가 명령…' : 'PC에 시킬 일을 입력하세요…'}
            placeholderTextColor={colors.faint}
            multiline
            scrollEnabled
            disableFullscreenUI
            textAlignVertical="top"
            accessibilityLabel="PC 에이전트에게 보낼 명령"
            onFocus={() => scheduleComposerKeyboardSync([0, 90, 240])}
            onContentSizeChange={() => scheduleComposerKeyboardSync([0, 80])}
          />
          <View style={shortKeyboardViewport ? styles.composerCompactControls : undefined}>
          <View style={[styles.composerToolbar, shortKeyboardViewport && { flex: 1 }]}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="입력창 모델 선택" style={[styles.composerSelectBtn, styles.composerModelBtn, configurationLocked && styles.disabledBtn]} onPress={openModelPicker} disabled={configurationLocked}>
              <Text style={styles.composerSelectText} numberOfLines={1}>{conversation?.routingPresetId ? '복합 트리' : conversation?.providerModel || providers.find(p => p.id === conversation?.providerId)?.model || '모델 선택'} ⌄</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`대화 액세스 실제 적용 ${permissionLabel}${permissionCappedByDevice ? ', 기기 상한으로 제한됨' : ''}`}
              accessibilityHint="이 대화의 작업 승인 방식을 선택합니다"
              accessibilityState={{ expanded: showAccess, disabled: configurationLocked }}
              style={[styles.composerSelectBtn, configurationLocked && styles.disabledBtn]}
              onPress={() => { setPermissionNotice(''); setShowAccess(true); }}
              disabled={configurationLocked}
            >
              <Text style={styles.composerSelectText} numberOfLines={1}>권한 {permissionLabel}{permissionCappedByDevice ? '·상한' : ''}⌄</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`추론 강도 ${selectedReasoningEffort}`}
              accessibilityHint="작업용 추론 강도입니다. 단순 인사·계산은 같은 모델의 낮은 추론으로 처리합니다."
              accessibilityState={{ expanded: showReasoning, disabled: reasoningLocked }}
              style={[styles.composerSelectBtn, (reasoningSaveFailed || configurationSaveFailed) && styles.composerSelectError, reasoningLocked && styles.disabledBtn]}
              onPress={() => setShowReasoning(true)}
              disabled={reasoningLocked}
            >
              <Text style={styles.composerSelectText} numberOfLines={1}>{savingReasoning ? '저장 중…' : `추론 ${selectedReasoningEffort}⌄`}</Text>
            </TouchableOpacity>
          </View>
          <View style={[styles.composerActionRow, shortKeyboardViewport && { flexShrink: 0 }]}>
            {shortKeyboardViewport && <RunActivity run={activeRun ?? null} busy={busy} executionMode={selectedExecutionMode} compact />}
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={uploading ? '파일 업로드 취소' : '파일 첨부'} accessibilityState={{ busy: uploading }} style={[styles.composerIconBtn, uploading && styles.toolBtnCancel]} onPress={() => uploading ? void cancelAttachment() : void attachFile()}><Text style={styles.toolBtnText}>{uploading ? '×' : '＋'}</Text></TouchableOpacity>
            <TouchableOpacity style={styles.composerIconBtn} accessibilityRole="button" accessibilityLabel="추가 실행 설정" onPress={() => { Keyboard.dismiss(); setShowChatOptions(true); }}><Text style={styles.toolBtnText}>⋯</Text></TouchableOpacity>
            {supportsDaybreak(reasoningProvider, conversation?.providerModel ?? reasoningProvider?.model) && <TouchableOpacity accessibilityRole="button" accessibilityLabel="Daybreak" accessibilityState={{ selected: conversation?.daybreakEnabled === true, disabled: configurationLocked }} disabled={configurationLocked} onPress={() => void toggleDaybreak()} style={styles.composerSelectBtn}><Text style={[styles.composerSelectText, conversation?.daybreakEnabled && { color: colors.accent2 }]}>☀ {shortKeyboardViewport ? (conversation?.daybreakEnabled ? 'ON' : 'OFF') : `Daybreak ${conversation?.daybreakEnabled ? '켜짐' : '꺼짐'}`}</Text></TouchableOpacity>}
            {!shortKeyboardViewport && <View style={styles.composerToolbarSpacer} />}
            {busyControls}
            {!busy && (
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="명령 보내기" accessibilityState={{ disabled: !input.trim() || savingConfiguration }} style={[styles.sendBtn, (!input.trim() || savingConfiguration) && { opacity: 0.5 }]} onPress={() => void send()} disabled={!input.trim() || savingConfiguration}>
                <Text style={styles.sendText}>{savingConfiguration ? '저장 중…' : '보내기'}</Text>
              </TouchableOpacity>
            )}
          </View>
          </View>
        </View>
        {configurationSaveFailed && <Text style={styles.composerSettingError} accessibilityLiveRegion="assertive">대화 설정을 저장하지 못했습니다. 다시 선택해 주세요.</Text>}
      </View>

      <ProjectPicker client={client} visible={showProjects} projects={workspaces} active={projectScope} onClose={() => setShowProjects(false)} onSelect={id => void selectProject(id)} onChanged={setWorkspaces} />
      <Modal visible={showChatOptions} transparent animationType="slide" onRequestClose={() => setShowChatOptions(false)} accessibilityViewIsModal>
        <View style={[styles.optionsBackdrop, { paddingBottom: Math.max(12, insets.bottom), paddingTop: Math.max(12, insets.top) }]}>
          <View style={styles.optionsSheet}>
            <View style={styles.optionsHeading}><Text style={styles.modalTitle}>대화 설정</Text><TouchableOpacity accessibilityLabel="추가 설정 닫기" onPress={() => setShowChatOptions(false)} style={styles.composerIconBtn}><Text style={styles.toolBtnText}>×</Text></TouchableOpacity></View>
            <ScrollView keyboardShouldPersistTaps="handled" style={styles.optionsScroll}>
              <Text style={styles.optionsSection}>실행 환경</Text>
              <TouchableOpacity style={styles.optionsRow} disabled={configurationLocked} onPress={() => { setShowChatOptions(false); setShowWorkspaces(true); }}><Text style={styles.optionsLabel}>작업 폴더</Text><Text style={styles.optionsValue} numberOfLines={1}>{workspaces.find(w => w.id === conversation?.workspaceId)?.name || '선택 안 함'} ›</Text></TouchableOpacity>
              <TouchableOpacity style={styles.optionsRow} disabled={configurationLocked} onPress={() => { setShowChatOptions(false); setShowScenarios(true); }}><Text style={styles.optionsLabel}>모델 시나리오</Text><Text style={styles.optionsValue} numberOfLines={1}>{routingPresets.find(p => p.id === conversation?.routingPresetId)?.name || '단일 모델'} ›</Text></TouchableOpacity>
              <TouchableOpacity style={styles.optionsRow} accessibilityLabel="대화 토큰 정책" disabled={configurationLocked} onPress={() => { setShowChatOptions(false); setShowTokenPolicy(true); }}><Text style={styles.optionsLabel}>질문 예산</Text><Text style={styles.optionsValue}>{QUESTION_LABELS[conversation?.tokenPolicy ?? 'adaptive']} ›</Text></TouchableOpacity>
              <Text style={styles.optionsSection}>현재 대화</Text>
              <TouchableOpacity style={styles.optionsRow} disabled={configurationLocked} onPress={() => conversation && void togglePin(conversation)}><Text style={styles.optionsLabel}>{conversation?.pinned ? '대화 고정 해제' : '대화 고정'}</Text><Text style={styles.optionsValue}>⌖</Text></TouchableOpacity>
              <TouchableOpacity style={styles.optionsRow} disabled={configurationLocked} onPress={() => { setShowChatOptions(false); void archiveConversation(); }}><Text style={styles.optionsLabel}>보관함으로 이동</Text><Text style={styles.optionsValue}>›</Text></TouchableOpacity>
              <Text style={styles.optionsSection}>최근 대화</Text>
              {conversations.filter(c => projectScope === '*' || c.workspaceId === projectScope).map(c => <TouchableOpacity key={c.id} style={[styles.optionsRow, c.id === conversation?.id && styles.optionsRowOn]} disabled={savingConfiguration} onPress={() => { setShowChatOptions(false); void loadConversation(c.id); }}><Text style={styles.optionsLabel} numberOfLines={1}>{c.pinned ? '⌖ ' : ''}{c.title}</Text><Text style={styles.optionsValue}>{c.id === conversation?.id ? '✓' : '›'}</Text></TouchableOpacity>)}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={showModels} transparent animationType="fade" onRequestClose={() => setShowModels(false)} accessibilityViewIsModal>
        <KeyboardAvoidingView style={styles.modalKeyboardAvoiding} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0}>
          <View style={[styles.modalBackdrop, { paddingTop: Math.max(12, insets.top), paddingBottom: Math.max(12, insets.bottom), paddingLeft: Math.max(12, insets.left + 8), paddingRight: Math.max(12, insets.right + 8) }]}>
            <View style={styles.modal}>
              <Text style={styles.modalTitle}>이 대화에서 사용할 모델</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="모델 목록 새로고침" style={styles.bigBtn} disabled={refreshingModels} onPress={() => void refreshProviders(true).catch(() => setModelRefreshStatus('PC 연결을 확인하세요. 기존 모델 목록은 유지됩니다.'))}><Text style={styles.bigBtnText}>{refreshingModels ? '모델 목록 확인 중…' : '↻ 모델 목록 새로고침'}</Text></TouchableOpacity>
              {Boolean(modelRefreshStatus) && <Text accessibilityLiveRegion="polite" style={styles.accessCapText}>{modelRefreshStatus}</Text>}
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
                  <Text style={styles.modelName}>{preset.executionMode === 'adaptive' ? '적응형 협업' : preset.executionMode === 'vote' ? '의견 교환·투표' : preset.executionMode === 'pipeline' ? '순차 검증' : preset.executionMode === 'hybrid' ? '분류·회의·검증' : '단일 라우팅'} · {preset.graph?.nodes.length ?? 0}노드</Text>
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
            <Text style={styles.accessCapText}>이 기기 상한 · {client.isAdmin ? 'PC 관리자 (전체)' : client.permissionCap}</Text>
            {permissionCappedByDevice ? <Text style={styles.accessNotice} accessibilityLiveRegion="polite">대화에는 {requestedPermissionMode}가 저장되어 있지만, 이 휴대폰에서는 실제로 {effectiveDevicePermissionMode}까지만 적용됩니다. PC 앱의 원격 PC 관리에서 이 기기 권한을 높여 주세요.</Text> : null}
            {permissionNotice ? <Text style={styles.accessNotice} accessibilityLiveRegion="assertive">{permissionNotice}</Text> : null}
            <ScrollView style={styles.modelList} keyboardShouldPersistTaps="handled">
              {([
                ['read-only', '읽기 전용', '파일과 상태만 읽고 변경은 모두 차단'],
                ['ask', '변경 전 확인', '파일·명령 변경 직전에 모바일에서 승인'],
                ['workspace', '작업 폴더 자동', '선택한 작업 폴더 안 변경만 자동 실행'],
                ['full', '전체 허용', '이 기기 권한 상한 안에서 확인 없이 실행'],
              ] as Array<[PermissionMode, string, string]>).map(([value, label, description]) => {
                const blockedByDevice = !permissionWithinCap(value, client.permissionCap);
                return <TouchableOpacity
                  key={value}
                  style={[styles.modelChoice, blockedByDevice && styles.accessChoiceBlocked, savingConfiguration && styles.disabledBtn]}
                  disabled={savingConfiguration || blockedByDevice}
                  accessibilityRole="button"
                  accessibilityLabel={`${label}${blockedByDevice ? ', PC에서 기기 권한 상향 필요' : ''}`}
                  accessibilityState={{ selected: conversation?.permissionMode === value, disabled: savingConfiguration || blockedByDevice }}
                  onPress={() => void selectAccess(value)}
                >
                  <Text style={styles.modelProvider}>{conversation?.permissionMode === value ? '✓ ' : ''}{label}{blockedByDevice ? ' · 잠김' : ''}</Text>
                  <Text style={styles.faintChoice}>{description}{blockedByDevice ? '\nPC 앱의 원격 PC 관리에서 이 기기 상한을 먼저 높여야 합니다.' : ''}</Text>
                </TouchableOpacity>;
              })}
            </ScrollView>
            <TouchableOpacity style={styles.bigBtn} onPress={() => setShowAccess(false)} accessibilityRole="button"><Text style={styles.bigBtnText}>닫기</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={showReasoning} transparent animationType="fade" onRequestClose={() => setShowReasoning(false)} accessibilityViewIsModal>
        <View style={[styles.modalBackdrop, { paddingTop: Math.max(12, insets.top), paddingBottom: Math.max(12, insets.bottom), paddingLeft: Math.max(12, insets.left + 8), paddingRight: Math.max(12, insets.right + 8) }]}>
          <View style={styles.dropdownModal}>
            <Text style={styles.modalTitle}>추론 강도</Text>
            {reasoningSupportUnconfirmed && <Text style={styles.modalText}>저장된 {selectedReasoningEffort} 단계의 지원을 확인하지 못했습니다. 모델 목록을 새로고침하거나 자동을 선택하세요.</Text>}
            <Text style={styles.modalText}>작업용 강도로 저장됩니다. 단순 인사·계산은 같은 모델의 낮은 추론으로 처리하고, 그 외 작업에는 선택한 강도를 사용합니다.</Text>
            <ScrollView style={styles.dropdownList} keyboardShouldPersistTaps="handled">
              {reasoningEfforts.map((effort) => {
                const selected = selectedReasoningEffort === effort;
                return <TouchableOpacity
                  key={effort}
                  accessibilityRole="button"
                  accessibilityLabel={`추론 강도 ${effort}`}
                  accessibilityState={{ selected, disabled: savingConfiguration }}
                  style={[styles.dropdownChoice, selected && styles.dropdownChoiceOn, savingConfiguration && styles.disabledBtn]}
                  disabled={savingConfiguration}
                  onPress={() => selected ? setShowReasoning(false) : void selectReasoningEffort(effort)}
                >
                  <Text style={[styles.dropdownChoiceText, selected && styles.dropdownChoiceTextOn]}>{selected ? '✓ ' : ''}{effort}</Text>
                </TouchableOpacity>;
              })}
            </ScrollView>
            <TouchableOpacity style={styles.bigBtn} onPress={() => setShowReasoning(false)} accessibilityRole="button"><Text style={styles.bigBtnText}>닫기</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={showTokenPolicy} transparent animationType="fade" onRequestClose={() => setShowTokenPolicy(false)} accessibilityViewIsModal>
        <View style={[styles.modalBackdrop, { paddingTop: Math.max(12, insets.top), paddingBottom: Math.max(12, insets.bottom), paddingLeft: Math.max(12, insets.left + 8), paddingRight: Math.max(12, insets.right + 8) }]}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>질문별 토큰 예산</Text>
            <Text style={styles.modalText}>새 질문마다 예산을 초기화합니다. 복합 트리는 해당 질문의 모든 모델 사용량을 합산합니다. 무제한도 공급자 요금·계정 한도는 적용됩니다.</Text>
            <ScrollView style={styles.modelList} keyboardShouldPersistTaps="handled">
              {([
                ['adaptive', '적응형 · 품질 우선', '요청 난이도와 실행 방식에 맞춰 품질을 우선하고 안전 상한을 자동 조정합니다.'],
                ['economy', '절약 · 질문당 6.4만', '질문 하나당 64,000토큰. 새 질문마다 초기화합니다.'],
                ['standard', '표준 · 질문당 25.6만', '질문 하나당 256,000토큰. 이전 질문 사용량은 차감하지 않습니다.'],
                ['quality', '고품질 · 질문당 100만', '질문 하나당 1,000,000토큰. 복합 트리의 전체 사용량을 합산합니다.'],
                ...(client.canUseAuditOnly ? [['audit-only', '무제한 · 감사만', 'V.E.R.A의 누적 토큰 예산으로 중단하지 않고 사용량만 기록합니다. 사용량을 보고하지 않는 로컬 CLI는 보수적으로 추정합니다. 공급자 자체 한도와 요금은 계속 적용되며, 사용량은 대화 기록과 PC 설정의 텔레메트리에서 확인합니다.']] : []),
              ] as Array<[ConversationTokenPolicy, string, string]>).map(([value, label, description]) => <TouchableOpacity key={value} style={[styles.modelChoice, (configurationLocked || !client.canUseAuditOnly) && styles.disabledBtn]} disabled={configurationLocked || !client.canUseAuditOnly} onPress={() => void selectTokenPolicy(value)}><Text style={styles.modelProvider}>{(client.canUseAuditOnly ? conversation?.tokenPolicy ?? 'adaptive' : 'adaptive') === value ? '✓ ' : ''}{label}</Text><Text style={styles.faintChoice}>{description}</Text></TouchableOpacity>)}
            </ScrollView>
            <TouchableOpacity style={styles.bigBtn} onPress={() => setShowTokenPolicy(false)} accessibilityRole="button"><Text style={styles.bigBtnText}>닫기</Text></TouchableOpacity>
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
  empty: { alignItems: 'center', marginVertical: 40, paddingHorizontal: 20 },
  emptyIcon: { fontSize: 40, color: '#c8c1e0', textShadowColor: '#a091df22', textShadowRadius: 12 },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 10 },
  emptyText: { color: colors.faint, textAlign: 'center', lineHeight: 21, marginTop: 6 },
  row: { flexDirection: 'column', alignItems: 'flex-start', gap: 6 },
  rowUser: { alignItems: 'flex-end' },
  bubble: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
    maxWidth: '96%',
    minWidth: 60,
  },
  bubbleUser: { backgroundColor: '#2c2939', borderColor: '#baa9e61a', borderWidth: 1, maxWidth: '90%', borderBottomRightRadius: 5 },
  bubbleText: { color: colors.text, fontSize: 15, lineHeight: 24 },
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
  inputBar: { gap: 7, padding: 12, backgroundColor: colors.bg },
  inputBarCompact: { paddingHorizontal: 8, paddingTop: 8 },
  composerCard: { borderWidth: 1, borderColor: '#ffffff1a', borderTopColor: '#ffffff26', borderRadius: 20, backgroundColor: '#24262e', padding: 8, gap: 2, shadowColor: '#000', shadowOpacity: .24, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 5 },
  composerToolbar: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 4 },
  composerCompactControls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chatHeader: { minHeight: 52, paddingHorizontal: 12, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 6 },
  pcSelectIcon: { color: colors.dim, fontSize: 11, fontWeight: '600' },
  chatHeading: { flex: 1, minWidth: 0 },
  chatHeadingTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  chatHeadingDetail: { color: colors.faint, fontSize: 11, marginTop: 3 },
  composerActionRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  composerModelBtn: { flex: 1, minWidth: 0, maxWidth: undefined },
  optionsBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,.55)', paddingHorizontal: 12 },
  optionsSheet: { maxHeight: '88%', backgroundColor: colors.card, borderRadius: 24, borderWidth: 1, borderColor: colors.border, padding: 16 },
  optionsHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  optionsScroll: { flexShrink: 1 },
  optionsSection: { color: colors.faint, fontSize: 11, fontWeight: '700', marginTop: 18, marginBottom: 6 },
  optionsRow: { minHeight: 48, paddingHorizontal: 10, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 12 },
  optionsRowOn: { backgroundColor: 'rgba(124,92,255,.12)' },
  optionsLabel: { color: colors.text, fontSize: 13, flexShrink: 1 },
  optionsValue: { color: colors.dim, fontSize: 12, marginLeft: 'auto', flexShrink: 1, maxWidth: '58%' },
  composerToolbarSpacer: { flex: 1, minWidth: 2 },
  composerIconBtn: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent' },
  composerSelectBtn: { minHeight: 40, maxWidth: 140, flexShrink: 1, justifyContent: 'center', borderRadius: 9, backgroundColor: 'transparent', paddingHorizontal: 7 },
  composerSelectError: { borderColor: 'rgba(248,113,113,.6)', backgroundColor: 'rgba(248,113,113,.08)' },
  composerSelectText: { color: colors.dim, fontSize: 11.5, fontWeight: '600' },
  composerSettingError: { color: colors.err, fontSize: 10.5, lineHeight: 15, paddingHorizontal: 3 },
  toolBtn: { width: 44, minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.inputBg },
  toolBtnCancel: { borderColor: 'rgba(248,113,113,.5)', backgroundColor: 'rgba(248,113,113,.16)' },
  toolBtnText: { color: colors.text, fontSize: 17, fontWeight: '800' },
  input: {
    width: '100%',
    backgroundColor: 'transparent',
    color: colors.text,
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 6,
    fontSize: 14.5,
    minHeight: 44,
    maxHeight: 120,
  },
  sendBtn: { minHeight: 40, backgroundColor: colors.accent, borderRadius: radius.sm, paddingHorizontal: 14, justifyContent: 'center', alignItems: 'center' },
  cancelBtn: { backgroundColor: 'rgba(248,113,113,0.25)' },
  busyActions: { flexDirection: 'row', gap: 6, flexShrink: 0, width: 98 },
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
  dropdownModal: { width: '100%', maxWidth: 420, maxHeight: '82%', alignSelf: 'center', backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 16, gap: 10 },
  dropdownList: { maxHeight: 360, flexShrink: 1 },
  dropdownChoice: { minHeight: 44, justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.inputBg, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 6 },
  dropdownChoiceOn: { borderColor: colors.accent, backgroundColor: 'rgba(124,92,255,0.18)' },
  dropdownChoiceText: { color: colors.dim, fontSize: 13, fontWeight: '700' },
  dropdownChoiceTextOn: { color: colors.text },
  modalTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  modalText: { color: colors.dim, fontSize: 14 },
  modelList: { maxHeight: 420, flexShrink: 1, minHeight: 0 },
  modelChoice: { backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, marginBottom: 8 },
  modelChoiceOn: { borderColor: colors.accent, backgroundColor: 'rgba(124,92,255,0.16)' },
  accessChoiceBlocked: { opacity: 0.48, borderStyle: 'dashed' },
  accessCapText: { alignSelf: 'flex-start', color: colors.accent2, fontSize: 11.5, fontWeight: '800', borderWidth: 1, borderColor: 'rgba(34,211,238,.28)', borderRadius: 999, backgroundColor: 'rgba(34,211,238,.08)', paddingHorizontal: 10, paddingVertical: 5 },
  accessNotice: { color: colors.warn, fontSize: 11.5, lineHeight: 17, borderWidth: 1, borderColor: 'rgba(251,191,36,.35)', borderRadius: radius.sm, backgroundColor: 'rgba(251,191,36,.08)', padding: 9 },
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
