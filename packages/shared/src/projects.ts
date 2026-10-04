/** A removed explicit project must never silently execute in another folder.
 * Only legacy/unassigned conversations inherit the host's default workspace. */
export function resolveProjectWorkspace<T extends { id: string; isDefault: boolean }>(projects: readonly T[], id?: string | null): T | undefined {
  return id ? projects.find(project => project.id === id) : projects.find(project => project.isDefault);
}

/** Never use a draft's contents as a sidebar title. */
export function conversationDisplayTitle(conversation: { title?: string; messageCount?: number }, hasDraft = false): string {
  const title = conversation.title?.trim().replace(/\s+/g, ' ') ?? '';
  const placeholder = !title || /^(?:새 대화|new (?:chat|conversation)|untitled)$/i.test(title);
  return placeholder && !conversation.messageCount ? (hasDraft ? '작성 중인 새 대화' : '새 대화') : title || '제목 없는 대화';
}

export function groupProjectConversations<T extends { workspaceId?: string }>(
  projects: readonly { id: string; name: string }[], conversations: readonly T[], scope = '*',
): Array<{ id: string; name: string; conversations: T[] }> {
  const selected = conversations.filter(c => scope === '*' || c.workspaceId === scope);
  const groups = projects.filter(p => scope === '*' || p.id === scope).map(p => ({ ...p, conversations: selected.filter(c => c.workspaceId === p.id) }));
  const other = selected.filter(c => !projects.some(p => p.id === c.workspaceId));
  if (other.length) groups.push({ id: '__unassigned__', name: '일반 대화', conversations: other });
  return groups.filter(group => group.conversations.length > 0 || scope === group.id);
}

export function parseCollapsedProjects(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length <= 200))].slice(0, 200) : [];
  } catch { return []; }
}
