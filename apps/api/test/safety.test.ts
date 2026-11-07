import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentDriver, AgentEvent, AgentRunInput } from '../src/agents/driver.js';
import { folderSize, reapIdleWorkspaces } from '../src/agents/housekeeping.js';
import { AgentManager, PROJECT_INSTRUCTIONS_HEADER, type RunContext } from '../src/agents/manager.js';
import { loadConfig } from '../src/config.js';
import { openPglite, type Database } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { runGit } from '../src/git/git.js';
import { buildApp } from '../src/http/app.js';
import { StreamRedactor, utf8Boundary } from '../src/terminal/redact.js';
import { Vault } from '../src/vault/vault.js';
import { workspacePaths } from '../src/workspaces/paths.js';
import { localRuntime, type WorkspaceRuntime } from '../src/workspaces/runtime.js';
import { Client, PASSWORD, seedOrg, WEB_ORIGIN } from './helpers.js';

/**
 * Claude safety and operations: project instructions, production gating in a real run,
 * run time limit, disk guard, idle reaper, terminal output redaction, audit of variable
 * names, and the team activity views for app admins.
 */

// ---- pure units ----------------------------------------------------------------------

describe('terminal output redaction', () => {
  const SECRET = 'sk_live_ABCDEFGHIJKLMNOP';
  const run = (r: StreamRedactor, chunks: (string | Buffer)[]) => {
    const out: Buffer[] = [];
    for (const c of chunks) out.push(r.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    out.push(r.flush());
    return Buffer.concat(out).toString('utf8');
  };

  it('replaces a secret inside one chunk', () => {
    expect(run(new StreamRedactor([SECRET]), [`key=${SECRET}\r\n`])).toBe('key=[redacted]\r\n');
  });

  it('catches a secret split across chunks, at every split point', () => {
    const text = `before ${SECRET} after`;
    for (let i = 1; i < text.length; i++) {
      const r = new StreamRedactor([SECRET]);
      expect(run(r, [text.slice(0, i), text.slice(i)]), `split at ${i}`).toBe('before [redacted] after');
    }
    // And one byte at a time.
    expect(run(new StreamRedactor([SECRET]), [...text].map((c) => c))).toBe('before [redacted] after');
  });

  it('holds back only what could start a secret, never more than its length − 1', () => {
    const r = new StreamRedactor([SECRET]);
    expect(r.push(Buffer.from('plain output\r\n')).toString()).toBe('plain output\r\n');
    expect(r.pending).toBe(0);
    expect(r.push(Buffer.from('x sk_live_ABC')).toString()).toBe('x ');
    expect(r.pending).toBe('sk_live_ABC'.length);
    // Nothing more arrives: the timer flush releases it as is (it never completed a secret).
    expect(r.flush().toString()).toBe('sk_live_ABC');
    expect(r.pending).toBe(0);
    const long = new StreamRedactor([SECRET]);
    long.push(Buffer.from(SECRET.slice(0, -1)));
    expect(long.pending).toBeLessThanOrEqual(SECRET.length - 1);
  });

  it('handles several secrets, longest first, and repeated occurrences', () => {
    const r = new StreamRedactor(['token-12345678', 'token-12345678-extended', 'AKIAEXAMPLEKEY01']);
    expect(run(r, ['a token-12345678-extended b token-12345678 c AKIAEXAMPLE', 'KEY01 d token-12345678'])).toBe(
      'a [redacted] b [redacted] c [redacted] d [redacted]',
    );
  });

  it('never splits a multi-byte UTF-8 character between messages', () => {
    const r = new StreamRedactor([]);
    const euro = Buffer.from('€', 'utf8'); // 3 bytes
    const first = r.push(Buffer.concat([Buffer.from('price '), euro.subarray(0, 2)]));
    expect(first.toString('utf8')).toBe('price ');
    expect(r.push(euro.subarray(2)).toString('utf8')).toBe('€');
    expect(utf8Boundary(Buffer.from('aé'), 2)).toBe(1);
    expect(utf8Boundary(Buffer.from('aé'), 3)).toBe(3);
    expect(utf8Boundary(Buffer.from('😀'), 3)).toBe(0);
  });

  it('redacts secrets that contain multi-byte characters, split mid-character', () => {
    const secret = 'pässwörd-geheim-ü';
    const bytes = Buffer.from(`x${secret}y`, 'utf8');
    for (let i = 1; i < bytes.length; i++) {
      const r = new StreamRedactor([secret]);
      expect(run(r, [bytes.subarray(0, i), bytes.subarray(i)])).toBe('x[redacted]y');
    }
  });

  it('ignores very short values, which would mangle ordinary output', () => {
    expect(run(new StreamRedactor(['abc', '']), ['abc abc'])).toBe('abc abc');
  });
});

describe('workspace disk size', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ep-size-'));
    await mkdir(path.join(dir, 'node_modules', '.pkg'), { recursive: true });
    await mkdir(path.join(dir, '.git', 'objects'), { recursive: true });
    await writeFile(path.join(dir, 'a.txt'), Buffer.alloc(1000));
    await writeFile(path.join(dir, 'node_modules', '.pkg', 'b.bin'), Buffer.alloc(2000));
    await writeFile(path.join(dir, '.git', 'objects', 'c'), Buffer.alloc(3000));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('counts every file, including dot folders and dependencies', async () => {
    expect(await folderSize(dir)).toEqual({ bytes: 6000, complete: true });
  });

  it('stops early above a limit or when out of time', async () => {
    const above = await folderSize(dir, { stopAboveBytes: 500 });
    expect(above.complete).toBe(false);
    expect(above.bytes).toBeGreaterThan(500);
    expect((await folderSize(dir, { timeLimitMs: -1 })).complete).toBe(false);
  });
});

// ---- the platform, with a scripted Claude ---------------------------------------------

type Script = (input: AgentRunInput) => AsyncGenerator<AgentEvent>;
let script: Script = async function* () {};
const driver: AgentDriver = { run: (input) => script(input) };
const noSignal = () => ({ signal: new AbortController().signal }) as never;

const MAX_MINUTES = 0.03; // 1.8 seconds
const API_SECRET = 'svc_secret_' + 'k'.repeat(20) + 'END';

let db: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
let tmp: string;
let workspacesDir: string;
let orgId: string;
let admin: Client;
let lead: Client;
let dev: Client;
let other: Client;
let devUserId: string;
let appId: string;
let devEnvId: string;
let prodEnvId: string;
let wsId: string;
let prodWsId: string;

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const events = (sessionId: string) =>
  db.system((q) => q.query<{ kind: string; data: Record<string, any> }>('SELECT kind, data FROM agent_events WHERE session_id = $1 ORDER BY id', [sessionId]));

const waitIdle = (sessionId: string) =>
  waitFor(async () => {
    const evs = await events(sessionId);
    const last = evs.at(-1);
    return last?.kind === 'status' && last.data.state === 'idle' && evs.length > 2 ? evs : undefined;
  });

async function createWorkspace(client: Client, environmentId: string, branch: string): Promise<string> {
  const r = await client.post(`/api/applications/${appId}/workspaces`, { environmentId, branch });
  expect(r.statusCode, r.body).toBe(202);
  const id = r.json().id as string;
  const ws = await waitFor(async () => {
    const w = (await client.get(`/api/workspaces/${id}`)).json();
    return w.state === 'creating' ? undefined : w;
  });
  expect(ws.state, ws.error).toBe('ready');
  return id;
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'ep-safety-'));
  const bare = path.join(tmp, 'origin.git');
  const seed = path.join(tmp, 'seed');
  await runGit(['init', '--bare', '-b', 'main', bare], { cwd: tmp });
  await runGit(['clone', bare, seed], { cwd: tmp, allowLocalRemote: true });
  await writeFile(path.join(seed, 'README.md'), '# Ledger\n');
  await runGit(['add', '-A'], { cwd: seed });
  await runGit(['commit', '-m', 'initial'], { cwd: seed, author: { name: 'Seed', email: 'seed@test' } });
  await runGit(['push', 'origin', 'HEAD:main'], { cwd: seed, allowLocalRemote: true });

  db = await openPglite();
  await migrate(db);
  workspacesDir = path.join(tmp, 'workspaces');
  await mkdir(workspacesDir, { recursive: true });
  app = await buildApp({
    config: loadConfig({ WEB_ORIGIN, LOG_LEVEL: 'silent', AGENT_MAX_MINUTES: String(MAX_MINUTES) }),
    db,
    vault: Vault.fromKey(randomBytes(32).toString('base64')),
    workspacesDir,
    remoteFor: () => bare,
    agentDriver: driver,
  });

  const seeded = await seedOrg(db, 'safety');
  orgId = seeded.orgId;
  admin = await Client.login(app, seeded.adminEmail);
  const clientId = (await admin.post('/api/clients', { name: 'Ledger Co' })).json().id;
  const created = (await admin.post(`/api/clients/${clientId}/applications`, { name: 'Ledger' })).json();
  appId = created.id;
  devEnvId = created.environments.find((e: { kind: string }) => e.kind === 'development').id;
  prodEnvId = created.environments.find((e: { kind: string }) => e.kind === 'production').id;
  await admin.request('PUT', `/api/applications/${appId}/repository`, { url: 'https://github.com/ledger/ledger', defaultBranch: 'main' });
  await admin.request('PUT', `/api/environments/${devEnvId}/variables/LEDGER_API_TOKEN`, { value: API_SECRET, isSecret: true });
  await admin.request('PUT', `/api/environments/${devEnvId}/variables/LEDGER_URL`, { value: 'https://ledger.example', isSecret: false });

  for (const email of ['lead@safety.test', 'dev@safety.test', 'other@safety.test']) {
    await admin.post('/api/users', { email, displayName: email.split('@')[0], password: PASSWORD });
  }
  const users = (await admin.get('/api/users')).json() as { id: string; email: string }[];
  const id = (email: string) => users.find((u) => u.email === email)!.id;
  devUserId = id('dev@safety.test');
  await admin.post('/api/grants', { userId: id('lead@safety.test'), role: 'app_admin', scopeType: 'application', scopeId: appId });
  await admin.post('/api/grants', { userId: devUserId, role: 'developer', scopeType: 'application', scopeId: appId });
  await admin.post('/api/grants', { userId: devUserId, role: 'developer', scopeType: 'environment', scopeId: prodEnvId });
  await admin.post('/api/grants', { userId: id('other@safety.test'), role: 'developer', scopeType: 'application', scopeId: appId });
  lead = await Client.login(app, 'lead@safety.test');
  dev = await Client.login(app, 'dev@safety.test');
  other = await Client.login(app, 'other@safety.test');
  await dev.request('PUT', '/api/me/credentials/anthropic_api_key', { value: 'sk-ant-api03-' + 's'.repeat(40) + 'SAFE' });

  wsId = await createWorkspace(dev, devEnvId, 'feature/ledger');
  prodWsId = await createWorkspace(dev, prodEnvId, 'hotfix/ledger');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

describe('project instructions', () => {
  const INSTRUCTIONS = 'Use pnpm, never npm.\nAll money amounts are integers in cents.';

  it('only app admins and org admins can edit them; everyone who can view the app can read them', async () => {
    expect((await dev.patch(`/api/applications/${appId}`, { agentInstructions: 'x' })).statusCode).toBe(403);
    const r = await lead.patch(`/api/applications/${appId}`, { agentInstructions: `  ${INSTRUCTIONS}  ` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().agentInstructions).toBe(INSTRUCTIONS);
    expect((await dev.get(`/api/applications/${appId}`)).json().agentInstructions).toBe(INSTRUCTIONS);
    // Name and description updates leave the instructions alone.
    await admin.patch(`/api/applications/${appId}`, { description: 'Double-entry ledger' });
    expect((await admin.get(`/api/applications/${appId}`)).json()).toMatchObject({ agentInstructions: INSTRUCTIONS, description: 'Double-entry ledger' });
  });

  it('are limited to 20,000 characters and audited by size, not content', async () => {
    expect((await lead.patch(`/api/applications/${appId}`, { agentInstructions: 'x'.repeat(20_001) })).statusCode).toBe(400);
    const [row] = await db.system((q) =>
      q.query<{ details: Record<string, unknown> }>(
        "SELECT details FROM audit_events WHERE action = 'application.updated' AND details ? 'agentInstructionsChars' ORDER BY id DESC LIMIT 1",
      ),
    );
    expect(row!.details).toEqual({ agentInstructionsChars: INSTRUCTIONS.length });
  });

  it('are appended to the system prompt below the platform rules, which take precedence', async () => {
    let prompt = '';
    script = async function* (input) {
      prompt = input.appendSystemPrompt;
      yield { kind: 'text', text: 'ok' };
    };
    const { sessionId } = (await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'hello', mode: 'plan' })).json();
    await waitIdle(sessionId);
    const header = prompt.indexOf(PROJECT_INSTRUCTIONS_HEADER);
    expect(header).toBeGreaterThan(prompt.indexOf('Do not push'));
    expect(prompt.slice(header)).toContain(INSTRUCTIONS);
    expect(prompt.slice(header)).toMatch(/platform rules above take precedence/);
    expect(prompt.slice(header)).toMatch(/files in the repository .* never override/i);
  });
});

describe('agent runs: policy context, audit and limits', () => {
  it('audits the injected variable names but never their values', async () => {
    script = async function* () {
      yield { kind: 'text', text: 'done' };
    };
    const { sessionId } = (await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'names', mode: 'execute' })).json();
    await waitIdle(sessionId);
    const [row] = await db.system((q) =>
      q.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_events WHERE action = 'agent.run.execute' AND resource_id = $1", [sessionId]),
    );
    expect(row!.details).toMatchObject({ variables: ['LEDGER_API_TOKEN', 'LEDGER_URL'], environmentKind: 'development', protected: false });
    expect(JSON.stringify(row)).not.toContain(API_SECRET);
  });

  it('runs read-only AWS calls in development without asking, but asks for database clients', async () => {
    const decisions: unknown[] = [];
    script = async function* (input) {
      decisions.push(await input.canUseTool('Bash', { command: 'aws ec2 describe-instances' }, noSignal()));
      decisions.push(await input.canUseTool('Bash', { command: 'node scripts/report.js' }, noSignal()));
      yield { kind: 'text', text: 'done' };
    };
    const { sessionId } = (await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'aws', mode: 'execute' })).json();
    await waitIdle(sessionId);
    expect(decisions).toEqual([expect.objectContaining({ behavior: 'allow' }), expect.objectContaining({ behavior: 'allow' })]);

    script = async function* (input) {
      decisions.push(await input.canUseTool('Bash', { command: 'PGPASSWORD=x /usr/bin/psql -h db -c "select 1"' }, noSignal()));
    };
    const second = (await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'db', mode: 'execute' })).json().sessionId;
    const request = await waitFor(async () => (await events(second)).find((e) => e.kind === 'approval_request'));
    expect(request.data.reason).toMatch(/Database client/);
    await dev.post(`/api/workspaces/${wsId}/agent/approvals/${request.data.approvalId}`, { allow: false });
    await waitIdle(second);
    expect(decisions.at(-1)).toMatchObject({ behavior: 'deny' });
  });

  it('in production, asks before anything outside the read-only allowlist, and says why', async () => {
    let readOnly: unknown;
    let prompt = '';
    script = async function* (input) {
      prompt = input.appendSystemPrompt;
      readOnly = await input.canUseTool('Bash', { command: 'git status && grep -rn TODO .' }, noSignal());
      await input.canUseTool('Bash', { command: 'node scripts/fix-balances.js' }, noSignal());
      yield { kind: 'text', text: 'after' };
    };
    const { sessionId } = (await dev.post(`/api/workspaces/${prodWsId}/agent/run`, { prompt: 'fix balances', mode: 'execute' })).json();
    const request = await waitFor(async () => (await events(sessionId)).find((e) => e.kind === 'approval_request'));
    expect(readOnly).toMatchObject({ behavior: 'allow' });
    expect(request.data.reason).toMatch(/^Production environment: only read-only commands/);
    expect(prompt).toMatch(/protected production environment/);
    await dev.post(`/api/workspaces/${prodWsId}/agent/approvals/${request.data.approvalId}`, { allow: true });
    await waitIdle(sessionId);
  });

  it(`stops a run that exceeds AGENT_MAX_MINUTES with a clear message`, async () => {
    script = async function* (input) {
      yield { kind: 'text', text: 'starting a long task' };
      const signal = input.abortController.signal;
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      throw new Error('aborted');
    };
    const started = Date.now();
    const { sessionId } = (await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'forever', mode: 'execute' })).json();
    const evs = await waitIdle(sessionId);
    expect(Date.now() - started).toBeGreaterThanOrEqual(MAX_MINUTES * 60_000 - 100);
    expect(evs.find((e) => e.kind === 'error')?.data.message).toBe(`Stopped: the run exceeded ${MAX_MINUTES} minutes.`);
    expect(evs.some((e) => e.kind === 'cancelled')).toBe(false);
    const [audited] = await db.system((q) => q.query("SELECT 1 FROM audit_events WHERE action = 'agent.run.timeout' AND resource_id = $1", [sessionId]));
    expect(audited).toBeTruthy();
    // The workspace is free again.
    expect((await dev.get(`/api/workspaces/${wsId}/agent/sessions`)).json().running).toBe(false);
  });

  it('also stops a run that is waiting for an approval when time runs out', async () => {
    let decision: unknown;
    script = async function* (input) {
      decision = await input.canUseTool('Bash', { command: 'terraform apply' }, noSignal());
    };
    const { sessionId } = (await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'apply', mode: 'execute' })).json();
    const evs = await waitIdle(sessionId);
    expect(decision).toMatchObject({ behavior: 'deny' });
    expect(evs.find((e) => e.kind === 'error')?.data.message).toMatch(/^Stopped: the run exceeded/);
  });
});

describe('disk guard', () => {
  it('refuses a run in a workspace over WORKSPACE_MAX_GB, with a clear message', async () => {
    const paths = workspacePaths(workspacesDir, wsId);
    await writeFile(path.join(paths.repo, 'big.bin'), Buffer.alloc(64 * 1024));
    const manager = new AgentManager(db, driver, localRuntime, { maxTurns: 5, maxBudgetUsd: 1, maxWorkspaceGb: 32 / (1024 * 1024) }); // 32 KB
    const ctx: RunContext = {
      orgId, userId: devUserId, workspaceId: wsId, repoDir: paths.repo, homeDir: paths.home, dirs: paths,
      clientId: '00000000-0000-0000-0000-000000000000', applicationId: appId, environmentId: devEnvId,
      environmentKind: 'development', protected: false,
      labels: { client: 'c', application: 'a', environment: 'e', branch: 'b' },
      authEnv: {}, authMode: 'api_key', appEnv: {}, appSecrets: [], network: { mode: 'restricted', hosts: [] },
    };
    ctx.clientId = (await db.system((q) => q.query<{ client_id: string }>('SELECT client_id FROM applications WHERE id = $1', [appId])))[0]!.client_id;
    await expect(manager.start(ctx, { prompt: 'x', mode: 'plan', model: 'default' })).rejects.toMatchObject({
      statusCode: 507,
      message: expect.stringMatching(/more than .* GB of disk/),
    });
    expect(manager.isRunning(wsId)).toBe(false);
    const [refused] = await db.system((q) => q.query("SELECT details FROM audit_events WHERE action = 'agent.run.refused' AND resource_id = $1", [wsId]));
    expect(refused).toBeTruthy();
    await rm(path.join(paths.repo, 'big.bin'));
  });

  it('does not limit a workspace under the configured size (default 10 GB)', async () => {
    script = async function* () {
      yield { kind: 'text', text: 'fine' };
    };
    const r = await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'small', mode: 'plan' });
    expect(r.statusCode).toBe(200);
    await waitIdle(r.json().sessionId);
  });
});

describe('idle reaper', () => {
  const stops: string[] = [];
  const fake: WorkspaceRuntime = { ...localRuntime, stop: async (id) => void stops.push(id) };

  it('stops containers of workspaces idle for longer than the limit, unless Claude is running', async () => {
    await db.system((q) => q.query("UPDATE workspaces SET last_active_at = now() - interval '3 hours' WHERE id = $1", [wsId]));
    await db.system((q) => q.query("UPDATE workspaces SET last_active_at = now() - interval '10 minutes' WHERE id = $1", [prodWsId]));

    expect(await reapIdleWorkspaces(db, fake, { idleMinutes: 120, isRunning: (id) => id === wsId })).toEqual([]);
    const stopped = new Map<string, string>();
    expect(await reapIdleWorkspaces(db, fake, { idleMinutes: 120, isRunning: () => false, stopped })).toEqual([wsId]);
    expect(stops).toEqual([wsId]);
    // Already stopped and not used since: left alone on the next pass.
    expect(await reapIdleWorkspaces(db, fake, { idleMinutes: 120, isRunning: () => false, stopped })).toEqual([]);
    // A shorter limit catches the workspace used ten minutes ago too.
    expect(await reapIdleWorkspaces(db, fake, { idleMinutes: 5, isRunning: () => false, stopped })).toEqual([prodWsId]);
  });

  it('every runtime can stop a workspace (local: nothing to do)', async () => {
    await expect(localRuntime.stop(wsId)).resolves.toBeUndefined();
  });
});

describe('team activity', () => {
  it('lists every conversation in the application for app admins and org admins', async () => {
    for (const client of [lead, admin]) {
      const r = await client.get(`/api/applications/${appId}/agent/sessions`);
      expect(r.statusCode, r.body).toBe(200);
      const sessions = r.json().sessions as Record<string, unknown>[];
      expect(sessions.length).toBeGreaterThan(3);
      expect(sessions[0]).toMatchObject({
        userName: 'dev', userEmail: 'dev@safety.test', branch: expect.stringMatching(/ledger$/), model: 'default',
        costUsd: expect.any(Number), inputTokens: expect.any(Number), outputTokens: expect.any(Number), updatedAt: expect.any(String), running: false,
      });
      expect(sessions.map((s) => s.branch)).toEqual(expect.arrayContaining(['feature/ledger', 'hotfix/ledger']));
    }
  });

  it('is not available to developers', async () => {
    expect((await dev.get(`/api/applications/${appId}/agent/sessions`)).statusCode).toBe(403);
    expect((await other.get(`/api/applications/${appId}/agent/sessions`)).statusCode).toBe(403);
  });

  it('shows a transcript read-only to its owner and to admins, never to other developers', async () => {
    script = async function* (input) {
      yield { kind: 'tool_result', toolUseId: 't', isError: false, output: `token is ${input.env.LEDGER_API_TOKEN}` };
    };
    const { sessionId } = (await dev.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'show the token', mode: 'execute' })).json();
    await waitIdle(sessionId);

    const mine = await dev.get(`/api/agent/sessions/${sessionId}/transcript`);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().session).toMatchObject({ id: sessionId, title: 'show the token', userName: 'dev', branch: 'feature/ledger' });
    expect(mine.json().events.map((e: { kind: string }) => e.kind)).toEqual(['user', 'status', 'tool_result', 'status']);
    expect(mine.body).not.toContain(API_SECRET);
    expect(mine.json().events[2].data.output).toBe('token is [redacted]');

    expect((await lead.get(`/api/agent/sessions/${sessionId}/transcript`)).statusCode).toBe(200);
    expect((await admin.get(`/api/agent/sessions/${sessionId}/transcript`)).statusCode).toBe(200);
    expect((await other.get(`/api/agent/sessions/${sessionId}/transcript`)).statusCode).toBe(404);

    // Admin views are audited; the owner's own views are not.
    const views = await db.system((q) =>
      q.query<{ actor_id: string }>("SELECT actor_id FROM audit_events WHERE action = 'agent.transcript.viewed' AND resource_id = $1", [sessionId]),
    );
    expect(views).toHaveLength(2);
    expect(views.every((v) => v.actor_id !== devUserId)).toBe(true);
  });

  it('stops showing the owner their transcript once their access is revoked (admins still can)', async () => {
    const { sessions } = (await lead.get(`/api/applications/${appId}/agent/sessions`)).json() as { sessions: { id: string; branch: string }[] };
    const prodSession = sessions.find((s) => s.branch === 'hotfix/ledger')!.id;
    expect((await dev.get(`/api/agent/sessions/${prodSession}/transcript`)).statusCode).toBe(200);
    const grants = (await admin.get(`/api/grants?scopeType=environment&scopeId=${prodEnvId}`)).json() as { id: string; userId: string; scopeType: string; inherited: boolean }[];
    const envGrant = grants.find((g) => g.userId === devUserId && g.scopeType === 'environment' && !g.inherited)!;
    expect((await admin.delete(`/api/grants/${envGrant.id}`)).statusCode).toBe(200);
    expect((await dev.get(`/api/agent/sessions/${prodSession}/transcript`)).statusCode).toBe(404);
    expect((await lead.get(`/api/agent/sessions/${prodSession}/transcript`)).statusCode).toBe(200);
  });

  it('returns 404 for unknown conversations', async () => {
    expect((await admin.get('/api/agent/sessions/00000000-0000-4000-8000-000000000000/transcript')).statusCode).toBe(404);
  });
});
