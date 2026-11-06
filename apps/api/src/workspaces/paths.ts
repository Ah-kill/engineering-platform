import path from 'node:path';

/**
 * On-disk layout of a workspace:
 *   <WORKSPACES_DIR>/<workspaceId>/repo    the git checkout the developer and Claude edit
 *   <WORKSPACES_DIR>/<workspaceId>/home    HOME and CLAUDE_CONFIG_DIR for the agent, so it
 *                                          never sees the server user's own ~/.claude login
 */
export function workspacePaths(workspacesDir: string, workspaceId: string) {
  if (!/^[0-9a-f-]{36}$/.test(workspaceId)) throw new Error('Invalid workspace id');
  const root = path.resolve(workspacesDir, workspaceId);
  return { root, repo: path.join(root, 'repo'), home: path.join(root, 'home') };
}

/** Serialises git operations per workspace so two requests cannot interleave. */
const locks = new Map<string, Promise<unknown>>();
export function withWorkspaceLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(workspaceId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(workspaceId, next);
  void next.finally(() => {
    if (locks.get(workspaceId) === next) locks.delete(workspaceId);
  });
  return next;
}
