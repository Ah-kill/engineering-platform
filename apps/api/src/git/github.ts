import { HttpError } from '../http/errors.js';

/**
 * Accepts only https://github.com/<owner>/<repo>[.git] (or owner/repo). Restricting the
 * host keeps user input from pointing clone or API calls at internal services (SSRF).
 */
export function parseGithubRepo(input: string): { owner: string; name: string } {
  const s = input.trim();
  const m =
    /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(s) ??
    /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/.exec(s);
  if (!m || m[2] === '.' || m[2] === '..') {
    throw HttpError.badRequest('Use a GitHub repository URL like https://github.com/owner/repo');
  }
  return { owner: m[1]!, name: m[2]! };
}

export const cloneUrl = (owner: string, name: string) => `https://github.com/${owner}/${name}.git`;

/** Owner and repository names as GitHub allows them; checked before they go into an API path. */
export const GITHUB_OWNER_NAME = /^[A-Za-z0-9-]{1,39}$/;
export const GITHUB_REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

function repoPath(owner: string, name: string): string {
  if (!GITHUB_OWNER_NAME.test(owner) || !GITHUB_REPO_NAME.test(name) || name === '.' || name === '..') {
    throw HttpError.badRequest('Invalid repository name');
  }
  return `/repos/${owner}/${name}`;
}

/** A branch name in an API path: each segment encoded, slashes kept. */
const branchPath = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');

class GithubError extends HttpError {
  constructor(readonly githubStatus: number, message: string) {
    super(githubStatus === 401 ? 400 : 502, 'github_error', message);
  }
}

async function gh<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'engineering-platform',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as { message?: string; errors?: ({ message?: string } | string)[] };
  if (!res.ok) {
    const detail = data.errors?.map((e) => (typeof e === 'string' ? e : e.message)).filter(Boolean).join('; ');
    throw new GithubError(res.status, `GitHub: ${data.message ?? res.statusText}${detail ? ` (${detail})` : ''}`);
  }
  return data as T;
}

const isStatus = (err: unknown, status: number) => err instanceof GithubError && err.githubStatus === status;

export async function repoInfo(token: string, owner: string, name: string) {
  return gh<{ default_branch: string; private: boolean; permissions?: { push?: boolean } }>(token, 'GET', repoPath(owner, name));
}

export interface GithubRepoSummary {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string;
  updatedAt: string;
  url: string;
}

export const MAX_LISTED_REPOS = 300;
const MAX_REPO_PAGES = 10;

/**
 * Repositories the token can reach (GitHub `/user/repos`), most recently updated first,
 * optionally only those of one owner. Paginated, capped at MAX_LISTED_REPOS.
 */
export async function listUserRepos(token: string, owner?: string): Promise<{ repos: GithubRepoSummary[]; truncated: boolean }> {
  const want = owner?.toLowerCase();
  const repos: GithubRepoSummary[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_REPO_PAGES && !truncated; page++) {
    const batch = await gh<
      { name: string; full_name: string; private: boolean; default_branch: string; description: string | null; updated_at: string; html_url: string; owner: { login: string } }[]
    >(token, 'GET', `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
    for (const r of batch) {
      if (want && r.owner.login.toLowerCase() !== want) continue;
      if (repos.length >= MAX_LISTED_REPOS) {
        truncated = true;
        break;
      }
      repos.push({
        owner: r.owner.login, name: r.name, fullName: r.full_name, private: r.private, defaultBranch: r.default_branch,
        description: r.description ?? '', updatedAt: r.updated_at, url: r.html_url,
      });
    }
    if (batch.length < 100) break;
    if (page === MAX_REPO_PAGES) truncated = true;
  }
  return { repos, truncated };
}

/**
 * Creates a repository under an organization, or under the token's own user when `owner` is
 * that user. `auto_init` adds a first commit so the default branch exists.
 */
export async function createRepository(
  token: string,
  repo: { owner: string; name: string; private: boolean; description: string },
): Promise<{ owner: string; name: string; defaultBranch: string; url: string }> {
  repoPath(repo.owner, repo.name); // validates both names
  const me = await gh<{ login: string }>(token, 'GET', '/user');
  const body = { name: repo.name, private: repo.private, description: repo.description, auto_init: true };
  const path = me.login.toLowerCase() === repo.owner.toLowerCase() ? '/user/repos' : `/orgs/${repo.owner}/repos`;
  const created = await gh<{ name: string; owner: { login: string }; default_branch: string; html_url: string }>(token, 'POST', path, body);
  return { owner: created.owner.login, name: created.name, defaultBranch: created.default_branch || 'main', url: created.html_url };
}

/** Whether GitHub branch protection is on. A branch that does not exist on GitHub yet is not protected. */
export async function isBranchProtected(token: string, owner: string, name: string, branch: string): Promise<boolean> {
  try {
    const b = await gh<{ protected?: boolean }>(token, 'GET', `${repoPath(owner, name)}/branches/${branchPath(branch)}`);
    return b.protected === true;
  } catch (err) {
    if (isStatus(err, 404)) return false;
    throw err;
  }
}

export async function createPullRequest(
  token: string,
  owner: string,
  name: string,
  pr: { title: string; body: string; head: string; base: string; draft?: boolean },
) {
  return gh<{ number: number; html_url: string }>(token, 'POST', `${repoPath(owner, name)}/pulls`, pr);
}

interface RawPull {
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft?: boolean;
  merged_at: string | null;
  html_url: string;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  created_at: string;
  updated_at: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  author: string;
  head: string;
  base: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

const summarise = (p: RawPull): PullRequestSummary => ({
  number: p.number, title: p.title, state: p.merged_at ? 'merged' : p.state, draft: !!p.draft, author: p.user?.login ?? '',
  head: p.head.ref, base: p.base.ref, url: p.html_url, createdAt: p.created_at, updatedAt: p.updated_at,
});

export async function listPullRequests(token: string, owner: string, name: string, state: 'open' | 'closed' | 'all' = 'open'): Promise<PullRequestSummary[]> {
  const pulls = await gh<RawPull[]>(token, 'GET', `${repoPath(owner, name)}/pulls?state=${state}&per_page=50&sort=updated&direction=desc`);
  return pulls.map(summarise);
}

export interface PullRequestChecks {
  state: 'success' | 'pending' | 'failure' | 'none';
  total: number;
  failed: number;
  pending: number;
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string;
  headSha: string;
  /** null while GitHub is still computing it. */
  mergeable: boolean | null;
  /** clean, unstable, blocked, behind, dirty, draft, unknown, ... */
  mergeableState: string;
  /** Commit statuses and check runs on the head commit; null when the token cannot read them. */
  checks: PullRequestChecks | null;
  files: { path: string; status: string; additions: number; deletions: number; patch?: string }[];
  filesTruncated: boolean;
}

export async function getPullRequest(token: string, owner: string, name: string, number: number): Promise<PullRequestDetail> {
  const base = `${repoPath(owner, name)}/pulls/${number}`;
  const [pr, files] = await Promise.all([
    gh<RawPull & { body: string | null; mergeable: boolean | null; mergeable_state?: string; changed_files?: number }>(token, 'GET', base),
    gh<{ filename: string; status: string; additions: number; deletions: number; patch?: string }[]>(token, 'GET', `${base}/files?per_page=100`),
  ]);
  return {
    ...summarise(pr),
    body: pr.body ?? '',
    headSha: pr.head.sha,
    mergeable: pr.mergeable,
    mergeableState: pr.mergeable_state ?? 'unknown',
    checks: await checksFor(token, owner, name, pr.head.sha),
    files: files.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch?.slice(0, 20_000) })),
    filesTruncated: (pr.changed_files ?? files.length) > files.length,
  };
}

/** Two cheap calls: commit statuses and check runs. Each may fail (missing permission); both failing gives null. */
async function checksFor(token: string, owner: string, name: string, sha: string): Promise<PullRequestChecks | null> {
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  const [status, runs] = await Promise.all([
    gh<{ statuses: { state: string }[] }>(token, 'GET', `${repoPath(owner, name)}/commits/${sha}/status`).catch(() => null),
    gh<{ check_runs: { status: string; conclusion: string | null }[] }>(token, 'GET', `${repoPath(owner, name)}/commits/${sha}/check-runs?per_page=100`).catch(() => null),
  ]);
  if (!status && !runs) return null;
  let failed = 0;
  let pending = 0;
  let total = 0;
  for (const s of status?.statuses ?? []) {
    total++;
    if (s.state === 'pending') pending++;
    else if (s.state !== 'success') failed++;
  }
  for (const r of runs?.check_runs ?? []) {
    total++;
    if (r.status !== 'completed') pending++;
    else if (!['success', 'neutral', 'skipped'].includes(r.conclusion ?? '')) failed++;
  }
  const state = total === 0 ? 'none' : failed ? 'failure' : pending ? 'pending' : 'success';
  return { state, total, failed, pending };
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

/** Merges only if the head is still `sha`, so a push after the review cannot slip in. */
export async function mergePullRequest(token: string, owner: string, name: string, number: number, opts: { method: MergeMethod; sha: string }) {
  return gh<{ merged: boolean; sha: string; message: string }>(token, 'PUT', `${repoPath(owner, name)}/pulls/${number}/merge`, {
    merge_method: opts.method,
    sha: opts.sha,
  });
}
