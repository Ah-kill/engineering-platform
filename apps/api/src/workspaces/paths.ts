import path from 'node:path';

/**
 * On-disk layout of a workspace:
 *   <WORKSPACES_DIR>/<workspaceId>/repo    the checkout the developer and Claude edit
 *   <WORKSPACES_DIR>/<workspaceId>/git     its git directory (mounted read-only into the container)
 *   <WORKSPACES_DIR>/<workspaceId>/home    HOME and CLAUDE_CONFIG_DIR for the agent, so it
 *                                          never sees the server user's own ~/.claude login
 */
export function workspacePaths(workspacesDir: string, workspaceId: string) {
  if (!/^[0-9a-f-]{36}$/.test(workspaceId)) throw new Error('Invalid workspace id');
  const root = path.resolve(workspacesDir, workspaceId);
  return { id: workspaceId, root, repo: path.join(root, 'repo'), gitDir: path.join(root, 'git'), home: path.join(root, 'home') };
}

/** Serialises git operations per workspace so two requests cannot interleave. */
const locks = new Map<string, Promise<unknown>>();

/** True while a git operation holds (or is queued on) the workspace lock. */
export function isWorkspaceLocked(workspaceId: string): boolean {
  return locks.has(workspaceId);
}
export function withWorkspaceLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(workspaceId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(workspaceId, next);
  // The caller handles `next`'s outcome; this cleanup chain must not raise an unhandled rejection.
  next
    .finally(() => {
      if (locks.get(workspaceId) === next) locks.delete(workspaceId);
    })
    .catch(() => undefined);
  return next;
}
