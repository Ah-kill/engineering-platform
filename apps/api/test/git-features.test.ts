import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentDriver, AgentEvent, AgentRunInput } from '../src/agents/driver.js';
import { runGit } from '../src/git/git.js';
import { Client, PASSWORD, seedOrg, setup, type TestEnv } from './helpers.js';

/**
 * GitHub tokens per owner, the repository picker and creation, history/compare/branch
 * deletion, reset, code search, pull requests and branch protection. Git runs against local
 * bare repositories; GitHub's REST API is replaced by a stubbed fetch.
 */

type Script = (input: AgentRunInput) => AsyncGenerator<AgentEvent>;
let script: Script = async function* () {};
const driver: AgentDriver = { run: (input) => script(input) };

let env: TestEnv;
let tmp: string;
let bare: string;
let emptyBare: string;
let admin: Client;
let dev: Client;
let lead: Client;
let appId: string;
let newAppId: string;
let devEnvId: string;
let newDevEnvId: string;
let wsId: string;

const author = { name: 'Seeder', email: 'seed@test' };
const DEFAULT_TOKEN = 'github_pat_' + 'd'.repeat(30) + 'DEF1';
const ACME_TOKEN = 'github_pat_' + 'a'.repeat(30) + 'ACM1';
const LEAD_TOKEN = 'github_pat_' + 'l'.repeat(30) + 'LEAD';

interface GhCall { method: string; url: string; token: string; body: unknown }
let ghCalls: GhCall[] = [];
type GhHandler = (call: GhCall) => { status?: number; body: unknown } | undefined;

/** Replaces fetch with a router over GitHub API paths; unhandled calls fail the test with 599. */
function stubGithub(handler: GhHandler) {
  ghCalls = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: GhCall = {
      method: init?.method ?? 'GET',
      url: url.replace('https://api.github.com', ''),
      token: (headers.authorization ?? '').replace(/^Bearer /, ''),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    ghCalls.push(call);
    const res = handler(call) ?? { status: 599, body: { message: `unexpected ${call.method} ${call.url}` } };
    return new Response(JSON.stringify(res.body), { status: res.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function createWorkspace(client: Client, app: string, envId: string, branch: string): Promise<string> {
  const r = await client.post(`/api/applications/${app}/workspaces`, { environmentId: envId, branch });
  expect(r.statusCode, r.body).toBe(202);
  const id = r.json().id as string;
  const ws = await waitFor(async () => {
    const w = (await client.get(`/api/workspaces/${id}`)).json();
    return w.state === 'creating' ? undefined : w;
  });
  expect(ws.state, ws.error).toBe('ready');
  return id;
}

async function auditActions(): Promise<string[]> {
  const rows = await env.db.system((q) => q.query<{ action: string }>('SELECT action FROM audit_events ORDER BY occurred_at'));
  return rows.map((r) => r.action);
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'ep-gitf-'));
  bare = path.join(tmp, 'origin.git');
  emptyBare = path.join(tmp, 'empty.git');
  const seed = path.join(tmp, 'seed');
  await runGit(['init', '--bare', '-b', 'main', bare], { cwd: tmp });
  await runGit(['init', '--bare', '-b', 'main', emptyBare], { cwd: tmp });
  await runGit(['clone', bare, seed], { cwd: tmp, allowLocalRemote: true });
  await writeFile(path.join(seed, 'README.md'), '# Payments\n');
  await writeFile(path.join(seed, 'retry.js'), 'export const retries = 3;\n// retry with backoff\n');
  await runGit(['add', '-A'], { cwd: seed });
  await runGit(['commit', '-m', 'initial'], { cwd: seed, author });
  await runGit(['push', 'origin', 'HEAD:main'], { cwd: seed, allowLocalRemote: true });
  // A second branch on the remote, for compare.
  await runGit(['checkout', '-b', 'feature/refunds'], { cwd: seed });
  await writeFile(path.join(seed, 'refunds.js'), 'export const refund = () => true;\n');
  await runGit(['add', '-A'], { cwd: seed });
  await runGit(['commit', '-m', 'Add refunds'], { cwd: seed, author });
  await runGit(['push', 'origin', 'HEAD:feature/refunds'], { cwd: seed, allowLocalRemote: true });

  env = await setup({ remoteFor: (_owner, name) => (name === 'fresh-app' ? emptyBare : bare), agentDriver: driver });
  const { adminEmail } = await seedOrg(env.db, 'gitco');
  admin = await Client.login(env.app, adminEmail);

  const clientId = (await admin.post('/api/clients', { name: 'ABC' })).json().id;
  const created = (await admin.post(`/api/clients/${clientId}/applications`, { name: 'Payments' })).json();
  appId = created.id;
  devEnvId = created.environments.find((e: { kind: string }) => e.kind === 'development').id;
  const fresh = (await admin.post(`/api/clients/${clientId}/applications`, { name: 'Fresh', origin: 'new' })).json();
  newAppId = fresh.id;
  newDevEnvId = fresh.environments.find((e: { kind: string }) => e.kind === 'development').id;

  for (const email of ['dev@gitco.test', 'lead@gitco.test']) {
    await admin.post('/api/users', { email, displayName: email.split('@')[0], password: PASSWORD });
  }
  const users = (await admin.get('/api/users')).json() as { id: string; email: string }[];
  const id = (email: string) => users.find((u) => u.email === email)!.id;
  for (const app of [appId, newAppId]) {
    await admin.post('/api/grants', { userId: id('dev@gitco.test'), role: 'developer', scopeType: 'application', scopeId: app });
    await admin.post('/api/grants', { userId: id('lead@gitco.test'), role: 'app_admin', scopeType: 'application', scopeId: app });
  }
  dev = await Client.login(env.app, 'dev@gitco.test');
  lead = await Client.login(env.app, 'lead@gitco.test');
  await admin.request('PUT', `/api/applications/${appId}/repository`, { url: 'https://github.com/acme/payments', defaultBranch: 'main' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await env.close();
  await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

describe('GitHub tokens per owner', () => {
  it('saves a default token and one per owner, listing hints only', async () => {
    expect((await dev.request('PUT', '/api/me/credentials/github_token', { value: DEFAULT_TOKEN })).statusCode).toBe(200);
    expect((await dev.request('PUT', '/api/me/credentials/github_token', { value: ACME_TOKEN, owner: 'Acme' })).statusCode).toBe(200);
    const s = await dev.get('/api/me/settings');
    expect(s.body).not.toContain(DEFAULT_TOKEN);
    expect(s.body).not.toContain(ACME_TOKEN);
    expect(s.json().credentials.github_token).toMatchObject({ saved: true, hint: '…DEF1' });
    expect(s.json().githubTokens).toEqual([
      expect.objectContaining({ owner: null, hint: '…DEF1' }),
      expect.objectContaining({ owner: 'acme', hint: '…ACM1' }),
    ]);
  });

  it('replaces the token for the same owner instead of adding another', async () => {
    const replacement = 'github_pat_' + 'b'.repeat(30) + 'ACM2';
    await dev.request('PUT', '/api/me/credentials/github_token', { value: replacement, owner: 'acme' });
    const tokens = (await dev.get('/api/me/settings')).json().githubTokens as { owner: string | null; hint: string }[];
    expect(tokens.filter((t) => t.owner === 'acme')).toEqual([expect.objectContaining({ hint: '…ACM2' })]);
    await dev.request('PUT', '/api/me/credentials/github_token', { value: ACME_TOKEN, owner: 'acme' });
  });

  it('validates owner names and refuses owners on other credential kinds', async () => {
    expect((await dev.request('PUT', '/api/me/credentials/github_token', { value: ACME_TOKEN, owner: 'bad owner!' })).statusCode).toBe(400);
    const key = 'sk-ant-api03-' + 'k'.repeat(40);
    expect((await dev.request('PUT', '/api/me/credentials/anthropic_api_key', { value: key, owner: 'acme' })).statusCode).toBe(400);
  });

  it('uses the owner-specific token and falls back to the default one', async () => {
    stubGithub((c) => (c.url.startsWith('/user/repos') ? { body: [] } : undefined));
    expect((await dev.get('/api/me/github/repos?owner=acme')).statusCode).toBe(200);
    expect((await dev.get('/api/me/github/repos?owner=someone-else')).statusCode).toBe(200);
    expect(ghCalls.map((c) => c.token)).toEqual([ACME_TOKEN, DEFAULT_TOKEN]);
  });

  it('deletes one owner token without touching the default', async () => {
    const extra = 'github_pat_' + 'e'.repeat(30) + 'EXT1';
    await dev.request('PUT', '/api/me/credentials/github_token', { value: extra, owner: 'extra-co' });
    expect((await dev.delete('/api/me/credentials/github_token?owner=extra-co')).statusCode).toBe(200);
    const owners = ((await dev.get('/api/me/settings')).json().githubTokens as { owner: string | null }[]).map((t) => t.owner);
    expect(owners).toEqual([null, 'acme']);
  });
});

describe('repository picker', () => {
  const repo = (owner: string, i: number) => ({
    name: `repo-${i}`, full_name: `${owner}/repo-${i}`, private: true, default_branch: 'main', description: null,
    updated_at: '2026-11-01T00:00:00Z', html_url: `https://github.com/${owner}/repo-${i}`, owner: { login: owner },
  });

  it('lists repositories of one owner across pages, capped at 300', async () => {
    stubGithub((c) => {
      const page = Number(new URL(`https://x${c.url}`).searchParams.get('page'));
      // Five full pages: half acme, half other.
      if (c.url.startsWith('/user/repos') && page <= 8) {
        return { body: Array.from({ length: 100 }, (_, i) => repo(i % 2 ? 'Acme' : 'other', page * 100 + i)) };
      }
      return { body: [] };
    });
    const r = await dev.get('/api/me/github/repos?owner=acme');
    expect(r.statusCode, r.body).toBe(200);
    const { repos, truncated } = r.json() as { repos: { owner: string; fullName: string; defaultBranch: string }[]; truncated: boolean };
    expect(repos).toHaveLength(300);
    expect(truncated).toBe(true);
    expect(repos.every((x) => x.owner === 'Acme')).toBe(true);
    expect(repos[0]).toMatchObject({ defaultBranch: 'main' });
  });

  it('needs a token', async () => {
    expect((await admin.get('/api/me/github/repos')).statusCode).toBe(400);
  });
});

describe('creating a repository for a new app', () => {
  it('only app admins can create it', async () => {
    const r = await dev.post(`/api/applications/${newAppId}/repository/create`, { owner: 'acme', name: 'fresh-app' });
    expect(r.statusCode).toBe(403);
  });

  it('creates the repository in the organization and connects it', async () => {
    await lead.request('PUT', '/api/me/credentials/github_token', { value: LEAD_TOKEN });
    stubGithub((c) => {
      if (c.method === 'GET' && c.url === '/user') return { body: { login: 'lead-user' } };
      if (c.method === 'POST' && c.url === '/orgs/acme/repos') {
        return { status: 201, body: { name: 'fresh-app', owner: { login: 'acme' }, default_branch: 'main', html_url: 'https://github.com/acme/fresh-app' } };
      }
      return undefined;
    });
    const r = await lead.post(`/api/applications/${newAppId}/repository/create`, { owner: 'acme', name: 'fresh-app', description: 'New app' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ owner: 'acme', name: 'fresh-app', defaultBranch: 'main' });
    const post = ghCalls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ name: 'fresh-app', private: true, auto_init: true, description: 'New app' });
    expect(post.token).toBe(LEAD_TOKEN);
    expect(await auditActions()).toContain('repository.created');
  });

  it('refuses when a repository is already connected', async () => {
    stubGithub(() => undefined);
    const r = await lead.post(`/api/applications/${newAppId}/repository/create`, { owner: 'acme', name: 'other' });
    expect(r.statusCode).toBe(409);
    expect(ghCalls).toHaveLength(0);
  });

  it('opens a workspace on an empty repository with an orphan branch, then commits and pushes', async () => {
    // The stand-in remote for acme/fresh-app is an empty bare repository.
    const id = await createWorkspace(dev, newAppId, newDevEnvId, 'feature/start');
    const status = (await dev.get(`/api/workspaces/${id}/git/status`)).json();
    expect(status.branch).toBe('feature/start');
    expect((await dev.get(`/api/workspaces/${id}/git/log`)).json()).toEqual([]);
    await dev.request('PUT', `/api/workspaces/${id}/file`, { path: 'index.js', content: 'console.log(1);\n' });
    expect((await dev.post(`/api/workspaces/${id}/git/commit`, { message: 'First commit' })).statusCode).toBe(200);
    stubGithub((c) => (c.url.includes('/branches/') ? { status: 404, body: { message: 'Branch not found' } } : undefined));
    const push = await dev.post(`/api/workspaces/${id}/git/push`);
    expect(push.statusCode, push.body).toBe(200);
    expect(await runGit(['branch', '--list'], { cwd: emptyBare })).toContain('feature/start');
    await dev.delete(`/api/workspaces/${id}`);
  });
});

describe('history, compare and branches', () => {
  let commitSha: string;

  it('creates a workspace and commits a change', async () => {
    wsId = await createWorkspace(dev, appId, devEnvId, 'feature/retry');
    await dev.request('PUT', `/api/workspaces/${wsId}/file`, { path: 'retry.js', content: 'export const retries = 5;\n// retry with backoff\n' });
    await dev.request('PUT', `/api/workspaces/${wsId}/file`, { path: 'docs/notes.md', content: 'notes\n' });
    commitSha = (await dev.post(`/api/workspaces/${wsId}/git/commit`, { message: 'More retries\n\nBecause the API is flaky.' })).json().sha;
    expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('shows a commit with each file before and after', async () => {
    const r = await dev.get(`/api/workspaces/${wsId}/git/commit/${commitSha.slice(0, 10)}`);
    expect(r.statusCode, r.body).toBe(200);
    const c = r.json();
    expect(c).toMatchObject({ sha: commitSha, subject: 'More retries', body: 'Because the API is flaky.', author: 'dev' });
    const retry = c.files.find((f: { path: string }) => f.path === 'retry.js');
    expect(retry).toMatchObject({ status: 'modified' });
    expect(retry.original).toContain('retries = 3');
    expect(retry.modified).toContain('retries = 5');
    expect(c.files.find((f: { path: string }) => f.path === 'docs/notes.md')).toMatchObject({ status: 'added', original: '', modified: 'notes\n' });
  });

  it('shows the root commit, and validates the commit id', async () => {
    const log = (await dev.get(`/api/workspaces/${wsId}/git/log`)).json() as { sha: string }[];
    const root = (await dev.get(`/api/workspaces/${wsId}/git/commit/${log.at(-1)!.sha}`)).json();
    expect(root.parent).toBeNull();
    expect(root.files.map((f: { path: string }) => f.path).sort()).toEqual(['README.md', 'retry.js']);
    expect((await dev.get(`/api/workspaces/${wsId}/git/commit/HEAD~1`)).statusCode).toBe(400);
    expect((await dev.get(`/api/workspaces/${wsId}/git/commit/--output=x`)).statusCode).toBe(400);
    expect((await dev.get(`/api/workspaces/${wsId}/git/commit/${'0'.repeat(40)}`)).statusCode).toBe(404);
  });

  it('compares branches (three-dot) with file contents and commits', async () => {
    const r = await dev.get(`/api/workspaces/${wsId}/git/compare?base=main&head=feature/retry`);
    expect(r.statusCode, r.body).toBe(200);
    const cmp = r.json();
    expect(cmp.commits.map((c: { subject: string }) => c.subject)).toEqual(['More retries']);
    expect(cmp.files.map((f: { path: string }) => f.path).sort()).toEqual(['docs/notes.md', 'retry.js']);
    const remote = (await dev.get(`/api/workspaces/${wsId}/git/compare?base=feature/retry&head=origin/feature/refunds`)).json();
    expect(remote.files).toEqual([expect.objectContaining({ path: 'refunds.js', status: 'added' })]);
  });

  it('rejects bad branch names in compare', async () => {
    expect((await dev.get(`/api/workspaces/${wsId}/git/compare?base=main&head=--upload-pack=x`)).statusCode).toBe(400);
    expect((await dev.get(`/api/workspaces/${wsId}/git/compare?base=main..x&head=main`)).statusCode).toBe(400);
    expect((await dev.get(`/api/workspaces/${wsId}/git/compare?base=main&head=nope`)).statusCode).toBe(400);
  });

  it('deletes local branches with the safety checks', async () => {
    // An unmerged branch: refused without force, deleted with it.
    await dev.post(`/api/workspaces/${wsId}/git/checkout`, { branch: 'feature/tmp', create: true });
    await dev.request('PUT', `/api/workspaces/${wsId}/file`, { path: 'tmp.txt', content: 'x' });
    await dev.post(`/api/workspaces/${wsId}/git/commit`, { message: 'tmp' });
    expect((await dev.delete(`/api/workspaces/${wsId}/git/branches/feature/tmp`)).statusCode).toBe(400); // current
    await dev.post(`/api/workspaces/${wsId}/git/checkout`, { branch: 'feature/retry' });
    const unmerged = await dev.delete(`/api/workspaces/${wsId}/git/branches/feature/tmp`);
    expect(unmerged.statusCode).toBe(409);
    expect(unmerged.json().error.message).toMatch(/not merged/);
    const forced = await dev.delete(`/api/workspaces/${wsId}/git/branches/${encodeURIComponent('feature/tmp')}?force=true`);
    expect(forced.statusCode, forced.body).toBe(200);
    expect(forced.json().local).not.toContain('feature/tmp');

    expect((await dev.delete(`/api/workspaces/${wsId}/git/branches/main`)).statusCode).toBe(403);
    expect((await dev.delete(`/api/workspaces/${wsId}/git/branches/feature/none`)).statusCode).toBe(404);
    expect((await dev.delete(`/api/workspaces/${wsId}/git/branches/bad..name`)).statusCode).toBe(400);
    expect(await auditActions()).toContain('git.branch_deleted');
  });

  it('never deletes the branch on the remote', async () => {
    await dev.post(`/api/workspaces/${wsId}/git/checkout`, { branch: 'feature/pushed', create: true });
    stubGithub((c) => (c.url.includes('/branches/') ? { body: { protected: false } } : undefined));
    expect((await dev.post(`/api/workspaces/${wsId}/git/push`)).statusCode).toBe(200);
    await dev.post(`/api/workspaces/${wsId}/git/checkout`, { branch: 'feature/retry' });
    expect((await dev.delete(`/api/workspaces/${wsId}/git/branches/feature/pushed`)).statusCode).toBe(200);
    expect(await runGit(['branch', '--list'], { cwd: bare })).toContain('feature/pushed');
  });
});

describe('branch protection on push', () => {
  it('refuses to push to a branch GitHub protects, using the owner token', async () => {
    stubGithub((c) => (c.url === '/repos/acme/payments/branches/feature/retry' ? { body: { name: 'feature/retry', protected: true } } : undefined));
    const r = await dev.post(`/api/workspaces/${wsId}/git/push`);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toMatch(/not allowed/);
    expect(ghCalls[0]!.token).toBe(ACME_TOKEN);
    expect(await runGit(['branch', '--list'], { cwd: bare })).not.toContain('feature/retry');
  });

  it('refuses to push when protection cannot be checked', async () => {
    stubGithub(() => ({ status: 500, body: { message: 'boom' } }));
    expect((await dev.post(`/api/workspaces/${wsId}/git/push`)).statusCode).toBe(502);
  });

  it('pushes an unprotected branch', async () => {
    stubGithub((c) => (c.url.includes('/branches/') ? { body: { protected: false } } : undefined));
    expect((await dev.post(`/api/workspaces/${wsId}/git/push`)).statusCode).toBe(200);
    expect(await runGit(['branch', '--list'], { cwd: bare })).toContain('feature/retry');
  });
});

describe('workspace reset', () => {
  it('discards every uncommitted change, including untracked files', async () => {
    await dev.request('PUT', `/api/workspaces/${wsId}/file`, { path: 'retry.js', content: 'broken' });
    await dev.request('PUT', `/api/workspaces/${wsId}/file`, { path: 'junk/new.txt', content: 'junk' });
    expect((await dev.get(`/api/workspaces/${wsId}/git/status`)).json().files.length).toBe(2);
    const r = await dev.post(`/api/workspaces/${wsId}/git/reset`, { to: 'head' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().files).toEqual([]);
    expect((await dev.get(`/api/workspaces/${wsId}/file?path=retry.js`)).json().content).toContain('retries = 5');
  });

  it('resets the branch to GitHub, dropping local commits', async () => {
    const remoteSha = (await runGit(['rev-parse', 'feature/retry'], { cwd: bare })).trim();
    await dev.request('PUT', `/api/workspaces/${wsId}/file`, { path: 'local.txt', content: 'local only' });
    await dev.post(`/api/workspaces/${wsId}/git/commit`, { message: 'local only' });
    const r = await dev.post(`/api/workspaces/${wsId}/git/reset`, { to: 'remote' });
    expect(r.statusCode, r.body).toBe(200);
    const log = (await dev.get(`/api/workspaces/${wsId}/git/log`)).json() as { sha: string }[];
    expect(log[0]!.sha).toBe(remoteSha);
    expect(await auditActions()).toContain('git.reset');
  });

  it('validates the target and refuses while Claude is working', async () => {
    expect((await dev.post(`/api/workspaces/${wsId}/git/reset`, { to: 'yesterday' })).statusCode).toBe(400);
    await dev.request('PUT', '/api/me/credentials/anthropic_api_key', { value: 'sk-ant-api03-' + 'a'.repeat(40) });
    script = async function* (input) {
      const signal = input.abortController.signal;
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      throw new Error('aborted');
    };
    const run = await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'busy', mode: 'execute' });
    expect(run.statusCode, run.body).toBe(200);
    await waitFor(async () => ((await dev.get(`/api/workspaces/${wsId}/agent/sessions`)).json().running ? true : undefined));
    expect((await dev.post(`/api/workspaces/${wsId}/git/reset`, { to: 'head' })).statusCode).toBe(409);
    expect((await dev.delete(`/api/workspaces/${wsId}/git/branches/feature/x`)).statusCode).toBe(409);
    await dev.post(`/api/workspaces/${wsId}/agent/cancel`);
    await waitFor(async () => ((await dev.get(`/api/workspaces/${wsId}/agent/sessions`)).json().running ? undefined : true));
  });
});

describe('code search', () => {
  it('finds fixed strings in tracked and untracked files with line numbers', async () => {
    await dev.request('PUT', `/api/workspaces/${wsId}/file`, { path: 'src/new.js', content: 'const a = 1;\n// RETRY later\n' });
    const r = await dev.get(`/api/workspaces/${wsId}/search?q=retry`);
    expect(r.statusCode, r.body).toBe(200);
    const hits = r.json().hits as { path: string; line: number; text: string }[];
    expect(hits).toEqual(expect.arrayContaining([
      { path: 'retry.js', line: 2, text: '// retry with backoff' },
      { path: 'src/new.js', line: 2, text: '// RETRY later' },
    ]));
    // Fixed string: regex characters match literally.
    expect((await dev.get(`/api/workspaces/${wsId}/search?q=${encodeURIComponent('retries = .')}`)).json().hits).toEqual([]);
  });

  it('supports regular expressions and rejects invalid ones', async () => {
    const hits = (await dev.get(`/api/workspaces/${wsId}/search?q=${encodeURIComponent('retries = [0-9]')}&regex=true`)).json().hits;
    expect(hits).toEqual([expect.objectContaining({ path: 'retry.js', line: 1 })]);
    expect((await dev.get(`/api/workspaces/${wsId}/search?q=${encodeURIComponent('(')}&regex=true`)).statusCode).toBe(400);
  });

  it('treats a query starting with a dash as text, not an option', async () => {
    await dev.request('PUT', `/api/workspaces/${wsId}/file`, { path: 'flags.txt', content: '--output=x\n' });
    const r = await dev.get(`/api/workspaces/${wsId}/search?q=${encodeURIComponent('--output=x')}`);
    expect(r.json().hits).toEqual([{ path: 'flags.txt', line: 1, text: '--output=x' }]);
  });

  it('caps results at 200', async () => {
    const many = Array.from({ length: 50 }, (_, i) => `needle ${i}`).join('\n');
    for (let i = 0; i < 5; i++) await dev.request('PUT', `/api/workspaces/${wsId}/file`, { path: `many/f${i}.txt`, content: many });
    const r = (await dev.get(`/api/workspaces/${wsId}/search?q=needle`)).json();
    expect(r.hits).toHaveLength(200);
    expect(r.truncated).toBe(true);
    await dev.post(`/api/workspaces/${wsId}/git/reset`, { to: 'head' });
  });
});

describe('pull requests', () => {
  const pull = { number: 7, title: 'More retries', state: 'open', draft: false, merged_at: null, html_url: 'https://github.com/acme/payments/pull/7',
    user: { login: 'dev' }, head: { ref: 'feature/retry', sha: 'a'.repeat(40) }, base: { ref: 'main' }, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' };
  let mergeable: boolean | null = true;
  let mergeableState = 'clean';

  const handler: GhHandler = (c) => {
    if (c.url.startsWith('/repos/acme/payments/pulls?')) return { body: [pull] };
    if (c.url === '/repos/acme/payments/pulls/7') return { body: { ...pull, body: 'Details', mergeable, mergeable_state: mergeableState, changed_files: 1 } };
    if (c.url.startsWith('/repos/acme/payments/pulls/7/files')) return { body: [{ filename: 'retry.js', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@' }] };
    if (c.url.endsWith('/status')) return { body: { statuses: [{ state: 'success' }] } };
    if (c.url.includes('/check-runs')) return { body: { check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }] } };
    if (c.method === 'PUT' && c.url === '/repos/acme/payments/pulls/7/merge') return { body: { merged: true, sha: 'b'.repeat(40), message: 'Pull Request successfully merged' } };
    return undefined;
  };

  it('lists and shows pull requests with files, mergeability and checks', async () => {
    stubGithub(handler);
    const list = await dev.get(`/api/workspaces/${wsId}/pull-requests`);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual([expect.objectContaining({ number: 7, state: 'open', head: 'feature/retry', base: 'main' })]);
    const detail = (await dev.get(`/api/workspaces/${wsId}/pull-requests/7`)).json();
    expect(detail).toMatchObject({ number: 7, mergeable: true, mergeableState: 'clean', canMerge: false, headSha: 'a'.repeat(40) });
    expect(detail.checks).toEqual({ state: 'pending', total: 3, failed: 0, pending: 1 });
    expect(detail.files).toEqual([expect.objectContaining({ path: 'retry.js', additions: 1 })]);
    expect(ghCalls.every((c) => c.token === ACME_TOKEN)).toBe(true);
  });

  it('only users with application.merge can merge', async () => {
    stubGithub(handler);
    expect((await dev.post(`/api/workspaces/${wsId}/pull-requests/7/merge`, { method: 'squash' })).statusCode).toBe(403);
    expect(ghCalls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('refuses to merge when GitHub says it is not mergeable', async () => {
    const leadWs = await createWorkspace(lead, appId, devEnvId, 'feature/lead');
    stubGithub(handler);
    expect((await lead.get(`/api/workspaces/${leadWs}/pull-requests/7`)).json().canMerge).toBe(true);
    mergeable = false;
    mergeableState = 'dirty';
    expect((await lead.post(`/api/workspaces/${leadWs}/pull-requests/7/merge`, { method: 'squash' })).statusCode).toBe(409);
    mergeable = null;
    expect((await lead.post(`/api/workspaces/${leadWs}/pull-requests/7/merge`, { method: 'squash' })).statusCode).toBe(409);
    mergeable = true;
    mergeableState = 'blocked';
    expect((await lead.post(`/api/workspaces/${leadWs}/pull-requests/7/merge`, { method: 'squash' })).statusCode).toBe(409);
    expect(ghCalls.some((c) => c.method === 'PUT')).toBe(false);

    mergeableState = 'clean';
    const r = await lead.post(`/api/workspaces/${leadWs}/pull-requests/7/merge`, { method: 'rebase' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ merged: true });
    const put = ghCalls.find((c) => c.method === 'PUT')!;
    expect(put.body).toEqual({ merge_method: 'rebase', sha: 'a'.repeat(40) });
    expect(put.token).toBe(LEAD_TOKEN);
    expect(await auditActions()).toContain('git.pull_request_merged');
    expect((await lead.post(`/api/workspaces/${leadWs}/pull-requests/7/merge`, { method: 'octopus' })).statusCode).toBe(400);
  });

  it('opens a pull request with the owner token', async () => {
    stubGithub((c) => (c.method === 'POST' && c.url === '/repos/acme/payments/pulls' ? { status: 201, body: { number: 8, html_url: 'https://github.com/acme/payments/pull/8' } } : undefined));
    const r = await dev.post(`/api/workspaces/${wsId}/pull-request`, { title: 'Retries' });
    expect(r.statusCode, r.body).toBe(200);
    expect(ghCalls[0]).toMatchObject({ token: ACME_TOKEN, body: expect.objectContaining({ head: 'feature/retry', base: 'main' }) });
  });
});

describe('branch names with dots and a detached HEAD', () => {
  let dotWs: string;
  const repoOf = (id: string) => path.join(env.workspacesDir, id, 'repo');
  const pushStub: GhHandler = (c) => {
    if (c.url.includes('/branches/')) return { body: { protected: false } };
    if (c.method === 'POST' && c.url === '/repos/acme/payments/pulls') return { status: 201, body: { number: 9, html_url: 'https://github.com/acme/payments/pull/9' } };
    return undefined;
  };

  it('keeps the whole branch name for status, push, pull, reset and pull requests', async () => {
    dotWs = await createWorkspace(dev, appId, devEnvId, 'release-2.0');
    const s = (await dev.get(`/api/workspaces/${dotWs}/git/status`)).json();
    expect(s).toMatchObject({ branch: 'release-2.0', detached: false, head: expect.stringMatching(/^[0-9a-f]{40}$/) });

    await dev.request('PUT', `/api/workspaces/${dotWs}/file`, { path: 'notes v1.txt', content: 'dotted\n' });
    expect((await dev.get(`/api/workspaces/${dotWs}/git/status`)).json().files).toEqual([{ path: 'notes v1.txt', code: '??', status: 'untracked' }]);
    expect((await dev.post(`/api/workspaces/${dotWs}/git/commit`, { message: 'Dotted' })).statusCode).toBe(200);
    expect((await dev.get(`/api/workspaces/${dotWs}/git/status`)).json()).toMatchObject({ branch: 'release-2.0', files: [] });

    stubGithub(pushStub);
    const push = await dev.post(`/api/workspaces/${dotWs}/git/push`);
    expect(push.statusCode, push.body).toBe(200);
    expect(push.json().branch).toBe('release-2.0');
    expect(ghCalls[0]!.url).toBe('/repos/acme/payments/branches/release-2.0');
    const remote = await runGit(['for-each-ref', '--format=%(refname)', 'refs/heads'], { cwd: bare });
    expect(remote.split('\n')).toContain('refs/heads/release-2.0');
    expect(remote.split('\n')).not.toContain('refs/heads/release-2');
    expect((await dev.get(`/api/workspaces/${dotWs}/git/status`)).json()).toMatchObject({ ahead: 0, behind: 0 });

    expect((await dev.post(`/api/workspaces/${dotWs}/git/pull`)).statusCode).toBe(200);
    expect((await dev.post(`/api/workspaces/${dotWs}/git/reset`, { to: 'remote' })).statusCode).toBe(200);
    const pr = await dev.post(`/api/workspaces/${dotWs}/pull-request`, { title: 'Release' });
    expect(pr.statusCode, pr.body).toBe(200);
    expect(ghCalls.at(-1)!.body).toMatchObject({ head: 'release-2.0' });

    // A dotted name after a slash, created in the workspace.
    expect((await dev.post(`/api/workspaces/${dotWs}/git/checkout`, { branch: 'feature/v1.2', create: true })).statusCode).toBe(200);
    expect((await dev.get(`/api/workspaces/${dotWs}/git/status`)).json().branch).toBe('feature/v1.2');
    expect((await dev.post(`/api/workspaces/${dotWs}/git/push`)).statusCode).toBe(200);
    expect((await runGit(['for-each-ref', '--format=%(refname)', 'refs/heads'], { cwd: bare })).split('\n')).toContain('refs/heads/feature/v1.2');
  });

  it('reports a detached HEAD and refuses push, pull, reset to GitHub and pull requests', async () => {
    await runGit(['checkout', '-q', '--detach'], { cwd: repoOf(dotWs) });
    const s = (await dev.get(`/api/workspaces/${dotWs}/git/status`)).json();
    expect(s).toMatchObject({ branch: '', detached: true, head: expect.stringMatching(/^[0-9a-f]{40}$/) });

    stubGithub(pushStub);
    const before = await runGit(['for-each-ref', '--format=%(refname)', 'refs/heads'], { cwd: bare });
    const attempts: [string, object][] = [
      ['git/push', {}],
      ['git/pull', {}],
      ['git/reset', { to: 'remote' }],
      ['pull-request', { title: 'Detached' }],
    ];
    for (const [url, body] of attempts) {
      const r = await dev.post(`/api/workspaces/${dotWs}/${url}`, body);
      expect(r.statusCode, `${url}: ${r.body}`).toBe(400);
      expect(r.json().error.message).toMatch(/detached/i);
    }
    expect(ghCalls).toEqual([]);
    expect(await runGit(['for-each-ref', '--format=%(refname)', 'refs/heads'], { cwd: bare })).toBe(before);
    expect(before).not.toContain('refs/heads/HEAD');

    // Discarding local changes still works without a branch.
    expect((await dev.post(`/api/workspaces/${dotWs}/git/reset`, { to: 'head' })).statusCode).toBe(200);
    await runGit(['checkout', '-q', 'feature/v1.2'], { cwd: repoOf(dotWs) });
    expect((await dev.get(`/api/workspaces/${dotWs}/git/status`)).json()).toMatchObject({ branch: 'feature/v1.2', detached: false });
  });
});

describe('git errors are explained', () => {
  let errWs: string;
  const gitDirOf = (id: string) => path.join(env.workspacesDir, id, 'git');

  it('fetch failures come back as a 400 with the git message and no token', async () => {
    errWs = await createWorkspace(dev, appId, devEnvId, 'feature/errors');
    const moved = `${bare}-moved`;
    await rename(bare, moved);
    try {
      const r = await dev.post(`/api/workspaces/${errWs}/git/fetch`);
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error.message).toMatch(/^git fetch failed: /);
      expect(r.body).not.toContain(ACME_TOKEN);
    } finally {
      await rename(moved, bare);
    }
    expect((await dev.post(`/api/workspaces/${errWs}/git/fetch`)).statusCode).toBe(200);
  });

  it('commit and discard failures come back as a 400 with the git message', async () => {
    await dev.request('PUT', `/api/workspaces/${errWs}/file`, { path: 'retry.js', content: 'changed\n' });
    const lock = path.join(gitDirOf(errWs), 'index.lock');
    await writeFile(lock, '');
    try {
      const commit = await dev.post(`/api/workspaces/${errWs}/git/commit`, { message: 'Blocked' });
      expect(commit.statusCode, commit.body).toBe(400);
      expect(commit.json().error.message).toMatch(/^git (add|commit) failed: .*try again/);
      const discard = await dev.post(`/api/workspaces/${errWs}/git/discard`, { path: 'retry.js' });
      expect(discard.statusCode, discard.body).toBe(400);
      expect(discard.json().error.message).toMatch(/^git restore failed: .*try again/);
    } finally {
      await rm(lock, { force: true });
    }
    expect((await dev.post(`/api/workspaces/${errWs}/git/discard`, { path: 'retry.js' })).statusCode).toBe(200);
    expect((await dev.get(`/api/workspaces/${errWs}/git/status`)).json().files).toEqual([]);
  });

  it('discard is refused while Claude is working', async () => {
    await dev.request('PUT', `/api/workspaces/${errWs}/file`, { path: 'retry.js', content: 'changed again\n' });
    script = async function* (input) {
      const signal = input.abortController.signal;
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      throw new Error('aborted');
    };
    const run = await dev.post(`/api/workspaces/${errWs}/agent/run`, { prompt: 'busy', mode: 'execute' });
    expect(run.statusCode, run.body).toBe(200);
    await waitFor(async () => ((await dev.get(`/api/workspaces/${errWs}/agent/sessions`)).json().running ? true : undefined));
    expect((await dev.post(`/api/workspaces/${errWs}/git/discard`, { path: 'retry.js' })).statusCode).toBe(409);
    await dev.post(`/api/workspaces/${errWs}/agent/cancel`);
    await waitFor(async () => ((await dev.get(`/api/workspaces/${errWs}/agent/sessions`)).json().running ? undefined : true));
    expect((await dev.get(`/api/workspaces/${errWs}/file?path=retry.js`)).json().content).toBe('changed again\n');
    expect((await dev.post(`/api/workspaces/${errWs}/git/discard`, { path: 'retry.js' })).statusCode).toBe(200);
  });
});
