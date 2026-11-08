import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentDriver, AgentEvent, AgentRunInput } from '../src/agents/driver.js';
import { AgentManager } from '../src/agents/manager.js';
import { INTERRUPTED_MESSAGE, recoverInterruptedRuns } from '../src/agents/recovery.js';
import { loadConfig } from '../src/config.js';
import { openPglite, type Database, type Queryable } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/http/app.js';
import { Vault } from '../src/vault/vault.js';
import { Client, seedOrg, WEB_ORIGIN } from './helpers.js';

/**
 * Reliability of Claude runs and their event stream: failures while starting or finishing a
 * run, events recorded while a stream opens, out-of-order writes, disconnects, shutdown with
 * open streams, and conversations left "running" by a restart.
 */

type Script = (input: AgentRunInput) => AsyncGenerator<AgentEvent>;
let script: Script = async function* () {};
const driver: AgentDriver = { run: (input) => script(input) };

// ---- a database wrapper that can fail or delay chosen statements -------------------------

interface Statement { sql: string; params: unknown[] }
/** Throws to fail a statement (inside its transaction). */
let beforeStatement: ((s: Statement) => void) | undefined;
/** Awaited after a transaction commits, before its result is returned to the caller. */
let afterCommit: ((statements: Statement[]) => Promise<void> | void) | undefined;

function instrument(raw: Database): Database {
  const run = async <T>(tx: (fn: (q: Queryable) => Promise<T>) => Promise<T>, fn: (q: Queryable) => Promise<T>): Promise<T> => {
    const seen: Statement[] = [];
    const out = await tx((q) =>
      fn({
        query: async <R>(sql: string, params: unknown[] = []) => {
          const s = { sql, params };
          seen.push(s);
          beforeStatement?.(s);
          return q.query<R>(sql, params);
        },
      }),
    );
    await afterCommit?.(seen);
    return out;
  };
  return {
    tenant: (orgId, fn) => run((f) => raw.tenant(orgId, f), fn),
    system: (fn) => run((f) => raw.system(f), fn),
    script: (sql) => raw.script(sql),
    close: () => raw.close(),
  };
}

const isEventInsert = (s: Statement, kind?: string) => s.sql.startsWith('INSERT INTO agent_events') && (!kind || s.params[2] === kind);
const isHistoryRead = (s: Statement) => s.sql.includes('FROM agent_events e WHERE e.session_id');

// Counts live stream subscriptions on every AgentManager.
let liveSubscriptions = 0;
const realSubscribe = AgentManager.prototype.subscribe;
vi.spyOn(AgentManager.prototype, 'subscribe').mockImplementation(function (this: AgentManager, sessionId, fn) {
  const off = realSubscribe.call(this, sessionId, fn);
  liveSubscriptions++;
  let done = false;
  return () => {
    if (!done) liveSubscriptions--;
    done = true;
    off();
  };
});

let raw: Database;
let db: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
let workspacesDir: string;
let orgId: string;
let userId: string;
let wsId: string;
let client: Client;
let base: string;
let cookie: string;
let appClosed = false;

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const events = (sessionId: string) =>
  raw.system((q) => q.query<{ id: string; kind: string; data: Record<string, any> }>('SELECT e.id::text AS id, e.kind, e.data FROM agent_events e WHERE e.session_id = $1 ORDER BY e.id', [sessionId]));

const waitIdle = (sessionId: string) =>
  waitFor(async () => {
    const evs = await events(sessionId);
    const last = evs.at(-1);
    return last?.kind === 'status' && last.data.state === 'idle' && evs.length > 2 ? evs : undefined;
  });

const notRunning = () => waitFor(async () => ((await client.get(`/api/workspaces/${wsId}/agent/sessions`)).json().running ? undefined : true));

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

/** An open event stream, read in the background. */
async function openStream(sessionId: string, signal?: AbortSignal) {
  const res = await fetch(`${base}/api/agent/sessions/${sessionId}/events?after=0`, { headers: { cookie }, signal });
  const reader = res.body!.getReader();
  const stream = { status: res.status, text: '', ended: false, reader };
  void (async () => {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.value) stream.text += new TextDecoder().decode(r.value);
        if (r.done) break;
      }
    } catch {
      // aborted
    }
    stream.ended = true;
  })();
  return stream;
}

const streamed = (text: string) =>
  [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]!) as { id: string; kind: string; data: Record<string, any> });

beforeAll(async () => {
  raw = await openPglite();
  await migrate(raw);
  db = instrument(raw);
  workspacesDir = await mkdtemp(path.join(os.tmpdir(), 'ep-streams-'));
  app = await buildApp({
    config: loadConfig({ WEB_ORIGIN, LOG_LEVEL: 'silent' }),
    db,
    vault: Vault.fromKey(randomBytes(32).toString('base64')),
    workspacesDir,
    agentDriver: driver,
  });
  const seeded = await seedOrg(raw, 'streams');
  orgId = seeded.orgId;
  client = await Client.login(app, seeded.adminEmail);
  const [user] = await raw.system((q) => q.query<{ id: string }>('SELECT id FROM users WHERE org_id = $1', [orgId]));
  userId = user!.id;
  wsId = await raw.system(async (q) => {
    const [c] = await q.query<{ id: string }>(`INSERT INTO clients (org_id, name, slug) VALUES ($1,'c','c') RETURNING id`, [orgId]);
    const [a] = await q.query<{ id: string }>(`INSERT INTO applications (org_id, client_id, name, slug) VALUES ($1,$2,'a','a') RETURNING id`, [orgId, c!.id]);
    const [e] = await q.query<{ id: string }>(`INSERT INTO environments (org_id, application_id, name, kind) VALUES ($1,$2,'development','development') RETURNING id`, [orgId, a!.id]);
    const [r] = await q.query<{ id: string }>(`INSERT INTO repositories (org_id, application_id, provider, owner, name) VALUES ($1,$2,'github','o','n') RETURNING id`, [orgId, a!.id]);
    const [w] = await q.query<{ id: string }>(
      `INSERT INTO workspaces (org_id, application_id, environment_id, repository_id, owner_id, branch, base_branch, state)
       VALUES ($1,$2,$3,$4,$5,'b','main','ready') RETURNING id`,
      [orgId, a!.id, e!.id, r!.id, userId],
    );
    await q.query(`INSERT INTO grants (org_id, user_id, role, scope_type, scope_id) VALUES ($1,$2,'developer','application',$3)`, [orgId, userId, a!.id]);
    return w!.id;
  });
  expect((await client.request('PUT', '/api/me/credentials/anthropic_api_key', { value: 'sk-ant-api03-' + 'q'.repeat(40) })).statusCode).toBe(200);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  cookie = (client as unknown as { cookie: string }).cookie;
});

afterAll(async () => {
  beforeStatement = undefined;
  afterCommit = undefined;
  if (!appClosed) await app?.close();
  await raw?.close();
  if (workspacesDir) await rm(workspacesDir, { recursive: true, force: true, maxRetries: 3 });
});

const startRun = (prompt = 'go') => client.post(`/api/workspaces/${wsId}/agent/run`, { prompt, mode: 'execute' });

describe('failures around a run', () => {
  it('a failure while starting releases the workspace, so Claude can run again', async () => {
    script = async function* () {
      yield { kind: 'text', text: 'hello' };
    };
    beforeStatement = (s) => {
      if (isEventInsert(s, 'status') && String(s.params[3]).includes('running')) throw new Error('disk full');
    };
    const failed = await startRun();
    beforeStatement = undefined;
    expect(failed.statusCode).toBe(500);
    const sessions = (await client.get(`/api/workspaces/${wsId}/agent/sessions`)).json();
    expect(sessions).toMatchObject({ running: false, activeSessionId: null, runningBy: null });

    const again = await startRun();
    expect(again.statusCode, again.body).toBe(200);
    const evs = await waitIdle(again.json().sessionId);
    expect(evs.map((e) => e.kind)).toEqual(['user', 'status', 'text', 'status']);
  });

  it('a failure recording the end of a run neither crashes the server nor leaves it running', async () => {
    script = async function* () {
      yield { kind: 'text', text: 'working' };
      throw new Error('the model went away');
    };
    beforeStatement = (s) => {
      if (isEventInsert(s, 'error')) throw new Error('database unavailable');
    };
    try {
      const r = await startRun();
      expect(r.statusCode).toBe(200);
      const evs = await waitIdle(r.json().sessionId);
      expect(evs.map((e) => e.kind)).toEqual(['user', 'status', 'text', 'status']);
      await notRunning();
    } finally {
      beforeStatement = undefined;
    }
    expect((await startRun()).statusCode).toBe(200);
    await notRunning();
  });
});

describe('the event stream', () => {
  it('delivers events recorded while the history is being read', async () => {
    const step = gate();
    script = async function* () {
      yield { kind: 'text', text: 'A' };
      await step.opened;
      yield { kind: 'text', text: 'B' };
      yield { kind: 'text', text: 'C' };
    };
    const { sessionId } = (await startRun()).json();
    await waitFor(async () => ((await events(sessionId)).some((e) => e.data.text === 'A') ? true : undefined));

    // Hold the stream between reading its history and going live; record B meanwhile.
    const historyRead = gate();
    const release = gate();
    afterCommit = async (statements) => {
      if (statements.some(isHistoryRead)) {
        afterCommit = undefined;
        historyRead.open();
        await release.opened;
      }
    };
    const streamPromise = openStream(sessionId);
    await historyRead.opened;
    step.open();
    await waitFor(async () => ((await events(sessionId)).some((e) => e.data.text === 'C') ? true : undefined));
    release.open();
    const stream = await streamPromise;
    const stored = await waitIdle(sessionId);
    await waitFor(() => (streamed(stream.text).length === stored.length ? true : undefined));
    expect(streamed(stream.text).map((e) => e.id)).toEqual(stored.map((e) => e.id));
    await stream.reader.cancel();
    await waitFor(() => (liveSubscriptions === 0 ? true : undefined));
  });

  it('records a conversation’s events in order, so a stream never drops an approval request', async () => {
    let decision: Promise<unknown> | undefined;
    script = async function* (input) {
      // The SDK may ask for permission while it is still reporting other output.
      decision = input.canUseTool('Bash', { command: 'rm -rf build' }, { signal: input.abortController.signal } as never);
      yield { kind: 'text', text: 'while waiting' };
      await decision;
    };
    // Slow the approval request down after its id is assigned; with a connection pool the
    // next event could otherwise commit and reach the stream first.
    afterCommit = async (statements) => {
      if (statements.some((s) => isEventInsert(s, 'approval_request'))) {
        afterCommit = undefined;
        await new Promise((r) => setTimeout(r, 300));
      }
    };
    const { sessionId } = (await startRun()).json();
    const stream = await openStream(sessionId);
    const request = await waitFor(() => streamed(stream.text).find((e) => e.kind === 'approval_request'));
    const stored = await waitFor(async () => {
      const evs = await events(sessionId);
      return evs.some((e) => e.kind === 'text') ? evs : undefined;
    });
    const kinds = stored.map((e) => e.kind);
    expect(kinds.indexOf('approval_request')).toBeLessThan(kinds.indexOf('text'));
    expect((await client.post(`/api/workspaces/${wsId}/agent/approvals/${request.data.approvalId}`, { allow: false })).statusCode).toBe(200);
    const all = await waitIdle(sessionId);
    await waitFor(() => (streamed(stream.text).length === all.length ? true : undefined));
    const ids = streamed(stream.text).map((e) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids).toEqual(all.map((e) => Number(e.id)));
    await stream.reader.cancel();
    await waitFor(() => (liveSubscriptions === 0 ? true : undefined));
  });

  it('does not leak a subscription when the client leaves while the history is read', async () => {
    const [s] = await raw.system((q) => q.query<{ id: string }>('SELECT id FROM agent_sessions ORDER BY created_at DESC LIMIT 1'));
    const historyRead = gate();
    const release = gate();
    afterCommit = async (statements) => {
      if (statements.some(isHistoryRead)) {
        afterCommit = undefined;
        historyRead.open();
        await release.opened;
      }
    };
    const abort = new AbortController();
    const opening = openStream(s!.id, abort.signal).catch(() => undefined);
    await historyRead.opened;
    expect(liveSubscriptions).toBe(1);
    abort.abort();
    await opening;
    // Give the server a moment to see the socket close.
    await new Promise((r) => setTimeout(r, 100));
    release.open();
    await waitFor(() => (liveSubscriptions === 0 ? true : undefined));
  });

  it('refuses streams of other people’s conversations without leaving a subscription', async () => {
    const res = await fetch(`${base}/api/agent/sessions/77777777-7777-4777-8777-777777777777/events`, { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(liveSubscriptions).toBe(0);
  });
});

describe('restart recovery', () => {
  it('closes off conversations left running by a restart, once', async () => {
    const insertSession = async (statuses: string[]) =>
      raw.system(async (q) => {
        const [s] = await q.query<{ id: string }>(
          `INSERT INTO agent_sessions (org_id, workspace_id, user_id, model, auth_mode, title) VALUES ($1,$2,$3,'default','api_key','t') RETURNING id`,
          [orgId, wsId, userId],
        );
        await q.query(`INSERT INTO agent_events (org_id, session_id, kind, data) VALUES ($1,$2,'user','{"prompt":"x"}')`, [orgId, s!.id]);
        for (const state of statuses) {
          await q.query(`INSERT INTO agent_events (org_id, session_id, kind, data) VALUES ($1,$2,'status',$3)`, [orgId, s!.id, JSON.stringify({ state })]);
          await q.query(`INSERT INTO agent_events (org_id, session_id, kind, data) VALUES ($1,$2,'text','{"text":"t"}')`, [orgId, s!.id]);
        }
        return s!.id;
      });
    const stuck = await insertSession(['running', 'idle', 'running']);
    const finished = await insertSession(['running', 'idle']);
    const before = (await events(finished)).length;

    expect(await recoverInterruptedRuns(raw)).toBe(1);
    const evs = await events(stuck);
    expect(evs.slice(-2).map((e) => [e.kind, e.data])).toEqual([
      ['error', { message: INTERRUPTED_MESSAGE, reason: 'restart' }],
      ['status', { state: 'idle' }],
    ]);
    expect((await events(finished)).length).toBe(before);
    expect(await recoverInterruptedRuns(raw)).toBe(0);

    // The recovered conversation can be continued.
    script = async function* () {
      yield { kind: 'text', text: 'resumed' };
    };
    const r = await client.post(`/api/workspaces/${wsId}/agent/run`, { prompt: 'again', mode: 'plan', sessionId: stuck });
    expect(r.statusCode, r.body).toBe(200);
    await waitIdle(stuck);
    await notRunning();
  });
});

describe('shutdown', () => {
  it('app.close() ends open event streams instead of waiting for them', async () => {
    const [s] = await raw.system((q) => q.query<{ id: string }>('SELECT id FROM agent_sessions ORDER BY created_at DESC LIMIT 1'));
    const stream = await openStream(s!.id);
    expect(stream.status).toBe(200);
    await waitFor(() => (liveSubscriptions === 1 ? true : undefined));
    const closed = await Promise.race([
      app.close().then(() => {
        appClosed = true;
        return 'closed';
      }),
      new Promise((r) => setTimeout(() => r('hung'), 5_000)),
    ]);
    expect(closed).toBe('closed');
    await waitFor(() => (stream.ended ? true : undefined));
    expect(liveSubscriptions).toBe(0);
  });
});
