import type { ConversationSummary, WorkspaceInfo } from '@mr-robot/shared';

export const PROJECT_PREVIEW_COUNT = 5;
export interface NavigationProject {
  id: string;
  name: string;
  project: WorkspaceInfo;
  conversations: ConversationSummary[];
  latestActivity: number;
  retained: boolean;
}

/** Presentation only: never reassign, archive, or delete the underlying records. */
export function projectNavigation(projects: WorkspaceInfo[], conversations: ConversationSummary[], active: string, selectedId?: string, running: string[] = []) {
  const buckets = new Map(projects.map(project => [project.id, [] as ConversationSummary[]]));
  const loose: ConversationSummary[] = [];
  const runningIds = new Set(running);
  for (const conversation of conversations) {
    const bucket = conversation.workspaceId ? buckets.get(conversation.workspaceId) : undefined;
    (bucket ?? loose).push(conversation);
  }
  const groups: NavigationProject[] = projects.map(project => {
    const items = buckets.get(project.id)!;
    return { id: project.id, name: project.name, project, conversations: items,
      latestActivity: items.reduce((latest, item) => Math.max(latest, item.updatedAt), 0),
      retained: project.id === active || items.some(item => item.id === selectedId || runningIds.has(item.id) || item.pinned),
    };
  }).sort((a, b) => b.latestActivity - a.latestActivity || b.project.createdAt - a.project.createdAt || a.id.localeCompare(b.id));
  const recentIds = new Set(groups.filter(group => group.conversations.length > 0).slice(0, PROJECT_PREVIEW_COUNT).map(group => group.id));
  const preview = groups.filter(group => recentIds.has(group.id) || group.retained);
  return { groups, preview, loose, hiddenCount: groups.length - preview.length };
}
