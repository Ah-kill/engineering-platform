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
  const data = (await res.json().catch(() => ({}))) as { message?: string; errors?: { message?: string }[] };
  if (!res.ok) {
    const detail = data.errors?.map((e) => e.message).filter(Boolean).join('; ');
    throw new HttpError(res.status === 401 ? 400 : 502, 'github_error', `GitHub: ${data.message ?? res.statusText}${detail ? ` (${detail})` : ''}`);
  }
  return data as T;
}

export async function repoInfo(token: string, owner: string, name: string) {
  return gh<{ default_branch: string; private: boolean; permissions?: { push?: boolean } }>(token, 'GET', `/repos/${owner}/${name}`);
}

export async function createPullRequest(
  token: string,
  owner: string,
  name: string,
  pr: { title: string; body: string; head: string; base: string; draft?: boolean },
) {
  return gh<{ number: number; html_url: string }>(token, 'POST', `/repos/${owner}/${name}/pulls`, pr);
}
