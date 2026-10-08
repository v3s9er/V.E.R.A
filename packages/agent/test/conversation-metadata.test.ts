import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationStore } from '../src/conversations.js';

function fixture(t: any) {
  const home = mkdtempSync(join(tmpdir(), 'vera-conversation-metadata-'));
  t.after(() => { assert.ok(home.startsWith(join(tmpdir(), 'vera-conversation-metadata-'))); rmSync(home, { recursive: true, force: true }); });
  return { home, store: new ConversationStore(home), file: join(home, 'conversations.json') };
}

test('invalid create metadata cannot poison existing conversation storage', t => {
  const { home, store, file } = fixture(t), saved = store.create({ title: 'Keep existing conversation' });
  const before = readFileSync(file, 'utf8');
  for (const field of ['providerId', 'providerModel', 'routingPresetId', 'workspaceId']) {
    for (const value of [null, 3, {}, 'x'.repeat(513)]) assert.throws(() => store.create({ [field]: value } as any));
  }
  for (const input of [null, [], { title: 4 }, { title: '한'.repeat(180) }, { daybreakEnabled: 'yes' }, { pinned: 'yes' }, { permissionMode: 'other' }]) {
    assert.throws(() => store.create(input as any));
  }
  assert.equal(readFileSync(file, 'utf8'), before);
  const reloaded = new ConversationStore(home);
  assert.equal(reloaded.list().length, 1); assert.equal(reloaded.get(saved.id)?.title, saved.title);
  assert.equal(reloaded.recovery.degraded, false);
});

test('invalid update is atomic and explicit null clears identifiers across restart', t => {
  const { home, store, file } = fixture(t);
  const saved = store.create({ title: 'Before', providerId: 'provider', providerModel: 'model', routingPresetId: 'legacy', workspaceId: 'project' });
  const before = readFileSync(file, 'utf8');
  for (const patch of [{ title: 'Changed', daybreakEnabled: 'wrong' }, { title: 'Changed', providerModel: {} }, { routingPresetId: 'x'.repeat(257) }]) {
    assert.throws(() => store.update(saved.id, patch as any));
    assert.equal(store.get(saved.id)?.title, 'Before'); assert.equal(readFileSync(file, 'utf8'), before);
  }
  store.update(saved.id, { providerId: null, routingPresetId: null, workspaceId: null });
  const reloaded = new ConversationStore(home), restored = reloaded.get(saved.id)!;
  assert.equal(restored.providerId, undefined); assert.equal(restored.providerModel, undefined);
  assert.equal(restored.routingPresetId, undefined); assert.equal(restored.workspaceId, undefined);
  assert.equal(reloaded.recovery.degraded, false);
});
