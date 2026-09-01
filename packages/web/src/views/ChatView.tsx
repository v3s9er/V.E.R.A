import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatConfirmRequest, ChatRunState, ConversationDetail, ConversationSummary, PermissionMode, ProviderInfo, ReasoningEffort, RoutingPreset, WorkspaceInfo } from '@mr-robot/shared';
import { useMrRobot } from '../state';
import { Button, Input, Modal, Select, Spinner } from '../components/ui';
import { MarkdownMessage } from '../components/MarkdownMessage';
import { pcOrigin, type DesktopPcLoadResult, type SavedPc } from '../pcs';

interface UiTool { key: string; name: string; summary: string; status: 'start' | 'done' | 'error'; detail?: string }
interface UiMsg { id: string; role: 'user' | 'assistant'; content: string; tools: UiTool[]; done: boolean; error?: string }
interface RouteInfo { providerLabel: string; model: string; role: string; effort: ReasoningEffort; reason: string; advisor?: { providerLabel: string; model: string } }
interface ConversationMenu { conversation: ConversationSummary; x: number; y: number }
type ExecutionConfigPatch = {
  reasoningEffort?: ReasoningEffort;
  providerId?: string | null;
  providerModel?: string | null;
  routingPresetId?: string | null;
  workspaceId?: string | null;
  permissionMode?: PermissionMode;
};

const EXECUTION_CONFIG_SAVE_MESSAGE = '모델 실행 설정을 저장하고 있습니다. 저장이 끝난 뒤 명령을 보내주세요.';

declare global {
  interface Window {
    mrRobotDesktop?: {
      chooseDirectory(): Promise<string | null>;
      chooseCalendarWorkbook(): Promise<string | null>;
      getLocalConnection(): Promise<{ name: string; host: string; port: number; auth: string }>;
      connectLocalRpc(input: { url: string; credentialRef: string }): Promise<{ ok: boolean; isAdmin: boolean; permissionCap: PermissionMode }>;
      callLocalRpc(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
      closeLocalRpc(): void;
      onLocalRpcEvent(handler: (message: { event: string; data: unknown }) => void): () => void;
      onLocalRpcClose(handler: (reason: string) => void): () => void;
      loadPcs(): Promise<DesktopPcLoadResult>;
      savePcs(pcs: SavedPc[]): Promise<{ ok: boolean }>;
      pairRemotePc(input: { origin: string; pin: string; deviceName: string; permissionCap: string; accessClientId?: string; accessClientSecret?: string }): Promise<{ credentialRef: string }>;
      downloadFile(input: { id: string; url: string; token: string; suggestedName: string }): Promise<{ canceled: boolean; path?: string }>;
      cancelDownload(id: string): Promise<{ ok: boolean }>;
      onNavigate(handler: (view: string) => void): () => void;
      platform: string;
    };
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    SpeechRecognition?: new () => SpeechRecognitionLike;
  }
}
interface SpeechRecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null; onerror: (() => void) | null;
}

let uid = 1;
const nextId = (): string => `m${uid++}`;
const modelChoiceValue = (providerId: string, model: string): string => JSON.stringify([providerId, model]);
const describe = (input: unknown): string => { try { const s = JSON.stringify(input); return s.length > 90 ? `${s.slice(0, 90)}…` : s; } catch { return ''; } };
const fromDetail = (detail: ConversationDetail): UiMsg[] => detail.messages
  .filter((m) => m.role === 'user' || m.role === 'assistant')
  .map((m) => ({ id: nextId(), role: m.role as 'user' | 'assistant', content: m.content, tools: [], done: true }));

const TOOL_EMOJI: Record<string, string> = {
  shell_exec: '🖥️', list_files: '📂', read_file: '📄', write_file: '✏️', delete_file: '🗑️', move_file: '📦', launch_app: '🚀',
  mouse_move: '🖱️', mouse_click: '👆', mouse_scroll: '🖱️', type_text: '⌨️', key_press: '⌨️', screenshot: '📸', get_screen_size: '🖥️',
  native_agent: '✦',
};
const TOOL_LABEL: Record<string, string> = {
  shell_exec: '명령 실행', list_files: '폴더 확인', read_file: '파일 읽기', write_file: '파일 수정', delete_file: '파일 삭제', move_file: '파일 이동', launch_app: '앱 실행',
  mouse_move: '마우스 이동', mouse_click: '클릭', mouse_scroll: '스크롤', type_text: '텍스트 입력', key_press: '키 입력', screenshot: '화면 확인', get_screen_size: '화면 크기 확인',
  native_agent: '네이티브 에이전트 실행',
};
const EFFORTS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'auto', label: '자동' }, { value: 'none', label: '없음' }, { value: 'low', label: '낮음' },
  { value: 'medium', label: '보통' }, { value: 'high', label: '높음' }, { value: 'xhigh', label: '매우 높음' }, { value: 'max', label: '최대' },
];
const COMMON_REASONING_EFFORTS = new Set<ReasoningEffort>(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
const reasoningEffortsForProvider = (provider?: ProviderInfo): typeof EFFORTS => {
  const supported = provider?.supportedReasoning.length ? new Set(provider.supportedReasoning) : COMMON_REASONING_EFFORTS;
  return EFFORTS.filter(({ value }) => value === 'auto' || supported.has(value));
};
const compatibleReasoningEffort = (current: ReasoningEffort, provider?: ProviderInfo): ReasoningEffort => (
  reasoningEffortsForProvider(provider).some(({ value }) => value === current) ? current : 'auto'
);
const ACCESS: Array<{ value: PermissionMode; label: string; short: string; detail: string }> = [
  { value: 'read-only', label: '읽기 전용', short: '읽기', detail: '파일과 상태를 읽을 수 있지만 변경하지 않습니다.' },
  { value: 'ask', label: '변경 전 확인', short: '확인', detail: '변경이나 실행 전에 대화 안에서 승인받습니다.' },
  { value: 'workspace', label: '작업 폴더 허용', short: '폴더', detail: '선택한 작업 폴더 안에서는 묻지 않고 작업합니다.' },
  { value: 'full', label: '전체 허용', short: '전체', detail: '기기 권한 상한 안에서 PC 전체 작업을 허용합니다.' },
];

export function ChatView({ profile, voiceCommand, onVoiceCommandHandled, activePc, executionPcs = [], onSwitchExecutionPc, onExecutionBusyChange }: {
  profile?: ReactNode;
  voiceCommand?: { id: number; text: string } | null;
  onVoiceCommandHandled?: (id: number) => void;
  activePc?: SavedPc | null;
  /** Every independently paired agent host available to this controller. */
  executionPcs?: SavedPc[];
  /** Changes the agent host that will receive subsequent conversation work. */
  onSwitchExecutionPc?: (id: string) => void;
  onExecutionBusyChange?: (busy: boolean) => void;
}) {
  const { client } = useMrRobot();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState<ConversationDetail | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [messages, setMessages] = useState<UiMsg[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [routingPresets, setRoutingPresets] = useState<RoutingPreset[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [confirm, setConfirm] = useState<ChatConfirmRequest | null>(null);
  const [conversationMenu, setConversationMenu] = useState<ConversationMenu | null>(null);
  const [renameTarget, setRenameTarget] = useState<ConversationSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [listening, setListening] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState('');
  const [workspaceError, setWorkspaceError] = useState('');
  const [workspaceAdding, setWorkspaceAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ConversationSummary | null>(null);
  const [composerError, setComposerError] = useState('');
  const [executionConfigSaving, setExecutionConfigSaving] = useState(false);
  const [voiceAck, setVoiceAck] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [visibleMessageLimit, setVisibleMessageLimit] = useState(160);
  const scroller = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const uploadAbortReason = useRef<'user' | 'timeout' | null>(null);
  const mountedRef = useRef(true);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const selectedId = useRef<string | null>(null);
  const selectedRef = useRef<ConversationDetail | null>(null);
  const busyRef = useRef(false);
  const executionConfigSavingRef = useRef(false);
  const runningConversationRef = useRef<string | null>(null);
  const toolCounter = useRef(0);
  const dragDepth = useRef(0);
  const deltaBuffer = useRef<{ conversationId: string; text: string } | null>(null);
  const deltaTimer = useRef<number | null>(null);
  const ownedTimers = useRef(new Set<number>());
  const conversationUpdateQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (busy) onExecutionBusyChange?.(true);
  }, [busy, onExecutionBusyChange]);

  const later = useCallback((callback: () => void, delayMs: number): number => {
    const id = window.setTimeout(() => {
      ownedTimers.current.delete(id);
      callback();
    }, delayMs);
    ownedTimers.current.add(id);
    return id;
  }, []);

  const flushDelta = useCallback((): void => {
    if (deltaTimer.current !== null) window.clearTimeout(deltaTimer.current);
    deltaTimer.current = null;
    const pending = deltaBuffer.current;
    deltaBuffer.current = null;
    if (!pending || selectedId.current !== pending.conversationId) return;
    setMessages((items) => {
      const last = items[items.length - 1];
      if (!last || last.role !== 'assistant') return items;
      return [...items.slice(0, -1), { ...last, content: last.content + pending.text }];
    });
  }, []);

  useEffect(() => {
    // React StrictMode mounts effects twice in development. Re-arm this guard on
    // every effect setup so a simulated cleanup cannot permanently suppress UI.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      uploadAbortReason.current = 'user';
      uploadAbortRef.current?.abort();
      if (deltaTimer.current !== null) window.clearTimeout(deltaTimer.current);
      deltaTimer.current = null;
      deltaBuffer.current = null;
      for (const timer of ownedTimers.current) window.clearTimeout(timer);
      ownedTimers.current.clear();
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      if (recognition) {
        recognition.onresult = null;
        recognition.onend = null;
        recognition.onerror = null;
        try { recognition.stop(); } catch { /* already stopped */ }
      }
    };
  }, []);

  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { busyRef.current = busy; }, [busy]);

  const executeCommand = useCallback(async (rawText: string): Promise<void> => {
    const text = rawText.trim();
    if (!text) return;
    if (executionConfigSavingRef.current) {
      setComposerError(EXECUTION_CONFIG_SAVE_MESSAGE);
      return;
    }
    setComposerError('');

    let conversation = selectedRef.current;
    if (!conversation) {
      try {
        conversation = await client.call('conversations.create', {}) as ConversationDetail;
        selectedId.current = conversation.id;
        selectedRef.current = conversation;
        setSelected(conversation);
        setConversations((items) => [conversation as ConversationDetail, ...items]);
        setMessages([]);
      } catch (error) {
        setComposerError(error instanceof Error ? error.message : String(error));
        return;
      }
    }

    if (busyRef.current) {
      try {
        const result = await client.call('chat.steer', { conversationId: runningConversationRef.current ?? conversation.id, text }) as { ok?: boolean; queued?: number };
        setStatus(`추가 명령을 실행 흐름에 넣었습니다${result.queued ? ` · 대기 ${result.queued}개` : ''}.`);
      } catch (error) {
        setComposerError(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    busyRef.current = true;
    runningConversationRef.current = conversation.id;
    setBusy(true);
    setStatus('모델 선택 중…');
    setRoute(null);
    setMessages((items) => [...items, { id: nextId(), role: 'user', content: text, tools: [], done: true }, { id: nextId(), role: 'assistant', content: '', tools: [], done: false }]);
    try {
      const result = await client.call('chat.start', {
        conversationId: conversation.id,
        text,
        reasoningEffort: conversation.reasoningEffort,
        providerId: conversation.providerId,
        providerModel: conversation.providerModel,
        routingPresetId: conversation.routingPresetId,
        workspaceId: conversation.workspaceId,
        permissionMode: conversation.permissionMode,
      }, 10 * 60_000) as { ok?: boolean; error?: string; text?: string; route?: RouteInfo };
      if (result.ok === false) throw new Error(result.error || '작업 실행에 실패했습니다.');
      if (result.route) setRoute(result.route);
      if (result.text) {
        setMessages((items) => {
          const copy = [...items];
          const last = copy[copy.length - 1];
          if (last?.role === 'assistant') { if (!last.content) last.content = result.text ?? ''; last.done = true; }
          return copy;
        });
      }
    } catch (error) {
      setMessages((items) => {
        const copy = [...items];
        const last = copy[copy.length - 1];
        if (last?.role === 'assistant' && !last.done) { last.done = true; last.error = error instanceof Error ? error.message : String(error); }
        return copy;
      });
    } finally {
      if (runningConversationRef.current === conversation.id) runningConversationRef.current = null;
      busyRef.current = false;
      setBusy(false);
      setStatus('');
    }
  }, [client]);

  const discoverProviderModels = useCallback(async (items: ProviderInfo[]): Promise<void> => {
    const entries = await Promise.all(items.map(async (provider): Promise<[string, string[]]> => {
      try {
        const discovered = await client.call('providers.models', { id: provider.id }) as string[];
        return [provider.id, [...new Set([provider.model, ...discovered])]];
      } catch {
        return [provider.id, [provider.model]];
      }
    }));
    setProviderModels(Object.fromEntries(entries));
  }, [client]);

  const loadConversation = useCallback(async (id: string): Promise<void> => {
    const [detail, runs] = await Promise.all([
      client.call('conversations.get', { id }) as Promise<ConversationDetail>,
      client.call('chat.runs', {}, 5000).catch(() => []) as Promise<ChatRunState[]>,
    ]);
    const selectedRun = runs.find((run) => run.conversationId === id);
    const controlledRun = selectedRun ?? runs[0];
    const confirmations = await Promise.all(runs.map((run) => (
      client.call('chat.pendingConfirm', { conversationId: run.conversationId }, 5000)
        .catch(() => null) as Promise<ChatConfirmRequest | null>
    )));
    selectedId.current = id;
    selectedRef.current = detail;
    setSelected(detail);
    const restored = fromDetail(detail);
    setMessages(selectedRun ? [...restored, { id: nextId(), role: 'assistant', content: '', tools: [], done: false }] : restored);
    setVisibleMessageLimit(160);
    setRoute(null);
    runningConversationRef.current = controlledRun?.conversationId ?? null;
    busyRef.current = Boolean(controlledRun);
    setBusy(Boolean(controlledRun));
    setStatus(controlledRun?.status ?? '');
    setConfirm(confirmations.find((item): item is ChatConfirmRequest => item !== null) ?? null);
  }, [client]);

  const refresh = useCallback(async (preferredId?: string): Promise<void> => {
    const [list, provs, presets, workspaceList] = await Promise.all([
      client.call('conversations.list', { status: showArchived ? 'archived' : 'active' }) as Promise<ConversationSummary[]>,
      client.call('providers.list', {}) as Promise<ProviderInfo[]>,
      client.call('routing.presets.list', {}) as Promise<RoutingPreset[]>,
      client.call('workspaces.list', {}) as Promise<WorkspaceInfo[]>,
    ]);
    setConversations(list);
    setProviders(provs);
    setRoutingPresets(presets);
    setWorkspaces(workspaceList);
    void discoverProviderModels(provs);
    const target = preferredId ?? selectedId.current ?? list[0]?.id;
    if (target && list.some((c) => c.id === target)) await loadConversation(target);
    else if (!showArchived) {
      const created = await client.call('conversations.create', {}) as ConversationDetail;
      setConversations([created, ...list]);
      selectedId.current = created.id;
      selectedRef.current = created;
      setSelected(created);
      setMessages([]);
    } else {
      selectedId.current = null;
      selectedRef.current = null;
      setSelected(null);
      setMessages([]);
    }
  }, [client, discoverProviderModels, loadConversation, showArchived]);

  useEffect(() => {
    let active = true;
    void refresh().finally(() => { if (active) setInitialized(true); });
    return () => { active = false; };
  }, [refresh]);

  useEffect(() => {
    if (!initialized || !voiceCommand) return;
    setVoiceAck(`실행 시작 · “${voiceCommand.text}”`);
    setInput('');
    onVoiceCommandHandled?.(voiceCommand.id);
    void executeCommand(voiceCommand.text);
    later(() => setVoiceAck(''), 5000);
  }, [executeCommand, initialized, later, onVoiceCommandHandled, voiceCommand]);

  useEffect(() => {
    const offList = client.on('conversations.changed', (data) => {
      const all = data as ConversationSummary[];
      setConversations(all.filter((c) => c.status === (showArchived ? 'archived' : 'active')));
    });
    const offProviders = client.on('providers.changed', (data) => {
      const next = data as ProviderInfo[];
      setProviders(next);
      void discoverProviderModels(next);
    });
    const offPresets = client.on('routing.presets.changed', (data) => setRoutingPresets(data as RoutingPreset[]));
    const offWorkspaces = client.on('workspaces.changed', (data) => setWorkspaces(data as WorkspaceInfo[]));
    const isCurrent = (data: unknown): boolean => (data as { conversationId?: string }).conversationId === selectedId.current;
    const offDelta = client.on('chat.delta', (data) => {
      if (!isCurrent(data)) return;
      const event = data as { conversationId: string; text: string };
      const text = event.text ?? '';
      if (!text) return;
      if (deltaBuffer.current && deltaBuffer.current.conversationId !== event.conversationId) flushDelta();
      if (deltaBuffer.current) deltaBuffer.current.text += text;
      else deltaBuffer.current = { conversationId: event.conversationId, text };
      if (deltaTimer.current === null) deltaTimer.current = window.setTimeout(flushDelta, 32);
    });
    const offTool = client.on('chat.tool', (data) => {
      if (!isCurrent(data)) return;
      const info = data as { name: string; input: unknown; status: 'start' | 'done' | 'error'; detail?: string };
      setMessages((items) => {
        const copy = [...items]; const last = copy[copy.length - 1]; if (!last || last.role !== 'assistant') return copy;
        if (info.status === 'start') last.tools = [...last.tools, { key: `${info.name}#${++toolCounter.current}`, name: info.name, summary: describe(info.input), status: 'start' }];
        else { const found = [...last.tools].reverse().findIndex((t) => t.name === info.name && t.status === 'start'); if (found >= 0) { const index = last.tools.length - 1 - found; last.tools[index] = { ...last.tools[index], status: info.status, detail: info.detail }; } }
        return copy;
      });
    });
    const offStatus = client.on('chat.status', (data) => { if (isCurrent(data)) setStatus((data as { status: string }).status ?? ''); });
    const offDone = client.on('chat.done', (data) => {
      flushDelta();
      const eventConversationId = (data as { conversationId?: string }).conversationId ?? null;
      if (runningConversationRef.current === eventConversationId) {
        runningConversationRef.current = null;
        busyRef.current = false;
        setBusy(false);
        setStatus('');
      }
      if (!isCurrent(data)) return;
      const done = data as { text: string; route?: RouteInfo; conversation?: ConversationDetail };
      setMessages((items) => { const copy = [...items]; const last = copy[copy.length - 1]; if (last?.role === 'assistant') { if (!last.content) last.content = done.text; last.done = true; } return copy; });
      if (done.conversation) { selectedRef.current = done.conversation; setSelected(done.conversation); }
      setRoute(done.route ?? null);
    });
    const offError = client.on('chat.error', (data) => {
      flushDelta();
      const eventConversationId = (data as { conversationId?: string }).conversationId ?? null;
      if (runningConversationRef.current === eventConversationId) {
        runningConversationRef.current = null;
        busyRef.current = false;
        setBusy(false);
        setStatus('');
      }
      if (!isCurrent(data)) return;
      setMessages((items) => { const copy = [...items]; const last = copy[copy.length - 1]; if (last?.role === 'assistant') { last.done = true; last.error = (data as { message: string }).message; } return copy; });
    });
    const offConfirm = client.on('chat.confirm', (data) => setConfirm(data as ChatConfirmRequest));
    const offVoice = client.on('voice.wake', (data) => {
      const wake = data as { kind?: string; commandText?: string; awaitingCommand?: boolean };
      if (wake.kind !== 'pc') return;
      setVoiceAck(wake.commandText ? `음성 명령 확인 · “${wake.commandText}”` : wake.awaitingCommand ? '호출 확인 · 명령을 듣는 중…' : '호출을 들었습니다.');
      later(() => setVoiceAck(''), 5000);
    });
    const offVoiceReady = client.on('voice.command.ready', (data) => {
      if ((data as { kind?: string }).kind === 'pc') setVoiceAck('말씀하세요 · 다음 문장을 바로 실행합니다.');
    });
    const offVoiceTimeout = client.on('voice.command.timeout', (data) => {
      if ((data as { kind?: string }).kind === 'pc') setVoiceAck('음성 명령 대기 시간이 끝났습니다. 다시 “로봇”이라고 불러주세요.');
    });
    return () => { offList(); offProviders(); offPresets(); offWorkspaces(); offDelta(); offTool(); offStatus(); offDone(); offError(); offConfirm(); offVoice(); offVoiceReady(); offVoiceTimeout(); };
  }, [client, discoverProviderModels, flushDelta, later, showArchived]);

  useEffect(() => { if (messages.length > 0 && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [messages]);

  useEffect(() => {
    if (!conversationMenu) return;
    const close = (): void => setConversationMenu(null);
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('blur', close); window.removeEventListener('keydown', key); };
  }, [conversationMenu]);

  const createConversation = async (): Promise<void> => {
    const created = await client.call('conversations.create', {}) as ConversationDetail;
    setConversations((list) => [created, ...list]); selectedId.current = created.id; selectedRef.current = created; setSelected(created); setMessages([]); setShowArchived(false);
  };
  const updateConversation = (patch: Record<string, unknown>, onError?: () => void): Promise<void> => {
    const target = selectedRef.current;
    if (!target) return Promise.resolve();
    const task = conversationUpdateQueue.current
      .catch(() => undefined)
      .then(async () => {
        const detail = await client.call('conversations.update', { id: target.id, ...patch }) as ConversationDetail;
        if (selectedId.current === detail.id) {
          selectedRef.current = detail;
          setSelected(detail);
        }
        setConversations((list) => list.map((conversation) => conversation.id === detail.id ? detail : conversation));
      });
    const safeTask = task.catch((error) => {
      setComposerError(error instanceof Error ? error.message : String(error));
      onError?.();
    });
    conversationUpdateQueue.current = safeTask;
    return safeTask;
  };
  const updateExecutionConfig = (patch: ExecutionConfigPatch): Promise<void> => {
    const target = selectedRef.current;
    if (!target || busyRef.current || executionConfigSavingRef.current || target.status === 'archived') return Promise.resolve();

    const keys = Object.keys(patch) as Array<keyof ExecutionConfigPatch>;
    if (keys.length === 0 || keys.every((key) => Object.is(target[key], patch[key]))) return Promise.resolve();

    const targetRecord = target as ConversationDetail & Record<string, unknown>;
    const patchRecord = patch as Record<string, unknown>;
    const previousValues = Object.fromEntries(keys.map((key) => [key, targetRecord[key]])) as Record<string, unknown>;
    const optimistic = { ...target, ...patch } as ConversationDetail;

    // Set the ref before React can render again so a second selector event or
    // send action cannot overtake this queued persistence request.
    executionConfigSavingRef.current = true;
    setExecutionConfigSaving(true);
    setComposerError('');
    selectedRef.current = optimistic;
    setSelected(optimistic);
    setConversations((list) => list.map((conversation) => conversation.id === target.id ? { ...conversation, ...patch } as ConversationSummary : conversation));

    const rollbackMatchingFields = <T extends ConversationSummary>(conversation: T): T => {
      if (conversation.id !== target.id) return conversation;
      const currentRecord = conversation as T & Record<string, unknown>;
      let rolledBack: (T & Record<string, unknown>) | null = null;
      for (const key of keys) {
        if (!Object.is(currentRecord[key], patchRecord[key])) continue;
        if (!rolledBack) rolledBack = { ...conversation } as T & Record<string, unknown>;
        (rolledBack as Record<string, unknown>)[key] = previousValues[key];
      }
      return (rolledBack ?? conversation) as T;
    };

    return updateConversation(patch, () => {
      const current = selectedRef.current;
      if (current?.id === target.id) {
        const rolledBack = rollbackMatchingFields(current);
        if (rolledBack !== current) {
          selectedRef.current = rolledBack;
          setSelected(rolledBack);
        }
      }
      // Roll back only fields that still hold this failed optimistic value.
      // The sidebar is repaired even if the user switched conversations.
      setConversations((list) => list.map(rollbackMatchingFields));
    }).finally(() => {
      executionConfigSavingRef.current = false;
      if (mountedRef.current) setExecutionConfigSaving(false);
    });
  };
  const setReasoningEffort = (reasoningEffort: ReasoningEffort): void => {
    const target = selectedRef.current;
    if (!target || target.reasoningEffort === reasoningEffort) return;
    void updateExecutionConfig({ reasoningEffort });
  };
  const archive = async (): Promise<void> => { if (!selected) return; await updateConversation({ status: selected.status === 'archived' ? 'active' : 'archived' }); selectedId.current = null; await refresh(); };
  const remove = async (): Promise<void> => { if (selected) setDeleteTarget(selected); };
  const archiveFromMenu = async (conversation: ConversationSummary): Promise<void> => {
    await client.call('conversations.update', { id: conversation.id, status: conversation.status === 'archived' ? 'active' : 'archived' });
    setConversationMenu(null);
    if (selectedId.current === conversation.id) selectedId.current = null;
    await refresh();
  };
  const pinConversation = async (conversation: ConversationSummary): Promise<void> => {
    const updated = await client.call('conversations.update', { id: conversation.id, pinned: !conversation.pinned }) as ConversationDetail;
    setConversationMenu(null);
    if (selected?.id === updated.id) setSelected(updated);
    await refresh(updated.id);
  };
  const deleteFromMenu = async (conversation: ConversationSummary): Promise<void> => {
    setConversationMenu(null);
    setDeleteTarget(conversation);
  };
  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    await client.call('conversations.delete', { id: deleteTarget.id });
    if (selectedId.current === deleteTarget.id) selectedId.current = null;
    setDeleteTarget(null);
    await refresh();
  };
  const openRename = (conversation: ConversationSummary): void => {
    setConversationMenu(null);
    setRenameTarget(conversation);
    setRenameDraft(conversation.title);
  };
  const saveRename = async (): Promise<void> => {
    if (!renameTarget || !renameDraft.trim()) return;
    const updated = await client.call('conversations.update', { id: renameTarget.id, title: renameDraft.trim() }) as ConversationDetail;
    setConversations((items) => items.map((item) => item.id === updated.id ? updated : item));
    if (selected?.id === updated.id) setSelected(updated);
    setRenameTarget(null);
  };

  const registerWorkspace = async (path: string): Promise<void> => {
    const cleanPath = path.trim();
    if (!cleanPath || workspaceAdding) return;
    setWorkspaceAdding(true);
    setWorkspaceError('');
    try {
      const workspace = await client.call('workspaces.add', { path: cleanPath }) as WorkspaceInfo;
      setWorkspaces((items) => [...items.filter((item) => item.id !== workspace.id), workspace]);
      await updateExecutionConfig({ workspaceId: workspace.id });
      setWorkspaceDialogOpen(false);
      setWorkspacePath('');
      setContextOpen(true);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
      setWorkspaceDialogOpen(true);
    } finally {
      setWorkspaceAdding(false);
    }
  };

  const addWorkspace = async (): Promise<void> => {
    if (!window.mrRobotDesktop) {
      setWorkspaceError('');
      setWorkspaceDialogOpen(true);
      return;
    }
    try {
      const selectedPath = await window.mrRobotDesktop.chooseDirectory();
      if (selectedPath) await registerWorkspace(selectedPath);
    } catch (error) {
      setWorkspaceError(`폴더 선택 창을 열지 못했습니다. 경로를 직접 입력하세요. ${error instanceof Error ? error.message : String(error)}`);
      setWorkspaceDialogOpen(true);
    }
  };

  const uploadAttachment = async (files: FileList | File[] | null): Promise<void> => {
    const picked = Array.from(files ?? []).slice(0, 20);
    const workspace = workspaces.find((item) => item.id === selected?.workspaceId) ?? workspaces.find((item) => item.isDefault);
    if (!picked.length || uploading) return;
    if (!workspace) { setComposerError('파일을 올리려면 먼저 이 대화의 컨텍스트에서 작업 폴더를 선택하세요.'); return; }
    setComposerError('');
    setUploading(true);
    uploadAbortReason.current = null;
    const uploadController = new AbortController();
    uploadAbortRef.current = uploadController;
    const uploadTimeout = window.setTimeout(() => {
      if (uploadAbortRef.current !== uploadController) return;
      uploadAbortReason.current = 'timeout';
      uploadController.abort();
    }, 120_000);
    try {
      const labels: string[] = [];
      for (const [index, file] of picked.entries()) {
        const relativePath = `.mr-robot-uploads/${Date.now()}-${index}-${file.name.replace(/[\\/:*?"<>|]/g, '_')}`;
        const base = activePc ? pcOrigin(activePc) : window.location.origin;
        const response = await fetch(`${base}/api/workspaces/upload?workspaceId=${encodeURIComponent(workspace.id)}&path=${encodeURIComponent(relativePath)}`, {
          method: 'PUT',
          headers: { 'x-mr-robot-token': client.token, 'content-type': file.type || 'application/octet-stream' },
          body: file,
          credentials: 'same-origin',
          redirect: 'error',
          signal: uploadController.signal,
        });
        const body = await response.json().catch(() => ({})) as { path?: string; error?: string };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        labels.push(`[첨부 파일: ${workspace.path}\\${String(body.path ?? relativePath).replaceAll('/', '\\')}]`);
      }
      if (mountedRef.current) setInput((value) => `${value}${value ? '\n' : ''}${labels.join('\n')}`);
    } catch (error) {
      if (mountedRef.current) setComposerError(uploadAbortReason.current === 'user' ? '파일 업로드를 중지했습니다.' : uploadAbortReason.current === 'timeout' ? '파일 업로드 시간이 초과되었습니다.' : error instanceof Error ? error.message : String(error));
    } finally {
      window.clearTimeout(uploadTimeout);
      if (uploadAbortRef.current === uploadController) uploadAbortRef.current = null;
      uploadAbortReason.current = null;
      if (mountedRef.current) {
        setUploading(false);
        if (uploadRef.current) uploadRef.current.value = '';
      }
    }
  };

  const cancelAttachment = (): void => {
    if (!uploadAbortRef.current) return;
    uploadAbortReason.current = 'user';
    uploadAbortRef.current.abort();
  };

  const toggleVoice = (): void => {
    if (listening) { recognitionRef.current?.stop(); return; }
    const Engine = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Engine) { setComposerError('이 환경에서는 음성 인식을 사용할 수 없습니다. Voice Wake 플러그인에서 로컬 엔진을 연결하세요.'); return; }
    setComposerError('');
    const recognition = new Engine();
    recognition.lang = 'ko-KR'; recognition.continuous = false; recognition.interimResults = false;
    recognition.onresult = (event) => {
      const text = event.results[0]?.[0]?.transcript?.trim() ?? '';
      const command = text.replace(/^\s*미스터\s*로봇[,.!]?\s*/i, '');
      setInput((value) => `${value}${value && command ? ' ' : ''}${command || text}`);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recognitionRef.current = recognition; setListening(true); recognition.start();
  };

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text) return;
    if (executionConfigSavingRef.current) {
      setComposerError(EXECUTION_CONFIG_SAVE_MESSAGE);
      return;
    }
    setInput('');
    await executeCommand(text);
  };
  const cancelRun = async (): Promise<void> => {
    const conversationId = runningConversationRef.current ?? selected?.id;
    if (!conversationId) return;
    setStatus('중지 요청을 전달하는 중…');
    try {
      await client.call('chat.cancel', { conversationId });
      setStatus('중지됨');
      later(() => {
        if (runningConversationRef.current !== conversationId) return;
        runningConversationRef.current = null;
        busyRef.current = false;
        setBusy(false);
        setStatus('');
        setMessages((items) => {
          const copy = [...items]; const last = copy[copy.length - 1];
          if (last?.role === 'assistant' && !last.done) { last.done = true; last.error = '사용자가 작업을 중지했습니다.'; }
          return copy;
        });
      }, 2500);
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
    }
  };
  const respondConfirm = async (approve: boolean): Promise<void> => { if (!confirm) return; const { requestId, conversationId } = confirm; setConfirm(null); await client.call('chat.confirmResponse', { requestId, conversationId, approve }).catch(() => undefined); };

  const selectedPreset = routingPresets.find((preset) => preset.id === selected?.routingPresetId);
  const selectedProvider = providers.find((provider) => provider.id === selected?.providerId);
  const defaultProvider = providers.find((provider) => provider.isDefault) ?? providers[0];
  const reasoningProvider = selected?.routingPresetId ? undefined : selectedProvider ?? defaultProvider;
  const availableReasoningEfforts = reasoningEffortsForProvider(reasoningProvider);
  const displayedReasoningEffort = availableReasoningEfforts.some(({ value }) => value === selected?.reasoningEffort) ? selected?.reasoningEffort ?? 'auto' : 'auto';
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selected?.workspaceId) ?? workspaces.find((workspace) => workspace.isDefault);
  const selectedAccess = ACCESS.find((access) => access.value === selected?.permissionMode) ?? ACCESS[1];
  const activeModeLabel = selectedPreset?.name ?? selected?.providerModel ?? selectedProvider?.model ?? selectedProvider?.label ?? '기본 단일 모델';
  const executionControlsDisabled = busy || executionConfigSaving || !selected || selected.status === 'archived';
  const hiddenMessageCount = Math.max(0, messages.length - visibleMessageLimit);
  const visibleMessages = hiddenMessageCount > 0 ? messages.slice(-visibleMessageLimit) : messages;

  return (
    <div className="conversation-layout">
      <aside className="conversation-list">
        <div className="conversation-brand"><span className="conversation-brand-mark">✦</span><b>Mr.Robot</b></div>
        <div className="conversation-list-head"><Button onClick={() => void createConversation()}>＋ 새 대화</Button><button className="text-button" onClick={() => setShowArchived((v) => !v)}>{showArchived ? '진행 중' : '보관함'}</button></div>
        <div className="conversation-items">
          {conversations.map((c) => <div
            key={c.id}
            className={`conversation-item ${selected?.id === c.id ? 'active' : ''}`}
            onContextMenu={(event) => {
              event.preventDefault();
              setConversationMenu({ conversation: c, x: Math.min(event.clientX, window.innerWidth - 210), y: Math.min(event.clientY, window.innerHeight - 220) });
            }}
          ><button type="button" className="conversation-item-main" onClick={() => void loadConversation(c.id)}><span className="conversation-title">{c.pinned && <span className="conversation-pin">📌</span>}{c.title}</span><span className="conversation-meta">{new Date(c.updatedAt).toLocaleDateString()} · {c.messageCount}개 메시지</span></button><button
            type="button"
            className="conversation-more"
            aria-label={`${c.title} 메뉴`}
            title="대화 메뉴"
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              setConversationMenu({ conversation: c, x: Math.max(8, Math.min(rect.right - 190, window.innerWidth - 214)), y: Math.min(rect.bottom + 7, window.innerHeight - 220) });
            }}
          >•••</button></div>)}
          {conversations.length === 0 && <div className="conversation-empty">{showArchived ? '보관한 대화가 없습니다.' : '대화가 없습니다.'}</div>}
        </div>
        {profile}
      </aside>

      <section
        className={`chat-wrap ${draggingFiles ? 'dragging-files' : ''}`}
        onDragEnter={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current += 1; setDraggingFiles(true); } }}
        onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
        onDragLeave={(event) => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDraggingFiles(false); }}
        onDrop={(event) => { event.preventDefault(); dragDepth.current = 0; setDraggingFiles(false); void uploadAttachment(event.dataTransfer.files); }}
      >
        {draggingFiles && <div className="file-drop-overlay"><b>파일을 놓아 대화에 첨부</b><span>{selectedWorkspace ? '선택한 작업 폴더에 직접 업로드 · AI 토큰 0' : '먼저 작업 폴더를 선택해야 합니다'}</span></div>}
        {selected && <>
          <header className="chat-commandbar">
            <div className="chat-title-group">
              <input aria-label="대화 이름" className="conversation-title-input" value={selected.title} onChange={(e) => setSelected({ ...selected, title: e.target.value })} onBlur={() => void updateConversation({ title: selected.title })} />
              <span className={`agent-state ${busy || executionConfigSaving ? 'working' : ''}`}><i />{executionConfigSaving ? '실행 설정 저장 중…' : busy ? (status || '작업 준비 중') : activeModeLabel}</span>
            </div>
            <div className="chat-quick-controls">
              {activePc && executionPcs.length > 0 && <Select
                className="execution-pc-select"
                aria-label="실행 PC"
                title="명령과 파일 작업을 실행할 PC"
                value={activePc.id}
                onChange={(event) => onSwitchExecutionPc?.(event.target.value)}
                disabled={busy || executionConfigSaving || executionPcs.length < 2}
              >
                {executionPcs.map((pc) => <option key={pc.id} value={pc.id}>실행 PC · {pc.name}</option>)}
              </Select>}
              <Select className="scenario-select" aria-label="대화 모델 시나리오" value={selected.routingPresetId ?? ''} onChange={(event) => {
                const target = selectedRef.current;
                if (!target) return;
                const routingPresetId = event.target.value || null;
                const nextProvider = routingPresetId ? undefined : selectedProvider ?? defaultProvider;
                void updateExecutionConfig({
                  routingPresetId,
                  reasoningEffort: compatibleReasoningEffort(target.reasoningEffort, nextProvider),
                });
              }} disabled={executionControlsDisabled}>
                <option value="">단일 모델</option>
                {routingPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.builtin ? '' : '내 시나리오 · '}{preset.name}{preset.executionMode === 'pipeline' ? ' · 순차' : preset.executionMode === 'vote' ? ' · 투표' : preset.executionMode === 'hybrid' ? ' · 혼합' : preset.executionMode === 'swarm' ? ' · 경쟁 스웜' : ''}</option>)}
              </Select>
              <Select
                className="model-select"
                aria-label="대화 모델"
                value={selected.routingPresetId ? '' : selected.providerId ? modelChoiceValue(selected.providerId, selected.providerModel ?? providers.find((provider) => provider.id === selected.providerId)?.model ?? '') : ''}
                onChange={(event) => {
                  const target = selectedRef.current;
                  if (!target) return;
                  if (!event.target.value) {
                    if (!target.routingPresetId) void updateExecutionConfig({
                      providerId: null,
                      providerModel: null,
                      reasoningEffort: compatibleReasoningEffort(target.reasoningEffort, defaultProvider),
                    });
                    return;
                  }
                  const [providerId, providerModel] = JSON.parse(event.target.value) as [string, string];
                  void updateExecutionConfig({
                    routingPresetId: null,
                    providerId,
                    providerModel,
                    reasoningEffort: compatibleReasoningEffort(target.reasoningEffort, providers.find((provider) => provider.id === providerId)),
                  });
                }}
                disabled={executionControlsDisabled}
              >
                <option value="">{selected.routingPresetId ? '시나리오 자동 배정' : '기본 모델'}</option>
                {providers.map((provider) => <optgroup key={provider.id} label={provider.label}>
                  {(providerModels[provider.id] ?? [provider.model]).map((model) => <option key={model} value={modelChoiceValue(provider.id, model)}>{model}</option>)}
                </optgroup>)}
              </Select>
            </div>
            <button type="button" className={`context-trigger ${contextOpen ? 'active' : ''}`} aria-expanded={contextOpen} onClick={() => setContextOpen((value) => !value)}>
              <span className="context-trigger-icon">◎</span><span><b>컨텍스트</b><small>{selectedWorkspace?.name ?? '폴더 없음'} · {selectedAccess.short}</small></span><em>⌄</em>
            </button>
            <button type="button" className={`icon-action ${selected.pinned ? 'active' : ''}`} title={selected.pinned ? '대화 고정 해제' : '대화 고정'} aria-label={selected.pinned ? '대화 고정 해제' : '대화 고정'} onClick={() => void pinConversation(selected)} disabled={busy}>⌖</button>
          </header>
          {contextOpen && <section className="chat-context-panel" aria-label="대화 컨텍스트 설정">
            <div className="context-panel-head"><div><b>이 대화의 실행 컨텍스트</b><span>모델이 볼 작업 범위와 실행 권한을 대화별로 저장합니다.</span></div><button type="button" onClick={() => setContextOpen(false)} aria-label="컨텍스트 닫기">×</button></div>
            <div className="context-settings-grid">
              <label className="context-field"><span>추론 강도</span><Select aria-label="컨텍스트 추론 강도" value={displayedReasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)} disabled={executionControlsDisabled}>{availableReasoningEfforts.map((effort) => <option key={effort.value} value={effort.value}>{effort.label}</option>)}</Select></label>
              <label className="context-field context-workspace"><span>작업 폴더</span><div><Select aria-label="작업 폴더" value={selected.workspaceId ?? workspaces.find((item) => item.isDefault)?.id ?? ''} onChange={(event) => void updateExecutionConfig({ workspaceId: event.target.value || null })} disabled={executionControlsDisabled}><option value="">작업 폴더 없음</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.isDefault ? '기본 · ' : ''}{workspace.name}</option>)}</Select><Button variant="ghost" onClick={() => void addWorkspace()} disabled={executionControlsDisabled}>폴더 추가</Button></div></label>
              <div className="context-field access-field"><span>액세스 권한</span><div className="access-options">{ACCESS.map((access) => <button type="button" key={access.value} className={selected.permissionMode === access.value ? 'active' : ''} onClick={() => void updateExecutionConfig({ permissionMode: access.value })} disabled={executionControlsDisabled}><b>{access.label}</b><small>{access.detail}</small></button>)}</div><small className="context-help">연결 기기에 설정된 권한 상한보다 넓게 실행할 수 없습니다.</small></div>
            </div>
            <div className="context-panel-actions"><span>{selectedWorkspace ? selectedWorkspace.path : '작업 폴더를 지정하면 Codex·Claude가 해당 프로젝트에서 네이티브 에이전트로 실행됩니다.'}</span><Button variant="ghost" onClick={() => void archive()} disabled={busy}>{selected.status === 'archived' ? '대화 복원' : '보관함으로 이동'}</Button><Button variant="danger" onClick={() => void remove()} disabled={busy}>대화 삭제</Button></div>
          </section>}
        </>}

        <div className="chat-scroll" ref={scroller}>
          {messages.length === 0 && <div className="chat-empty"><div className="chat-empty-orb">✦</div><span className="chat-empty-kicker">MR.ROBOT AGENT</span><h2>무엇을 맡길까요?</h2><p>{selectedWorkspace ? <><b>{selectedWorkspace.name}</b>에서 파일을 읽고 실제 작업을 수행할 준비가 됐습니다.</> : '작업 폴더를 연결하면 프로젝트를 이해하고 파일까지 직접 다룰 수 있습니다.'}</p><div className="prompt-suggestions"><button onClick={() => setInput('이 작업 폴더의 구조와 현재 상태를 분석해줘')}>프로젝트 분석<span>구조·의존성·위험 확인</span></button><button onClick={() => setInput('현재 문제를 재현하고 원인을 찾아서 수정한 뒤 테스트해줘')}>문제 해결<span>재현부터 검증까지</span></button><button onClick={() => setInput('이 프로젝트의 사용성과 UI를 검토하고 개선해줘')}>사용성 개선<span>UI·UX 전반 검토</span></button><button onClick={() => setContextOpen(true)}>컨텍스트 설정<span>폴더·권한·추론 선택</span></button></div></div>}
          {hiddenMessageCount > 0 && <button type="button" className="chat-history-more" onClick={() => setVisibleMessageLimit((count) => count + 160)}>이전 메시지 {Math.min(160, hiddenMessageCount)}개 더 보기</button>}
          {visibleMessages.map((m) => <div key={m.id} className={`msg-row ${m.role}`}><div className="msg-avatar">{m.role === 'user' ? 'U' : '✦'}</div><div className="msg-body"><div className="msg-meta">{m.role === 'user' ? '나' : 'Mr.Robot'}</div><div className="msg-bubble">{m.content ? (m.role === 'assistant' ? <MarkdownMessage>{m.content}</MarkdownMessage> : <div className="user-message-text">{m.content}</div>) : (!m.done && <span className="typing">작업을 분석하고 있습니다<span className="dots"><span>.</span><span>.</span><span>.</span></span></span>)}{m.error && <div className="msg-error">⚠️ {m.error}</div>}</div>{m.tools.length > 0 && <div className="tool-list" aria-label="작업 활동">{m.tools.map((t) => <div key={t.key} className={`tool-chip ${t.status}`} title={t.summary}><span className="tool-icon">{TOOL_EMOJI[t.name] ?? '🔌'}</span><span className="tool-name">{TOOL_LABEL[t.name] ?? t.name}</span>{t.summary && <span className="tool-summary">{t.summary}</span>}<span className="tool-state">{t.status === 'start' ? <Spinner size={12} /> : t.status === 'done' ? '✓' : '!'}</span></div>)}</div>}</div></div>)}
        </div>

        <div className="chat-inputbar">
          {executionConfigSaving ? <div className="run-status live"><span className="run-status-icon"><Spinner size={13} /></span><span><b>모델 실행 설정 저장 중…</b><small>저장이 끝나면 새 설정으로 명령을 보낼 수 있습니다.</small></span></div> : (status || route) && <div className={`run-status ${busy ? 'live' : 'complete'}`}><span className="run-status-icon">{busy ? <Spinner size={13} /> : '✓'}</span><span><b>{busy ? status || '작업 준비 중' : '마지막 실행 완료'}</b>{route && <small>{route.advisor ? `${route.advisor.providerLabel} 자문 → ` : ''}{route.providerLabel} · {route.model} · {route.reason}</small>}</span></div>}
          {voiceAck && <div className="voice-ack"><span>🎙</span><b>{voiceAck}</b></div>}
          {composerError && <div className="composer-error"><span>!</span>{composerError}<button type="button" aria-label="오류 닫기" onClick={() => setComposerError('')}>×</button></div>}
          <textarea className="chat-input" rows={2} placeholder={busy ? '실행 중인 작업에 추가할 명령을 입력하세요…' : 'PC 에이전트에게 시킬 일을 입력하세요…'} value={input} disabled={!selected || selected.status === 'archived'} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
          <div className="chat-actions">
            <div className="composer-options">
              <label className="composer-reasoning" title={executionConfigSaving ? '실행 설정을 저장하는 중입니다.' : busy ? '작업 실행 중에는 추론 강도를 변경할 수 없습니다.' : '이 대화에 사용할 추론 강도'}>
                <span className="composer-reasoning-icon" aria-hidden="true">✦</span>
                <span className="composer-reasoning-label">추론</span>
                <Select className="composer-reasoning-select" aria-label="입력창 추론 강도" value={displayedReasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)} disabled={executionControlsDisabled}>
                  {availableReasoningEfforts.map((effort) => <option key={effort.value} value={effort.value}>{effort.label}</option>)}
                </Select>
              </label>
              {selected?.compactedMessages ? <span className="compaction-note">이전 메시지 {selected.compactedMessages}개 압축됨</span> : null}
            </div>
            <input ref={uploadRef} hidden type="file" multiple onChange={(event) => void uploadAttachment(event.target.files)} />
            <Button variant={uploading ? 'danger' : 'ghost'} onClick={() => uploading ? cancelAttachment() : uploadRef.current?.click()} disabled={!uploading && !selectedWorkspace}>{uploading ? '업로드 취소' : '＋ 파일'}</Button>
            <Button variant={listening ? 'accent' : 'ghost'} onClick={toggleVoice}>{listening ? '듣는 중…' : '🎙 음성'}</Button>
            {busy && <Button onClick={() => void send()} disabled={!input.trim() || executionConfigSaving}>명령 끼워넣기</Button>}
            {busy ? <Button variant="danger" onClick={() => void cancelRun()}>중지</Button> : <Button onClick={() => void send()} disabled={!input.trim() || !selected || executionConfigSaving}>{executionConfigSaving ? '설정 저장 중…' : '보내기'}</Button>}
          </div>
        </div>
      </section>

      {conversationMenu && <div className="conversation-context-menu" role="menu" aria-label={`${conversationMenu.conversation.title} 대화 메뉴`} style={{ left: conversationMenu.x, top: conversationMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
        <div className="context-menu-title">{conversationMenu.conversation.title}</div>
        <button onClick={() => void pinConversation(conversationMenu.conversation)}><span>📌</span> {conversationMenu.conversation.pinned ? '고정 해제' : '대화 고정'}</button>
        <button onClick={() => openRename(conversationMenu.conversation)}><span>✎</span> 이름 바꾸기</button>
        <button onClick={() => void archiveFromMenu(conversationMenu.conversation)}><span>▣</span> {conversationMenu.conversation.status === 'archived' ? '진행 중으로 복원' : '보관함으로 이동'}</button>
        <div className="context-menu-separator" />
        <button className="danger" onClick={() => void deleteFromMenu(conversationMenu.conversation)}><span>⌫</span> 삭제</button>
      </div>}

      <Modal open={renameTarget !== null} onClose={() => setRenameTarget(null)} title="대화 이름 바꾸기">{renameTarget && <div className="rename-dialog"><Input autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveRename(); }} /><div className="modal-actions"><Button variant="ghost" onClick={() => setRenameTarget(null)}>취소</Button><Button variant="accent" disabled={!renameDraft.trim()} onClick={() => void saveRename()}>이름 저장</Button></div></div>}</Modal>
      <Modal open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="대화를 삭제할까요?">{deleteTarget && <div className="delete-dialog"><div className="delete-dialog-icon">⌫</div><div><b>{deleteTarget.title}</b><p>대화와 저장된 실행 기록이 영구적으로 삭제됩니다. 이 작업은 되돌릴 수 없습니다.</p></div><div className="modal-actions"><Button variant="ghost" onClick={() => setDeleteTarget(null)}>취소</Button><Button variant="danger" onClick={() => void confirmDelete()}>영구 삭제</Button></div></div>}</Modal>
      <Modal open={workspaceDialogOpen} onClose={() => { if (!workspaceAdding) setWorkspaceDialogOpen(false); }} title="작업 폴더 추가">
        <div className="workspace-dialog">
          <div className="workspace-dialog-icon">⌂</div>
          <div><b>에이전트가 작업할 폴더를 연결합니다.</b><p>절대 경로를 입력하면 존재 여부를 확인한 뒤 이 대화에 바로 적용합니다.</p></div>
          <label className="field workspace-path-field"><span className="field-label">Windows 폴더 경로</span><Input autoFocus value={workspacePath} onChange={(event) => { setWorkspacePath(event.target.value); setWorkspaceError(''); }} onKeyDown={(event) => { if (event.key === 'Enter') void registerWorkspace(workspacePath); }} placeholder="예: C:\\Work\\MyProject" /></label>
          {workspaceError && <div className="inline-error">{workspaceError}</div>}
          <div className="modal-actions"><Button variant="ghost" onClick={() => setWorkspaceDialogOpen(false)} disabled={workspaceAdding}>취소</Button><Button variant="accent" onClick={() => void registerWorkspace(workspacePath)} disabled={!workspacePath.trim() || workspaceAdding}>{workspaceAdding ? '확인 중…' : '폴더 연결'}</Button></div>
        </div>
      </Modal>
      <Modal open={confirm !== null} onClose={() => void respondConfirm(false)} title="작업 승인 필요">{confirm && <div className="confirm-box"><p className="confirm-text">{confirm.conversationId === selected?.id ? `현재 대화 ‘${confirm.conversationTitle}’에서 다음 작업을 요청했습니다.` : `백그라운드 대화 ‘${confirm.conversationTitle}’에서 요청한 작업입니다. 현재 보고 있는 대화와 다릅니다.`}</p><div className="confirm-cmd"><span className="confirm-tool">{TOOL_EMOJI[confirm.tool] ?? '🔧'} {confirm.tool}</span><code>{confirm.summary}</code></div><div className="confirm-actions"><Button variant="danger" onClick={() => void respondConfirm(false)}>거부</Button><Button onClick={() => void respondConfirm(true)}>이 대화 작업 허용</Button></div></div>}</Modal>
    </div>
  );
}
