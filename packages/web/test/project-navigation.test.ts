import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary, WorkspaceInfo } from '@mr-robot/shared';
import { projectNavigation } from '../src/components/project-navigation.js';

const project = (id: string): WorkspaceInfo => ({ id, name: id, path: '', isDefault: false, createdAt: 1 });
const chat = (id: string, workspaceId?: string, updatedAt = 1): ConversationSummary => ({ id, workspaceId, updatedAt, title: id, status: 'active', pinned: false, createdAt: 1, messageCount: 0, reasoningEffort: 'medium', permissionMode: 'ask', tokenPolicy: 'adaptive', compactedMessages: 0 });

test('89 projects with 67 empty in this view render only five recent groups by default', () => {
  const projects = Array.from({ length: 89 }, (_, i) => project(`p${i}`));
  const conversations = Array.from({ length: 22 }, (_, i) => chat(`c${i}`, `p${i}`, i + 1));
  const before = JSON.stringify({ projects, conversations });
  const result = projectNavigation(projects, conversations, '*');
  assert.deepEqual(result.preview.map(p => p.id), ['p21', 'p20', 'p19', 'p18', 'p17']);
  assert.equal(result.groups.length, 89);
  assert.equal(result.hiddenCount, 84);
  assert.equal(JSON.stringify({ projects, conversations }), before);
});

test('selection, running, pinned, and newly created empty project survive the recent limit', () => {
  const projects = Array.from({ length: 10 }, (_, i) => project(`p${i}`));
  const conversations = Array.from({ length: 9 }, (_, i) => chat(`c${i}`, `p${i}`, i + 1));
  conversations[2].pinned = true;
  const result = projectNavigation(projects, conversations, 'p9', 'c0', ['c1']);
  for (const id of ['p9', 'p0', 'p1', 'p2']) assert.ok(result.preview.some(group => group.id === id));
  assert.ok(!result.preview.some(group => group.id === 'p3'));
  assert.equal(result.hiddenCount, 1);
});

test('loose and detached conversations stay in original order without invented folders', () => {
  const conversations = [chat('detached', 'removed'), chat('project', 'p'), chat('loose')];
  const result = projectNavigation([project('p')], conversations, '*');
  assert.deepEqual(result.loose.map(c => c.id), ['detached', 'loose']);
  assert.equal(conversations[0].workspaceId, 'removed');
});

test('empty-only views keep all projects discoverable, not all expanded by default', () => {
  const projects = [project('a'), project('b')];
  assert.equal(projectNavigation(projects, [], '*').preview.length, 0);
  assert.equal(projectNavigation(projects, [], '*').hiddenCount, 2);
  assert.deepEqual(projectNavigation(projects, [], 'a').preview.map(p => p.id), ['a']);
});
