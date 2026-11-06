import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, PASSWORD, seedOrg, setup, type TestEnv } from './helpers.js';

/**
 * Usage and cost reporting. Agent sessions are seeded directly in the database with
 * fixed timestamps so day boundaries (UTC) and the inclusive range can be checked exactly.
 */

let env: TestEnv;
let orgId: string;
let admin: Client;
let alice: Client;
let ids: { alice: string; bob: string; payments: string; portal: string };

interface Numbers { costUsd: number; inputTokens: number; outputTokens: number; sessions: number }
interface Report {
  from: string; to: string; scope: 'org' | 'self'; totals: Numbers;
  byDay: (Numbers & { day: string })[];
  byUser: (Numbers & { userId: string; email: string })[];
  byApplication: (Numbers & { applicationId: string; applicationName: string; clientName: string })[];
  byModel: (Numbers & { model: string })[];
}

/** Creates a client with one application and a ready workspace owned by each user. */
async function appWithWorkspaces(clientName: string, appName: string, owners: string[]) {
  const clientId = (await admin.post('/api/clients', { name: clientName })).json().id as string;
  const created = (await admin.post(`/api/clients/${clientId}/applications`, { name: appName })).json();
  const envId = created.environments.find((e: { kind: string }) => e.kind === 'development').id as string;
  const workspaces = await env.db.system(async (q) => {
    const [repo] = await q.query<{ id: string }>(
      `INSERT INTO repositories (org_id, application_id, provider, owner, name) VALUES ($1, $2, 'github', 'acme', $3) RETURNING id`,
      [orgId, created.id, appName.toLowerCase()],
    );
    const out: Record<string, string> = {};
    for (const owner of owners) {
      const [ws] = await q.query<{ id: string }>(
        `INSERT INTO workspaces (org_id, application_id, environment_id, repository_id, owner_id, branch, base_branch, state)
         VALUES ($1, $2, $3, $4, $5, 'feature', 'main', 'ready') RETURNING id`,
        [orgId, created.id, envId, repo!.id, owner],
      );
      out[owner] = ws!.id;
    }
    return out;
  });
  return { appId: created.id as string, workspaces };
}

async function session(workspaceId: string, userId: string, model: string, cost: number, input: number, output: number, at: string) {
  await env.db.system((q) =>
    q.query(
      `INSERT INTO agent_sessions (org_id, workspace_id, user_id, model, auth_mode, cost_usd, input_tokens, output_tokens, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'api_key', $5, $6, $7, $8, $8)`,
      [orgId, workspaceId, userId, model, cost, input, output, at],
    ),
  );
}

beforeAll(async () => {
  env = await setup();
  ({ orgId } = await seedOrg(env.db, 'acme'));
  admin = await Client.login(env.app, 'admin@acme.test');
  for (const name of ['alice', 'bob']) {
    const r = await admin.post('/api/users', { email: `${name}@acme.test`, displayName: name, password: PASSWORD });
    expect(r.statusCode).toBe(201);
  }
  const users = (await admin.get('/api/users')).json() as { id: string; email: string }[];
  const alicId = users.find((u) => u.email === 'alice@acme.test')!.id;
  const bobId = users.find((u) => u.email === 'bob@acme.test')!.id;
  alice = await Client.login(env.app, 'alice@acme.test');

  const payments = await appWithWorkspaces('ABC', 'Payments', [alicId, bobId]);
  const portal = await appWithWorkspaces('XYZ', 'Portal', [alicId, bobId]);
  ids = { alice: alicId, bob: bobId, payments: payments.appId, portal: portal.appId };

  // In range 2026-03-01 .. 2026-03-03 (inclusive, UTC)
  await session(payments.workspaces[alicId]!, alicId, 'opus', 1.25, 1000, 200, '2026-03-01T00:00:00Z');
  await session(payments.workspaces[alicId]!, alicId, 'sonnet', 0.5, 500, 100, '2026-03-01T23:59:59Z');
  await session(portal.workspaces[bobId]!, bobId, 'sonnet', 2.5, 3000, 600, '2026-03-03T00:15:00Z');
  await session(portal.workspaces[alicId]!, alicId, 'opus', 0.25, 100, 50, '2026-03-03T23:59:59.999Z');
  // Just outside the range on either side
  await session(payments.workspaces[bobId]!, bobId, 'opus', 9.99, 9999, 999, '2026-02-28T23:59:59.999Z');
  await session(payments.workspaces[bobId]!, bobId, 'opus', 7.77, 7777, 777, '2026-03-04T00:00:00Z');
});

afterAll(async () => {
  await env.close();
});

async function report(client: Client, query = 'from=2026-03-01&to=2026-03-03'): Promise<Report> {
  const r = await client.get(`/api/usage?${query}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Report;
}

describe('usage report for an org admin', () => {
  it('totals the whole organization within the inclusive range', async () => {
    const r = await report(admin);
    expect(r).toMatchObject({ from: '2026-03-01', to: '2026-03-03', scope: 'org' });
    expect(r.totals).toEqual({ costUsd: 4.5, inputTokens: 4600, outputTokens: 950, sessions: 4 });
    expect(typeof r.totals.costUsd).toBe('number');
  });

  it('breaks down by UTC day with empty days filled in', async () => {
    const r = await report(admin);
    expect(r.byDay).toEqual([
      { day: '2026-03-01', costUsd: 1.75, inputTokens: 1500, outputTokens: 300, sessions: 2 },
      { day: '2026-03-02', costUsd: 0, inputTokens: 0, outputTokens: 0, sessions: 0 },
      { day: '2026-03-03', costUsd: 2.75, inputTokens: 3100, outputTokens: 650, sessions: 2 },
    ]);
  });

  it('breaks down by developer, application and model, most expensive first', async () => {
    const r = await report(admin);
    expect(r.byUser.map((u) => [u.email, u.costUsd, u.sessions])).toEqual([
      ['bob@acme.test', 2.5, 1],
      ['alice@acme.test', 2, 3],
    ]);
    expect(r.byApplication.map((a) => [a.clientName, a.applicationName, a.costUsd, a.sessions])).toEqual([
      ['XYZ', 'Portal', 2.75, 2],
      ['ABC', 'Payments', 1.75, 2],
    ]);
    expect(r.byApplication[0]!.applicationId).toBe(ids.portal);
    expect(r.byModel.map((m) => [m.model, m.costUsd, m.inputTokens, m.outputTokens, m.sessions])).toEqual([
      ['sonnet', 3, 3500, 700, 2],
      ['opus', 1.5, 1100, 250, 2],
    ]);
  });

  it('a one-day range picks up exactly that day', async () => {
    const r = await report(admin, 'from=2026-03-04&to=2026-03-04');
    expect(r.totals).toEqual({ costUsd: 7.77, inputTokens: 7777, outputTokens: 777, sessions: 1 });
    expect(r.byDay).toHaveLength(1);
  });

  it('defaults to the last 30 days ending today', async () => {
    const r = await report(admin, '');
    const today = new Date().toISOString().slice(0, 10);
    expect(r.to).toBe(today);
    expect(r.byDay).toHaveLength(30);
    expect(r.byDay.at(-1)!.day).toBe(today);
    expect(r.totals.sessions).toBe(0);
  });
});

describe('usage report for a developer', () => {
  it('shows only their own usage, on the same endpoint', async () => {
    const r = await report(alice);
    expect(r.scope).toBe('self');
    expect(r.totals).toEqual({ costUsd: 2, inputTokens: 1600, outputTokens: 350, sessions: 3 });
    expect(r.byUser.map((u) => u.userId)).toEqual([ids.alice]);
    expect(r.byApplication.map((a) => [a.applicationName, a.costUsd])).toEqual([
      ['Payments', 1.75],
      ['Portal', 0.25],
    ]);
    expect(r.byDay.reduce((n, d) => n + d.sessions, 0)).toBe(3);
    expect(JSON.stringify(r)).not.toContain('bob@acme.test');
  });

  it('cannot widen the scope with query parameters', async () => {
    const r = await alice.get(`/api/usage?from=2026-02-01&to=2026-03-31&userId=${ids.bob}`);
    expect(r.statusCode).toBe(200);
    expect(r.json().totals.sessions).toBe(3);
  });
});

describe('date validation', () => {
  it.each([
    ['from=2026-13-01&to=2026-12-31', 'impossible month'],
    ['from=2026-02-30&to=2026-03-01', 'impossible day'],
    ['from=03/01/2026&to=2026-03-02', 'wrong format'],
    ['from=2026-03-05&to=2026-03-01', 'from after to'],
    ['from=2024-01-01&to=2025-01-01', '367 days'],
  ])('rejects %s (%s)', async (query) => {
    const r = await admin.get(`/api/usage?${query}`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_failed');
  });

  it('accepts a full 366-day range', async () => {
    const r = await report(admin, 'from=2024-01-01&to=2024-12-31');
    expect(r.byDay).toHaveLength(366);
  });

  it('requires sign-in', async () => {
    expect((await new Client(env.app).get('/api/usage')).statusCode).toBe(401);
  });
});
