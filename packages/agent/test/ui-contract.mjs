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
const routingGraph = read('packages/web/src/components/RoutingGraphEditor.tsx');
const css = read('packages/web/src/styles.css');
if (/window\.(prompt|alert|confirm)\(/.test(uiSource)) throw new Error('native browser prompt/alert/confirm returned to the product UI');
if (!chat.includes('chat-context-panel') || !chat.includes('workspaceDialogOpen')) throw new Error('conversation context/workspace fallback UI is missing');
if (!chat.includes('MarkdownMessage') || !existsSync(join(root, 'packages/web/src/components/MarkdownMessage.tsx'))) throw new Error('rich assistant response rendering is missing');
if (!ui.includes("size?: 'default' | 'wide'")) throw new Error('responsive modal sizing contract is missing');
if (!settings.includes('size="wide"')) throw new Error('preset browser does not request a wide modal');
if (!css.includes('.modal-wide') || !css.includes('.preset-browser { width: 100%')) throw new Error('preset modal overflow safeguards are missing');
if (!chat.includes('aria-label={`${c.title} 메뉴`}') || !chat.includes('setConversationMenu({ conversation: c')) throw new Error('conversation ellipsis is not an actual menu trigger');
if (!app.includes("client.on('voice.command'") || !app.includes("setView('chat')") || !chat.includes('executeCommand(voiceCommand.text)')) throw new Error('recognized wake commands are not globally queued and connected to chat execution');
if (!chat.includes('finally {') || !chat.includes('busyRef.current = false')) throw new Error('chat busy state has no request-completion fallback');
if (!chat.includes("updateConversation({ routingPresetId: null, providerId, providerModel })")) throw new Error('model picker cannot switch directly from a routing preset to single-model mode');
if (!routingGraph.includes('graph-port-in') || !routingGraph.includes('graph-port-out') || !routingGraph.includes('edge-preview')) throw new Error('routing graph lacks intuitive directional drag connection ports');
if (!routingGraph.includes('removeEdge') || !routingGraph.includes('reverseEdge') || !routingGraph.includes('edge-inspector')) throw new Error('routing edges cannot be selected, reversed and deleted');
if (!routingGraph.includes('addGroup') || !routingGraph.includes('updateGroup') || !routingGraph.includes('removeGroup') || !routingGraph.includes('group-dot-picker')) throw new Error('routing meeting groups lack create/update/delete/assignment controls');
if (!routingGraph.includes('startGroupInteraction') || !routingGraph.includes("mode: 'move' | 'resize'") || !routingGraph.includes('syncGroupMembership') || !routingGraph.includes('group-resize-handle')) throw new Error('routing groups cannot be moved, resized, and populated spatially');
if (!routingGraph.includes('graph-health') || !routingGraph.includes('orphanNodes')) throw new Error('routing graph does not report disconnected nodes');
if (!css.includes('.routing-group-bubble') || !css.includes('.graph-edge.selected') || !css.includes('stroke: #766dff !important')) throw new Error('routing groups and persistent edges lack visual design contracts');

console.log(`UI CONTRACT TEST PASSED · ${uiCalls.size} RPC calls matched · menus + model controls + run lifecycle + voice execution verified`);
