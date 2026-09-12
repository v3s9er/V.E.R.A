import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ConfigStore } from '../src/config.js';
import { ConversationStore } from '../src/conversations.js';
import { resolveProjectWorkspace } from '../../shared/src/projects.js';
import { projectRunConflicts } from '../src/server/project-runs.js';
const protector = { protect: (text: string) => `test:${Buffer.from(text).toString('base64url')}`, unprotect: (value: string) => Buffer.from(value.slice(5), 'base64url').toString() };
test('removed explicit projects never fall back to another folder', () => {
  const projects = [{ id: 'default', isDefault: true }, { id: 'other', isDefault: false }];
  assert.equal(resolveProjectWorkspace(projects, 'removed'), undefined);
  assert.equal(resolveProjectWorkspace(projects, 'other'), projects[1]);
  assert.equal(resolveProjectWorkspace(projects), projects[0]);
});
test('project writes stay ordered while separate projects and read-only runs may overlap', () => {
  assert.equal(projectRunConflicts([{ workspaceId: 'a', permissionMode: 'full' }], { workspaceId: 'a', permissionMode: 'ask' }), true);
  assert.equal(projectRunConflicts([{ workspaceId: 'a', permissionMode: 'full' }], { workspaceId: 'b', permissionMode: 'ask' }), false);
  assert.equal(projectRunConflicts([{ workspaceId: 'a', permissionMode: 'read-only' }], { workspaceId: 'a', permissionMode: 'read-only' }), false);
  assert.equal(projectRunConflicts([{ permissionMode: 'ask' }], { permissionMode: 'ask' }), false, 'isolated ticket runs have independent existing scheduling');
});
test('projects persist, preserve separate conversation histories, and never delete files on unlink', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mrrobot-project-test-'));
  try {
    const a = join(temp, 'one'), b = join(temp, 'two'); await mkdir(a); await mkdir(b);
    const config = new ConfigStore(join(temp, 'config'), { providerVault: protector, pairingVault: protector });
    const store = new ConversationStore(join(temp, 'conversations'));
    const first = config.createProject('앱', a, '한국어로 작성'); const second = config.createProject('가이드', b);
    const one = store.create({ workspaceId: first.id }), two = store.create({ workspaceId: second.id });
    store.appendResult(one.id, [{ role: 'user', content: 'project-one-only' }, { role: 'assistant', content: 'answer-one' }], { promptTokens: 1, completionTokens: 1 });
    assert.deepEqual(store.turns(two.id), []);
    assert.notEqual(one.id, two.id); assert.notEqual(first.id, second.id);
    assert.throws(() => config.createProject('duplicate', a), /이미 연결/);
    assert.throws(() => config.createProject('bad', '../relative'), /절대/);
    assert.throws(() => config.createProject('', b), /이름/);
    assert.throws(() => config.updateProject(first.id, 'x', 'x'.repeat(8001)), /8,000/);
    config.updateProject(first.id, '새 이름', '검증 후 답변');
    const reopened = new ConfigStore(join(temp, 'config'), { providerVault: protector, pairingVault: protector });
    assert.equal(reopened.workspaces.find(p => p.id === first.id)?.instructions, '검증 후 답변');
    const reopenedChats = new ConversationStore(join(temp, 'conversations'));
    assert.deepEqual(reopenedChats.turns(one.id), store.turns(one.id));
    assert.equal(reopenedChats.get(two.id)?.workspaceId, second.id);
    await writeFile(join(a, 'keep.txt'), 'keep');
    assert.equal(reopened.removeWorkspace(first.id), true);
    assert.equal(await readFile(join(a, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(reopenedChats.get(one.id)?.workspaceId, first.id, 'orphan ID retained; never silently rebound');
    assert.ok(!reopened.settings.safety.allowedRoots?.includes(a));
    assert.equal(reopened.workspaces[0].isDefault, true);
  } finally {
    const path = relative(tmpdir(), temp); assert.ok(path && !path.startsWith('..'));
    await rm(temp, { recursive: true, force: true });
  }
});
