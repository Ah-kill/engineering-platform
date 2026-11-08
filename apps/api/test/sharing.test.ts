import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentDriver, AgentEvent, AgentRunInput } from '../src/agents/driver.js';
import { registerTerminalUsers } from '../src/workspaces/terminal-registry.js';
import { runGit } from '../src/git/git.js';
import { Client, PASSWORD, seedOrg, setup, type TestEnv } from './helpers.js';

/**
 * Workspace sharing: the owner adds viewers and editors who hold `environment.use` on the
 * workspace's environment. Viewers read; editors work; only the owner deletes and shares.
 */

type Script = (input: AgentRunInput) => AsyncGenerator<AgentEvent>;
let script: Script = async function* () {};
const driver: AgentDriver = { run: (input) => script(input) };

let env: TestEnv;
let tmp: string;
let bare: string;
let admin: Client;
let owner: Client;
let viewer: Client;
let editor: Client;
let outsider: Client;
let noAccess: Client;
let appId: string;
let devEnvId: string;
let wsId: string;
const ids: Record<string, string> = {};
let viewerGrantId: string;

const EDITOR_TOKEN = 'github_pat_' + 'e'.repeat(30) + 'EDIT';
const OWNER_TOKEN = 'github_pat_' + 'o'.repeat(30) + 'OWNR';

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'ep-share-'));
  bare = path.join(tmp, 'origin.git');
  const seed = path.join(tmp, 'seed');
  await runGit(['init', '--bare', '-b', 'main', bare], { cwd: tmp });
  await runGit(['clone', bare, seed], { cwd: tmp, allowLocalRemote: true });
  await writeFile(path.join(seed, 'README.md'), '# Shared\n');
  await runGit(['add', '-A'], { cwd: seed });
  await runGit(['commit', '-m', 'initial'], { cwd: seed, author: { name: 'Seed', email: 'seed@test' } });
  await runGit(['push', 'origin', 'HEAD:main'], { cwd: seed, allowLocalRemote: true });

  env = await setup({ remoteFor: () => bare, agentDriver: driver });
  const { adminEmail } = await seedOrg(env.db, 'share');
  admin = await Client.login(env.app, adminEmail);
  const clientId = (await admin.post('/api/clients', { name: 'ABC' })).json().id;
  const created = (await admin.post(`/api/clients/${clientId}/applications`, { name: 'Payments' })).json();
  appId = created.id;
  devEnvId = created.environments.find((e: { kind: string }) => e.kind === 'development').id;
  await admin.request('PUT', `/api/applications/${appId}/repository`, { url: 'https://github.com/acme/payments', defaultBranch: 'main' });

  for (const name of ['owner', 'viewer', 'editor', 'outsider', 'noaccess']) {
    await admin.post('/api/users', { email: `${name}@share.test`, displayName: name, password: PASSWORD });
  }
  const users = (await admin.get('/api/users')).json() as { id: string; email: string }[];
  for (const u of users) ids[u.email.split('@')[0]!] = u.id;
  for (const name of ['owner', 'viewer', 'editor', 'outsider']) {
    const g = await admin.post('/api/grants', { userId: ids[name], role: 'developer', scopeType: 'application', scopeId: appId });
    if (name === 'viewer') viewerGrantId = g.json().id;
  }
  [owner, viewer, editor, outsider, noAccess] = await Promise.all(
    ['owner', 'viewer', 'editor', 'outsider', 'noaccess'].map((n) => Client.login(env.app, `${n}@share.test`)),
  );

  const r = await owner.post(`/api/applications/${appId}/workspaces`, { environmentId: devEnvId, branch: 'feature/shared' });
  wsId = r.json().id;
  const ws = await waitFor(async () => {
    const w = (await owner.get(`/api/workspaces/${wsId}`)).json();
    return w.state === 'creating' ? undefined : w;
  });
  expect(ws.state, ws.error).toBe('ready');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await env.close();
  await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

describe('managing members', () => {
  it('the owner sees their access and the candidates who can work in the environment', async () => {
    expect((await owner.get(`/api/workspaces/${wsId}`)).json()).toMatchObject({ access: 'owner', ownerName: 'owner' });
    const candidates = (await owner.get(`/api/workspaces/${wsId}/members/candidates`)).json() as { displayName: string }[];
    expect(candidates.map((c) => c.displayName).sort()).toEqual(['editor', 'outsider', 'viewer']);
  });

  it('adds a viewer and an editor', async () => {
    expect((await owner.request('PUT', `/api/workspaces/${wsId}/members/${ids.viewer}`, { role: 'viewer' })).statusCode).toBe(200);
    const r = await owner.request('PUT', `/api/workspaces/${wsId}/members/${ids.editor}`, { role: 'editor' });
    expect(r.statusCode).toBe(200);
    expect(r.json().map((m: { displayName: string; role: string }) => [m.displayName, m.role])).toEqual([['editor', 'editor'], ['viewer', 'viewer']]);
    const audit = await env.db.system((q) => q.query("SELECT 1 FROM audit_events WHERE action = 'workspace.member_added'"));
    expect(audit).toHaveLength(2);
  });

  it('refuses people without working access to the environment, the owner, and bad roles', async () => {
    const r = await owner.request('PUT', `/api/workspaces/${wsId}/members/${ids.noaccess}`, { role: 'viewer' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/no working access/);
    expect((await owner.request('PUT', `/api/workspaces/${wsId}/members/${ids.owner}`, { role: 'editor' })).statusCode).toBe(400);
    expect((await owner.request('PUT', `/api/workspaces/${wsId}/members/${ids.outsider}`, { role: 'admin' })).statusCode).toBe(400);
  });

  it('only the owner manages members', async () => {
    expect((await editor.request('PUT', `/api/workspaces/${wsId}/members/${ids.outsider}`, { role: 'viewer' })).statusCode).toBe(403);
    expect((await editor.get(`/api/workspaces/${wsId}/members/candidates`)).statusCode).toBe(403);
    expect((await editor.delete(`/api/workspaces/${wsId}/members/${ids.viewer}`)).statusCode).toBe(403);
    const list = (await viewer.get(`/api/workspaces/${wsId}/members`)).json();
    expect(list).toMatchObject({ canManage: false, owner: { displayName: 'owner' } });
    expect(list.members).toHaveLength(2);
  });

  it('non-members cannot see the workspace at all', async () => {
    expect((await outsider.get(`/api/workspaces/${wsId}`)).statusCode).toBe(404);
    expect((await outsider.get(`/api/workspaces/${wsId}/members`)).statusCode).toBe(404);
    expect((await noAccess.get(`/api/workspaces/${wsId}/tree`)).statusCode).toBe(404);
  });
});

describe('viewers', () => {
  it('see the workspace in their list, marked as shared', async () => {
    const list = (await viewer.get(`/api/applications/${appId}/workspaces`)).json() as { id: string; access: string; ownerName: string }[];
    expect(list).toEqual([expect.objectContaining({ id: wsId, access: 'viewer', ownerName: 'owner' })]);
    expect((await outsider.get(`/api/applications/${appId}/workspaces`)).json()).toEqual([]);
  });

  it('read files, git status, history and diffs', async () => {
    expect((await viewer.get(`/api/workspaces/${wsId}`)).json()).toMatchObject({ access: 'viewer' });
    for (const url of ['tree', 'file?path=README.md', 'git/status', 'git/log', 'git/branches', 'git/diff?path=README.md', 'search?q=Shared', 'members']) {
      expect((await viewer.get(`/api/workspaces/${wsId}/${url}`)).statusCode, url).toBe(200);
    }
  });

  it('cannot change files, run git mutations, Claude or delete the workspace', async () => {
    const forbidden = [
      viewer.request('PUT', `/api/workspaces/${wsId}/file`, { path: 'x.txt', content: 'x' }),
      viewer.delete(`/api/workspaces/${wsId}/file?path=README.md`),
      viewer.post(`/api/workspaces/${wsId}/git/commit`, { message: 'x' }),
      viewer.post(`/api/workspaces/${wsId}/git/push`),
      viewer.post(`/api/workspaces/${wsId}/git/pull`),
      viewer.post(`/api/workspaces/${wsId}/git/fetch`),
      viewer.post(`/api/workspaces/${wsId}/git/checkout`, { branch: 'main' }),
      viewer.post(`/api/workspaces/${wsId}/git/discard`, { path: 'README.md' }),
      viewer.post(`/api/workspaces/${wsId}/git/reset`, { to: 'head' }),
      viewer.delete(`/api/workspaces/${wsId}/git/branches/main`),
      viewer.post(`/api/workspaces/${wsId}/pull-request`, { title: 'x' }),
      viewer.post(`/api/workspaces/${wsId}/pull-requests/1/merge`, {}),
      viewer.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'hi', mode: 'plan' }),
      viewer.delete(`/api/workspaces/${wsId}`),
    ];
    for (const [i, r] of (await Promise.all(forbidden)).entries()) expect(r.statusCode, `request ${i}: ${r.body}`).toBe(403);
  });
});

describe('editors', () => {
  it('edit, commit as themselves and reset', async () => {
    expect((await editor.request('PUT', `/api/workspaces/${wsId}/file`, { path: 'README.md', content: '# Edited\n' })).statusCode).toBe(200);
    expect((await editor.post(`/api/workspaces/${wsId}/git/commit`, { message: 'Edit readme' })).statusCode).toBe(200);
    expect((await owner.get(`/api/workspaces/${wsId}/git/log`)).json()[0]).toMatchObject({ subject: 'Edit readme', author: 'editor' });
    await editor.request('PUT', `/api/workspaces/${wsId}/file`, { path: 'tmp.txt', content: 'x' });
    expect((await editor.post(`/api/workspaces/${wsId}/git/reset`, { to: 'head' })).statusCode).toBe(200);
  });

  it('use their own GitHub token', async () => {
    await editor.request('PUT', '/api/me/credentials/github_token', { value: EDITOR_TOKEN });
    await owner.request('PUT', '/api/me/credentials/github_token', { value: OWNER_TOKEN });
    const tokens: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      tokens.push(String((init.headers as Record<string, string>).authorization));
      return new Response(JSON.stringify({ number: 3, html_url: 'https://github.com/acme/payments/pull/3' }), { status: 201 });
    });
    expect((await editor.post(`/api/workspaces/${wsId}/pull-request`, { title: 'Readme' })).statusCode).toBe(200);
    expect(tokens).toEqual([`Bearer ${EDITOR_TOKEN}`]);
  });

  it('cannot delete the workspace or manage members', async () => {
    expect((await editor.delete(`/api/workspaces/${wsId}`)).statusCode).toBe(403);
    expect((await editor.request('PUT', `/api/workspaces/${wsId}/members/${ids.outsider}`, { role: 'editor' })).statusCode).toBe(403);
  });
});

describe('Claude runs in a shared workspace', () => {
  const KEY = (c: string) => `sk-ant-api03-${c.repeat(40)}`;
  const events = (sessionId: string) =>
    env.db.system((q) => q.query<{ kind: string; data: Record<string, any> }>('SELECT kind, data FROM agent_events WHERE session_id = $1 ORDER BY id', [sessionId]));

  it('only the person who started a run can approve its actions; the owner can stop it', async () => {
    await editor.request('PUT', '/api/me/credentials/anthropic_api_key', { value: KEY('e') });
    script = async function* (input) {
      await input.canUseTool('Bash', { command: 'rm -rf build' }, { signal: input.abortController.signal } as never);
    };
    const run = await editor.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'clean', mode: 'execute' });
    expect(run.statusCode, run.body).toBe(200);
    const request = await waitFor(async () => (await events(run.json().sessionId)).find((e) => e.kind === 'approval_request'));
    // Everyone sees that Claude is busy and for whom; only the editor is pointed at the
    // conversation (the owner could not open it, and must not auto-select it).
    expect((await owner.get(`/api/workspaces/${wsId}/agent/sessions`)).json()).toMatchObject({
      running: true, activeSessionId: null, runningBy: { name: 'editor', you: false },
    });
    expect((await editor.get(`/api/workspaces/${wsId}/agent/sessions`)).json()).toMatchObject({
      running: true, activeSessionId: run.json().sessionId, runningBy: { name: 'editor', you: true },
    });
    expect((await owner.get(`/api/agent/sessions/${run.json().sessionId}/events`)).statusCode).toBe(404);
    // The owner cannot answer the editor's approval...
    expect((await owner.post(`/api/workspaces/${wsId}/agent/approvals/${request.data.approvalId}`, { allow: true })).statusCode).toBe(404);
    // ...and cannot open a terminal into the container while the editor's run is active.
    const term = await owner.get(`/api/workspaces/${wsId}/terminal`);
    expect([409, 400]).toContain(term.statusCode); // 409 in Docker mode; tests use the local runtime (400)
    // ...but can stop it.
    expect((await owner.post(`/api/workspaces/${wsId}/agent/cancel`)).json()).toEqual({ cancelled: true });
    await waitFor(async () => ((await editor.get(`/api/workspaces/${wsId}/agent/sessions`)).json().running ? undefined : true));
  });

  it('Claude does not run while someone else has a terminal open in the workspace', async () => {
    script = async function* () {};
    registerTerminalUsers((id) => (id === wsId ? [ids.owner!] : []));
    try {
      const r = await editor.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'x', mode: 'plan' });
      expect(r.statusCode).toBe(409);
      expect(r.json().error.message).toMatch(/terminal open/);
    } finally {
      registerTerminalUsers(() => []);
    }
  });
});

describe('losing access', () => {
  it('a member whose environment access is revoked loses the workspace immediately', async () => {
    expect((await admin.delete(`/api/grants/${viewerGrantId}`)).statusCode).toBe(200);
    expect([403, 404]).toContain((await viewer.get(`/api/workspaces/${wsId}`)).statusCode);
    expect((await viewer.get(`/api/applications/${appId}/workspaces`)).statusCode).toBe(404);
  });

  it('a member can leave, and the owner can remove a member', async () => {
    await owner.request('PUT', `/api/workspaces/${wsId}/members/${ids.outsider}`, { role: 'viewer' });
    expect((await outsider.delete(`/api/workspaces/${wsId}/members/${ids.outsider}`)).statusCode).toBe(200);
    expect((await outsider.get(`/api/workspaces/${wsId}`)).statusCode).toBe(404);
    expect((await owner.delete(`/api/workspaces/${wsId}/members/${ids.editor}`)).statusCode).toBe(200);
    expect((await editor.get(`/api/workspaces/${wsId}`)).statusCode).toBe(404);
    expect((await owner.delete(`/api/workspaces/${wsId}/members/${ids.editor}`)).statusCode).toBe(404);
  });

  it('the owner can delete the workspace', async () => {
    expect((await owner.delete(`/api/workspaces/${wsId}`)).statusCode).toBe(200);
  });
});
