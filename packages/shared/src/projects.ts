/** A removed explicit project must never silently execute in another folder.
 * Only legacy/unassigned conversations inherit the host's default workspace. */
export function resolveProjectWorkspace<T extends { id: string; isDefault: boolean }>(projects: readonly T[], id?: string | null): T | undefined {
  return id ? projects.find(project => project.id === id) : projects.find(project => project.isDefault);
}
