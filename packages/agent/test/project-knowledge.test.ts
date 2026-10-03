import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectKnowledge } from '../src/project-knowledge.js';
import { MemoryStore } from '../src/memory.js';
import { knowledgeQuery } from '../src/ai/knowledge-tool.js';

function fixture(t: any) {
  const base = mkdtempSync(join(tmpdir(), 'mrrobot-project-knowledge-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'project'); mkdirSync(root);
  const write = (path: string, data: unknown) => { const dir = join(root, path); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'package.json'), JSON.stringify(data)); };
  write('', { name: 'workspace-root', workspaces: ['packages/*'] });
  write('packages/view', { name: '@fixture/view', dependencies: { '@fixture/api': '*', 'external': 'https://TOKEN@never-read.invalid' }, scripts: { test: 'SECRET_SCRIPT' } });
  write('packages/api', { name: '@fixture/api', dependencies: { '@fixture/data': '*' } });
  write('packages/data', { name: '@fixture/data' });
  return { root, write, memory: new MemoryStore(join(base, 'memory')), base };
}
test('fresh manifest graph supports change impact without storing private files or running scripts', async t => {
  const { root, memory } = fixture(t);
  const observed = await readProjectKnowledge(root, 'project');
  assert.equal(observed.partial, false); assert.equal(observed.facts.length, 9);
  const result = memory.retainedContext('@fixture/view 변경 영향', { workspaceId: 'project' }, { observed: observed.facts });
  assert.ok(result.facts.some(f => f.subject === '@fixture/view' && f.predicate === 'depends_on' && f.object === '@fixture/data' && f.status === 'inferred'));
  assert.match(result.context, /sha256=/); assert.doesNotMatch(result.context, /TOKEN|SECRET_SCRIPT|never-read/);
  assert.equal(memory.list().length, 0); assert.equal(memory.inspect('@fixture/view').context, '');
});
test('subsequent runs see edits and removed dependencies rather than stale inferred facts', async t => {
  const { root, write, memory } = fixture(t);
  const one = await readProjectKnowledge(root, 'project');
  write('packages/api', { name: '@fixture/api' });
  const two = await readProjectKnowledge(root, 'project');
  const result = memory.retainedContext('@fixture/view', { workspaceId: 'project' }, { observed: two.facts });
  assert.ok(!result.facts.some(f => f.subject === '@fixture/view' && f.object === '@fixture/data'));
  assert.notDeepEqual(one.facts, two.facts);
});
test('scope remains enforced for ephemeral metadata, stored claims and referential follow-ups', async t => {
  const { root, memory } = fixture(t);
  const observed = (await readProjectKnowledge(root, 'project')).facts;
  const options = { observed, previousUserQuery: '@fixture/api를 검토해줘' };
  assert.ok(memory.retainedContext('그거 바꾸면 어디 영향 있어?', { workspaceId: 'project' }, options).metrics.inferred > 0);
  assert.equal(memory.retainedContext('그거 바꾸면?', { workspaceId: 'other' }, options).context, '');
  assert.equal(memory.retainedContext('다른 여행 계획', { workspaceId: 'project' }, options).context, '');
  assert.equal(memory.retainedContext('그럼 unknown-project 상태는?', { workspaceId: 'project' }, options).context, '');
  assert.equal(memory.retainedContext('안녕', { workspaceId: 'project' }, options).context, '');
  memory.add('saved', [], { workspaceId: 'project', relationMode: 'fact', relation: { subject: '@fixture/api', predicate: 'located_in', object: 'old-location' } });
  const conflict = memory.retainedContext('@fixture/api', { workspaceId: 'project' }, { observed });
  assert.ok(conflict.conflicts.some(c => c.kind === 'single_value'));
});
test('traversal, junctions and unsupported globs cannot import external metadata', async t => {
  const { root, base, write } = fixture(t);
  const outside = join(base, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: 'private-outside' }));
  symlinkSync(outside, join(root, 'packages', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  write('', { name: 'workspace-root', workspaces: ['../outside', 'packages/*', 'packages/**', '.secret'] });
  const result = await readProjectKnowledge(root, 'project');
  assert.equal(result.partial, true); assert.doesNotMatch(JSON.stringify(result.facts), /private-outside/);
});
test('oversized, malformed and non-manifest files fail closed and do not block work', async t => {
  const { root, write } = fixture(t);
  write('packages/data', { name: '@fixture/data', padding: 'x'.repeat(140000) });
  writeFileSync(join(root, 'packages', 'api', 'package.json'), '{');
  writeFileSync(join(root, '.env'), 'PRIVATE_NEVER_INCLUDE');
  const result = await readProjectKnowledge(root, 'project');
  assert.equal(result.partial, true); assert.doesNotMatch(JSON.stringify(result.facts), /PRIVATE_NEVER_INCLUDE|@fixture\/data|@fixture\/api/);
});
test('hardlinked manifests and excessive workspaces stay bounded and explicitly partial', async t => {
  const { root, base, write } = fixture(t);
  const outside = join(base, 'hardlink-source.json');
  writeFileSync(outside, JSON.stringify({ name: 'private-hardlink' }));
  mkdirSync(join(root, 'packages', 'hardlink'));
  linkSync(outside, join(root, 'packages', 'hardlink', 'package.json'));
  const linked = await readProjectKnowledge(root, 'project');
  assert.equal(linked.partial, true); assert.doesNotMatch(JSON.stringify(linked.facts), /private-hardlink/);
  for (let i = 0; i < 80; i++) write(`packages/p${i}`, { name: `fixture-${i}` });
  const bounded = await readProjectKnowledge(root, 'project');
  assert.equal(bounded.partial, true);
  assert.ok(bounded.facts.filter(f => f.relation?.predicate === 'located_in').length <= 64);
});
test('knowledge lookup accepts queries only, never caller-selected scope, credentials or writes', () => {
  assert.equal(knowledgeQuery({ query: ' A ' }), 'A');
  for (const input of [null, [], {}, {query:''}, {query:'a'.repeat(2001)}, {query:'A',workspaceId:'other'}, {query:'A',save:true}]) assert.throws(() => knowledgeQuery(input));
});
