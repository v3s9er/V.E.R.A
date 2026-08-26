import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../dist/config.js';
import { ContextBroker } from '../dist/context-broker.js';
import { ChatSession } from '../dist/server/chat.js';
import { ConversationStore } from '../dist/conversations.js';

const home = mkdtempSync(join(tmpdir(), 'mr-robot-v02-'));
const workspacePath = join(home, 'workspace');
mkdirSync(workspacePath, { recursive: true });

const config = new ConfigStore(home);
const workspace = config.addWorkspace(workspacePath, '테스트 작업 폴더');
if (!workspace.isDefault || config.workspaces.length !== 1) throw new Error('workspace was not persisted as default');
if (config.addWorkspace(workspacePath).id !== workspace.id) throw new Error('duplicate workspace was created');
if (!config.settings.safety.allowedRoots?.includes(workspacePath)) throw new Error('workspace permission root was not registered');
let missingWorkspaceRejected = false;
try { config.addWorkspace(join(home, 'missing-workspace')); } catch { missingWorkspaceRejected = true; }
if (!missingWorkspaceRejected) throw new Error('nonexistent workspace path was accepted');

const conversations = new ConversationStore(home);
const ordinary = conversations.create({ title: '일반', permissionMode: 'read-only' });
const pinned = conversations.create({ title: '고정', pinned: true, permissionMode: 'workspace' });
if (conversations.list()[0].id !== pinned.id) throw new Error('pinned conversation was not sorted first');
if (conversations.get(ordinary.id)?.permissionMode !== 'read-only') throw new Error('per-conversation access was not persisted');
if (!conversations.update(ordinary.id, { pinned: true, permissionMode: 'full' }).pinned) throw new Error('conversation pin update failed');

const file = join(workspacePath, 'context.txt');
writeFileSync(file, 'shared context', 'utf8');
const broker = new ContextBroker(home);
if (broker.read(file).cached) throw new Error('first context read was incorrectly marked cached');
if (!broker.read(file).cached || broker.stats().hits !== 1) throw new Error('context cache did not reuse the parsed file');
broker.invalidate(file);
if (broker.read(file).cached) throw new Error('context cache invalidation failed');

const session = new ChatSession();
session.begin();
session.steer('첫 추가 명령');
session.steer('두 번째 추가 명령');
if (session.steeringQueued !== 2 || session.takeSteering().length !== 2 || session.steeringQueued !== 0) throw new Error('chat steering queue failed');
session.cancel();
session.end();

if (!config.removeWorkspace(workspace.id) || config.workspaces.length !== 0) throw new Error('workspace removal failed');
rmSync(home, { recursive: true, force: true });
console.log('V0.2 WORKSPACE + CONTEXT CACHE + STEERING TEST PASSED');
