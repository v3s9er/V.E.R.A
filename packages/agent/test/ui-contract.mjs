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
const schedulesView = read('packages/web/src/views/SchedulesView.tsx');
const dependencySetup = read('packages/web/src/components/DependencySetup.tsx');
const routingGraph = read('packages/web/src/components/RoutingGraphEditor.tsx');
const pcsRegistry = read('packages/web/src/pcs.ts');
const connectGate = read('packages/web/src/components/ConnectGate.tsx');
const profileMenu = read('packages/web/src/components/ProfileMenu.tsx');
const remoteLink = read('packages/agent/src/plugins/remote-link.ts');
const mobileChat = read('apps/mobile/src/screens/ChatScreen.tsx');
const mobileHome = read('apps/mobile/src/screens/HomeScreen.tsx');
const mobilePcList = read('apps/mobile/src/screens/PcListScreen.tsx');
const mobilePcsRegistry = read('apps/mobile/src/pcs.ts');
const mobileRpc = read('apps/mobile/src/pairing.ts');
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
if (!settings.includes('Number(telemetry.cachedPromptTokens ?? 0)') || !settings.includes('Number(telemetry.cacheHitRate ?? 0)')) throw new Error('settings telemetry is not backward-compatible with older agent summaries');
if (!chat.includes('aria-label={`${c.title} 메뉴`}') || !chat.includes('setConversationMenu({ conversation: c')) throw new Error('conversation ellipsis is not an actual menu trigger');
if (!app.includes("client.on('voice.command'") || !app.includes("setView('chat')") || !chat.includes('executeCommand(voiceCommand.text)')) throw new Error('recognized wake commands are not globally queued and connected to chat execution');
if (!chat.includes('finally {') || !chat.includes('busyRef.current = false')) throw new Error('chat busy state has no request-completion fallback');
if (!chat.includes('signal: uploadController.signal') || !chat.includes("uploadAbortReason.current = 'timeout'") || !chat.includes('업로드 취소')) throw new Error('chat drag-and-drop uploads lack cancellation and timeout UX');
if (!chat.includes("updateConversation({ routingPresetId: null, providerId, providerModel })")) throw new Error('model picker cannot switch directly from a routing preset to single-model mode');
if (!routingGraph.includes('graph-port-in') || !routingGraph.includes('graph-port-out') || !routingGraph.includes('edge-preview')) throw new Error('routing graph lacks intuitive directional drag connection ports');
if (!routingGraph.includes('previewColumnStep') || !routingGraph.includes('graph-content-sizer')) throw new Error('read-only routing preview can overlap nodes instead of scrolling on narrow screens');
if (!routingGraph.includes('removeEdge') || !routingGraph.includes('reverseEdge') || !routingGraph.includes('edge-inspector')) throw new Error('routing edges cannot be selected, reversed and deleted');
if (!routingGraph.includes('addGroup') || !routingGraph.includes('updateGroup') || !routingGraph.includes('removeGroup') || !routingGraph.includes('group-dot-picker')) throw new Error('routing meeting groups lack create/update/delete/assignment controls');
if (!routingGraph.includes('startGroupInteraction') || !routingGraph.includes("mode: 'move' | 'resize'") || !routingGraph.includes('syncGroupMembership') || !routingGraph.includes('group-resize-handle')) throw new Error('routing groups cannot be moved, resized, and populated spatially');
if (!routingGraph.includes('graph-health') || !routingGraph.includes('orphanNodes')) throw new Error('routing graph does not report disconnected nodes');
if (!css.includes('.routing-group-bubble') || !css.includes('.graph-edge.selected') || !css.includes('stroke: #766dff !important')) throw new Error('routing groups and persistent edges lack visual design contracts');
if (!pcsRegistry.includes('connectionOrigins') || !pcsRegistry.includes('activeOrigin') || !pcsRegistry.includes('originForDiscoveredHost')) throw new Error('desktop registry does not preserve per-address origins for LAN/HTTPS fallback');
if (!pcsRegistry.includes('if (!result.ok) throw') || pcsRegistry.includes("loadPcs().catch(() => []")) throw new Error('secure desktop registry failures can be mistaken for an empty registry');
if (!connectGate.includes('clientOwner') || !connectGate.includes('ownsClient()') || !connectGate.includes('if (!isCurrent() || !ownsClient()) return false')) throw new Error('connection gate lacks attempt-scoped client ownership guards');
if (!connectGate.includes('window.mrRobotDesktop && !preferredPc') || !connectGate.includes('await connectTo(localPc, false)') || !connectGate.includes('로컬 에이전트를 준비하는 중')) throw new Error('desktop startup can regress into the remote PC pairing gate');
if (!connectGate.includes('if (manageConnections)') || !profileMenu.includes('원격 PC 추가·관리') || !profileMenu.includes('로컬 에이전트 · 준비됨')) throw new Error('desktop optional remote-PC management is not separated from local startup');
if (!main.includes("openSync(file, 'r+')")) throw new Error('Windows desktop registry fsync can regress to an EPERM-prone read-only handle');
if (!remoteLink.includes('operationGeneration') || !remoteLink.includes('pendingStart') || !remoteLink.includes('ownsCurrentProcess')) throw new Error('remote link lifecycle lacks stale child callback guards');
if (!pluginsView.includes('refreshRemotePairing(status)') || !pluginsView.includes('host: status.publicUrl') || !pluginsView.includes("QRCode.toDataURL(payload") || !pluginsView.includes('모바일 원탭 연결')) throw new Error('Quick Link does not refresh a one-tap HTTPS+PIN QR after starting');
if (!pluginsView.includes('Quick Link 공개 연결 승인') || !pluginsView.includes('위험을 이해했으며 연결') || !pluginsView.includes('사용 후 반드시 링크를 중지')) throw new Error('Quick Link can expose the agent publicly without explicit informed confirmation');
if (!pluginsView.includes('if (remoteActionRef.current) return') || !pluginsView.includes("setRemoteStage('사전 상태 확인')")) throw new Error('Quick Link fast connect lacks duplicate-click and staged loading guards');
if (!pluginsView.includes("client.call('dependencies.install', { id: 'cloudflared' })") || !pluginsView.includes("client.call('plugins.setEnabled', { id: plugin.id, enabled: true })") || !pluginsView.includes('Quick Link 빠른 연결')) throw new Error('Quick Link does not bootstrap its dependency and plugin after approval');
if (!pluginsView.includes('기존 원격 설정을 복원했습니다.') || !pluginsView.includes('이번에 켠 플러그인을 다시 껐습니다.') || !pluginsView.includes('터널 상태를 다시 확인할 수 없어')) throw new Error('Quick Link partial failures lack safe rollback or preservation messaging');
if (!pluginsView.includes('mountedRef.current') || !pluginsView.includes('remoteActionRef.current = true')) throw new Error('Quick Link async completion can update an unmounted view');
if (!mobileManifest.includes('android:windowSoftInputMode="adjustResize"') || !mobileHome.includes('!keyboardVisible') || !mobileChat.includes("behavior={Platform.OS === 'ios' ? 'padding' : undefined}") || !mobileChat.includes('paddingBottom: keyboardVisible ? Math.max(12, insets.bottom) : 10')) throw new Error('mobile chat keyboard avoidance can regress behind the IME or bottom tab bar');
if (!mobilePcList.includes('modalScrollContent') || !mobilePcList.includes('keyboardShouldPersistTaps="handled"')) throw new Error('mobile PC setup form cannot scroll above the keyboard');
if (!mobilePcsRegistry.includes("if (!origin) throw new Error('이 PC에 보안 접속 주소가 없습니다.")) throw new Error('mobile HTTP calls can fall back to an unsafe plaintext LAN origin');
if (mobileRpc.includes('obj.secret') || mobilePcList.includes('payload.secret') || webRpc.includes('obj.secret')) throw new Error('legacy QR payloads can still import a long-lived device secret');
if (!mobileRpc.includes("obj.version !== 3") || !webRpc.includes("obj.version !== 3")
  || !mobileRpc.includes("/^\\d{6}$/.test(obj.pin)") || !webRpc.includes("/^\\d{6}$/.test(obj.pin)")) throw new Error('QR pairing is not restricted to v3 six-digit one-time PIN payloads');
if (!mobileRpc.includes('pairingOrigins(payload)') || !mobileRpc.includes('securePairingOrigin')
  || !webRpc.includes('assertSecurePairingHost')) throw new Error('QR import does not enforce HTTPS or Tailscale origins consistently');
if (!mobileChat.includes('FileSystem.createUploadTask') || !mobileChat.includes('cancelAttachment') || !mobileChat.includes('120_000')) throw new Error('mobile chat attachment upload lacks cancel, timeout, or lifecycle cleanup');
if (!app.includes('!client.isAdmin') || !app.includes('관리 제한')) throw new Error('paired-device admin scope is not visible in the workspace header');
if (!settings.includes('const canManage = client.isAdmin') || !settings.includes('access-scope-banner') || !settings.includes('disabled={locked}')) throw new Error('settings do not expose and enforce paired-device read-only management scope');
if (!settings.includes('readOnly={!canManage}') || !settings.includes('disabled={!canManage || !selectedRoutingPreset}')) throw new Error('routing graph and preset apply remain mutable for paired non-admin devices');
if (!dependencySetup.includes('const canManage = client.isAdmin') || !dependencySetup.includes('disabled={!canManage')) throw new Error('dependency setup is not safely read-only for paired devices');
if (!pluginsView.includes('if (!canManage)') || !pluginsView.includes('플러그인 관리는 PC 전용입니다') || !pluginsView.includes('if (!canManage) return;')) throw new Error('plugin management is not replaced by a read-only catalog for paired devices');
if (!schedulesView.includes('Promise.allSettled') || !schedulesView.includes('canManageJobs ? client.call(\'scheduler.list\'') || !schedulesView.includes('일정 보기 모드')) throw new Error('paired-device scheduler denial can still block general calendar use');

console.log(`UI CONTRACT TEST PASSED · ${uiCalls.size} RPC calls matched · menus + model controls + paired permission UX + run lifecycle + transport ownership verified`);
