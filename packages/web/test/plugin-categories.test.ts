import assert from 'node:assert/strict';
import type { PluginInfo } from '@mr-robot/shared';
import { PLUGIN_CATEGORY_LABELS, groupPluginsByCategory } from '../src/plugin-categories';

function plugin(id: string, category: PluginInfo['category'], builtin = false): PluginInfo {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: '',
    status: 'loaded',
    kind: 'tool',
    category,
    builtin,
    enabled: true,
    capabilities: [],
    permissions: [],
    dependencies: [],
    source: '',
    commands: [],
    subscriptions: 0,
    timers: 0,
  };
}

const legacyBuiltin = plugin('legacy-builtin', 'other', true) as Partial<PluginInfo>;
const legacyUser = plugin('legacy-user', 'system') as Partial<PluginInfo>;
delete legacyBuiltin.category;
delete legacyUser.category;

const groups = groupPluginsByCategory([
  plugin('unknown', 'other'),
  plugin('sslscan', 'pentest', true),
  plugin('calendar', 'productivity', true),
  plugin('orca', 'development', true),
  legacyBuiltin as PluginInfo,
  legacyUser as PluginInfo,
]);

assert.deepEqual(groups.map((group) => group.category), [
  'system',
  'productivity',
  'development',
  'pentest',
  'other',
]);
assert.deepEqual(groups.find((group) => group.category === 'system')?.plugins.map((item) => item.id), ['legacy-builtin']);
assert.deepEqual(groups.find((group) => group.category === 'other')?.plugins.map((item) => item.id), ['unknown', 'legacy-user']);
assert.equal(PLUGIN_CATEGORY_LABELS.pentest, '모의해킹');

console.log('PLUGIN CATEGORY TEST PASSED · stable sections + legacy fallbacks + Korean labels verified');
