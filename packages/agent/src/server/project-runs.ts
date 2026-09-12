type ProjectRun = { workspaceId?: string; permissionMode: string };
/** Coordinate host-owned project runs. Not an OS sandbox or a filesystem lock. */
export function projectRunConflicts(active: Iterable<ProjectRun>, incoming: ProjectRun): boolean {
  if (!incoming.workspaceId) return false;
  return [...active].some(run => run.workspaceId === incoming.workspaceId
    && !(run.permissionMode === 'read-only' && incoming.permissionMode === 'read-only'));
}
