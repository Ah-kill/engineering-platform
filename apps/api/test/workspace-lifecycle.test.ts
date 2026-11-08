import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reapIdleWorkspaces } from '../src/agents/housekeeping.js';
import { loadConfig } from '../src/config.js';
import { openPglite, type Database } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { runGit } from '../src/git/git.js';
import { buildApp } from '../src/http/app.js';
import { Vault } from '../src/vault/vault.js';
import { workspacePaths } from '../src/workspaces/paths.js';
import { DockerRuntime, localRuntime, type DockerCli, type WorkspaceDirs, type WorkspaceRuntime } from '../src/workspaces/runtime.js';
import { INTERRUPTED_SETUP_ERROR, provisionWorkspace, recoverInterruptedWorkspaces } from '../src/workspaces/service.js';
import { Client, PASSWORD, seedOrg, WEB_ORIGIN } from './helpers.js';

/**
 * Workspace lifecycle edge cases: deleting a workspace while it is still being set up, setups
 * interrupted by a restart, and the per-workspace ordering of container operations (with a
 * fake docker CLI, so no daemon is needed).
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(50);
  }
}

/** A runtime whose `ensure` waits until the test releases it, recording every call. */
function gatedRuntime() {
  const calls: string[] = [];
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const runtime: WorkspaceRuntime = {
    ...localRuntime,
    ensure: async (ws: WorkspaceDirs) => {
      calls.push('ensure');
      await released;
      // What a container start leaves behind on the host (Docker creates missing bind sources).
      await mkdir(ws.home, { recursive: true });
      await writeFile(path.join(ws.home, 'marker'), 'container was here');
      calls.push('ensured');
    },
    remove: async (id: string) => void calls.push(`remove:${id}`),
  };
  return { runtime, calls, release };
}

describe('workspace setup and deletion', () => {
  let db: Database;
  let app: FastifyInstance;
  let workspacesDir: string;
  let tmp: string;
  let bare: string;
  let dev: Client;
  let orgId: string;
  let appId: string;
  let devEnvId: string;
  const gate = gatedRuntime();

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'ep-life-'));
    bare = path.join(tmp, 'origin.git');
    const seed = path.join(tmp, 'seed');
    await runGit(['init', '--bare', '-b', 'main', bare], { cwd: tmp });
    await runGit(['clone', bare, seed], { cwd: tmp, allowLocalRemote: true });
    await writeFile(path.join(seed, 'README.md'), '# App\n');
    await runGit(['add', '-A'], { cwd: seed });
    await runGit(['commit', '-m', 'initial'], { cwd: seed, author: { name: 'Seeder', email: 'seed@test' } });
    await runGit(['push', 'origin', 'HEAD:main'], { cwd: seed, allowLocalRemote: true });

    db = await openPglite();
    await migrate(db);
    workspacesDir = path.join(tmp, 'workspaces');
    await mkdir(workspacesDir);
    app = await buildApp({
      config: loadConfig({ WEB_ORIGIN, LOG_LEVEL: 'silent' }),
      db,
      vault: Vault.fromKey(randomBytes(32).toString('base64')),
      workspacesDir,
      remoteFor: () => bare,
      runtime: gate.runtime,
    });
    const seeded = await seedOrg(db, 'lifeco');
    orgId = seeded.orgId;
    const admin = await Client.login(app, seeded.adminEmail);
    const clientId = (await admin.post('/api/clients', { name: 'ABC' })).json().id;
    const created = (await admin.post(`/api/clients/${clientId}/applications`, { name: 'Life' })).json();
    appId = created.id;
    devEnvId = created.environments.find((e: { kind: string }) => e.kind === 'development').id;
    await admin.post('/api/users', { email: 'dev@lifeco.test', displayName: 'dev', password: PASSWORD });
    const users = (await admin.get('/api/users')).json() as { id: string; email: string }[];
    const devId = users.find((u) => u.email === 'dev@lifeco.test')!.id;
    await admin.post('/api/grants', { userId: devId, role: 'developer', scopeType: 'application', scopeId: appId });
    await admin.request('PUT', `/api/applications/${appId}/repository`, { url: 'https://github.com/lifeco/app', defaultBranch: 'main' });
    dev = await Client.login(app, 'dev@lifeco.test');
  });

  afterAll(async () => {
    gate.release();
    await app?.close();
    await db?.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  });

  const stateOf = async (id: string) =>
    (await db.system((q) => q.query<{ state: string; error: string | null }>('SELECT state, error FROM workspaces WHERE id = $1', [id])))[0]!;

  it('a workspace deleted while it is being set up stays deleted, with no container or folder left', async () => {
    const r = await dev.post(`/api/applications/${appId}/workspaces`, { environmentId: devEnvId, branch: 'feature/gone' });
    expect(r.statusCode, r.body).toBe(202);
    const id = r.json().id as string;
    // The clone is done and the container is starting.
    await waitFor(() => (gate.calls.includes('ensure') ? true : undefined));
    expect((await stateOf(id)).state).toBe('creating');

    expect((await dev.delete(`/api/workspaces/${id}`)).statusCode).toBe(200);
    expect(gate.calls).toEqual(['ensure', `remove:${id}`]);
    gate.release();

    // Provisioning notices the deletion and removes what the container start created.
    await waitFor(() => (gate.calls.filter((c) => c === `remove:${id}`).length === 2 ? true : undefined));
    expect(gate.calls).toEqual(['ensure', `remove:${id}`, 'ensured', `remove:${id}`]);
    expect(await stateOf(id)).toEqual({ state: 'deleted', error: null });
    expect(existsSync(workspacePaths(workspacesDir, id).root)).toBe(false);
    expect((await dev.get(`/api/workspaces/${id}`)).statusCode).toBe(404);
  });

  it('a clone that fails because the workspace was deleted does not mark it failed', async () => {
    const id = await db.system(async (q) => {
      const [ws] = await q.query<{ id: string }>(
        `INSERT INTO workspaces (org_id, application_id, environment_id, repository_id, owner_id, branch, base_branch, state)
         SELECT $1, $2, $3, r.id, u.id, 'feature/x', 'main', 'deleted'
           FROM repositories r, users u WHERE r.application_id = $2 AND u.email = 'dev@lifeco.test'
         RETURNING id`,
        [orgId, appId, devEnvId],
      );
      return ws!.id;
    });
    const removed: string[] = [];
    await provisionWorkspace(db, {
      orgId, workspaceId: id, workspacesDir, remote: path.join(tmp, 'vanished.git'), branch: 'feature/x', baseBranch: 'main',
      createBranch: true, runtime: { ...localRuntime, remove: async (w) => void removed.push(w) }, network: { mode: 'restricted', hosts: [] },
    });
    expect(await stateOf(id)).toEqual({ state: 'deleted', error: null });
    expect(removed).toEqual([id]);
    expect(existsSync(workspacePaths(workspacesDir, id).root)).toBe(false);
  });

  it('marks workspaces left in setup by a restart as failed (system-wide)', async () => {
    const ids = await db.system(async (q) => {
      const rows = await q.query<{ id: string; state: string }>(
        `SELECT id, state FROM workspaces WHERE org_id = $1`,
        [orgId],
      );
      return rows;
    });
    // Two interrupted setups.
    const [a, b] = await db.system(async (q) => {
      const make = (branch: string) =>
        q.query<{ id: string }>(
          `INSERT INTO workspaces (org_id, application_id, environment_id, repository_id, owner_id, branch, base_branch)
           SELECT $1, $2, $3, r.id, u.id, $4, 'main'
             FROM repositories r, users u WHERE r.application_id = $2 AND u.email = 'dev@lifeco.test'
           RETURNING id`,
          [orgId, appId, devEnvId, branch],
        );
      return [(await make('feature/a'))[0]!.id, (await make('feature/b'))[0]!.id];
    });
    expect(await recoverInterruptedWorkspaces(db)).toBe(2);
    for (const id of [a!, b!]) expect(await stateOf(id)).toEqual({ state: 'failed', error: INTERRUPTED_SETUP_ERROR });
    // Everything else is untouched.
    for (const w of ids) expect((await stateOf(w.id)).state).toBe(w.state);
    expect(await recoverInterruptedWorkspaces(db)).toBe(0);
    const shown = (await dev.get(`/api/workspaces/${a}`)).json();
    expect(shown).toMatchObject({ state: 'failed', error: INTERRUPTED_SETUP_ERROR });
  });

  it('the idle reaper re-checks inside the runtime, so a run starting at the last moment keeps its container', async () => {
    const id = await db.system(async (q) => {
      const [ws] = await q.query<{ id: string }>(
        `INSERT INTO workspaces (org_id, application_id, environment_id, repository_id, owner_id, branch, base_branch, state, last_active_at)
         SELECT $1, $2, $3, r.id, u.id, 'feature/idle', 'main', 'ready', now() - interval '3 hours'
           FROM repositories r, users u WHERE r.application_id = $2 AND u.email = 'dev@lifeco.test'
         RETURNING id`,
        [orgId, appId, devEnvId],
      );
      return ws!.id;
    });
    let running = false;
    const stops: string[] = [];
    const runtime: WorkspaceRuntime = {
      ...localRuntime,
      stop: async (w) => void stops.push(w),
      // A run starts after the reaper's first look but before the runtime gets to the stop.
      stopIfIdle: async (w, isIdle) => {
        running = true;
        if (!isIdle()) return false;
        stops.push(w);
        return true;
      },
    };
    const stopped = new Map<string, string>();
    expect(await reapIdleWorkspaces(db, runtime, { idleMinutes: 120, isRunning: () => running, stopped })).toEqual([]);
    expect(stops).toEqual([]);
    expect(stopped.has(id)).toBe(false);
    running = false;
    const idleRuntime: WorkspaceRuntime = { ...runtime, stopIfIdle: async (w, isIdle) => (isIdle() ? (stops.push(w), true) : false) };
    expect(await reapIdleWorkspaces(db, idleRuntime, { idleMinutes: 120, isRunning: () => running, stopped })).toEqual([id]);
    expect(stops).toEqual([id]);
  });
});

describe('container operations are serialised per workspace', () => {
  let tmp: string;
  let dirs: WorkspaceDirs;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'ep-serial-'));
    const id = randomUUID();
    dirs = { id, root: tmp, repo: path.join(tmp, 'repo'), gitDir: path.join(tmp, 'git'), home: path.join(tmp, 'home') };
    await mkdir(dirs.repo, { recursive: true });
    await mkdir(dirs.gitDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  });

  /** A docker CLI that takes a few milliseconds per command and has no containers. */
  function fakeDocker() {
    const log: string[] = [];
    let inFlight = 0;
    let overlapped = false;
    const docker: DockerCli = async (args) => {
      if (++inFlight > 1) overlapped = true;
      log.push(args[0] === 'run' ? `run ${args[args.indexOf('--name') + 1]!.slice(0, 5)}` : args.slice(0, 2).join(' '));
      await sleep(3);
      inFlight--;
      if (args[0] === 'container' && args[1] === 'inspect') throw new Error('No such container');
      return '';
    };
    return { docker, log, overlapped: () => overlapped };
  }

  const runtimeWith = (docker: DockerCli) =>
    new DockerRuntime({ image: 'test-image', claudeCodeVersion: '0', cpus: '1', memory: '1g', pidsLimit: 64 }, docker);

  const ENSURE = ['info --format', 'container inspect', 'network create', 'rm -f', 'run ep-px', 'network connect', 'run ep-ws'];

  it('runs ensure, stop, remove and ensure for one workspace strictly one after another', async () => {
    const fake = fakeDocker();
    const rt = runtimeWith(fake.docker);
    await Promise.all([rt.ensure(dirs), rt.stop(dirs.id), rt.remove(dirs.id), rt.ensure(dirs)]);
    const first = [ENSURE[0]!, ENSURE[1]!, 'image inspect', ...ENSURE.slice(2)];
    expect(fake.log).toEqual([...first, 'stop -t', 'stop -t', 'rm -f', 'network rm', ...ENSURE]);
    expect(fake.overlapped()).toBe(false);
  });

  it('keeps going after a failed operation', async () => {
    const fake = fakeDocker();
    const failing: DockerCli = async (args, o) => {
      if (args[0] === 'info') throw new Error('daemon down');
      return fake.docker(args, o);
    };
    const rt = runtimeWith(failing);
    const [ensured, stopped] = await Promise.allSettled([rt.ensure(dirs), rt.stop(dirs.id)]);
    expect(ensured.status).toBe('rejected');
    expect(stopped.status).toBe('fulfilled');
    expect(fake.log).toEqual(['stop -t', 'stop -t']);
  });

  it('stopIfIdle decides inside the queue: a run that registered while ensure was in flight is not stopped', async () => {
    const fake = fakeDocker();
    const rt = runtimeWith(fake.docker);
    let running = false;
    const ensuring = rt.ensure(dirs).then(() => fake.log.length);
    // The reaper looked before the run began; the run registers, then its ensure is in flight.
    const reaped = rt.stopIfIdle(dirs.id, () => !running);
    running = true;
    expect(await reaped).toBe(false);
    await ensuring;
    expect(fake.log).not.toContain('stop -t');
    expect(fake.overlapped()).toBe(false);

    running = false;
    expect(await rt.stopIfIdle(dirs.id, () => !running)).toBe(true);
    expect(fake.log.slice(-2)).toEqual(['stop -t', 'stop -t']);
  });

  it('different workspaces do not wait for each other', async () => {
    const fake = fakeDocker();
    const rt = runtimeWith(fake.docker);
    await Promise.all([rt.stop(randomUUID()), rt.stop(randomUUID())]);
    expect(fake.overlapped()).toBe(true);
  });
});
