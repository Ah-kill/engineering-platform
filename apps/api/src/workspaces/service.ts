import { mkdir, rm } from 'node:fs/promises';
import { requirePermission } from '../access/authorize.js';
import type { Database, Queryable } from '../db/db.js';
import { HttpError } from '../http/errors.js';
import type { AuthUser } from '../identity/sessions.js';
import { principalOf } from '../identity/user-routes.js';
import { cloneUrl } from '../git/github.js';
import { assertBranch, runGit } from '../git/git.js';
import { readCredential } from '../settings/credentials.js';
import type { Vault } from '../vault/vault.js';
import { workspacePaths } from './paths.js';
import { separateGitDir, type NetworkPolicy, type WorkspaceRuntime } from './runtime.js';

export interface WorkspaceRow {
  id: string;
  orgId: string;
  applicationId: string;
  environmentId: string;
  repositoryId: string;
  ownerId: string;
  branch: string;
  baseBranch: string;
  state: 'creating' | 'ready' | 'failed' | 'deleted';
  error: string | null;
  createdAt: string;
  lastActiveAt: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  applicationName: string;
  clientId: string;
  clientName: string;
  environmentName: string;
  environmentKind: string;
  egressMode: 'restricted' | 'open';
  egressHosts: string[];
}

const WS_SELECT = `
  SELECT w.id, w.org_id AS "orgId", w.application_id AS "applicationId", w.environment_id AS "environmentId",
         w.repository_id AS "repositoryId", w.owner_id AS "ownerId", w.branch, w.base_branch AS "baseBranch",
         w.state, w.error, w.created_at AS "createdAt", w.last_active_at AS "lastActiveAt",
         r.owner AS "repoOwner", r.name AS "repoName", r.default_branch AS "defaultBranch",
         a.name AS "applicationName", a.client_id AS "clientId", c.name AS "clientName",
         e.name AS "environmentName", e.kind AS "environmentKind",
         a.egress_mode AS "egressMode", a.egress_hosts AS "egressHosts"
    FROM workspaces w
    JOIN repositories r ON r.id = w.repository_id
    JOIN applications a ON a.id = w.application_id
    JOIN clients c ON c.id = a.client_id
    JOIN environments e ON e.id = w.environment_id`;

/** Resolves the git remote for a repository. Overridable in tests (local bare repos). */
export type RemoteResolver = (owner: string, name: string) => string;
export const githubRemote: RemoteResolver = cloneUrl;

export async function listWorkspaces(q: Queryable, user: AuthUser, applicationId: string): Promise<WorkspaceRow[]> {
  return q.query<WorkspaceRow>(
    `${WS_SELECT} WHERE w.application_id = $1 AND w.owner_id = $2 AND w.state <> 'deleted' ORDER BY w.last_active_at DESC`,
    [applicationId, user.id],
  );
}

/**
 * Loads a workspace the caller may work in: they own it and still hold `environment.use`
 * on its environment (so revoking access takes effect immediately).
 */
export async function loadWorkspace(q: Queryable, user: AuthUser, id: string, opts: { allowNotReady?: boolean } = {}): Promise<WorkspaceRow> {
  const [ws] = await q.query<WorkspaceRow>(`${WS_SELECT} WHERE w.id = $1 AND w.state <> 'deleted'`, [id]);
  if (!ws || ws.ownerId !== user.id) throw HttpError.notFound('Workspace not found');
  await requirePermission(q, principalOf(user), 'environment.use', { type: 'environment', id: ws.environmentId });
  if (!opts.allowNotReady && ws.state !== 'ready') {
    throw HttpError.badRequest(ws.state === 'failed' ? `Workspace failed to set up: ${ws.error ?? 'unknown error'}` : 'Workspace is still being set up');
  }
  return ws;
}

export async function touchWorkspace(q: Queryable, id: string) {
  await q.query('UPDATE workspaces SET last_active_at = now() WHERE id = $1', [id]);
}

export async function githubToken(q: Queryable, vault: Vault, userId: string): Promise<string | undefined> {
  return readCredential(q, vault, userId, 'github_token');
}

/**
 * Clones the repository into the workspace and checks out the working branch.
 * `createBranch` makes a new branch from `baseBranch`; otherwise `branch` must exist on the remote.
 */
export async function provisionWorkspace(
  db: Database,
  opts: {
    orgId: string;
    workspaceId: string;
    workspacesDir: string;
    remote: string;
    token?: string;
    branch: string;
    baseBranch: string;
    createBranch: boolean;
    runtime: WorkspaceRuntime;
    network: NetworkPolicy;
  },
): Promise<void> {
  const paths = workspacePaths(opts.workspacesDir, opts.workspaceId);
  try {
    await mkdir(paths.root, { recursive: true });
    await mkdir(paths.home, { recursive: true });
    // The git directory lives beside the checkout so the container can mount it read-only:
    // Claude can read history and diffs but cannot change git configuration or hooks.
    await runGit(['clone', '--no-tags', '--origin', 'origin', '--separate-git-dir', paths.gitDir, opts.remote, paths.repo], {
      cwd: paths.root,
      token: opts.token,
      timeoutMs: 10 * 60_000,
      allowLocalRemote: !opts.remote.startsWith('https://'),
    });
    if (opts.createBranch) {
      await runGit(['checkout', '-B', assertBranch(opts.branch), `origin/${assertBranch(opts.baseBranch)}`], { cwd: paths.repo });
    } else {
      await runGit(['checkout', assertBranch(opts.branch)], { cwd: paths.repo });
    }
    await separateGitDir(paths);
    await opts.runtime.ensure(paths, opts.network);
    await db.tenant(opts.orgId, (q) => q.query(`UPDATE workspaces SET state = 'ready', error = NULL WHERE id = $1`, [opts.workspaceId]));
  } catch (err) {
    await opts.runtime.remove(opts.workspaceId).catch(() => undefined);
    await rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
    await db.tenant(opts.orgId, (q) =>
      q.query(`UPDATE workspaces SET state = 'failed', error = $2 WHERE id = $1`, [opts.workspaceId, String((err as Error).message).slice(0, 1000)]),
    );
  }
}

export async function destroyWorkspaceFiles(workspacesDir: string, workspaceId: string, runtime: WorkspaceRuntime) {
  await runtime.remove(workspaceId);
  await rm(workspacePaths(workspacesDir, workspaceId).root, { recursive: true, force: true, maxRetries: 3 });
}
