import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authorize, requirePermission } from '../access/authorize.js';
import { audit } from '../audit/audit.js';
import { caller, type RouteDeps } from '../http/app.js';
import { HttpError } from '../http/errors.js';
import { principalOf } from '../identity/user-routes.js';
import * as git from '../git/git.js';
import {
  createPullRequest, createRepository, getPullRequest, GITHUB_OWNER_NAME, GITHUB_REPO_NAME, isBranchProtected, listPullRequests,
  mergePullRequest, parseGithubRepo, repoInfo,
} from '../git/github.js';
import { deleteRepoPath, listTree, readRepoFile, resolveInRepo, writeRepoFile } from './files.js';
import { withWorkspaceLock, workspacePaths } from './paths.js';
import {
  destroyWorkspaceFiles, githubToken, listWorkspaces, loadWorkspace, networkPolicyFor, provisionWorkspace, touchWorkspace,
  type WorkspaceAccess, type WorkspaceRow,
} from './service.js';

const idParam = z.object({ id: z.string().uuid() });
const pathQuery = z.object({ path: z.string().min(1).max(1024) });

const repoBody = z.object({
  url: z.string().trim().min(3).max(300),
  defaultBranch: z.string().trim().max(200).optional(),
});

const createRepoBody = z.object({
  owner: z.string().trim().regex(GITHUB_OWNER_NAME, 'Not a valid GitHub user or organization name'),
  name: z.string().trim().regex(GITHUB_REPO_NAME, 'Repository names use letters, digits, ".", "-" and "_"').refine((n) => n !== '.' && n !== '..'),
  private: z.boolean().default(true),
  description: z.string().trim().max(350).default(''),
});

const createBody = z.object({
  environmentId: z.string().uuid(),
  branch: z.string().trim().min(1).max(200),
  /** Create `branch` from `baseBranch` (default: the repository's default branch). */
  createBranch: z.boolean().default(true),
  baseBranch: z.string().trim().max(200).optional(),
});

const fileBody = z.object({ path: z.string().min(1).max(1024), content: z.string().max(5 * 1024 * 1024) });
const commitBody = z.object({ message: z.string().trim().min(1).max(5000) });
const checkoutBody = z.object({ branch: z.string().trim().min(1).max(200), create: z.boolean().default(false) });
const prBody = z.object({ title: z.string().trim().min(1).max(250), body: z.string().max(20000).default(''), draft: z.boolean().default(false) });
const shaParam = z.object({ id: z.string().uuid(), sha: z.string().regex(git.SHA, 'Invalid commit id') });
const compareQuery = z.object({ base: z.string().min(1).max(200), head: z.string().min(1).max(200) });
const forceQuery = z.object({ force: z.enum(['true', 'false', '1', '0']).optional() });
const resetBody = z.object({ to: z.enum(['head', 'remote']) });
const searchQuery = z.object({ q: z.string().min(1).max(200), regex: z.enum(['true', 'false', '1', '0']).optional() });
const prListQuery = z.object({ state: z.enum(['open', 'closed', 'all']).default('open') });
const prParam = z.object({ id: z.string().uuid(), number: z.coerce.number().int().positive().max(10_000_000) });
const mergeBody = z.object({ method: z.enum(['merge', 'squash', 'rebase']).default('squash') });
const memberParam = z.object({ id: z.string().uuid(), userId: z.string().uuid() });
const memberBody = z.object({ role: z.enum(['viewer', 'editor']) });

const PROTECTED_BRANCHES = new Set(['main', 'master', 'production', 'prod', 'release']);
const truthy = (v?: string) => v === 'true' || v === '1';

export async function workspaceRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, vault, workspacesDir, remoteFor, runtime } = deps;

  // ---- repository connection ---------------------------------------------

  app.get('/applications/:id/repository', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    return db.tenant(user.orgId, async (q) => {
      await requirePermission(q, principalOf(user), 'application.view', { type: 'application', id });
      const [repo] = await q.query(
        `SELECT id, provider, owner, name, default_branch AS "defaultBranch",
                'https://github.com/' || owner || '/' || name AS url
           FROM repositories WHERE application_id = $1`,
        [id],
      );
      return repo ?? null;
    });
  });

  app.put('/applications/:id/repository', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    const body = repoBody.parse(req.body);
    const { owner, name } = parseGithubRepo(body.url);
    return db.tenant(user.orgId, async (q) => {
      const chain = await requirePermission(q, principalOf(user), 'application.update', { type: 'application', id });
      // Verify access with the caller's GitHub token for this owner when they have one.
      const token = await githubToken(q, vault, user.id, owner);
      let defaultBranch = body.defaultBranch ? git.assertBranch(body.defaultBranch) : undefined;
      if (token) defaultBranch ??= (await repoInfo(token, owner, name)).default_branch;
      defaultBranch ??= 'main';
      const [repo] = await q.query(
        `INSERT INTO repositories (org_id, application_id, provider, owner, name, default_branch)
         VALUES ($1, $2, 'github', $3, $4, $5)
         ON CONFLICT (application_id) DO UPDATE SET owner = EXCLUDED.owner, name = EXCLUDED.name,
           default_branch = EXCLUDED.default_branch, updated_at = now()
         RETURNING id, provider, owner, name, default_branch AS "defaultBranch"`,
        [user.orgId, id, owner, name, defaultBranch],
      );
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'repository.connected', resourceType: 'application', resourceId: id,
        clientId: chain?.clientId, applicationId: id, details: { owner, name, defaultBranch },
      });
      return { ...repo, url: `https://github.com/${owner}/${name}` };
    });
  });

  /**
   * Creates a new GitHub repository (with a first commit, so the default branch exists) and
   * connects it. For applications built from scratch; refused when one is already connected.
   */
  app.post('/applications/:id/repository/create', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    const body = createRepoBody.parse(req.body);
    return db.tenant(user.orgId, async (q) => {
      const chain = await requirePermission(q, principalOf(user), 'application.update', { type: 'application', id });
      const [existing] = await q.query('SELECT 1 FROM repositories WHERE application_id = $1', [id]);
      if (existing) throw HttpError.conflict('This application already has a repository connected');
      const token = await githubToken(q, vault, user.id, body.owner);
      if (!token) throw HttpError.badRequest(`Add a GitHub token for ${body.owner} in Settings to create repositories`);
      const created = await createRepository(token, body);
      const [repo] = await q.query(
        `INSERT INTO repositories (org_id, application_id, provider, owner, name, default_branch)
         VALUES ($1, $2, 'github', $3, $4, $5)
         RETURNING id, provider, owner, name, default_branch AS "defaultBranch"`,
        [user.orgId, id, created.owner, created.name, git.assertBranch(created.defaultBranch)],
      );
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'repository.created', resourceType: 'application', resourceId: id,
        clientId: chain?.clientId, applicationId: id,
        details: { owner: created.owner, name: created.name, private: body.private, defaultBranch: created.defaultBranch },
      });
      return { ...repo, url: `https://github.com/${created.owner}/${created.name}` };
    });
  });

  // ---- workspaces ---------------------------------------------------------

  app.get('/applications/:id/workspaces', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    return db.tenant(user.orgId, async (q) => {
      await requirePermission(q, principalOf(user), 'application.view', { type: 'application', id });
      return listWorkspaces(q, user, id);
    });
  });

  app.post('/applications/:id/workspaces', async (req, reply) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    const body = createBody.parse(req.body);
    git.assertBranch(body.branch);

    const prepared = await db.tenant(user.orgId, async (q) => {
      const principal = principalOf(user);
      await requirePermission(q, principal, 'application.view', { type: 'application', id });
      const [env] = await q.query<{ application_id: string }>('SELECT application_id FROM environments WHERE id = $1 AND archived_at IS NULL', [body.environmentId]);
      if (!env || env.application_id !== id) throw HttpError.badRequest('Environment does not belong to this application');
      if (!(await authorize(q, principal, 'environment.use', { type: 'environment', id: body.environmentId })).allowed) {
        throw HttpError.forbidden('You do not have working access to this environment');
      }
      const [repo] = await q.query<{ id: string; owner: string; name: string; default_branch: string; egress_mode: 'restricted' | 'open'; egress_hosts: string[] }>(
        `SELECT r.id, r.owner, r.name, r.default_branch, a.egress_mode, a.egress_hosts
           FROM repositories r JOIN applications a ON a.id = r.application_id WHERE r.application_id = $1`,
        [id],
      );
      if (!repo) throw HttpError.badRequest('Connect a repository to this application first');
      const baseBranch = git.assertBranch(body.baseBranch || repo.default_branch);
      const [ws] = await q.query<{ id: string }>(
        `INSERT INTO workspaces (org_id, application_id, environment_id, repository_id, owner_id, branch, base_branch)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [user.orgId, id, body.environmentId, repo.id, user.id, body.branch, baseBranch],
      );
      const [app_] = await q.query<{ client_id: string }>('SELECT client_id FROM applications WHERE id = $1', [id]);
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'workspace.created', resourceType: 'workspace', resourceId: ws!.id,
        clientId: app_?.client_id, applicationId: id, environmentId: body.environmentId,
        details: { branch: body.branch, baseBranch, createBranch: body.createBranch, repo: `${repo.owner}/${repo.name}` },
      });
      const [envAws] = await q.query<{ aws_region: string | null; aws_configured: boolean }>(
        'SELECT aws_region, (aws_role_arn IS NOT NULL) AS aws_configured FROM environments WHERE id = $1',
        [body.environmentId],
      );
      const network = networkPolicyFor({
        egressMode: repo.egress_mode, egressHosts: repo.egress_hosts,
        awsRegion: envAws?.aws_region ?? null, awsConfigured: !!envAws?.aws_configured,
      });
      return { workspaceId: ws!.id, repo, baseBranch, network, token: await githubToken(q, vault, user.id, repo.owner) };
    });

    // Cloning can take a while: do it in the background; the UI polls the workspace state.
    void provisionWorkspace(db, {
      orgId: user.orgId,
      workspaceId: prepared.workspaceId,
      workspacesDir,
      remote: remoteFor(prepared.repo.owner, prepared.repo.name),
      token: prepared.token,
      branch: body.branch,
      baseBranch: prepared.baseBranch,
      createBranch: body.createBranch,
      runtime,
      network: prepared.network,
    });
    return reply.status(202).send({ id: prepared.workspaceId, state: 'creating' });
  });

  app.get('/workspaces/:id', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    return db.tenant(user.orgId, async (q) => {
      const ws = await loadWorkspace(q, user, id, { allowNotReady: true, access: 'read' });
      if (ws.state === 'ready') await touchWorkspace(q, id);
      return ws;
    });
  });

  app.delete('/workspaces/:id', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    await db.tenant(user.orgId, async (q) => {
      const ws = await loadWorkspace(q, user, id, { allowNotReady: true, access: 'owner' });
      await q.query(`UPDATE workspaces SET state = 'deleted' WHERE id = $1`, [id]);
      await q.query('DELETE FROM workspace_members WHERE workspace_id = $1', [id]);
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'workspace.deleted', resourceType: 'workspace', resourceId: id,
        clientId: ws.clientId, applicationId: ws.applicationId, environmentId: ws.environmentId,
      });
    });
    deps.agents.cancel(id);
    await destroyWorkspaceFiles(workspacesDir, id, runtime).catch(() => undefined);
    return { ok: true };
  });

  /**
   * Loads the workspace (authorised for the access the route needs; default: write) and
   * returns its paths; wraps each handler below.
   */
  async function ws(req: { params: unknown; auth?: unknown }, access: WorkspaceAccess = 'write') {
    const { user } = caller(req as never);
    const { id } = idParam.parse(req.params);
    const row = await db.tenant(user.orgId, (q) => loadWorkspace(q, user, id, { access }));
    return { user, row, paths: workspacePaths(workspacesDir, id) };
  }

  /**
   * Prepares a git command that carries the acting developer's own GitHub token (for the
   * repository's owner): verifies the workspace's .git/config was not tampered with and
   * limits git to the expected remote.
   */
  async function tokenGit(row: WorkspaceRow, repoDir: string, userId: string, orgId: string) {
    // Claude (and anything it started) could rewrite .git/config between the check
    // below and the git command, so token-bearing commands never overlap a run.
    if (deps.agents.isRunning(row.id)) throw HttpError.conflict('Claude is working in this workspace; wait or stop it first');
    const remote = remoteFor(row.repoOwner, row.repoName);
    await git.assertSafeRepoConfig(repoDir, remote);
    const token = await db.tenant(orgId, (q) => githubToken(q, vault, userId, row.repoOwner));
    return { token, allowLocalRemote: !remote.startsWith('https://') };
  }

  /** The caller's GitHub token for this workspace's repository, for REST calls. */
  async function apiToken(user: { id: string; orgId: string }, row: WorkspaceRow, purpose: string): Promise<string> {
    const token = await db.tenant(user.orgId, (q) => githubToken(q, vault, user.id, row.repoOwner));
    if (!token) throw HttpError.badRequest(`Add a GitHub token for ${row.repoOwner} in Settings to ${purpose}`);
    return token;
  }

  function refuseWhileRunning(row: WorkspaceRow) {
    if (deps.agents.isRunning(row.id)) throw HttpError.conflict('Claude is working in this workspace; wait or stop it first');
  }

  async function auditWs(user: { id: string; orgId: string }, row: WorkspaceRow, action: string, details: Record<string, unknown>) {
    await db.tenant(user.orgId, (q) =>
      audit(q, {
        orgId: user.orgId, actorId: user.id, action, resourceType: 'workspace', resourceId: row.id,
        clientId: row.clientId, applicationId: row.applicationId, environmentId: row.environmentId, details,
      }),
    );
  }

  // ---- files --------------------------------------------------------------

  app.get('/workspaces/:id/tree', async (req) => {
    const { paths } = await ws(req, 'read');
    return listTree(paths.repo);
  });

  app.get('/workspaces/:id/file', async (req) => {
    const { paths } = await ws(req, 'read');
    const { path } = pathQuery.parse(req.query);
    return { path, ...(await readRepoFile(paths.repo, path)) };
  });

  app.put('/workspaces/:id/file', async (req) => {
    const { paths, row } = await ws(req);
    const body = fileBody.parse(req.body);
    if (deps.agents.isRunning(row.id)) throw HttpError.conflict('Claude is working in this workspace; wait or stop it before editing');
    await writeRepoFile(paths.repo, body.path, body.content);
    return { ok: true };
  });

  app.delete('/workspaces/:id/file', async (req) => {
    const { paths, row } = await ws(req);
    const { path } = pathQuery.parse(req.query);
    if (deps.agents.isRunning(row.id)) throw HttpError.conflict('Claude is working in this workspace');
    await deleteRepoPath(paths.repo, path);
    return { ok: true };
  });

  /** Code search over the checkout (`git grep`), at most 200 matches. */
  app.get('/workspaces/:id/search', async (req) => {
    const { paths } = await ws(req, 'read');
    const query = searchQuery.parse(req.query);
    if (query.q.includes('\0') || query.q.includes('\n')) throw HttpError.badRequest('Search for text on one line');
    return git.grep(paths.repo, query.q, { regex: truthy(query.regex) });
  });

  // ---- git ----------------------------------------------------------------

  app.get('/workspaces/:id/git/status', async (req) => {
    const { paths, row } = await ws(req, 'read');
    const s = await git.status(paths.repo);
    return { ...s, baseBranch: row.baseBranch, defaultBranch: row.defaultBranch };
  });

  app.get('/workspaces/:id/git/diff', async (req) => {
    const { paths } = await ws(req, 'read');
    const { path } = pathQuery.parse(req.query);
    await resolveInRepo(paths.repo, path);
    const original = await git.showHead(paths.repo, path.replace(/\\/g, '/'));
    const current = await readRepoFile(paths.repo, path).catch(() => ({ content: '', binary: false, size: 0 }));
    return { path, original, modified: current.content, binary: current.binary };
  });

  app.get('/workspaces/:id/git/branches', async (req) => {
    const { paths } = await ws(req, 'read');
    return git.branches(paths.repo);
  });

  app.get('/workspaces/:id/git/log', async (req) => {
    const { paths } = await ws(req, 'read');
    return git.log(paths.repo, 50);
  });

  /** One commit with its changed files and their contents before and after. */
  app.get('/workspaces/:id/git/commit/:sha', async (req) => {
    const { sha } = shaParam.parse(req.params);
    const { paths } = await ws(req, 'read');
    const detail = await git.commitDetail(paths.repo, sha);
    if (!detail) throw HttpError.notFound('Commit not found');
    return detail;
  });

  /** What `head` changes since it forked from `base` (three-dot diff), with file contents. */
  app.get('/workspaces/:id/git/compare', async (req) => {
    const { paths } = await ws(req, 'read');
    const { base, head } = compareQuery.parse(req.query);
    return git.compare(paths.repo, base, head);
  });

  /**
   * Deletes a local branch (never the remote one). Refuses the current, default and
   * protected branches, and an unmerged branch unless `force`.
   */
  app.delete('/workspaces/:id/git/branches/*', async (req) => {
    const { paths, row, user } = await ws(req);
    let name = (req.params as { '*'?: string })['*'] ?? '';
    try {
      if (name.includes('%')) name = decodeURIComponent(name);
    } catch {
      throw HttpError.badRequest('Invalid branch name');
    }
    const branch = git.assertBranch(name);
    const force = truthy(forceQuery.parse(req.query).force);
    refuseWhileRunning(row);
    if (branch === row.defaultBranch || branch === row.baseBranch || PROTECTED_BRANCHES.has(branch)) {
      throw HttpError.forbidden(`"${branch}" is a protected branch and cannot be deleted here`);
    }
    await withWorkspaceLock(row.id, async () => {
      const b = await git.branches(paths.repo);
      if (branch === b.current) throw HttpError.badRequest('Switch to another branch before deleting this one');
      if (!b.local.includes(branch)) throw HttpError.notFound(`There is no local branch "${branch}"`);
      await git.runGit(['branch', force ? '-D' : '-d', branch], { cwd: paths.repo }).catch((e: git.GitError) => {
        if (/not fully merged/i.test(e.stderr)) {
          throw HttpError.conflict(`"${branch}" has commits that are not merged. Delete it anyway to lose them.`);
        }
        throw HttpError.badRequest(e.message);
      });
    });
    await auditWs(user, row, 'git.branch_deleted', { branch, force });
    return git.branches(paths.repo);
  });

  app.post('/workspaces/:id/git/discard', async (req) => {
    const { paths, row, user } = await ws(req);
    const { path } = pathQuery.parse(req.body);
    refuseWhileRunning(row);
    await resolveInRepo(paths.repo, path);
    await withWorkspaceLock(row.id, async () => {
      const s = await git.status(paths.repo);
      const entry = s.files.find((f) => f.path === path.replace(/\\/g, '/'));
      if (!entry) return;
      if (entry.status === 'untracked' || entry.code === 'A ') {
        await git.runGit(['rm', '--cached', '-q', '--ignore-unmatch', '--', path], { cwd: paths.repo }).catch(() => undefined);
        await deleteRepoPath(paths.repo, path);
      } else {
        await git.runGit(['restore', '--source=HEAD', '--staged', '--worktree', '--', path], { cwd: paths.repo }).catch(git.gitBadRequest);
      }
    });
    await auditWs(user, row, 'git.discard', { path });
    return { ok: true };
  });

  /**
   * Resets the workspace. 'head' discards every uncommitted change (`reset --hard`, then
   * `clean -fd`, which removes untracked files inside the checkout but keeps ignored ones such
   * as node_modules and .env). 'remote' also drops local commits: the current branch is set to
   * GitHub's copy after a fetch. The fetch carries the token; the reset, which checks files
   * out, runs without it.
   */
  app.post('/workspaces/:id/git/reset', async (req) => {
    const { paths, row, user } = await ws(req);
    const { to } = resetBody.parse(req.body);
    refuseWhileRunning(row);
    const branch = await withWorkspaceLock(row.id, async () => {
      const s = await git.status(paths.repo);
      // Resetting to HEAD works on a detached HEAD too; resetting to GitHub needs a branch.
      const current = to === 'remote' ? git.requireBranch(s, 'reset it to GitHub') : s.detached ? null : s.branch;
      let target = 'HEAD';
      if (to === 'remote') {
        const auth = await tokenGit(row, paths.repo, user.id, user.orgId);
        await git
          .runGit(['fetch', '--no-recurse-submodules', 'origin', `+refs/heads/${current}:refs/remotes/origin/${current}`], { cwd: paths.repo, ...auth })
          .catch((e: git.GitError) => {
            if (/couldn't find remote ref/i.test(e.message)) throw HttpError.badRequest(`Branch "${current}" is not on GitHub yet`);
            throw HttpError.badRequest(e.message);
          });
        target = `refs/remotes/origin/${current}`;
      } else if (!(await git.resolveCommit(paths.repo, 'HEAD'))) {
        // No commits yet (new repository): there is nothing to reset to, only files to remove.
        await git.runGit(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', '.'], { cwd: paths.repo });
        await git.runGit(['clean', '-fd', '-q'], { cwd: paths.repo });
        return current;
      }
      await git.runGit(['reset', '--hard', '-q', target], { cwd: paths.repo }).catch((e: git.GitError) => {
        throw HttpError.badRequest(e.message);
      });
      await git.runGit(['clean', '-fd', '-q'], { cwd: paths.repo });
      return current;
    });
    await auditWs(user, row, 'git.reset', { to, branch });
    return git.status(paths.repo);
  });

  app.post('/workspaces/:id/git/fetch', async (req) => {
    const { paths, row, user } = await ws(req);
    await withWorkspaceLock(row.id, async () => {
      const auth = await tokenGit(row, paths.repo, user.id, user.orgId);
      await git.runGit(['fetch', '--prune', '--no-recurse-submodules', 'origin'], { cwd: paths.repo, ...auth }).catch(git.gitBadRequest);
    });
    return git.branches(paths.repo);
  });

  app.post('/workspaces/:id/git/pull', async (req) => {
    const { paths, row, user } = await ws(req);
    const s = await git.status(paths.repo);
    const branch = git.requireBranch(s, 'pull');
    const out = await withWorkspaceLock(row.id, async () => {
      const auth = await tokenGit(row, paths.repo, user.id, user.orgId);
      // Fetch with the token, then merge without it: merging checks files out, which can
      // run filter programs, and those must never see the token.
      await git.runGit(['fetch', '--no-recurse-submodules', 'origin', `refs/heads/${branch}`], { cwd: paths.repo, ...auth }).catch((e: git.GitError) => {
        if (/couldn't find remote ref/i.test(e.message)) throw HttpError.badRequest(`Branch "${branch}" has not been pushed yet`);
        throw HttpError.badRequest(e.message);
      });
      return git.runGit(['merge', '--ff-only', 'FETCH_HEAD'], { cwd: paths.repo }).catch((e: git.GitError) => {
        throw HttpError.badRequest(e.message);
      });
    });
    await auditWs(user, row, 'git.pull', { branch });
    return { output: out };
  });

  app.post('/workspaces/:id/git/checkout', async (req) => {
    const { paths, row, user } = await ws(req);
    const body = checkoutBody.parse(req.body);
    const branch = git.assertBranch(body.branch);
    if (deps.agents.isRunning(row.id)) throw HttpError.conflict('Claude is working in this workspace');
    await withWorkspaceLock(row.id, async () => {
      const s = await git.status(paths.repo);
      if (s.files.length && !body.create) throw HttpError.badRequest('Commit or discard your changes before switching branches');
      await git
        .runGit(body.create ? ['checkout', '-b', branch] : ['checkout', branch], { cwd: paths.repo })
        .catch((e: git.GitError) => {
          throw HttpError.badRequest(e.message);
        });
    });
    await db.tenant(user.orgId, (q) => q.query('UPDATE workspaces SET branch = $2 WHERE id = $1', [row.id, branch]));
    await auditWs(user, row, body.create ? 'git.branch_created' : 'git.checkout', { branch });
    return git.branches(paths.repo);
  });

  app.post('/workspaces/:id/git/commit', async (req) => {
    const { paths, row, user } = await ws(req);
    const { message } = commitBody.parse(req.body);
    if (deps.agents.isRunning(row.id)) throw HttpError.conflict('Claude is working in this workspace; wait before committing');
    const sha = await withWorkspaceLock(row.id, async () => {
      const s = await git.status(paths.repo);
      if (!s.files.length) throw HttpError.badRequest('There are no changes to commit');
      await git.runGit(['add', '-A'], { cwd: paths.repo }).catch(git.gitBadRequest);
      await git
        .runGit(['commit', '-q', '-m', message], { cwd: paths.repo, author: { name: user.displayName, email: user.email } })
        .catch(git.gitBadRequest);
      return (await git.runGit(['rev-parse', 'HEAD'], { cwd: paths.repo })).trim();
    });
    await auditWs(user, row, 'git.commit', { sha, message: message.slice(0, 200) });
    return { sha };
  });

  app.post('/workspaces/:id/git/push', async (req) => {
    const { paths, row, user } = await ws(req);
    const s = await git.status(paths.repo);
    const branch = git.requireBranch(s, 'push');
    const refusal = (b: string) => HttpError.forbidden(`Pushing directly to "${b}" is not allowed. Push a feature branch and open a pull request.`);
    if (branch === row.defaultBranch || PROTECTED_BRANCHES.has(branch)) throw refusal(branch);
    await withWorkspaceLock(row.id, async () => {
      const auth = await tokenGit(row, paths.repo, user.id, user.orgId);
      // Branches protected on GitHub are refused here too, not only the names above.
      if (auth.token) {
        const isProtected = await isBranchProtected(auth.token, row.repoOwner, row.repoName, branch).catch((e: Error) => {
          throw new HttpError(502, 'github_error', `Could not check branch protection on GitHub, so nothing was pushed. ${e.message}`);
        });
        if (isProtected) throw refusal(branch);
      }
      await git.runGit(['push', '--no-recurse-submodules', '-u', 'origin', `HEAD:refs/heads/${branch}`], { cwd: paths.repo, ...auth, timeoutMs: 5 * 60_000 }).catch((e: git.GitError) => {
        throw HttpError.badRequest(e.message);
      });
    });
    await auditWs(user, row, 'git.push', { branch });
    return { ok: true, branch };
  });

  // ---- pull requests ------------------------------------------------------

  app.post('/workspaces/:id/pull-request', async (req) => {
    const { paths, row, user } = await ws(req);
    const body = prBody.parse(req.body);
    const head = git.requireBranch(await git.status(paths.repo), 'open a pull request');
    const token = await apiToken(user, row, 'open pull requests');
    const pr = await createPullRequest(token, row.repoOwner, row.repoName, {
      title: body.title, body: body.body, head, base: row.baseBranch, draft: body.draft,
    });
    await auditWs(user, row, 'git.pull_request', { number: pr.number, head, base: row.baseBranch });
    return { number: pr.number, url: pr.html_url };
  });

  app.get('/workspaces/:id/pull-requests', async (req) => {
    const { row, user } = await ws(req, 'read');
    const { state } = prListQuery.parse(req.query);
    const token = await apiToken(user, row, 'see pull requests');
    return listPullRequests(token, row.repoOwner, row.repoName, state);
  });

  app.get('/workspaces/:id/pull-requests/:number', async (req) => {
    const { number } = prParam.parse(req.params);
    const { row, user } = await ws(req, 'read');
    const token = await apiToken(user, row, 'see pull requests');
    const pr = await getPullRequest(token, row.repoOwner, row.repoName, number);
    const canMerge =
      row.access !== 'viewer' &&
      (await db.tenant(user.orgId, (q) => authorize(q, principalOf(user), 'application.merge', { type: 'application', id: row.applicationId }))).allowed;
    return { ...pr, canMerge };
  });

  /** Merges a pull request of this workspace's repository. Needs `application.merge`; refused unless GitHub says it can merge. */
  app.post('/workspaces/:id/pull-requests/:number/merge', async (req) => {
    const { number } = prParam.parse(req.params);
    const { row, user } = await ws(req);
    const { method } = mergeBody.parse(req.body);
    await db.tenant(user.orgId, (q) => requirePermission(q, principalOf(user), 'application.merge', { type: 'application', id: row.applicationId }));
    const token = await apiToken(user, row, 'merge pull requests');
    const pr = await getPullRequest(token, row.repoOwner, row.repoName, number);
    if (pr.state !== 'open') throw HttpError.conflict(`Pull request #${number} is ${pr.state}`);
    if (pr.draft) throw HttpError.conflict(`Pull request #${number} is a draft`);
    if (pr.mergeable === null) throw HttpError.conflict('GitHub is still checking whether this pull request can be merged. Try again in a moment.');
    if (!pr.mergeable || ['dirty', 'blocked'].includes(pr.mergeableState)) {
      throw HttpError.conflict(
        pr.mergeableState === 'blocked'
          ? 'GitHub reports this pull request as blocked (required reviews or checks are missing)'
          : 'GitHub reports this pull request cannot be merged (it has conflicts)',
      );
    }
    const result = await mergePullRequest(token, row.repoOwner, row.repoName, number, { method, sha: pr.headSha });
    await auditWs(user, row, 'git.pull_request_merged', { number, method, head: pr.head, base: pr.base, sha: result.sha });
    return { merged: result.merged, sha: result.sha, message: result.message };
  });

  // ---- sharing ------------------------------------------------------------

  async function memberList(id: string, orgId: string) {
    return db.tenant(orgId, (q) =>
      q.query<{ userId: string; displayName: string; email: string; role: 'viewer' | 'editor'; createdAt: string }>(
        `SELECT m.user_id AS "userId", u.display_name AS "displayName", u.email, m.role, m.created_at AS "createdAt"
           FROM workspace_members m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = $1 ORDER BY u.display_name`,
        [id],
      ),
    );
  }

  app.get('/workspaces/:id/members', async (req) => {
    const { row, user } = await ws(req, 'read');
    const owner = await db.tenant(user.orgId, async (q) => {
      const [o] = await q.query<{ id: string; displayName: string; email: string }>(
        'SELECT id, display_name AS "displayName", email FROM users WHERE id = $1',
        [row.ownerId],
      );
      return o;
    });
    return { owner, members: await memberList(row.id, user.orgId), canManage: row.access === 'owner' };
  });

  /** People the owner can share with: active users holding `environment.use` on the workspace's environment. */
  app.get('/workspaces/:id/members/candidates', async (req) => {
    const { row, user } = await ws(req, 'owner');
    return db.tenant(user.orgId, async (q) => {
      const users = await q.query<{ id: string; displayName: string; email: string; isOrgAdmin: boolean }>(
        `SELECT u.id, u.display_name AS "displayName", u.email, u.is_org_admin AS "isOrgAdmin" FROM users u
          WHERE u.status = 'active' AND u.id <> $1
            AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = $2 AND m.user_id = u.id)
          ORDER BY u.display_name`,
        [row.ownerId, row.id],
      );
      const out = [];
      for (const u of users) {
        const { allowed } = await authorize(q, { userId: u.id, isOrgAdmin: u.isOrgAdmin }, 'environment.use', { type: 'environment', id: row.environmentId });
        if (allowed) out.push({ id: u.id, displayName: u.displayName, email: u.email });
      }
      return out;
    });
  });

  app.put('/workspaces/:id/members/:userId', async (req) => {
    const { userId } = memberParam.parse(req.params);
    const { role } = memberBody.parse(req.body);
    const { row, user } = await ws(req, 'owner');
    if (userId === row.ownerId) throw HttpError.badRequest('The owner already has full access');
    await db.tenant(user.orgId, async (q) => {
      const [target] = await q.query<{ id: string; is_org_admin: boolean; status: string }>(
        'SELECT id, is_org_admin, status FROM users WHERE id = $1',
        [userId],
      );
      if (!target || target.status !== 'active') throw HttpError.notFound('User not found');
      const { allowed } = await authorize(q, { userId, isOrgAdmin: target.is_org_admin }, 'environment.use', { type: 'environment', id: row.environmentId });
      if (!allowed) throw HttpError.badRequest(`That person has no working access to the ${row.environmentName} environment`);
      await q.query(
        `INSERT INTO workspace_members (org_id, workspace_id, user_id, role, added_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [user.orgId, row.id, userId, role, user.id],
      );
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'workspace.member_added', resourceType: 'workspace', resourceId: row.id,
        clientId: row.clientId, applicationId: row.applicationId, environmentId: row.environmentId, details: { userId, role },
      });
    });
    return memberList(row.id, user.orgId);
  });

  /** The owner removes a member, or a member leaves. */
  app.delete('/workspaces/:id/members/:userId', async (req) => {
    const { userId } = memberParam.parse(req.params);
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    const row = await db.tenant(user.orgId, (q) => loadWorkspace(q, user, id, { access: 'read', allowNotReady: true }));
    if (row.access !== 'owner' && userId !== user.id) throw HttpError.forbidden('Only the owner of this workspace can do this');
    await db.tenant(user.orgId, async (q) => {
      const removed = await q.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 RETURNING user_id', [row.id, userId]);
      if (!removed.length) throw HttpError.notFound('Not a member of this workspace');
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'workspace.member_removed', resourceType: 'workspace', resourceId: row.id,
        clientId: row.clientId, applicationId: row.applicationId, environmentId: row.environmentId, details: { userId },
      });
    });
    return memberList(row.id, user.orgId);
  });
}
