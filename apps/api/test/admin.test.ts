import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csvCell } from '../src/audit/query.js';
import { checkMonthlyBudget, monthBounds } from '../src/org/budgets.js';
import { Client, PASSWORD, seedOrg, setup, type TestEnv } from './helpers.js';

/**
 * Admin, audit and account hygiene: audit filters and CSV export, the user's own sign-in
 * sessions, organisation settings, per-developer budgets and the monthly budget maths.
 */

let env: TestEnv;
let orgId: string;
let admin: Client;
let dev: Client;
let devId: string;
let adminId: string;

/** Logs in again as the same user: a second device. */
const device = (email: string) => Client.login(env.app, email);
const put = (c: Client, url: string, body: unknown) => c.request('PUT', url, body);

/** Inserts an audit event directly, with a fixed time and fields the API never writes. */
async function event(e: {
  action: string; at: string; outcome?: string; actorId?: string | null; resourceType?: string | null; resourceId?: string | null;
  clientId?: string | null; applicationId?: string | null; environmentId?: string | null; details?: Record<string, unknown>;
}) {
  await env.db.system((q) =>
    q.query(
      `INSERT INTO audit_events (org_id, occurred_at, actor_id, action, resource_type, resource_id, client_id, application_id, environment_id, outcome, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [orgId, e.at, e.actorId ?? null, e.action, e.resourceType ?? null, e.resourceId ?? null, e.clientId ?? null,
        e.applicationId ?? null, e.environmentId ?? null, e.outcome ?? 'success', JSON.stringify(e.details ?? {})],
    ),
  );
}

interface Row { id: string; action: string; outcome: string; actorEmail: string | null; details: Record<string, unknown>; clientName: string | null }
const actions = (rows: Row[]) => rows.map((r) => r.action);

beforeAll(async () => {
  env = await setup();
  const seeded = await seedOrg(env.db, 'adm');
  orgId = seeded.orgId;
  admin = await Client.login(env.app, seeded.adminEmail);
  adminId = (await admin.get('/api/auth/me')).json().user.id;
  const created = await admin.post('/api/users', { email: 'dev@adm.test', displayName: 'Dev', password: PASSWORD });
  devId = created.json().id;
  dev = await Client.login(env.app, 'dev@adm.test');
});

afterAll(async () => {
  await env?.close();
});

// ---- audit filters ----------------------------------------------------------------

describe('audit log filters', () => {
  const ids = {
    client: '11111111-1111-4111-8111-111111111111',
    app: '22222222-2222-4222-8222-222222222222',
    envA: '33333333-3333-4333-8333-333333333333',
    envB: '44444444-4444-4444-8444-444444444444',
    ws: '55555555-5555-4555-8555-555555555555',
    agent: '66666666-6666-4666-8666-666666666666',
  };

  beforeAll(async () => {
    await event({ action: 'git.push', at: '2026-03-01T10:00:00Z', actorId: devId, resourceType: 'workspace', resourceId: ids.ws, environmentId: ids.envA, details: { branch: 'f' } });
    await event({ action: 'git.pull_request', at: '2026-03-02T23:59:59Z', actorId: devId, resourceType: 'workspace', resourceId: ids.ws, environmentId: ids.envA });
    await event({ action: 'gitx.other', at: '2026-03-03T00:00:00Z', actorId: devId, environmentId: ids.envB });
    await event({ action: 'agent.run.plan', at: '2026-03-02T12:00:00Z', actorId: devId, resourceType: 'agent_session', resourceId: ids.agent, details: { workspaceId: ids.ws } });
    await event({ action: 'auth.login', at: '2026-03-02T08:00:00Z', actorId: devId, outcome: 'denied' });
    await event({ action: 'aws.connection.tested', at: '2026-03-04T08:00:00Z', actorId: adminId, outcome: 'failure', clientId: ids.client, applicationId: ids.app });
  });

  const list = async (qs: string) => {
    const res = await admin.get(`/api/audit?${qs}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Row[];
  };

  it('filters by action prefix without treating _ as a wildcard', async () => {
    expect(actions(await list('action=git.&from=2026-03-01&to=2026-03-31'))).toEqual(['git.pull_request', 'git.push']);
    expect(actions(await list('action=git.pull_&from=2026-03-01&to=2026-03-31'))).toEqual(['git.pull_request']);
    expect(actions(await list('action=git&from=2026-03-01&to=2026-03-31'))).toEqual(['gitx.other', 'git.pull_request', 'git.push']);
  });

  it('filters by outcome, actor and environment', async () => {
    expect(actions(await list('outcome=denied&from=2026-03-01&to=2026-03-31'))).toEqual(['auth.login']);
    expect(actions(await list('outcome=failure&from=2026-03-01&to=2026-03-31'))).toEqual(['aws.connection.tested']);
    expect(actions(await list(`actorId=${adminId}&from=2026-03-01&to=2026-03-31`))).toEqual(['aws.connection.tested']);
    expect(actions(await list(`environmentId=${ids.envB}`))).toEqual(['gitx.other']);
    expect(actions(await list(`clientId=${ids.client}&applicationId=${ids.app}`))).toEqual(['aws.connection.tested']);
  });

  it('finds workspace events by resource id and by details.workspaceId', async () => {
    expect(actions(await list(`workspaceId=${ids.ws}`))).toEqual(['agent.run.plan', 'git.pull_request', 'git.push']);
  });

  it('treats dates as whole UTC days and timestamps as exact, both inclusive (newest id first)', async () => {
    expect(actions(await list('from=2026-03-02&to=2026-03-02'))).toEqual(['auth.login', 'agent.run.plan', 'git.pull_request']);
    expect(actions(await list('from=2026-03-02T12:00:00Z&to=2026-03-03T00:00:00Z'))).toEqual(['agent.run.plan', 'gitx.other', 'git.pull_request']);
    expect(actions(await list('from=2026-03-02T12:00:00%2B01:00&to=2026-03-02T12:00:00Z'))).toEqual(['agent.run.plan']);
  });

  it('pages with before and limit', async () => {
    const first = await list('from=2026-03-01&to=2026-03-31&limit=2');
    expect(first).toHaveLength(2);
    const next = await list(`from=2026-03-01&to=2026-03-31&limit=10&before=${first[1]!.id}`);
    expect(next.map((r) => r.id)).not.toContain(first[0]!.id);
    expect([...first, ...next].length).toBe(6);
  });

  it('rejects invalid filters', async () => {
    for (const qs of [
      'action=GIT.', 'action=git%25', "action=git'--", 'outcome=maybe', 'from=2026-02-30', 'from=yesterday',
      'from=2026-03-05&to=2026-03-01', 'workspaceId=nope', 'environmentId=1', 'limit=0', 'limit=201', 'before=-1', 'unknown=1',
    ]) {
      const res = await admin.get(`/api/audit?${qs}`);
      expect(res.statusCode, qs).toBe(400);
    }
  });

  it('is for org admins only', async () => {
    expect((await dev.get('/api/audit')).statusCode).toBe(403);
    expect((await dev.get('/api/audit/export.csv')).statusCode).toBe(403);
    expect((await new Client(env.app).get('/api/audit/export.csv')).statusCode).toBe(401);
  });
});

// ---- CSV export ---------------------------------------------------------------------

describe('audit CSV export', () => {
  it('escapes cells against formula injection and quotes per RFC 4180', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+1')).toBe(`'+1`);
    expect(csvCell('-2')).toBe(`'-2`);
    expect(csvCell('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(csvCell('\tx')).toBe(`'\tx`);
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(null)).toBe('');
    expect(csvCell({ a: '"q"' })).toBe('"{""a"":""\\""q\\""""}"');
  });

  it('streams the filtered rows as an escaped CSV download and audits the export', async () => {
    await event({ action: 'zz.inject', at: '2026-04-10T00:00:00Z', resourceType: '=cmd|"/c calc"!A1', details: { note: '@evil', text: 'a,"b"' } });
    await event({ action: 'zz.other', at: '2026-04-11T00:00:00Z', outcome: 'denied' });
    await event({ action: 'zz.outside', at: '2026-05-01T00:00:00Z' });

    const res = await admin.get('/api/audit/export.csv?action=zz.&from=2026-04-01&to=2026-04-30');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="audit-.*\.csv"$/);
    expect(res.headers['cache-control']).toBe('no-store');

    const body = res.body.replace(/^﻿/, '');
    const lines = body.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('id,occurred_at,actor_email,actor_id,action,outcome,resource_type,resource_id,client,client_id,application,application_id,environment,environment_id,details');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(',zz.other,denied,');
    expect(lines[2]).toContain(',zz.inject,success,');
    expect(lines[2]).toContain(`"'=cmd|""/c calc""!A1"`);
    // JSON details start with "{", so they are quoted but need no apostrophe.
    expect(lines[2]).toContain('"{""note"":""@evil"",""text"":""a,\\""b\\""""}"');
    expect(body).not.toContain('zz.outside');

    const [logged] = (await admin.get('/api/audit?action=audit.exported&limit=1')).json() as Row[];
    expect(logged!.actorEmail).toBe('admin@adm.test');
    expect(logged!.details).toMatchObject({ filters: { action: 'zz.' }, limit: 50000 });
  });

  it('respects the row limit across batches and validates the limit', async () => {
    await env.db.system((q) =>
      q.query(
        `INSERT INTO audit_events (org_id, occurred_at, action) SELECT $1, '2026-06-15T00:00:00Z', 'bulk.event' FROM generate_series(1, 2500)`,
        [orgId],
      ),
    );
    const all = await admin.get('/api/audit/export.csv?action=bulk.');
    expect(all.body.split('\r\n').filter(Boolean)).toHaveLength(2501);
    const some = await admin.get('/api/audit/export.csv?action=bulk.&limit=1500');
    const rows = some.body.split('\r\n').filter(Boolean).slice(1);
    expect(rows).toHaveLength(1500);
    expect(new Set(rows.map((l) => l.split(',')[0])).size).toBe(1500);
    expect((await admin.get('/api/audit/export.csv?limit=50001')).statusCode).toBe(400);
    expect((await admin.get('/api/audit/export.csv?outcome=nope')).statusCode).toBe(400);
  });
});

// ---- sign-in sessions ----------------------------------------------------------------

interface SessionRow { id: string; createdAt: string; lastUsedAt: string; expiresAt: string; ip: string | null; userAgent: string | null; current: boolean }

describe('your sign-in sessions', () => {
  it('lists only your active sessions, marks this device and never returns tokens', async () => {
    const a = await device('dev@adm.test');
    const b = await device('dev@adm.test');
    const res = await a.get('/api/me/sessions');
    expect(res.statusCode).toBe(200);
    const rows = res.json() as SessionRow[];
    expect(rows.length).toBeGreaterThanOrEqual(3); // dev, a, b
    expect(rows.filter((r) => r.current)).toHaveLength(1);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['createdAt', 'current', 'expiresAt', 'id', 'ip', 'lastUsedAt', 'userAgent']);
      expect(new Date(r.lastUsedAt).getTime()).toBeGreaterThanOrEqual(new Date(r.createdAt).getTime()); // updated on use
    }
    const [hash] = await env.db.system((q) => q.query<{ token_hash: string }>('SELECT token_hash FROM sessions LIMIT 1'));
    expect(res.body).not.toContain(hash!.token_hash);
    expect(res.body).not.toMatch(/token/i);

    // The admin's own list holds none of the developer's sessions.
    const adminRows = (await admin.get('/api/me/sessions')).json() as SessionRow[];
    expect(adminRows.some((r) => rows.some((d) => d.id === r.id))).toBe(false);
    await b.post('/api/auth/logout');
  });

  it('revokes one of your sessions; the current one stays', async () => {
    const a = await device('dev@adm.test');
    const b = await device('dev@adm.test');
    const bId = ((await b.get('/api/me/sessions')).json() as SessionRow[]).find((r) => r.current)!.id;

    const res = await a.delete(`/api/me/sessions/${bId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, signedOut: false });
    expect((await b.get('/api/auth/me')).statusCode).toBe(401);
    expect((await a.get('/api/auth/me')).statusCode).toBe(200);
    // Already revoked: gone.
    expect((await a.delete(`/api/me/sessions/${bId}`)).statusCode).toBe(404);

    const [logged] = (await admin.get('/api/audit?action=auth.session_revoked&limit=1')).json() as Row[];
    expect(logged).toMatchObject({ actorEmail: 'dev@adm.test', details: { current: false } });
  });

  it("cannot revoke someone else's session", async () => {
    const d = await device('dev@adm.test');
    const dId = ((await d.get('/api/me/sessions')).json() as SessionRow[]).find((r) => r.current)!.id;
    expect((await admin.delete(`/api/me/sessions/${dId}`)).statusCode).toBe(404);
    expect((await admin.delete('/api/me/sessions/not-a-uuid')).statusCode).toBe(400);
    expect((await d.get('/api/auth/me')).statusCode).toBe(200);
  });

  it('revoking the current session signs you out', async () => {
    const a = await device('dev@adm.test');
    const aId = ((await a.get('/api/me/sessions')).json() as SessionRow[]).find((r) => r.current)!.id;
    const res = await a.delete(`/api/me/sessions/${aId}`);
    expect(res.json()).toEqual({ ok: true, signedOut: true });
    expect(String(res.headers['set-cookie'])).toMatch(/ep_session=;/);
    expect((await a.get('/api/auth/me')).statusCode).toBe(401);
  });

  it('signs out every other device and keeps this one', async () => {
    const keep = await device('dev@adm.test');
    const other = await device('dev@adm.test');
    const res = await keep.post('/api/me/sessions/revoke-others');
    expect(res.statusCode).toBe(200);
    expect(res.json().revoked).toBeGreaterThanOrEqual(2); // `other` and the original `dev`
    expect((await other.get('/api/auth/me')).statusCode).toBe(401);
    expect((await dev.get('/api/auth/me')).statusCode).toBe(401);
    expect((await keep.get('/api/auth/me')).statusCode).toBe(200);
    expect(((await keep.get('/api/me/sessions')).json() as SessionRow[]).map((r) => r.current)).toEqual([true]);
    // The admin was not touched.
    expect((await admin.get('/api/auth/me')).statusCode).toBe(200);
    const [logged] = (await admin.get('/api/audit?action=auth.sessions_revoked&limit=1')).json() as Row[];
    expect(logged!.details).toEqual({ count: res.json().revoked });
    dev = keep;
  });
});

// ---- organisation settings and budgets -------------------------------------------------

describe('organisation settings', () => {
  it('any member reads the settings; only admins change them', async () => {
    const mine = await dev.get('/api/org');
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({ id: orgId, name: 'adm', slug: 'adm', monthlyBudgetUsd: null, canManage: false });
    expect((await admin.get('/api/org')).json().canManage).toBe(true);

    expect((await dev.patch('/api/org', { name: 'Hacked' })).statusCode).toBe(403);
    const res = await admin.patch('/api/org', { name: 'Admin Co', monthlyBudgetUsd: 25.555 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Admin Co', monthlyBudgetUsd: 25.56 });
    expect((await dev.get('/api/auth/me')).json().org.name).toBe('Admin Co');

    // Clearing the default leaves the name alone.
    expect((await admin.patch('/api/org', { monthlyBudgetUsd: null })).json()).toMatchObject({ name: 'Admin Co', monthlyBudgetUsd: null });
    const [logged] = (await admin.get('/api/audit?action=org.updated&limit=1')).json() as Row[];
    expect(logged!.details).toEqual({ monthlyBudgetUsd: null });
  });

  it('validates changes', async () => {
    for (const body of [{}, { name: '' }, { monthlyBudgetUsd: -1 }, { monthlyBudgetUsd: 'ten' }, { monthlyBudgetUsd: 2_000_000 }, { slug: 'x' }]) {
      expect((await admin.patch('/api/org', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('per-developer budgets', () => {
  it('are admin-only', async () => {
    expect((await dev.get('/api/org/budgets')).statusCode).toBe(403);
    expect((await dev.get(`/api/org/budgets/${devId}`)).statusCode).toBe(403);
    expect((await put(dev, `/api/org/budgets/${devId}`, { monthlyBudgetUsd: 1000 })).statusCode).toBe(403);
  });

  it('sets, reports and clears an override over the organisation default', async () => {
    await admin.patch('/api/org', { monthlyBudgetUsd: 50 });
    let res = await admin.get(`/api/org/budgets/${devId}`);
    expect(res.json()).toMatchObject({ userId: devId, email: 'dev@adm.test', overrideUsd: null, defaultUsd: 50, limitUsd: 50, spentUsd: 0, allowed: true, month: monthBounds().month });

    res = await put(admin, `/api/org/budgets/${devId}`, { monthlyBudgetUsd: 12.5 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ overrideUsd: 12.5, defaultUsd: 50, limitUsd: 12.5 });

    const list = (await admin.get('/api/org/budgets')).json();
    expect(list.defaultUsd).toBe(50);
    expect(list.users.find((u: { userId: string }) => u.userId === devId)).toMatchObject({ overrideUsd: 12.5, limitUsd: 12.5, spentUsd: 0, allowed: true });
    expect(list.users.find((u: { userId: string }) => u.userId === adminId)).toMatchObject({ overrideUsd: null, limitUsd: 50 });

    expect((await dev.get('/api/me/budget')).json()).toMatchObject({ limitUsd: 12.5, overrideUsd: 12.5, defaultUsd: 50 });

    res = await put(admin, `/api/org/budgets/${devId}`, { monthlyBudgetUsd: null });
    expect(res.json()).toMatchObject({ overrideUsd: null, limitUsd: 50 });
    const logged = (await admin.get(`/api/audit?action=budget.&limit=2`)).json() as Row[];
    expect(actions(logged)).toEqual(['budget.cleared', 'budget.set']);
    await admin.patch('/api/org', { monthlyBudgetUsd: null });
  });

  it('validates the user and the amount', async () => {
    expect((await put(admin, '/api/org/budgets/77777777-7777-4777-8777-777777777777', { monthlyBudgetUsd: 5 })).statusCode).toBe(404);
    expect((await admin.get('/api/org/budgets/77777777-7777-4777-8777-777777777777')).statusCode).toBe(404);
    expect((await put(admin, '/api/org/budgets/nope', { monthlyBudgetUsd: 5 })).statusCode).toBe(400);
    for (const body of [{}, { monthlyBudgetUsd: -0.01 }, { monthlyBudgetUsd: '5' }, { monthlyBudgetUsd: 5, extra: 1 }]) {
      expect((await put(admin, `/api/org/budgets/${devId}`, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("cannot see or set budgets of another organisation's users", async () => {
    const other = await seedOrg(env.db, 'otherorg');
    const [otherAdmin] = await env.db.system((q) => q.query<{ id: string }>('SELECT id FROM users WHERE org_id = $1', [other.orgId]));
    expect((await admin.get(`/api/org/budgets/${otherAdmin!.id}`)).statusCode).toBe(404);
    expect((await put(admin, `/api/org/budgets/${otherAdmin!.id}`, { monthlyBudgetUsd: 1 })).statusCode).toBe(404);
  });
});

describe('checkMonthlyBudget', () => {
  const NOW = new Date('2026-04-15T12:00:00Z');
  let otherId: string;

  beforeAll(async () => {
    otherId = (await admin.post('/api/users', { email: 'other@adm.test', displayName: 'Other', password: PASSWORD })).json().id;
    await env.db.system(async (q) => {
      const [c] = await q.query<{ id: string }>(`INSERT INTO clients (org_id, name, slug) VALUES ($1, 'Budget', 'budget') RETURNING id`, [orgId]);
      const [a] = await q.query<{ id: string }>(`INSERT INTO applications (org_id, client_id, name, slug) VALUES ($1, $2, 'B', 'b') RETURNING id`, [orgId, c!.id]);
      const [e] = await q.query<{ id: string }>(`INSERT INTO environments (org_id, application_id, name, kind) VALUES ($1, $2, 'development', 'development') RETURNING id`, [orgId, a!.id]);
      const [r] = await q.query<{ id: string }>(`INSERT INTO repositories (org_id, application_id, provider, owner, name) VALUES ($1, $2, 'github', 'o', 'b') RETURNING id`, [orgId, a!.id]);
      const [w] = await q.query<{ id: string }>(
        `INSERT INTO workspaces (org_id, application_id, environment_id, repository_id, owner_id, branch, base_branch, state)
         VALUES ($1, $2, $3, $4, $5, 'f', 'main', 'ready') RETURNING id`,
        [orgId, a!.id, e!.id, r!.id, devId],
      );
      const session = (userId: string, cost: number, at: string) =>
        q.query(
          `INSERT INTO agent_sessions (org_id, workspace_id, user_id, model, auth_mode, cost_usd, created_at, updated_at)
           VALUES ($1, $2, $3, 'm', 'api_key', $4, $5, $5)`,
          [orgId, w!.id, userId, cost, at],
        );
      await session(devId, 100, '2026-03-31T23:59:59.999Z'); // last month
      await session(devId, 2.25, '2026-04-01T00:00:00Z'); // first instant of the month
      await session(devId, 0.123456, '2026-04-10T09:00:00Z');
      await session(devId, 5.126544, '2026-04-30T23:59:59.999Z'); // last instant of the month
      await session(devId, 40, '2026-05-01T00:00:00Z'); // next month
      await session(otherId, 9, '2026-04-12T00:00:00Z'); // someone else
    });
  });

  const check = (userId = devId) => env.db.tenant(orgId, (q) => checkMonthlyBudget(q, orgId, userId, NOW));
  const setDefault = (v: number | null) => env.db.system((q) => q.query('UPDATE organizations SET monthly_budget_usd = $2 WHERE id = $1', [orgId, v]));
  const setOverride = (v: number | null) =>
    env.db.system((q) =>
      v === null
        ? q.query('DELETE FROM user_budgets WHERE user_id = $1', [devId])
        : q.query(
            `INSERT INTO user_budgets (user_id, org_id, monthly_budget_usd) VALUES ($1, $2, $3)
             ON CONFLICT (user_id) DO UPDATE SET monthly_budget_usd = EXCLUDED.monthly_budget_usd`,
            [devId, orgId, v],
          ),
    );

  it('sums only this UTC calendar month for this developer', async () => {
    expect(await check()).toEqual({ limitUsd: null, spentUsd: 7.5, allowed: true });
    expect(await check(otherId)).toEqual({ limitUsd: null, spentUsd: 9, allowed: true });
    expect(monthBounds(NOW)).toEqual({ start: new Date('2026-04-01T00:00:00Z'), end: new Date('2026-05-01T00:00:00Z'), month: '2026-04' });
    expect(monthBounds(new Date('2026-12-31T23:59:59Z')).end).toEqual(new Date('2027-01-01T00:00:00Z'));
  });

  it('uses the organisation default, then the override, and blocks once spend reaches the limit', async () => {
    await setDefault(10);
    expect(await check()).toEqual({ limitUsd: 10, spentUsd: 7.5, allowed: true });
    expect(await check(otherId)).toEqual({ limitUsd: 10, spentUsd: 9, allowed: true });

    await setOverride(7.5);
    expect(await check()).toEqual({ limitUsd: 7.5, spentUsd: 7.5, allowed: false });
    await setOverride(7.51);
    expect((await check()).allowed).toBe(true);
    await setOverride(0);
    expect(await check()).toEqual({ limitUsd: 0, spentUsd: 7.5, allowed: false });

    // An override above the default wins too.
    await setOverride(500);
    expect((await check()).limitUsd).toBe(500);
    await setOverride(null);
    await setDefault(null);
    expect((await check()).limitUsd).toBeNull();
  });

  it('runs under row-level security: another org sees nothing', async () => {
    const other = await seedOrg(env.db, 'rlsorg');
    const res = await env.db.tenant(other.orgId, (q) => checkMonthlyBudget(q, orgId, devId, NOW));
    expect(res).toEqual({ limitUsd: null, spentUsd: 0, allowed: true });
  });
});
