import { mkdir, rm } from 'node:fs/promises';
import { authorize, requirePermission } from '../access/authorize.js';
import type { Database, Queryable } from '../db/db.js';
import { HttpError } from '../http/errors.js';
import type { AuthUser } from '../identity/sessions.js';
import { principalOf } from '../identity/user-routes.js';
import { cloneUrl } from '../git/github.js';
import { assertBranch, runGit } from '../git/git.js';
import { readGithubToken } from '../settings/credentials.js';
import type { Vault } from '../vault/vault.js';
import { workspacePaths } from './paths.js';
import { separateGitDir, type NetworkPolicy, type WorkspaceRuntime } from './runtime.js';
import { awsHostsFor } from '../aws/aws.js';

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
  awsRegion: string | null;
  awsConfigured: boolean;
  ownerName: string;
  /** The caller's access: they own it, or it was shared with them as editor or viewer. */
  access: WorkspaceRole;
}

/** What a user may do in a workspace. Owner: everything. Editor: all but delete and sharing. Viewer: read only. */
export type WorkspaceRole = 'owner' | 'editor' | 'viewer';
/** The access a request needs: read (any member), write (owner or editor), owner. */
export type WorkspaceAccess = 'read' | 'write' | 'owner';

const SATISFIES: Record<WorkspaceAccess, readonly WorkspaceRole[]> = {
  read: ['owner', 'editor', 'viewer'],
  write: ['owner', 'editor'],
  owner: ['owner'],
};

/** `$2` must be the caller's user id: computes their role (or NULL when they have none). */
const WS_SELECT = `
  SELECT w.id, w.org_id AS "orgId", w.application_id AS "applicationId", w.environment_id AS "environmentId",
         w.repository_id AS "repositoryId", w.owner_id AS "ownerId", ou.display_name AS "ownerName",
         CASE WHEN w.owner_id = $2 THEN 'owner'
              ELSE (SELECT m.role FROM workspace_members m WHERE m.workspace_id = w.id AND m.user_id = $2) END AS access,
         w.branch, w.base_branch AS "baseBranch",
         w.state, w.error, w.created_at AS "createdAt", w.last_active_at AS "lastActiveAt",
         r.owner AS "repoOwner", r.name AS "repoName", r.default_branch AS "defaultBranch",
         a.name AS "applicationName", a.client_id AS "clientId", c.name AS "clientName",
         e.name AS "environmentName", e.kind AS "environmentKind",
         a.egress_mode AS "egressMode", a.egress_hosts AS "egressHosts",
         e.aws_region AS "awsRegion", (e.aws_role_arn IS NOT NULL) AS "awsConfigured"
    FROM workspaces w
    JOIN repositories r ON r.id = w.repository_id
    JOIN applications a ON a.id = w.application_id
    JOIN clients c ON c.id = a.client_id
    JOIN environments e ON e.id = w.environment_id
    JOIN users ou ON ou.id = w.owner_id`;

/** Resolves the git remote for a repository. Overridable in tests (local bare repos). */
export type RemoteResolver = (owner: string, name: string) => string;
export const githubRemote: RemoteResolver = cloneUrl;

/**
 * The caller's workspaces in an application: their own and those shared with them, as long
 * as they still hold `environment.use` on the workspace's environment.
 */
export async function listWorkspaces(q: Queryable, user: AuthUser, applicationId: string): Promise<WorkspaceRow[]> {
  const rows = await q.query<WorkspaceRow>(
    `${WS_SELECT} WHERE w.application_id = $1 AND w.state <> 'deleted'
       AND (w.owner_id = $2 OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.user_id = $2))
     ORDER BY w.last_active_at DESC`,
    [applicationId, user.id],
  );
  const allowed = new Map<string, boolean>();
  const out: WorkspaceRow[] = [];
  for (const r of rows) {
    if (r.access === 'owner') {
      out.push(r);
      continue;
    }
    if (!allowed.has(r.environmentId)) {
      allowed.set(r.environmentId, (await authorize(q, principalOf(user), 'environment.use', { type: 'environment', id: r.environmentId })).allowed);
    }
    if (allowed.get(r.environmentId)) out.push(r);
  }
  return out;
}

/**
 * Loads a workspace the caller may use: they own it or it was shared with them, and they
 * still hold `environment.use` on its environment (so revoking access takes effect
 * immediately). `access` is what the request needs and defaults to 'write', so callers
 * that predate sharing keep refusing viewers.
 */
export async function loadWorkspace(
  q: Queryable,
  user: AuthUser,
  id: string,
  opts: { allowNotReady?: boolean; access?: WorkspaceAccess } = {},
): Promise<WorkspaceRow> {
  const [ws] = await q.query<WorkspaceRow>(`${WS_SELECT} WHERE w.id = $1 AND w.state <> 'deleted'`, [id, user.id]);
  if (!ws || !ws.access) throw HttpError.notFound('Workspace not found');
  await requirePermission(q, principalOf(user), 'environment.use', { type: 'environment', id: ws.environmentId });
  const need = opts.access ?? 'write';
  if (!SATISFIES[need].includes(ws.access)) {
    throw HttpError.forbidden(
      need === 'owner' ? 'Only the owner of this workspace can do this' : 'You have view-only access to this workspace',
    );
  }
  if (!opts.allowNotReady && ws.state !== 'ready') {
    throw HttpError.badRequest(ws.state === 'failed' ? `Workspace failed to set up: ${ws.error ?? 'unknown error'}` : 'Workspace is still being set up');
  }
  return ws;
}

/**
 * The one place a workspace's network policy is computed, so provisioning, Claude runs and
 * terminals always agree (a different policy would rebuild the container). AWS endpoints for
 * the environment's region are added whenever an AWS role is configured.
 */
export function networkPolicyFor(ws: Pick<WorkspaceRow, 'egressMode' | 'egressHosts' | 'awsRegion' | 'awsConfigured'>): NetworkPolicy {
  const aws = ws.awsConfigured && ws.awsRegion ? awsHostsFor(ws.awsRegion) : [];
  return { mode: ws.egressMode, hosts: [...new Set([...ws.egressHosts, ...aws])] };
}

export async function touchWorkspace(q: Queryable, id: string) {
  await q.query('UPDATE workspaces SET last_active_at = now() WHERE id = $1', [id]);
}

/**
 * The user's GitHub token for a repository owner (organization or user), falling back to
 * their default token. Always the acting user's own token, also in shared workspaces.
 */
export async function githubToken(q: Queryable, vault: Vault, userId: string, owner?: string): Promise<string | undefined> {
  return readGithubToken(q, vault, userId, owner);
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
    const remoteOpts = { token: opts.token, allowLocalRemote: !opts.remote.startsWith('https://') };
    await runGit(['clone', '--no-tags', '--origin', 'origin', '--separate-git-dir', paths.gitDir, opts.remote, paths.repo], {
      cwd: paths.root,
      timeoutMs: 10 * 60_000,
      ...remoteOpts,
    });
    // A new, empty repository has no branches yet: start the working branch without history.
    const heads = await runGit(['ls-remote', '--heads', 'origin'], { cwd: paths.repo, timeoutMs: 60_000, ...remoteOpts });
    if (!heads.trim()) {
      await runGit(['checkout', '--orphan', assertBranch(opts.branch)], { cwd: paths.repo });
    } else if (opts.createBranch) {
      await runGit(['checkout', '-B', assertBranch(opts.branch), `origin/${assertBranch(opts.baseBranch)}`], { cwd: paths.repo });
    } else {
      await runGit(['checkout', assertBranch(opts.branch)], { cwd: paths.repo });
    }
    await separateGitDir(paths);
    await opts.runtime.ensure(paths, opts.network);
    // Only a workspace still being set up becomes ready. If it was deleted meanwhile (the delete
    // route already removed its folder), this update matches nothing and what was just created
    // (container, files) is removed again instead of resurrecting the workspace.
    const updated = await db.tenant(opts.orgId, (q) =>
      q.query(`UPDATE workspaces SET state = 'ready', error = NULL WHERE id = $1 AND state = 'creating' RETURNING id`, [opts.workspaceId]),
    );
    if (!updated.length) await discardWorkspaceFiles(paths.root, opts.workspaceId, opts.runtime);
  } catch (err) {
    await discardWorkspaceFiles(paths.root, opts.workspaceId, opts.runtime);
    // A deleted workspace stays deleted (its clone usually fails because the folder vanished).
    await db
      .tenant(opts.orgId, (q) =>
        q.query(`UPDATE workspaces SET state = 'failed', error = $2 WHERE id = $1 AND state = 'creating'`, [
          opts.workspaceId,
          String((err as Error).message).slice(0, 1000),
        ]),
      )
      .catch(() => undefined);
  }
}

async function discardWorkspaceFiles(root: string, workspaceId: string, runtime: WorkspaceRuntime) {
  await runtime.remove(workspaceId).catch(() => undefined);
  await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
}

export const INTERRUPTED_SETUP_ERROR = 'Setup was interrupted by a server restart; delete and recreate the workspace.';

/**
 * At startup: a workspace still `creating` was being cloned by a server process that is gone,
 * so it can never become ready. Marks each one failed (the owner can then delete and recreate
 * it). Runs across organizations, so it uses the system connection. Returns how many.
 */
export async function recoverInterruptedWorkspaces(db: Database): Promise<number> {
  const rows = await db.system((q) =>
    q.query<{ id: string }>(`UPDATE workspaces SET state = 'failed', error = $1 WHERE state = 'creating' RETURNING id`, [INTERRUPTED_SETUP_ERROR]),
  );
  return rows.length;
}

export async function destroyWorkspaceFiles(workspacesDir: string, workspaceId: string, runtime: WorkspaceRuntime) {
  await runtime.remove(workspaceId);
  await rm(workspacePaths(workspacesDir, workspaceId).root, { recursive: true, force: true, maxRetries: 3 });
}
