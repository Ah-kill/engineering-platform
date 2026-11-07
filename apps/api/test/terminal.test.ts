import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSdkPackage } from '../src/agents/version.js';
import { loadConfig } from '../src/config.js';
import { openPglite, type Database } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { runGit } from '../src/git/git.js';
import { buildApp } from '../src/http/app.js';
import { MAX_TERMINALS_PER_WORKSPACE } from '../src/terminal/routes.js';
import { Vault } from '../src/vault/vault.js';
import { defaultImage, DockerRuntime, type WorkspaceRuntime } from '../src/workspaces/runtime.js';
import { Client, PASSWORD, seedOrg, setup, WEB_ORIGIN } from './helpers.js';

/**
 * The browser terminal: who may open one, and (with Docker) that it is a real PTY shell
 * inside the workspace container with the environment's variables and nothing else.
 */

const author = { name: 'Seeder', email: 'seed@test' };

async function bareRepo(tmp: string): Promise<string> {
  const bare = path.join(tmp, 'origin.git');
  const seed = path.join(tmp, 'seed');
  await runGit(['init', '--bare', '-b', 'main', bare], { cwd: tmp });
  await runGit(['clone', bare, seed], { cwd: tmp, allowLocalRemote: true });
  await writeFile(path.join(seed, 'README.md'), '# Terminal\n');
  await runGit(['add', '-A'], { cwd: seed });
  await runGit(['commit', '-m', 'initial'], { cwd: seed, author });
  await runGit(['push', 'origin', 'HEAD:main'], { cwd: seed, allowLocalRemote: true });
  return bare;
}

async function sessionCookie(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD },
    headers: { origin: WEB_ORIGIN, 'x-requested-with': 'test' },
  });
  const set = res.headers['set-cookie'];
  return (Array.isArray(set) ? set[0] : set)!.split(';')[0]!;
}

interface World {
  admin: Client;
  dev: Client;
  devCookie: string;
  otherCookie: string;
  devEnvId: string;
  wsId: string;
}

/** Org, application, repository, a developer with a ready workspace and a second developer. */
async function world(app: FastifyInstance, db: Database, slug: string): Promise<World> {
  const { adminEmail } = await seedOrg(db, slug);
  const admin = await Client.login(app, adminEmail);
  const clientId = (await admin.post('/api/clients', { name: 'ABC' })).json().id;
  const created = (await admin.post(`/api/clients/${clientId}/applications`, { name: 'Shell' })).json();
  const devEnvId = created.environments.find((e: { kind: string }) => e.kind === 'development').id;
  await admin.request('PUT', `/api/applications/${created.id}/repository`, { url: 'https://github.com/abc/shell', defaultBranch: 'main' });
  for (const email of [`dev@${slug}.test`, `other@${slug}.test`]) {
    await admin.post('/api/users', { email, displayName: email.split('@')[0], password: PASSWORD });
  }
  const users = (await admin.get('/api/users')).json() as { id: string; email: string }[];
  for (const u of users.filter((u) => u.email !== adminEmail)) {
    await admin.post('/api/grants', { userId: u.id, role: 'developer', scopeType: 'application', scopeId: created.id });
  }
  const dev = await Client.login(app, `dev@${slug}.test`);
  const r = await dev.post(`/api/applications/${created.id}/workspaces`, { environmentId: devEnvId, branch: 'feature/term' });
  expect(r.statusCode, r.body).toBe(202);
  const wsId = r.json().id as string;
  const end = Date.now() + 300_000;
  for (;;) {
    const w = (await dev.get(`/api/workspaces/${wsId}`)).json();
    if (w.state === 'ready') break;
    if (w.state === 'failed') throw new Error(`workspace failed: ${w.error}`);
    if (Date.now() > end) throw new Error('workspace not ready');
    await new Promise((res) => setTimeout(res, 200));
  }
  return {
    admin, dev, devEnvId, wsId,
    devCookie: await sessionCookie(app, `dev@${slug}.test`),
    otherCookie: await sessionCookie(app, `other@${slug}.test`),
  };
}

type Refused = { ok: false; status: number; body: string };
interface Terminal {
  ok: true;
  socket: WebSocket;
  /** Output since the last clear, without escape sequences or carriage returns. */
  text(): string;
  clear(): void;
  send(msg: unknown): void;
  /** Types a command and waits for a line of output matching `expect`. */
  run(command: string, expect: RegExp): Promise<string>;
  closed: Promise<{ code: number; reason: string }>;
}

function connect(port: number, wsId: string, headers: Record<string, string>, query = ''): Promise<Terminal | Refused> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/workspaces/${wsId}/terminal${query}`, { headers });
    let raw = '';
    socket.on('message', (data: Buffer) => {
      raw += data.toString('utf8');
    });
    const closed = new Promise<{ code: number; reason: string }>((res) => socket.on('close', (code, reason) => res({ code, reason: reason.toString() })));
    const text = () => raw.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
    const term: Terminal = {
      ok: true, socket, closed, text,
      clear: () => { raw = ''; },
      send: (msg) => socket.send(JSON.stringify(msg)),
      run: async (command, expect) => {
        raw = '';
        socket.send(JSON.stringify({ type: 'input', data: `${command}\r` }));
        const end = Date.now() + 30_000;
        for (;;) {
          const m = expect.exec(text());
          if (m) return m[0];
          if (Date.now() > end) throw new Error(`no ${expect} in output of ${command}:\n${text()}`);
          await new Promise((r) => setTimeout(r, 50));
        }
      },
    };
    socket.on('open', () => resolve(term));
    socket.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => resolve({ ok: false, status: res.statusCode ?? 0, body }));
    });
    socket.on('error', (err) => reject(err));
  });
}

async function auditActions(db: Database, wsId: string) {
  return db.system((q) =>
    q.query<{ action: string; details: Record<string, unknown> }>(
      'SELECT action, details FROM audit_events WHERE resource_id = $1 AND action LIKE $2 ORDER BY occurred_at, id',
      [wsId, 'terminal.%'],
    ),
  );
}

describe('terminal access (local runtime)', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  let tmp: string;
  let port: number;
  let w: World;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'ep-term-'));
    const bare = await bareRepo(tmp);
    env = await setup({ remoteFor: () => bare });
    w = await world(env.app, env.db, 'termlocal');
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    port = (env.app.server.address() as AddressInfo).port;
  }, 120_000);

  afterAll(async () => {
    await env?.close();
    if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  });

  it('refuses an unauthenticated upgrade', async () => {
    const r = await connect(port, w.wsId, { origin: WEB_ORIGIN });
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses an upgrade from another origin, or with no origin (cross-site WebSocket hijacking)', async () => {
    const evil = await connect(port, w.wsId, { origin: 'https://evil.example', cookie: w.devCookie });
    expect(evil).toMatchObject({ ok: false, status: 403 });
    expect((evil as Refused).body).toContain('Origin not allowed');
    const none = await connect(port, w.wsId, { cookie: w.devCookie });
    expect(none).toMatchObject({ ok: false, status: 403 });
  });

  it('closes refused upgrades instead of leaving the socket half-open (any path)', async () => {
    const health = await new Promise<number>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/api/health`, { headers: { origin: WEB_ORIGIN } });
      s.on('unexpected-response', (_req, res) => {
        res.resume();
        res.socket.once('close', () => resolve(res.statusCode ?? 0));
      });
      s.on('error', reject);
    });
    expect(health).toBe(200);
  });

  it("refuses another developer's workspace", async () => {
    const r = await connect(port, w.wsId, { origin: WEB_ORIGIN, cookie: w.otherCookie });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it('refuses with a clear message when workspaces do not run in containers (never a host shell)', async () => {
    const r = await connect(port, w.wsId, { origin: WEB_ORIGIN, cookie: w.devCookie });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(JSON.parse((r as Refused).body).error).toMatchObject({ code: 'terminal_unavailable', message: expect.stringContaining('never opens a shell on the host') });
    // The plain request the web app makes first gives the same answer.
    const status = await w.dev.get(`/api/workspaces/${w.wsId}/terminal`);
    expect(status.statusCode).toBe(400);
    expect(status.json().error.message).toContain('WORKSPACE_RUNTIME=docker');
    expect(await auditActions(env.db, w.wsId)).toEqual([]);
  });
});

const dockerUp = await DockerRuntime.available();

describe.skipIf(!dockerUp)('terminal in a Docker workspace', () => {
  let app: FastifyInstance;
  let db: Database;
  let runtime: WorkspaceRuntime;
  let tmp: string;
  let port: number;
  let w: World;
  const FAKE_KEY = `sk-ant-api03-${'q'.repeat(40)}TERM`;

  const containerExec = (args: string[]) =>
    new Promise<string>((resolve) => {
      execFile('docker', ['exec', DockerRuntime.containerName(w.wsId), ...args], { windowsHide: true }, (_err, stdout) => resolve(stdout.trim()));
    });

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'ep-term-docker-'));
    const bare = await bareRepo(tmp);
    const sdk = await readSdkPackage();
    runtime = new DockerRuntime({ image: defaultImage(sdk.claudeCodeVersion!), claudeCodeVersion: sdk.claudeCodeVersion!, cpus: '1', memory: '1g', pidsLimit: 256 });
    db = await openPglite();
    await migrate(db);
    app = await buildApp({
      config: loadConfig({ WEB_ORIGIN, LOG_LEVEL: 'silent' }),
      db,
      vault: Vault.fromKey(randomBytes(32).toString('base64')),
      workspacesDir: path.join(tmp, 'workspaces'),
      remoteFor: () => bare,
      runtime,
    });
    w = await world(app, db, 'termdocker');
    expect((await w.admin.request('PUT', `/api/environments/${w.devEnvId}/variables/GREETING`, { value: 'hello from the environment', isSecret: true })).statusCode).toBe(200);
    // The developer's own Claude credential must not reach the terminal.
    expect((await w.dev.request('PUT', '/api/me/credentials/anthropic_api_key', { value: FAKE_KEY })).statusCode).toBe(200);
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  }, 600_000);

  afterAll(async () => {
    if (runtime && w) await runtime.remove(w.wsId);
    await app?.close();
    await db?.close();
    if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  }, 60_000);

  it('opens a PTY shell in the container as uid 1000 in the checkout, with the environment variables', async () => {
    const t = await connect(port, w.wsId, { origin: WEB_ORIGIN, cookie: w.devCookie }, '?cols=100&rows=30');
    if (!t.ok) throw new Error(`refused: ${t.status} ${t.body}`);
    try {
      expect(await t.run('echo $HOME', /^\/home\/agent$/m)).toBe('/home/agent');
      expect(await t.run('pwd', /^\/ws\/repo$/m)).toBe('/ws/repo');
      expect(await t.run('id -u', /^\d+$/m)).toBe('1000');
      // The secret reaches the shell (26 characters + newline) but its value is redacted from the output.
      expect(await t.run('printf %s "$GREETING" | wc -c', /^\d+$/m)).toBe('26');
      expect(await t.run('echo "v=$GREETING"', /^v=\S+$/m)).toBe('v=[redacted]');
      expect(t.text()).not.toContain('hello from the environment');
      expect(await t.run('echo "$TERM"', /^xterm-256color$/m)).toBeTruthy();
      expect(await t.run('tty', /^\/dev\/pts\/\d+$/m)).toMatch(/pts/);

      // No credentials or platform secrets in the shell's environment.
      await t.run('env; echo "END$((6*7))"', /^END42$/m);
      expect(t.text()).not.toContain(FAKE_KEY);
      expect(t.text()).not.toMatch(/^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|GITHUB_TOKEN|DATABASE_URL|VAULT_KEY)=/m);

      // The initial size comes from the query string; resize messages change it.
      expect(await t.run('stty size', /^\d+ \d+$/m)).toBe('30 100');
      t.send({ type: 'resize', cols: 123, rows: 37 });
      expect(await t.run('stty size', /^\d+ \d+$/m)).toBe('37 123');

    } finally {
      t.socket.close();
    }
    await t.closed;

    // Closing the socket ends the shell inside the container, and both ends are audited.
    const end = Date.now() + 20_000;
    while ((await containerExec(['pgrep', '-f', 'pty-bridge'])) !== '' && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
    expect(await containerExec(['pgrep', '-f', 'pty-bridge'])).toBe('');
    await new Promise((r) => setTimeout(r, 200));
    const actions = await auditActions(db, w.wsId);
    expect(actions.map((a) => a.action)).toEqual(['terminal.opened', 'terminal.closed']);
    expect(actions[1]!.details).toMatchObject({ reason: 'closed', durationSec: expect.any(Number) });
    expect(JSON.stringify(actions)).not.toContain('hello from the environment');
  }, 120_000);

  it(`allows at most ${MAX_TERMINALS_PER_WORKSPACE} terminals per workspace and rejects malformed messages`, async () => {
    const open: Terminal[] = [];
    try {
      for (let i = 0; i < MAX_TERMINALS_PER_WORKSPACE; i++) {
        const t = await connect(port, w.wsId, { origin: WEB_ORIGIN, cookie: w.devCookie });
        if (!t.ok) throw new Error(`refused: ${t.status} ${t.body}`);
        open.push(t);
      }
      const extra = await connect(port, w.wsId, { origin: WEB_ORIGIN, cookie: w.devCookie });
      expect(extra).toMatchObject({ ok: false, status: 409 });

      await open[0]!.run('echo ready$((1+1))', /^ready2$/m);
      open[0]!.socket.send('not json');
      expect((await open[0]!.closed).code).toBe(1008);
    } finally {
      for (const t of open) t.socket.close();
    }
    await Promise.all(open.map((t) => t.closed));
    // A slot frees up once a terminal closes.
    const again = await connect(port, w.wsId, { origin: WEB_ORIGIN, cookie: w.devCookie });
    expect(again.ok).toBe(true);
    if (again.ok) {
      again.socket.close();
      await again.closed;
    }
  }, 120_000);
});
