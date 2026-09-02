import {
  PLUGIN_CATEGORY_ORDER,
  normalizePluginCategory,
  type PluginCategory,
  type PluginInfo,
} from '@mr-robot/shared';

export const PLUGIN_CATEGORY_LABELS: Readonly<Record<PluginCategory, string>> = {
  system: '시스템·연결',
  productivity: '생산성',
  development: '개발',
  pentest: '모의해킹',
  other: '기타',
};

export interface PluginCategoryGroup {
  category: PluginCategory;
  label: string;
  plugins: PluginInfo[];
}

/**
 * Normalize old server payloads and keep catalog sections deterministic.
 * Plugin order inside a section remains the order supplied by the agent.
 */
export function groupPluginsByCategory(plugins: readonly PluginInfo[]): PluginCategoryGroup[] {
  const buckets = new Map<PluginCategory, PluginInfo[]>(
    PLUGIN_CATEGORY_ORDER.map((category) => [category, []]),
  );
  for (const plugin of plugins) {
    const category = normalizePluginCategory(plugin.category, plugin.builtin ? 'system' : 'other');
    buckets.get(category)?.push(plugin);
  }
  return PLUGIN_CATEGORY_ORDER.flatMap((category) => {
    const entries = buckets.get(category) ?? [];
    return entries.length > 0 ? [{ category, label: PLUGIN_CATEGORY_LABELS[category], plugins: entries }] : [];
  });
}
