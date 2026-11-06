import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authorize, requirePermission } from '../access/authorize.js';
import { audit } from '../audit/audit.js';
import { caller, type RouteDeps } from '../http/app.js';
import { HttpError, mapDbError } from '../http/errors.js';
import { principalOf } from '../identity/user-routes.js';
import * as git from '../git/git.js';
import { createPullRequest, parseGithubRepo, repoInfo } from '../git/github.js';
import { deleteRepoPath, listTree, readRepoFile, resolveInRepo, writeRepoFile } from './files.js';
import { withWorkspaceLock, workspacePaths } from './paths.js';
import { destroyWorkspaceFiles, githubToken, listWorkspaces, loadWorkspace, provisionWorkspace, touchWorkspace, type WorkspaceRow } from './service.js';

const idParam = z.object({ id: z.string().uuid() });
const pathQuery = z.object({ path: z.string().min(1).max(1024) });

const repoBody = z.object({
  url: z.string().trim().min(3).max(300),
  defaultBranch: z.string().trim().max(200).optional(),
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

const PROTECTED_BRANCHES = new Set(['main', 'master', 'production', 'prod', 'release']);

export async function workspaceRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, vault, workspacesDir, remoteFor } = deps;

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
      // Verify access with the caller's GitHub token when they have one.
      const token = await githubToken(q, vault, user.id);
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
      const [repo] = await q.query<{ id: string; owner: string; name: string; default_branch: string }>(
        'SELECT id, owner, name, default_branch FROM repositories WHERE application_id = $1',
        [id],
      );
      if (!repo) throw HttpError.badRequest('Connect a repository to this application first');
      const baseBranch = git.assertBranch(body.baseBranch || repo.default_branch);
      const [ws] = await q
        .query<{ id: string }>(
          `INSERT INTO workspaces (org_id, application_id, environment_id, repository_id, owner_id, branch, base_branch)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [user.orgId, id, body.environmentId, repo.id, user.id, body.branch, baseBranch],
        )
        .catch((e) => mapDbError(e, 'Workspace already exists'));
      const [app_] = await q.query<{ client_id: string }>('SELECT client_id FROM applications WHERE id = $1', [id]);
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'workspace.created', resourceType: 'workspace', resourceId: ws!.id,
        clientId: app_?.client_id, applicationId: id, environmentId: body.environmentId,
        details: { branch: body.branch, baseBranch, createBranch: body.createBranch, repo: `${repo.owner}/${repo.name}` },
      });
      return { workspaceId: ws!.id, repo, baseBranch, token: await githubToken(q, vault, user.id) };
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
    });
    return reply.status(202).send({ id: prepared.workspaceId, state: 'creating' });
  });

  app.get('/workspaces/:id', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    return db.tenant(user.orgId, async (q) => {
      const ws = await loadWorkspace(q, user, id, { allowNotReady: true });
      if (ws.state === 'ready') await touchWorkspace(q, id);
      return ws;
    });
  });

  app.delete('/workspaces/:id', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    await db.tenant(user.orgId, async (q) => {
      const ws = await loadWorkspace(q, user, id, { allowNotReady: true });
      await q.query(`UPDATE workspaces SET state = 'deleted' WHERE id = $1`, [id]);
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'workspace.deleted', resourceType: 'workspace', resourceId: id,
        clientId: ws.clientId, applicationId: ws.applicationId, environmentId: ws.environmentId,
      });
    });
    deps.agents.cancel(id);
    await destroyWorkspaceFiles(workspacesDir, id).catch(() => undefined);
    return { ok: true };
  });

  /** Loads the workspace (authorised) and returns its paths; wraps each handler below. */
  async function ws(req: { params: unknown; auth?: unknown }) {
    const { user } = caller(req as never);
    const { id } = idParam.parse(req.params);
    const row = await db.tenant(user.orgId, (q) => loadWorkspace(q, user, id));
    return { user, row, paths: workspacePaths(workspacesDir, id) };
  }

  /**
   * Prepares a git command that carries the developer's GitHub token: verifies the
   * workspace's .git/config was not tampered with and limits git to the expected remote.
   */
  async function tokenGit(row: WorkspaceRow, repoDir: string, userId: string, orgId: string) {
    const remote = remoteFor(row.repoOwner, row.repoName);
    await git.assertSafeRepoConfig(repoDir, remote);
    const token = await db.tenant(orgId, (q) => githubToken(q, vault, userId));
    return { token, allowLocalRemote: !remote.startsWith('https://') };
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
    const { paths } = await ws(req);
    return listTree(paths.repo);
  });

  app.get('/workspaces/:id/file', async (req) => {
    const { paths } = await ws(req);
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

  // ---- git ----------------------------------------------------------------

  app.get('/workspaces/:id/git/status', async (req) => {
    const { paths, row } = await ws(req);
    const s = await git.status(paths.repo);
    return { ...s, baseBranch: row.baseBranch, defaultBranch: row.defaultBranch };
  });

  app.get('/workspaces/:id/git/diff', async (req) => {
    const { paths } = await ws(req);
    const { path } = pathQuery.parse(req.query);
    await resolveInRepo(paths.repo, path);
    const original = await git.showHead(paths.repo, path.replace(/\\/g, '/'));
    const current = await readRepoFile(paths.repo, path).catch(() => ({ content: '', binary: false, size: 0 }));
    return { path, original, modified: current.content, binary: current.binary };
  });

  app.get('/workspaces/:id/git/branches', async (req) => {
    const { paths } = await ws(req);
    return git.branches(paths.repo);
  });

  app.get('/workspaces/:id/git/log', async (req) => {
    const { paths } = await ws(req);
    return git.log(paths.repo, 50);
  });

  app.post('/workspaces/:id/git/discard', async (req) => {
    const { paths, row, user } = await ws(req);
    const { path } = pathQuery.parse(req.body);
    await resolveInRepo(paths.repo, path);
    await withWorkspaceLock(row.id, async () => {
      const s = await git.status(paths.repo);
      const entry = s.files.find((f) => f.path === path.replace(/\\/g, '/'));
      if (!entry) return;
      if (entry.status === 'untracked' || entry.code === 'A ') {
        await git.runGit(['rm', '--cached', '-q', '--ignore-unmatch', '--', path], { cwd: paths.repo }).catch(() => undefined);
        await deleteRepoPath(paths.repo, path);
      } else {
        await git.runGit(['restore', '--source=HEAD', '--staged', '--worktree', '--', path], { cwd: paths.repo });
      }
    });
    await auditWs(user, row, 'git.discard', { path });
    return { ok: true };
  });

  app.post('/workspaces/:id/git/fetch', async (req) => {
    const { paths, row, user } = await ws(req);
    await withWorkspaceLock(row.id, async () => {
      const auth = await tokenGit(row, paths.repo, user.id, user.orgId);
      await git.runGit(['fetch', '--prune', 'origin'], { cwd: paths.repo, ...auth });
    });
    return git.branches(paths.repo);
  });

  app.post('/workspaces/:id/git/pull', async (req) => {
    const { paths, row, user } = await ws(req);
    const s = await git.status(paths.repo);
    const out = await withWorkspaceLock(row.id, async () => {
      const auth = await tokenGit(row, paths.repo, user.id, user.orgId);
      return git.runGit(['pull', '--ff-only', 'origin', git.assertBranch(s.branch)], { cwd: paths.repo, ...auth }).catch((e: git.GitError) => {
        if (/couldn't find remote ref/i.test(e.message)) throw HttpError.badRequest(`Branch "${s.branch}" has not been pushed yet`);
        throw HttpError.badRequest(e.message);
      });
    });
    await auditWs(user, row, 'git.pull', { branch: s.branch });
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
      await git.runGit(['add', '-A'], { cwd: paths.repo });
      await git.runGit(['commit', '-q', '-m', message], { cwd: paths.repo, author: { name: user.displayName, email: user.email } });
      return (await git.runGit(['rev-parse', 'HEAD'], { cwd: paths.repo })).trim();
    });
    await auditWs(user, row, 'git.commit', { sha, message: message.slice(0, 200) });
    return { sha };
  });

  app.post('/workspaces/:id/git/push', async (req) => {
    const { paths, row, user } = await ws(req);
    const s = await git.status(paths.repo);
    if (s.branch === row.defaultBranch || PROTECTED_BRANCHES.has(s.branch)) {
      throw HttpError.forbidden(`Pushing directly to "${s.branch}" is not allowed. Push a feature branch and open a pull request.`);
    }
    await withWorkspaceLock(row.id, async () => {
      const auth = await tokenGit(row, paths.repo, user.id, user.orgId);
      await git.runGit(['push', '-u', 'origin', `HEAD:refs/heads/${git.assertBranch(s.branch)}`], { cwd: paths.repo, ...auth, timeoutMs: 5 * 60_000 }).catch((e: git.GitError) => {
        throw HttpError.badRequest(e.message);
      });
    });
    await auditWs(user, row, 'git.push', { branch: s.branch });
    return { ok: true, branch: s.branch };
  });

  app.post('/workspaces/:id/pull-request', async (req) => {
    const { paths, row, user } = await ws(req);
    const body = prBody.parse(req.body);
    const token = await db.tenant(user.orgId, (q) => githubToken(q, vault, user.id));
    if (!token) throw HttpError.badRequest('Add a GitHub token in Settings to open pull requests');
    const s = await git.status(paths.repo);
    const pr = await createPullRequest(token, row.repoOwner, row.repoName, {
      title: body.title, body: body.body, head: s.branch, base: row.baseBranch, draft: body.draft,
    });
    await auditWs(user, row, 'git.pull_request', { number: pr.number, head: s.branch, base: row.baseBranch });
    return { number: pr.number, url: pr.html_url };
  });
}
