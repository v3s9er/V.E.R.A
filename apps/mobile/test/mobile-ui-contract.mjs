import { readFileSync } from 'node:fs';

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const appConfig = JSON.parse(read('app.json'));
const app = read('App.tsx');
const manifest = read('android/app/src/main/AndroidManifest.xml');
const home = read('src/screens/HomeScreen.tsx');
const chat = read('src/screens/ChatScreen.tsx');
const rpc = read('src/rpc.ts');
const pcList = read('src/screens/PcListScreen.tsx');
const settings = read('src/screens/SettingsScreen.tsx');
const schedules = read('src/screens/SchedulesScreen.tsx');

function check(description, condition) {
  if (!condition) throw new Error(`MOBILE UI CONTRACT FAILED: ${description}`);
}

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
  && chat.includes('listRef.current?.scrollToEnd({ animated: true })')
  && chat.includes('onContentSizeChange={() => { if (stickToBottom.current)')
  && chat.includes('onLayout={() => { if (stickToBottom.current)'));
check('keyboard entry mode frees vertical space without covering the composer',
  home.includes('{!keyboardVisible && <View style={[styles.header')
  && home.includes('{!keyboardVisible && <View style={[styles.tabbar')
  && chat.includes('{!keyboardVisible && <View style={styles.modeBar}')
  && chat.includes('paddingBottom: keyboardVisible ? 6 : Math.max(10, insets.bottom)'));
check('composer measures real keyboard occlusion and lifts only by the uncovered overlap',
  chat.includes('composerRef.current?.measureInWindow')
  && chat.includes('const unliftedBottom = y + composerHeight + composerKeyboardLiftRef.current')
  && chat.includes('const overlap = unliftedBottom - keyboardTopRef.current + 6')
  && chat.includes('marginBottom: composerKeyboardLift')
  && chat.includes('disableFullscreenUI')
  && chat.includes("Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'"));
check('conversation access and reasoning controls stay in the composer and use dropdown modals',
  chat.includes('style={styles.composerToolbar}')
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
check('busy steering and stop actions occupy their own responsive row',
  chat.includes('{busy && <View style={styles.busyActions}>')
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

console.log('MOBILE UI CONTRACT PASSED');
