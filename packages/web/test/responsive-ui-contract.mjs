import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');
const css = read('packages/web/src/styles.css');
const chat = read('packages/web/src/views/ChatView.tsx');
const connectGate = read('packages/web/src/components/ConnectGate.tsx');
const profile = read('packages/web/src/components/ProfileMenu.tsx');
const ui = read('packages/web/src/components/ui.tsx');

const requireAll = (source, fragments, message) => {
  const missing = fragments.filter((fragment) => !source.includes(fragment));
  if (missing.length) throw new Error(`${message}: ${missing.join(' | ')}`);
};

requireAll(css, [
  '@media (max-width: 1180px)',
  '.workspace-header-main .topbar-meta',
  'grid-column: 1 / -1;',
  '.workspace-header .pc-switch',
  'text-overflow: ellipsis;',
], 'workspace header can overlap in compact desktop windows');

requireAll(css, [
  '.pc-row {\n  display: grid;',
  'grid-template-columns: minmax(0, 1fr) auto;',
  '@media (max-width: 620px)',
  '.pc-actions {\n    display: grid;',
  'grid-template-columns: minmax(0, 1fr) 44px;',
  'min-height: 44px;',
], 'connection cards can overlap or lose touch targets');

requireAll(connectGate, [
  'className="pc-run-button"',
  'className="pc-remove-button"',
  'aria-label={`${pc.name} 등록 해제`}',
  'https://pc1.v3s9er.com 또는 https://…trycloudflare.com',
], 'connection card actions are not independently addressable');

requireAll(css, [
  '.remote-status-item {\n  display: grid;',
  '.remote-mode-guide > div.active {',
  '.remote-readiness-item.ok > span {',
  '.remote-readiness-item.missing > span {',
  '.remote-troubleshoot {\n  display: grid;',
  '.remote-diagnostics > summary:focus-visible {',
  '.remote-address-row {',
  'overflow-wrap: anywhere;',
], 'remote connection guidance can overflow or lose status hierarchy');

requireAll(css, [
  '.chat-inputbar {\n  max-height: min(44dvh, 300px);',
  'overflow-y: auto;',
  '@media (max-width: 900px) and (max-height: 760px)',
  '.chat-scroll { gap: 12px; padding-block: 4px 10px; }',
  '.chat-empty-orb,\n  .chat-empty-kicker { display: none; }',
], 'composer or empty-state content can cover the chat viewport');

requireAll(chat, [
  'const composerBar = useRef<HTMLDivElement>(null);',
  'const stickToBottomRef = useRef(true);',
  'const conversationMenuTriggerRef = useRef<HTMLButtonElement>(null);',
  'A different conversation owns a different scroll position',
  'scroll.scrollTop = scroll.scrollHeight;',
  'new ResizeObserver(() =>',
  'ref={composerBar} className="chat-inputbar"',
  'aria-label="에이전트 명령"',
  'queueMicrotask(() => conversationMenuTriggerRef.current?.focus());',
], 'composer resizing does not preserve visible chat content');

requireAll(css, [
  '.chat-policy-controls { grid-column: 1 / -1; min-width: 0; display: grid;',
  'grid-template-columns: minmax(0,.85fr) minmax(0,1.15fr);',
  '@media (max-width: 620px) {\n  .chat-policy-controls {\n    grid-template-columns: 1fr;',
], 'adjacent permission and token-policy selectors can overflow a compact chat header');
requireAll(chat, [
  'className="chat-policy-controls"',
  'aria-label="대화 권한"',
  'aria-label="대화 토큰 정책"',
], 'permission and per-conversation token policy controls are not grouped together');

requireAll(css, [
  '.profile-menu.embedded {\n    display: grid;',
  '.profile-menu.embedded .profile-trigger {',
  '.profile-menu.embedded .profile-popover {',
  'inset: auto 12px calc(62px + env(safe-area-inset-bottom));',
], 'compact chat can hide profile and execution-PC controls');

requireAll(profile, [
  'aria-label="프로필 및 실행 PC 메뉴"',
  'aria-haspopup="menu"',
  'role="menu"',
  'role="menuitem"',
  "event.key !== 'Escape'",
], 'profile menu keyboard and compact-window access contract is missing');

requireAll(chat, [
  'role="menuitem"',
  "event.key === 'ArrowDown'",
  "event.key === 'ArrowUp'",
  "window.addEventListener('scroll', close, true)",
  'Math.max(8, Math.min(event.clientX, window.innerWidth - 214))',
], 'conversation menu can escape the viewport or lose keyboard navigation');

requireAll(ui, [
  'const onCloseRef = useRef(onClose);',
  'onCloseRef.current = onClose;',
  'onCloseRef.current();',
  '}, [open]);',
], 'modal focus lifecycle can reset on every parent render');

console.log('RESPONSIVE UI CONTRACT PASSED · header, gate, chat, composer, menus and modal focus are bounded');
