import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentDriver } from '../src/agents/driver.js';
import { decideTool } from '../src/agents/tool-policy.js';
import { runGit } from '../src/git/git.js';
import { Client, PASSWORD, seedOrg, setup, type TestEnv } from './helpers.js';

/**
 * Regressions for findings from the security review.
 *
 * C1: code inside a workspace container can write anything in the checkout, including the
 * `.git` file that points at the git directory. If it pointed that file at a git directory of
 * its own with a filter in the config, host-side git (commit, discard, reset) would run the
 * filter on the host. The platform must always use the real, read-only git directory.
 */
const driver: AgentDriver = { run: async function* () {} };

let env: TestEnv;
let tmp: string;
let dev: Client;
let wsId: string;
let marker: string;

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const exists = (p: string) => stat(p).then(() => true, () => false);

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'ep-sec-'));
  marker = path.join(tmp, 'PWNED');
  const bare = path.join(tmp, 'origin.git');
  const seed = path.join(tmp, 'seed');
  await runGit(['init', '--bare', '-b', 'main', bare], { cwd: tmp });
  await runGit(['clone', bare, seed], { cwd: tmp, allowLocalRemote: true });
  await writeFile(path.join(seed, 'app.js'), 'console.log(1);\n');
  await runGit(['add', '-A'], { cwd: seed });
  await runGit(['commit', '-m', 'init'], { cwd: seed, author: { name: 's', email: 's@s' } });
  await runGit(['push', 'origin', 'HEAD:main'], { cwd: seed, allowLocalRemote: true });

  env = await setup({ remoteFor: () => bare, agentDriver: driver });
  const { adminEmail } = await seedOrg(env.db, 'sec');
  const admin = await Client.login(env.app, adminEmail);
  const clientId = (await admin.post('/api/clients', { name: 'Sec' })).json().id;
  const app = (await admin.post(`/api/clients/${clientId}/applications`, { name: 'Target' })).json();
  const devEnv = app.environments.find((e: { kind: string }) => e.kind === 'development').id;
  await admin.post('/api/users', { email: 'dev@sec.test', displayName: 'dev', password: PASSWORD });
  const devId = ((await admin.get('/api/users')).json() as { id: string; email: string }[]).find((u) => u.email === 'dev@sec.test')!.id;
  await admin.post('/api/grants', { userId: devId, role: 'developer', scopeType: 'application', scopeId: app.id });
  await admin.request('PUT', `/api/applications/${app.id}/repository`, { url: 'https://github.com/sec/target', defaultBranch: 'main' });
  dev = await Client.login(env.app, 'dev@sec.test');
  wsId = (await dev.post(`/api/applications/${app.id}/workspaces`, { environmentId: devEnv, branch: 'feature/x' })).json().id;
  const ws = await waitFor(async () => {
    const w = (await dev.get(`/api/workspaces/${wsId}`)).json();
    return w.state === 'creating' ? undefined : w;
  });
  expect(ws.state, ws.error).toBe('ready');
});

afterAll(async () => {
  await env.close();
  await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

describe('C1: the checkout cannot redirect host-side git', () => {
  it('a planted git directory with a filter is never used by commit, discard or reset', async () => {
    const repo = path.join(env.workspacesDir, wsId, 'repo');
    const realGit = path.join(env.workspacesDir, wsId, 'git');
    // What a hijacked agent or a terminal could do inside the container (all writes in /ws/repo).
    const planted = path.join(repo, '.cache-x');
    await cp(realGit, planted, { recursive: true });
    const cmd = `node -e "require('fs').writeFileSync(process.argv[1], 'owned')" ${JSON.stringify(marker)}`;
    const config = await readFile(path.join(planted, 'config'), 'utf8');
    await writeFile(path.join(planted, 'config'), `${config}\n[filter "x"]\n\tclean = ${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}\n\tsmudge = cat\n`);
    await writeFile(path.join(repo, '.gitattributes'), '* filter=x\n');
    await rm(path.join(repo, '.git'), { force: true });
    await writeFile(path.join(repo, '.git'), 'gitdir: .cache-x\n');
    await writeFile(path.join(repo, 'app.js'), 'console.log(2);\n');

    // The developer then uses the platform normally.
    expect((await dev.get(`/api/workspaces/${wsId}/git/status`)).statusCode).toBe(200);
    const commit = await dev.post(`/api/workspaces/${wsId}/git/commit`, { message: 'change' });
    expect(commit.statusCode, commit.body).toBe(200);
    await writeFile(path.join(repo, 'app.js'), 'console.log(3);\n');
    await dev.post(`/api/workspaces/${wsId}/git/discard`, { path: 'app.js' });
    await dev.post(`/api/workspaces/${wsId}/git/reset`, { to: 'head' });

    expect(await exists(marker)).toBe(false);
    // The commit landed in the real git directory, not the planted one.
    const log = await runGit(['--git-dir', realGit, 'log', '--oneline', '-1'], { cwd: tmp });
    expect(log).toContain('change');
  });

  it("Claude's file tools cannot write the .git file or anything under .git", () => {
    const root = '/ws/repo';
    for (const file_path of ['.git', '/ws/repo/.git', '.git/config', '.git/HEAD', '.GIT', '.git.']) {
      expect(decideTool(root, 'Write', { file_path }).action, file_path).toBe('deny');
    }
    expect(decideTool(root, 'Write', { file_path: '.gitattributes' }).action).toBe('allow');
  });
});
