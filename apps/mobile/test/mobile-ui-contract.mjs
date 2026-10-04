import { readFileSync } from 'node:fs';

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const appConfig = JSON.parse(read('app.json'));
const app = read('App.tsx');
const manifest = read('android/app/src/main/AndroidManifest.xml');
const androidBuild = read('android/app/build.gradle');
const home = read('src/screens/HomeScreen.tsx');
const chat = read('src/screens/ChatScreen.tsx');
const rpc = read('src/rpc.ts');
const pcList = read('src/screens/PcListScreen.tsx');
const settings = read('src/screens/SettingsScreen.tsx');
const schedules = read('src/screens/SchedulesScreen.tsx');
const types = read('src/types.ts');
const runActivity = read('src/components/RunActivity.tsx');

function check(description, condition) {
  if (!condition) throw new Error(`MOBILE UI CONTRACT FAILED: ${description}`);
}

check('Gradle bundle tasks track shared workspace sources and configuration outside the mobile root',
  androidBuild.includes("def mrRobotSharedRoot = new File(rootDir, '../../../packages/shared')")
  && androidBuild.includes('tasks.withType(com.facebook.react.tasks.BundleHermesCTask).configureEach')
  && androidBuild.includes("inputs.dir(new File(mrRobotSharedRoot, 'src'))")
  && androidBuild.includes("withPropertyName('mrRobotSharedSources')")
  && androidBuild.includes("new File(mrRobotSharedRoot, 'package.json')")
  && androidBuild.includes("new File(mrRobotSharedRoot, 'tsconfig.json')")
  && androidBuild.includes("new File(rootDir, '../../../tsconfig.base.json')")
  && androidBuild.includes("withPropertyName('mrRobotSharedConfig')")
  && (androidBuild.match(/withPathSensitivity\(org\.gradle\.api\.tasks\.PathSensitivity\.RELATIVE\)/g) ?? []).length >= 2);

check('run observation limits remain separate from phases and stay accessible in compact and expanded layouts',
  types.includes('observationLimited?: boolean;')
  && runActivity.includes('runPresentation({ ...run, busy }')
  && runActivity.includes('view.observationNotice')
  && runActivity.includes('compact && view.observationNotice')
  && runActivity.includes('accessibilityHint={`${view.heading}. ${view.detail}. ${view.observationNotice}`}')
  && chat.includes('mergeToolActivity(last.tools, event)'));

check('Expo and the committed Android activity both resize the app viewport for the soft keyboard',
  appConfig.expo?.android?.softwareKeyboardLayoutMode === 'resize'
  && manifest.includes('android:windowSoftInputMode="adjustResize"'));
check('phone, tablet, and landscape layouts are allowed by both generated and native configuration',
  appConfig.expo?.orientation === 'default'
  && !manifest.includes('android:screenOrientation='));
check('safe-area metrics are available on the first painted frame',
  app.includes('initialWindowMetrics')
  && app.includes('<SafeAreaProvider initialMetrics={initialWindowMetrics}>'));

const keyboardScreens = [chat, pcList, settings, schedules];
check('Android does not double-shrink adjustResize screens with KeyboardAvoidingView height behavior',
  keyboardScreens.every((source) => !source.includes("Platform.OS === 'ios' ? 'padding' : 'height'"))
  && keyboardScreens.every((source) => !source.includes("Platform.OS === 'android' ? 'height'")));
check('chat relies on native Android resize while retaining iOS keyboard insets',
  chat.includes("behavior={Platform.OS === 'ios' ? 'padding' : undefined}")
  && chat.includes("automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}"));
check('opening the keyboard follows the latest message and list size changes preserve bottom following',
  chat.includes('if (!keyboardVisible || !stickToBottom.current) return;')
  && chat.includes('listRef.current?.scrollToOffset({ offset: 0, animated: true })')
  && chat.includes('data={[...messages].reverse()}')
  && chat.includes('onContentSizeChange={() => { if (stickToBottom.current)')
  && chat.includes('onLayout={() => { if (stickToBottom.current)'));
check('keyboard entry mode frees vertical space without covering the composer',
  home.includes("{!keyboardVisible && tab !== 'chat' && <View style={[styles.header")
  && home.includes('{!keyboardVisible && <View style={[styles.tabbar')
  && chat.includes('{!keyboardVisible && <Text style={styles.chatHeadingDetail}')
  && !chat.includes('style={styles.modeBar}')
  && !chat.includes('style={styles.controlBar}')
  && chat.includes('paddingBottom: keyboardVisible ? 6 : Math.max(10, insets.bottom)'));
check('composer measures real keyboard occlusion and lifts only by the uncovered overlap',
  chat.includes('composerRef.current?.measureInWindow')
  && chat.includes('const unliftedBottom = y + composerHeight + composerKeyboardLiftRef.current')
  && chat.includes('const overlap = unliftedBottom - keyboardTopRef.current + 6')
  && chat.includes('marginBottom: composerKeyboardLift')
  && chat.includes('disableFullscreenUI')
  && chat.includes("Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'"));
check('conversation access and reasoning controls stay in the composer and use dropdown modals',
  chat.includes('styles.composerToolbar, shortKeyboardViewport')
  && chat.includes('accessibilityLabel={`대화 액세스 실제 적용 ${permissionLabel}')
  && chat.includes('accessibilityState={{ expanded: showReasoning, disabled: reasoningLocked }}')
  && chat.includes('<Modal visible={showReasoning}')
  && !chat.includes('style={[styles.reasoningChip'));
check('mobile auth retains the server authority ceiling and the access picker cannot raise it',
  rpc.includes("permissionCap: PermissionMode = 'read-only'")
  && rpc.includes('this.isAdmin = this.authed && auth?.isAdmin === true')
  && rpc.includes("this.permissionCap = 'read-only'")
  && chat.includes('!permissionWithinCap(value, client.permissionCap)')
  && chat.includes('effectivePermissionMode(requestedPermissionMode, client.permissionCap)')
  && chat.includes("permissionCappedByDevice ? '·상한' : ''")
  && chat.includes('updated.permissionMode !== permissionMode')
  && chat.includes('PC 앱의 원격 PC 관리'));
check('busy steering and stop actions share the composer toolbar without an extra full-width row',
  chat.includes('const busyControls = busy ?')
  && chat.includes('{busyControls}')
  && !chat.includes('{!shortKeyboardViewport && busyControls}')
  && chat.includes("busyActions: { flexDirection: 'row', gap: 6, flexShrink: 0, width: 98 }")
  && chat.includes('busyActionBtn: { flex: 1 }'));
check('an exact failed retry replaces only the failed tail while a start-dispatch ref blocks fast duplicate taps',
  chat.includes('const appendPendingAttempt = (items: UiMsg[], text: string): UiMsg[] =>')
  && chat.includes("assistant?.role === 'assistant'")
  && chat.includes('Boolean(assistant.error)')
  && chat.includes("user?.role === 'user'")
  && chat.includes('user.content === text')
  && chat.includes('const base = retryingFailedTail ? items.slice(0, -2) : items;')
  && chat.includes('const startingConversationRef = useRef<string | null>(null);')
  && chat.includes('if (startingConversationRef.current === currentConversation.id) return;')
  && chat.includes('startingConversationRef.current = currentConversation.id;')
  && chat.includes('setMessages((items) => appendPendingAttempt(items, text));'));
const mobilePermissionControl = chat.indexOf('setPermissionNotice(\'\'); setShowAccess(true);');
const mobileTokenPolicyControl = chat.indexOf('accessibilityLabel="대화 토큰 정책"');
check('per-conversation token policy follows permission and is run-locked, rollback-safe, and administrator-gated',
  mobilePermissionControl >= 0
  && mobileTokenPolicyControl > mobilePermissionControl
  && types.includes("export type ConversationTokenPolicy = 'adaptive' | 'economy' | 'standard' | 'quality' | 'audit-only';")
  && types.includes('tokenPolicy: ConversationTokenPolicy;')
  && rpc.includes('isAdmin = false;')
  && rpc.includes('this.isAdmin = this.authed && auth?.isAdmin === true;')
  && rpc.includes('canUseAuditOnly = false;')
  && rpc.includes('this.canUseAuditOnly = this.authed && auth?.canUseAuditOnly === true;')
  && chat.includes("if (!client.canUseAuditOnly || !conversation || busy || !beginConfigurationSave()) return;")
  && chat.includes("tokenPolicy: client.canUseAuditOnly ? currentConversation.tokenPolicy ?? 'adaptive' : 'adaptive'")
  && chat.includes('disabled={configurationLocked || !client.canUseAuditOnly}')
  && chat.includes("...(client.canUseAuditOnly ? [['audit-only', '무제한 · 감사만'")
  && chat.includes('적응형 · 품질 우선')
  && chat.includes('대화 기록과 PC 설정의 텔레메트리에서 확인'));

check('small screens and enlarged fonts switch connection cards to a stacked layout',
  pcList.includes('width < 480 || fontScale > 1.25')
  && pcList.includes('compact && styles.pcCardCompact')
  && pcList.includes("pcCardCompact: { flexDirection: 'column'"));
check('QR camera and confirmation controls use separate scrollable responsive panes',
  pcList.includes('scannerLandscape')
  && pcList.includes('styles.scanCameraPane')
  && pcList.includes('styles.scanPanelLandscape')
  && pcList.includes('<ScrollView style={[styles.scanPanel'));
check('remote enrollment keeps optional Access details progressive and validates partial credentials',
  pcList.includes('showAdvancedAccess')
  && pcList.includes('hasPartialAccess')
  && pcList.includes('disabled={busy || !canRegister}')
  && pcList.includes('const clearAccessFields = (): void =>')
  && pcList.includes('const closeAddPc = (): void =>')
  && pcList.includes('? optionalCloudflareAccess(accessClientId, accessClientSecret)')
  && pcList.includes('if (value) clearAccessFields();'));
check('critical connection, loading, and transfer state is exposed to accessibility services',
  home.includes('accessibilityLiveRegion="polite"')
  && chat.includes('accessibilityLiveRegion="assertive"')
  && pcList.includes('accessibilityLiveRegion="assertive"'));
check('text-entry sheets use scrollable keyboard insets on iOS and native resize on Android',
  settings.includes('automaticallyAdjustKeyboardInsets={Platform.OS === \'ios\'}')
  && schedules.includes('automaticallyAdjustKeyboardInsets={Platform.OS === \'ios\'}'));

check('calendar keeps complete week rows inside an unclipped bounded scroll area',
  schedules.includes('removeClippedSubviews={false}')
  && schedules.includes('scroll: { flex: 1, minHeight: 0 }')
  && schedules.includes('calendarCard: { flexShrink: 0,')
  && schedules.includes('grid.slice(week * 7, week * 7 + 7)')
  && schedules.includes("calendarWeek: { flexDirection: 'row', flexShrink: 0 }")
  && schedules.includes('dayCell: { flex: 1, minWidth: 0, minHeight: 64,'));

check('confirmed cancellation releases the mobile dispatch guard even without terminal events',
  /onSettled: \(\) => \{\s*requestOwnership.current.finish\(conversationId\);\s*if \(startingConversationRef.current === conversationId\) startingConversationRef.current = null;/.test(chat)
  && chat.includes('await watchChatSettlement(')
  && !chat.includes('cancelTimers'));

const progress = read('src/components/RunActivity.tsx');
const toolHistory = read('src/components/ToolHistory.tsx');
check('work details open in a bounded dismissible sheet instead of pushing the composer',
  chat.includes('<RunActivity key={conversation?.id}')
  && progress.includes('runPresentation({ ...run, busy }, now)')
  && progress.includes('<Modal visible={open}')
  && progress.includes('onRequestClose={() => setOpen(false)}')
  && progress.includes("maxHeight: '75%'")
  && chat.includes('<RunActivity run={activeRun ?? null} busy={busy} executionMode={selectedExecutionMode} compact />')
  && home.includes("paddingTop: keyboardVisible || tab === 'chat' ? insets.top : 0")
  && !progress.includes('item.input') && !progress.includes('item.detail'));
check('mobile tool history is collapsed, bounded and hides raw payloads',
  chat.includes('<ToolHistory tools={m.tools} />')
  && toolHistory.includes('useState(false)') && toolHistory.includes('maxHeight: 180')
  && toolHistory.includes('activityLabel(t.name)') && !toolHistory.includes('t.summary'));
check('terminal state is retained when completion and error notifications arrive late',
  chat.includes("setRunFinished(d.conversationId, 'failed')")
  && chat.includes('terminalRunUpdate(current[conversationId], phase)'));
const timeline = read('src/components/RunTimeline.tsx');
check('mobile unifies the PC and conversation header and shows actual waiting events',
  home.includes("!keyboardVisible && tab !== 'chat'")
  && home.includes('onSelectExecutionPc={() => setShowPcPicker(true)}')
  && chat.includes('<RunTimeline run={activeRun ?? null} busy={busy} executionMode={selectedExecutionMode} />')
  && timeline.includes('runTimeline(run ?? {})')
  && !timeline.includes('item.input') && !timeline.includes('item.output'));
console.log('MOBILE UI CONTRACT PASSED');
