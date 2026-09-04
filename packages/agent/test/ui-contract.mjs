import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');

function sourceFiles(directory) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  const result = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const path = join(absolute, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(path.slice(root.length + 1)));
    else if (['.ts', '.tsx'].includes(extname(entry.name))) result.push(path);
  }
  return result;
}

const uiSource = [...sourceFiles('packages/web/src'), ...sourceFiles('apps/mobile/src')]
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
const serverSource = read('packages/agent/src/server/server.ts');
const uiCalls = new Set([...uiSource.matchAll(/client\.call\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]));
const handlers = new Set([...serverSource.matchAll(/h\.set\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]));
const missingHandlers = [...uiCalls].filter((method) => !handlers.has(method));
if (missingHandlers.length) throw new Error(`UI RPC methods without handlers: ${missingHandlers.join(', ')}`);

const main = read('packages/desktop/main.mjs');
const preload = read('packages/desktop/preload.cjs');
const stage = read('scripts/stage-desktop.mjs');
if (!main.includes("preload: resolve(here, 'preload.cjs')")) throw new Error('desktop does not load the CommonJS preload bridge');
if (!preload.includes("ipcRenderer.invoke('mr-robot:choose-directory')")) throw new Error('directory picker is missing from preload bridge');
if (!main.includes("ipcMain.handle('mr-robot:choose-directory'")) throw new Error('directory picker IPC handler is missing');
if (!stage.includes("copyFileSync(join(desktop, 'preload.cjs')")) throw new Error('desktop stage omits the preload bridge');

const chat = read('packages/web/src/views/ChatView.tsx');
const app = read('packages/web/src/App.tsx');
const ui = read('packages/web/src/components/ui.tsx');
const settings = read('packages/web/src/views/SettingsView.tsx');
const pluginsView = read('packages/web/src/views/PluginsView.tsx');
const pluginCategories = read('packages/web/src/plugin-categories.ts');
const schedulesView = read('packages/web/src/views/SchedulesView.tsx');
const dependencySetup = read('packages/web/src/components/DependencySetup.tsx');
const routingGraph = read('packages/web/src/components/RoutingGraphEditor.tsx');
const pcsRegistry = read('packages/web/src/pcs.ts');
const connectGate = read('packages/web/src/components/ConnectGate.tsx');
const profileMenu = read('packages/web/src/components/ProfileMenu.tsx');
const remoteLink = read('packages/agent/src/plugins/remote-link.ts');
const dependenciesSource = read('packages/agent/src/dependencies.ts');
const desktopMain = read('packages/desktop/main.mjs');
const mobileChat = read('apps/mobile/src/screens/ChatScreen.tsx');
const mobileHome = read('apps/mobile/src/screens/HomeScreen.tsx');
const mobileApp = read('apps/mobile/App.tsx');
const mobilePcList = read('apps/mobile/src/screens/PcListScreen.tsx');
const mobilePcsRegistry = read('apps/mobile/src/pcs.ts');
const mobileRpc = read('apps/mobile/src/pairing.ts');
const mobileRpcClient = read('apps/mobile/src/rpc.ts');
const mobileAppConfig = read('apps/mobile/app.json');
const webRpc = read('packages/web/src/rpc.ts');
const mobileManifest = read('apps/mobile/android/app/src/main/AndroidManifest.xml');
const css = read('packages/web/src/styles.css');
if (/window\.(prompt|alert|confirm)\(/.test(uiSource)) throw new Error('native browser prompt/alert/confirm returned to the product UI');
if (!chat.includes('chat-context-panel') || !chat.includes('workspaceDialogOpen')) throw new Error('conversation context/workspace fallback UI is missing');
if (!chat.includes('MarkdownMessage') || !existsSync(join(root, 'packages/web/src/components/MarkdownMessage.tsx'))) throw new Error('rich assistant response rendering is missing');
if (!ui.includes("size?: 'default' | 'wide'")) throw new Error('responsive modal sizing contract is missing');
if (!settings.includes('size="wide"')) throw new Error('preset browser does not request a wide modal');
if (!css.includes('.modal-wide') || !css.includes('.preset-browser { width: 100%')) throw new Error('preset modal overflow safeguards are missing');
if (!css.includes('.preset-browser-preview .graph-editor { flex: 0 0 auto; }')) throw new Error('compact preset preview can still crush and clip its graph');
if (!css.includes('.chat-context-panel { flex: 0 1 auto; max-height: min(44dvh, 420px); overflow-y: auto;')) throw new Error('compact chat context panel can overflow behind the bottom navigation');
if (!settings.includes('Number(telemetry.cachedPromptTokens ?? 0)')
  || !settings.includes('Number(telemetry.cacheHitRate ?? 0)')
  || !settings.includes('Number(telemetry.accountedTokens ?? (Number(telemetry.promptTokens ?? 0) + Number(telemetry.completionTokens ?? 0)))')
  || !settings.includes('<span>감사 토큰</span>')) throw new Error('settings telemetry is not backward-compatible or missing host-accounted audit tokens');
if (!chat.includes('aria-label={`${c.title} 메뉴`}') || !chat.includes('setConversationMenu({ conversation: c')) throw new Error('conversation ellipsis is not an actual menu trigger');
if (!app.includes("client.on('voice.command'") || !app.includes("setView('chat')") || !chat.includes('executeCommand(voiceCommand.text)')) throw new Error('recognized wake commands are not globally queued and connected to chat execution');
if (!chat.includes('finally {') || !chat.includes('busyRef.current = false')) throw new Error('chat busy state has no request-completion fallback');
if (!chat.includes('const appendPendingAttempt = (items: UiMsg[], text: string): UiMsg[] =>')
  || !chat.includes("assistant?.role === 'assistant'")
  || !chat.includes('Boolean(assistant.error)')
  || !chat.includes("user?.role === 'user'")
  || !chat.includes('user.content === text')
  || !chat.includes('const base = retryingFailedTail ? items.slice(0, -2) : items;')
  || !chat.includes('setMessages((items) => appendPendingAttempt(items, text))')) {
  throw new Error('desktop chat can accumulate a duplicate tail when the exact failed request is retried');
}
if (!chat.includes('signal: uploadController.signal') || !chat.includes("uploadAbortReason.current = 'timeout'") || !chat.includes('업로드 취소')) throw new Error('chat drag-and-drop uploads lack cancellation and timeout UX');
if (!chat.includes('routingPresetId: null,') || !chat.includes('providerId,') || !chat.includes('providerModel,')) throw new Error('model picker cannot switch directly from a routing preset to single-model mode');
if (!chat.includes("const COMMON_REASONING_EFFORTS = new Set<ReasoningEffort>(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])")
  || !chat.includes('provider?.supportedReasoning.length')
  || !chat.includes("value === 'auto' || supported.has(value)")) throw new Error('desktop reasoning choices can lose provider capabilities, auto, or the common fallback');
const desktopComposerInput = chat.indexOf('<textarea className="chat-input"');
const desktopReasoningControl = chat.indexOf('className="composer-reasoning"');
if (desktopComposerInput < 0 || desktopReasoningControl < desktopComposerInput
  || !chat.includes('aria-label="입력창 추론 강도"')
  || !chat.includes('disabled={executionControlsDisabled}')) throw new Error('desktop reasoning selector is not accessible, composer-local, or locked during a run or settings save');
if ((chat.match(/setReasoningEffort\(event\.target\.value as ReasoningEffort\)/g) ?? []).length < 2
  || !chat.includes('selectedRef.current = optimistic')
  || !chat.includes('executionConfigSavingRef.current = true')
  || !chat.includes('rollbackMatchingFields')
  || !chat.includes('Object.is(currentRecord[key], patchRecord[key])')
  || !chat.includes('if (executionConfigSavingRef.current)')) throw new Error('desktop execution settings do not share rollback-safe persistence and a synchronous send lock');
const desktopPermissionSelect = chat.indexOf('aria-label="대화 권한"');
const desktopTokenPolicySelect = chat.indexOf('aria-label="대화 토큰 정책"');
if (desktopPermissionSelect < 0 || desktopTokenPolicySelect < desktopPermissionSelect
  || !chat.includes('className="chat-policy-controls"')
  || !css.includes('.chat-policy-controls { grid-column: 1 / -1; min-width: 0; display: grid;')
  || !chat.includes("tokenPolicy?: ConversationTokenPolicy;")
  || !chat.includes("tokenPolicy: client.canUseAuditOnly ? conversation.tokenPolicy ?? 'adaptive' : 'adaptive'")
  || !chat.includes("value={client.canUseAuditOnly ? selected.tokenPolicy ?? 'adaptive' : 'adaptive'}")
  || !chat.includes('disabled={executionControlsDisabled || !client.canUseAuditOnly}')
  || !chat.includes("TOKEN_POLICIES.filter((policy) => client.canUseAuditOnly || policy.value === 'adaptive')")
  || !chat.includes('적응형 · 품질 우선')
  || !chat.includes('무제한 · 감사만')
  || !chat.includes('대화 기록과 설정의 텔레메트리에서 확인')) {
  throw new Error('desktop per-conversation token policy is not adjacent to permission, rollback-safe, run-locked, or administrator-gated');
}
if (!chat.includes('updateExecutionConfig({ workspaceId:')
  || !chat.includes('updateExecutionConfig({ permissionMode:')
  || !chat.includes('const defaultProvider = providers.find((provider) => provider.isDefault) ?? providers[0]')) throw new Error('desktop workspace, access, or default-provider settings can race command execution');
if (!css.includes('.composer-options { min-width: 0; flex: 1 1 250px;')
  || !css.includes('.composer-options { width: 100%; flex-basis: 100%; }')
  || !css.includes('.composer-reasoning-label { display: none; }')) throw new Error('desktop reasoning selector can clip or crowd compact chat layouts');
if (!routingGraph.includes('graph-port-in') || !routingGraph.includes('graph-port-out') || !routingGraph.includes('edge-preview')) throw new Error('routing graph lacks intuitive directional drag connection ports');
if (!routingGraph.includes('previewColumnStep') || !routingGraph.includes('graph-content-sizer')) throw new Error('read-only routing preview can overlap nodes instead of scrolling on narrow screens');
if (!routingGraph.includes('removeEdge') || !routingGraph.includes('reverseEdge') || !routingGraph.includes('edge-inspector')) throw new Error('routing edges cannot be selected, reversed and deleted');
if (!routingGraph.includes('addGroup') || !routingGraph.includes('updateGroup') || !routingGraph.includes('removeGroup') || !routingGraph.includes('group-dot-picker')) throw new Error('routing meeting groups lack create/update/delete/assignment controls');
if (!routingGraph.includes('startGroupInteraction') || !routingGraph.includes("mode: 'move' | 'resize'") || !routingGraph.includes('syncGroupMembership') || !routingGraph.includes('group-resize-handle')) throw new Error('routing groups cannot be moved, resized, and populated spatially');
if (!routingGraph.includes('graph-health') || !routingGraph.includes('orphanNodes')) throw new Error('routing graph does not report disconnected nodes');
if (!css.includes('.routing-group-bubble') || !css.includes('.graph-edge.selected') || !css.includes('stroke: #766dff !important')) throw new Error('routing groups and persistent edges lack visual design contracts');
if (!pcsRegistry.includes('connectionOrigins') || !pcsRegistry.includes('activeOrigin') || !pcsRegistry.includes('originForDiscoveredHost')) throw new Error('desktop registry does not preserve per-address origins for LAN/HTTPS fallback');
if (!pcsRegistry.includes('if (!result.ok) throw') || pcsRegistry.includes("loadPcs().catch(() => []")) throw new Error('secure desktop registry failures can be mistaken for an empty registry');
if (!pcsRegistry.includes('sessionStorage.setItem(KEY')
  || !pcsRegistry.includes('localStorage.removeItem(KEY)')
  || pcsRegistry.includes('localStorage.setItem(KEY')) throw new Error('browser bearer registry can persist beyond the current tab session');
if (!connectGate.includes('clientOwner') || !connectGate.includes('ownsClient()') || !connectGate.includes('if (!isCurrent() || !ownsClient()) return false')) throw new Error('connection gate lacks attempt-scoped client ownership guards');
if (!connectGate.includes('const desktopAutomaticMode = Boolean(window.mrRobotDesktop && !manageConnections)')
  || !connectGate.includes('savedPcById(registered, lastId)')
  || !connectGate.includes('if (desktopAutomaticMode)')
  || !connectGate.includes('await connectTo(localPc, false)')
  || !connectGate.includes('setLastPcId(null)')
  || !connectGate.includes('저장된 실행 PC를 확인하는 중')) throw new Error('desktop saved-host restore or safe local fallback can regress');
if (!connectGate.includes('if (manageConnections)') || !profileMenu.includes('원격 PC 추가·관리') || !profileMenu.includes('로컬 에이전트 · 준비됨')) throw new Error('desktop optional remote-PC management is not separated from local startup');
if (!chat.includes('aria-label="실행 PC"')
  || !chat.includes('onSwitchExecutionPc?.(event.target.value)')
  || !app.includes('executionPcs={pcList}')
  || !profileMenu.includes('실행 PC 선택')) throw new Error('desktop chat cannot explicitly change its active execution host');
if (!app.includes("client.call('chat.runs'")
  || !app.includes('if (executionBusy) { showBusySwitchNotice(); return; }')
  || !profileMenu.includes('작업 중 · 완료 또는 중지 후 변경')
  || !chat.includes('onExecutionBusyChange?.(true)')) throw new Error('desktop can abandon a running job while changing execution PCs');
if (!connectGate.includes("/^(?:\\d{6}|\\d{12})$/.test(pin)") || !connectGate.includes("slice(0, 12)") || !connectGate.includes('외출용 12자리 일회용 코드')) throw new Error('desktop remote-PC registration does not accept the stronger travel handoff code');
if (!main.includes("openSync(file, 'r+')")) throw new Error('Windows desktop registry fsync can regress to an EPERM-prone read-only handle');
if (!remoteLink.includes('operationGeneration') || !remoteLink.includes('pendingStart') || !remoteLink.includes('pendingStartPromise') || !remoteLink.includes('pendingConfiguredStartPromise') || !remoteLink.includes('ownsCurrentProcess')) throw new Error('remote link lifecycle lacks stale child callback or duplicate-start guards');
if (!pluginsView.includes('refreshRemotePairing(status)') || !pluginsView.includes('host: status.publicUrl') || !pluginsView.includes("QRCode.toDataURL(payload") || !pluginsView.includes('모바일 원탭 연결')) throw new Error('remote link does not refresh a one-tap HTTPS handoff QR safely');
const passivePluginQrRefresh = pluginsView.slice(pluginsView.indexOf('const refreshRemotePairing'), pluginsView.indexOf('const revealNamedPairingQr'));
const passiveSettingsQrRefresh = settings.slice(settings.indexOf('const remoteOrigin = remoteStatus?.running'), settings.indexOf('const applyPreset'));
if (passivePluginQrRefresh.includes("name: 'remote-link.pairing.payload'") || passiveSettingsQrRefresh.includes("name: 'remote-link.pairing.payload'")) throw new Error('passive refresh can create a named-tunnel handoff QR without explicit approval');
if ((pluginsView.match(/name: 'remote-link\.pairing\.payload'/g) ?? []).length !== 1 || (settings.match(/name: 'remote-link\.pairing\.payload'/g) ?? []).length !== 1) throw new Error('named-tunnel handoff QR is not isolated to one explicit action per administrator view');
if (![pluginsView, settings].every((source) => source.includes('ACCESS_QR_REVEAL_MS = 60_000')
  && source.includes('보안 QR 60초 표시')
  && source.includes('장기 Cloudflare 자격증명')
  && source.includes('휴대폰에서')
  && source.includes('window.clearTimeout'))
  || !pluginsView.includes('clearRemotePairingQr();')
  || !settings.includes('clearPairingQr();')) throw new Error('named-tunnel QR lacks explicit approval, 60-second expiry, no-secret guidance, or state cleanup');
if (remoteLink.includes('cloudflareAccess: access') || remoteLink.includes('requiresCloudflareAccess: true') || !remoteLink.includes('cloudflareBootstrap')) throw new Error('named-tunnel QR can regress to exporting the long-lived Cloudflare Access credential');
if ((serverSource.match(/'remote-link\.changed'/g) ?? []).length < 2 || !pluginsView.includes("client.on('remote-link.changed'") || !settings.includes("client.on('remote-link.changed'")) throw new Error('Quick Link runtime status is not delivered live to both administrator views');
if (!pluginsView.includes('plugin-live-route') || !css.includes('.plugin-live-route') || !pluginsView.includes('expanded !== p.id')) throw new Error('running Quick Link address disappears when the plugin card is collapsed');
if (!settings.includes("name: 'remote-link.status'") || !settings.includes("'고정 Tunnel'") || !settings.includes('host: remoteOrigin') || !settings.includes('원격 보안 페어링 QR')) throw new Error('mobile connection settings do not merge the active HTTPS remote link into the visible route and QR');
if (!settings.includes("pairing?.host !== '127.0.0.1'") || !settings.includes('pairing-remote-required') || !settings.includes('원격 연결을 먼저 준비하세요')) throw new Error('mobile connection settings can render a loopback QR that mobile clients must reject');
if (!settings.includes('startPairingQuickLink') || !settings.includes('Quick Link 시작·QR 만들기') || !settings.includes("client.call('pairing.createRemoteHandoff'")) throw new Error('mobile connection settings cannot bootstrap a strong remote handoff QR from the empty state');
if (![settings, pluginsView].every((source) => source.includes("width: 300, margin: 4, errorCorrectionLevel: 'M'") && source.includes('hosts: [...new Set(['))) throw new Error('remote pairing QR readability or duplicate-host normalization can regress');
if (!settings.includes("client.call('pairing.createRemoteHandoff'") || !pluginsView.includes("client.call('pairing.createRemoteHandoff'") || !settings.includes('12자리 외출 코드') || !pluginsView.includes('10분·1회용 외출 코드 생성') || ![settings, pluginsView].every((source) => source.includes('ttlMinutes: 10'))) throw new Error('Quick Link administrator views lack the bounded one-use remote handoff code');
if (!settings.includes('pin: remoteHandoff.pin') || !pluginsView.includes('pin: handoff.pin') || !settings.includes('일반 6자리 PIN을 받지 않으며') || !pluginsView.includes('일반 6자리 PIN은 공개 주소에서 거부됩니다.')) throw new Error('public remote QR can regress to the ordinary six-digit pairing PIN');
if (/remoteOrigin[\s\S]{0,240}pin:\s*pairing\.pin/.test(settings) || /status\.publicUrl[\s\S]{0,300}pin:\s*pairing\.pin/.test(pluginsView)) throw new Error('ordinary six-digit pairing PIN is embedded in a public Cloudflare QR');
if (!settings.includes("client.call('pairing.revokeRemoteHandoff'") || !pluginsView.includes("client.call('pairing.revokeRemoteHandoff'") || !settings.includes('즉시 폐기') || !pluginsView.includes('즉시 폐기')) throw new Error('remote handoff code cannot be explicitly revoked from administrator views');
if (settings.includes('외출 코드: ${remoteHandoff.pin}') || pluginsView.includes('외출 코드: ${remoteHandoff.pin}')) throw new Error('clipboard failures can persist the remote handoff plaintext in ordinary UI status messages');
if (!pluginsView.includes('공개 연결 승인') || !pluginsView.includes('위험을 이해했으며 연결') || !pluginsView.includes('사용 후 반드시 링크를 중지')) throw new Error('Cloudflare links can expose the agent publicly without explicit informed confirmation');
if (!pluginsView.includes('if (remoteActionRef.current) return') || !pluginsView.includes("setRemoteStage('사전 상태 확인')")) throw new Error('Quick Link fast connect lacks duplicate-click and staged loading guards');
if (!pluginsView.includes("client.call('dependencies.install', { id: 'cloudflared' }, 20 * 60_000)") || !pluginsView.includes("client.call('plugins.setEnabled', { id: plugin.id, enabled: true })") || !pluginsView.includes('Quick Link 빠른 연결')) throw new Error('Quick Link does not bootstrap its dependency and plugin after approval');
if (!pluginsView.includes('remoteStatusRef.current') || pluginsView.includes('refreshRemotePairing, remoteStatus]') || !pluginsView.includes('interactive = false')) throw new Error('Orca and Remote Link passive refresh can regress into an RPC/render/busy-opacity loop');
if (!pluginsView.includes('remotePairingRouteRef.current === routeKey') || !pluginsView.includes('remoteStatusRevisionRef.current') || !settings.includes('remoteRouteRef.current !== routeKey') || !settings.includes('pairingRemoteActionRef.current')) throw new Error('remote administrator views can regress to duplicate status/pairing refresh races or QR flicker');
if (!pluginsView.includes('cloudflared 설치') || !dependencySetup.includes("'cloudflared'") || !dependencySetup.includes('DEPENDENCY_INSTALL_TIMEOUT_MS')) throw new Error('cloudflared is missing from explicit and first-run dependency installation UX');
if (!dependenciesSource.includes("envPath('ProgramFiles(x86)')") || !dependenciesSource.includes("'--installer-type', 'portable', '--scope', 'user'") || ![dependenciesSource, remoteLink].every((source) => source.includes('Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe'))) throw new Error('cloudflared install/probe paths can diverge after WinGet installation');
if (!pluginsView.includes('기존 원격 설정을 복원했습니다.') || !pluginsView.includes('이번에 켠 플러그인을 다시 껐습니다.') || !pluginsView.includes('터널 상태를 다시 확인할 수 없어')) throw new Error('Quick Link partial failures lack safe rollback or preservation messaging');
if (!pluginsView.includes('mountedRef.current') || !pluginsView.includes('remoteActionRef.current = true')) throw new Error('Quick Link async completion can update an unmounted view');
if (!pluginsView.includes("value=\"cloudflare-named\"") || !pluginsView.includes('이 PC 전용 고정 호스트명') || !pluginsView.includes('Cloudflare Tunnel 토큰')) throw new Error('named Cloudflare Tunnel cannot be configured directly from the plugin UI');
if (!pluginsView.includes('PC마다 고유한 호스트명·전용 Tunnel') || !pluginsView.includes('같은 호스트명을 두 PC Connector가 공유하면')) throw new Error('multi-PC Cloudflare setup can omit the unique-hostname requirement');
if (![pluginsView, settings].every((source) => source.includes('remote-status-board') && source.includes('remote-address-row')) || !pluginsView.includes('remote-readiness') || !pluginsView.includes('remoteFailureRecovery') || !settings.includes('remoteExternalReady')) throw new Error('remote connection UX does not show the phone address, external readiness, setup gaps, and recovery in one place');
if (!settings.includes('remoteConfiguredNamed') || !settings.includes("name: 'remote-link.start'") || !settings.includes('고정 연결 복구·QR 만들기')) throw new Error('mobile pairing recovery does not prefer an already secured named Tunnel over a temporary Quick Link');
if (!pluginsView.includes('clearRemoteTunnelToken') || !pluginsView.includes("name: 'remote-link.verify'") || !pluginsView.includes('Windows DPAPI')) throw new Error('named Tunnel credential lifecycle or public endpoint verification is missing from the UI');
if (!remoteLink.includes('protectSecret') || !remoteLink.includes('redactRemoteLinkDiagnostics') || !remoteLink.includes('TUNNEL_TOKEN') || remoteLink.includes("'--token', tunnelToken")) throw new Error('named Tunnel token is not protected from storage, diagnostics, and process arguments');
if (!remoteLink.includes('localTunnelCredentialsFromToken') || !remoteLink.includes('service: http_status:404') || !remoteLink.includes('cloudflaredEnvironment')) throw new Error('named Tunnel can fall back to remotely-managed extra routes or inherit unrelated credentials');
if (!desktopMain.includes('assertTrustedRenderer(event)') || !desktopMain.includes("redirect: 'error'") || !desktopMain.includes('resolveDesktopCredential(token, parsed.origin)') || !desktopMain.includes('MAX_DESKTOP_DOWNLOAD_BYTES')) throw new Error('desktop IPC/download trust boundary can leak a remote token or accept an unbounded redirect');
if (!remoteLink.includes('normalizeNamedTunnelHostname') || !remoteLink.includes('readSmallJson') || !remoteLink.includes("redirect: 'error'")) throw new Error('named Tunnel hostname or verification response is not tightly validated');
if (!mobileManifest.includes('android:windowSoftInputMode="adjustResize"')
  || mobileManifest.includes('android:screenOrientation=')
  || !mobileAppConfig.includes('"softwareKeyboardLayoutMode": "resize"')
  || !mobileAppConfig.includes('"orientation": "default"')
  || !mobileHome.includes('{!keyboardVisible && <View style={[styles.header')
  || !mobileHome.includes('{!keyboardVisible && <View style={[styles.tabbar')
  || !mobileChat.includes("behavior={Platform.OS === 'ios' ? 'padding' : undefined}")
  || mobileChat.includes("Platform.OS === 'ios' ? 'padding' : 'height'")
  || !mobileChat.includes("automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}")
  || !mobileChat.includes('if (!keyboardVisible || !stickToBottom.current) return;')
  || !mobileChat.includes('onLayout={() => { if (stickToBottom.current)')
  || !mobileChat.includes('paddingBottom: keyboardVisible ? 6 : Math.max(10, insets.bottom)')) throw new Error('mobile chat keyboard avoidance can regress behind the IME or bottom tab bar');
if (!mobileManifest.includes('android:usesCleartextTraffic="false"') || !mobileAppConfig.includes('"usesCleartextTraffic": false')) throw new Error('Android release can regress to sending device credentials over cleartext HTTP');
if (!mobileChat.includes('controlBar') || !mobileChat.includes('🤖 단일 모델 선택') || !mobileChat.includes('모델 ID 직접 지정') || !mobileChat.includes('{singleModelChoices(true)}')) throw new Error('mobile direct single-model controls can become hidden or lose explicit model selection');
if (!mobileChat.includes("const ORDERED_REASONING_EFFORTS: readonly ReasoningEffort[] = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max']")
  || !mobileChat.includes("const FALLBACK_REASONING_EFFORTS: readonly ReasoningEffort[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']")
  || !mobileChat.includes('provider?.supportedReasoning')
  || !mobileChat.includes("effort === 'auto' || supportedSet.has(effort)")) throw new Error('mobile reasoning choices can lose provider capabilities, none support, auto, or the common fallback');
const mobileInputBar = mobileChat.indexOf('<View style={[styles.inputBar');
const mobileReasoningBar = mobileChat.indexOf('<View style={[styles.reasoningBar');
const mobileModelModal = mobileChat.indexOf('<Modal visible={showModels}');
if (mobileInputBar < 0 || mobileReasoningBar < mobileInputBar || mobileReasoningBar > mobileModelModal
  || !mobileChat.includes('keyboardShouldPersistTaps="always"')
  || mobileChat.includes('cycleEffort')) throw new Error('mobile reasoning control is not a compact explicit selector at the keyboard-safe composer bottom');
if (!mobileChat.includes("client.call('conversations.update', { id: conversationId, reasoningEffort })")
  || !mobileChat.includes('const reasoningLocked = !conversation || busy || savingConfiguration')
  || !mobileChat.includes('configurationSaveInFlightRef.current')
  || !mobileChat.includes('beginConfigurationSave()')
  || !mobileChat.includes('finishConfigurationSave()')
  || !mobileChat.includes('disabled={reasoningLocked}')
  || !mobileChat.includes('accessibilityState={{ selected, disabled: reasoningLocked }}')) throw new Error('mobile per-conversation reasoning selection can race, skip persistence, or change during a run');
if (!mobileChat.includes('const defaultProvider = providers.find((provider) => provider.isDefault) ?? providers[0]')
  || !mobileChat.includes('reasoningEffortsFor(routingPresetId ? undefined : provider)')
  || !mobileChat.includes('applyConversationConfiguration(conversationId')
  || (mobileChat.match(/!beginConfigurationSave\(\)/g) ?? []).length < 5) throw new Error('mobile model, preset, workspace, access, or default-provider settings can race command execution');
if (!mobilePcList.includes('modalScrollContent') || !mobilePcList.includes('keyboardShouldPersistTaps="handled"')) throw new Error('mobile PC setup form cannot scroll above the keyboard');
if (!mobileHome.includes('고정된 모체 PC 없이')
  || !mobileHome.includes('onSelectPc(candidate)')
  || !mobileHome.includes('PC 추가·연결 관리')
  || !mobileApp.includes('selectExecutionPcRef')) throw new Error('mobile cannot directly choose or change an independent execution PC');
if (!mobileHome.includes("client.call('chat.runs'")
  || !mobileHome.includes('현재 PC에서 작업 중입니다')
  || !mobileHome.includes('disabled={selected || executionBusy}')
  || !mobileChat.includes('onExecutionBusyChange?.(true)')) throw new Error('mobile can abandon a running job while changing execution PCs');
if (!mobilePcsRegistry.includes("if (!origin) throw new Error('이 PC에 HTTPS 접속 주소가 없습니다.")) throw new Error('mobile HTTP calls can fall back to an unsafe plaintext LAN origin');
if (mobileRpc.includes('obj.secret') || mobilePcList.includes('payload.secret') || webRpc.includes('obj.secret')) throw new Error('legacy QR payloads can still import a long-lived device secret');
if (!mobileRpc.includes("obj.version !== 3") || !webRpc.includes("obj.version !== 3")
  || !mobileRpc.includes("/^(?:\\d{6}|\\d{12})$/.test(obj.pin)") || !webRpc.includes("/^(?:\\d{6}|\\d{12})$/.test(obj.pin)")) throw new Error('QR pairing is not restricted to v3 six- or twelve-digit one-time code payloads');
if (!mobileRpc.includes('pairingOrigins(payload)') || !mobileRpc.includes('securePairingOrigin')
  || !webRpc.includes('assertSecurePairingHost')) throw new Error('QR import does not enforce HTTPS origins consistently');
if (mobilePcsRegistry.includes('isTailnetHost') || mobileRpc.includes('isTailnetHost')
  || pcsRegistry.includes('isTailnetHost') || webRpc.includes('isTailnetHost')
  || !mobilePcsRegistry.includes("parsed.protocol !== 'https'")
  || !pcsRegistry.includes("endpoint.protocol !== 'https' && !isLoopbackHost(endpoint.host)")) {
  throw new Error('raw 100.64/10 HTTP can be mistaken for an authenticated Tailscale route');
}
if (![webRpc, mobileRpcClient].every((source) => source.includes('/api/ws-ticket')
  && source.includes('WS_UPGRADE_TICKET_PROTOCOL_PREFIX')
  && source.includes('new WebSocket(url, protocols)'))) throw new Error('public WebSocket clients can regress to unauthenticated upgrade admission');
if (!mobilePcList.includes('scanLockRef.current = true')
  || !mobilePcList.includes('setDetectedPayload(payload)')
  || !mobilePcList.includes('이 PC에 연결')
  || !mobilePcList.includes('다른 QR입니다. 카메라는 계속 스캔 중')
  || !mobilePcList.includes('barcodeScannerSettings={QR_SCANNER_SETTINGS}')) throw new Error('mobile QR scanning can regress to immediate connection, duplicate handling, or stop-on-foreign-code behavior');
if (!mobilePcList.includes('const detectedOrigins = detectedPayload ? pairingOrigins(detectedPayload) : []')
  || !mobilePcList.includes('detectedOrigins.map')
  || !mobilePcList.includes('표시된 후보만 순서대로 확인')) throw new Error('mobile QR confirmation can hide fallback origins that may actually receive the pairing credential');
const mobileScanHandler = mobilePcList.slice(mobilePcList.indexOf('const onScan ='), mobilePcList.indexOf('const connectDetectedPc ='));
if (mobileScanHandler.includes('exchangePin') || !mobileAppConfig.includes('"barcodeScannerEnabled": true')) throw new Error('mobile QR detection can reconnect immediately or ship without native barcode scanning enabled');
if (!mobilePcList.includes('PAIRING_PIN_PATTERN.test(pin)')
  || !mobilePcList.includes("slice(0, 12)")
  || !mobilePcList.includes('6자리 PIN 또는 외출용으로 발급한 12자리')) throw new Error('mobile manual pairing does not accept both local and travel one-time codes');
if (!mobileChat.includes('FileSystem.createUploadTask') || !mobileChat.includes('cancelAttachment') || !mobileChat.includes('120_000')) throw new Error('mobile chat attachment upload lacks cancel, timeout, or lifecycle cleanup');
if (!app.includes('!client.isAdmin') || !app.includes('관리 제한')) throw new Error('paired-device admin scope is not visible in the workspace header');
if (!settings.includes('const canManage = client.isAdmin') || !settings.includes('access-scope-banner') || !settings.includes('disabled={locked}')) throw new Error('settings do not expose and enforce paired-device read-only management scope');
if (!settings.includes('readOnly={!canManage}') || !settings.includes('disabled={!canManage || !selectedRoutingPreset}')) throw new Error('routing graph and preset apply remain mutable for paired non-admin devices');
if (!settings.includes("client.call('pairing.link.capability.set'")
  || settings.includes("pairing.link.update', { id: link.id, capabilities:")) throw new Error('device capability toggles can replay a stale full capability array');
if (!schedulesView.includes('clearNaverCredentials: true')
  || !schedulesView.includes('open={clearNaverConfirmOpen}')
  || !schedulesView.includes('집 주소와 근무 일정은 유지됩니다.')) throw new Error('NAVER credential removal lacks an explicit scoped confirmation dialog');
if (!dependencySetup.includes('const canManage = client.isAdmin') || !dependencySetup.includes('disabled={!canManage')) throw new Error('dependency setup is not safely read-only for paired devices');
if (!pluginsView.includes('if (!canManage)') || !pluginsView.includes('플러그인 관리는 PC 전용입니다') || !pluginsView.includes('if (!canManage) return;')) throw new Error('plugin management is not replaced by a read-only catalog for paired devices');
if ((pluginsView.match(/className="plugin-category-list"/g) ?? []).length !== 2
  || !pluginsView.includes('groupPluginsByCategory(plugins)')
  || !pluginsView.includes("client.call('plugins.setCategory'")
  || !pluginCategories.includes("pentest: '모의해킹'")
  || !css.includes('.plugin-category-head')) throw new Error('plugin categories are not grouped into labeled sections in both administrator and read-only catalogs');
if (!schedulesView.includes('Promise.allSettled') || !schedulesView.includes('canManageJobs ? client.call(\'scheduler.list\'') || !schedulesView.includes('일정 보기 모드')) throw new Error('paired-device scheduler denial can still block general calendar use');
if (!schedulesView.includes('disabled={busy || !importPerson.trim()}')
  || schedulesView.includes('disabled={busy || !importPerson.trim() || !importTeam.trim()}')) throw new Error('optional workbook team filter is incorrectly required by the UI');
if (!schedulesView.includes("client.on('calendar.work.changed', () => void refreshSelectedWorkDay())")
  || !schedulesView.includes('await refreshSelectedWorkDay();')
  || !schedulesView.includes('setDestinationAddress(event.target.value); setRoutePreview(null);')) throw new Error('work-day edits can leave stale selected fields or route results visible');

console.log(`UI CONTRACT TEST PASSED · ${uiCalls.size} RPC calls matched · menus + model controls + paired permission UX + run lifecycle + transport ownership verified`);
