import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, PASSWORD, seedOrg, setup, WEB_ORIGIN, type TestEnv } from './helpers.js';

/**
 * End-to-end through HTTP and real Postgres (embedded). Scenario:
 * org "acme" has client ABC with apps Payments and CRM.
 * dev  = developer on Payments only.
 * lead = app_admin on Payments.
 * A second org "other" must never see any of it.
 */
let env: TestEnv;
let admin: Client;
let dev: Client;
let lead: Client;
let clientId: string;
let paymentsId: string;
let crmId: string;
let devEnvId: string;
let prodEnvId: string;
let devUserId: string;
let leadUserId: string;

beforeAll(async () => {
  env = await setup();
  const { adminEmail } = await seedOrg(env.db, 'acme');
  admin = await Client.login(env.app, adminEmail);

  const c = await admin.post('/api/clients', { name: 'ABC Technologies' });
  expect(c.statusCode).toBe(201);
  clientId = c.json().id;

  const payments = await admin.post(`/api/clients/${clientId}/applications`, { name: 'Payment Service' });
  expect(payments.statusCode).toBe(201);
  paymentsId = payments.json().id;
  const envs = payments.json().environments as { id: string; kind: string; protected: boolean }[];
  devEnvId = envs.find((e) => e.kind === 'development')!.id;
  prodEnvId = envs.find((e) => e.kind === 'production')!.id;

  crmId = (await admin.post(`/api/clients/${clientId}/applications`, { name: 'CRM', origin: 'new' })).json().id;

  for (const [email, name] of [['dev@acme.test', 'Dev'], ['lead@acme.test', 'Lead']]) {
    const r = await admin.post('/api/users', { email, displayName: name, password: PASSWORD });
    expect(r.statusCode).toBe(201);
  }
  const users = (await admin.get('/api/users')).json() as { id: string; email: string }[];
  devUserId = users.find((u) => u.email === 'dev@acme.test')!.id;
  leadUserId = users.find((u) => u.email === 'lead@acme.test')!.id;

  expect((await admin.post('/api/grants', { userId: devUserId, role: 'developer', scopeType: 'application', scopeId: paymentsId })).statusCode).toBe(201);
  expect((await admin.post('/api/grants', { userId: leadUserId, role: 'app_admin', scopeType: 'application', scopeId: paymentsId })).statusCode).toBe(201);

  dev = await Client.login(env.app, 'dev@acme.test');
  lead = await Client.login(env.app, 'lead@acme.test');
});

afterAll(async () => {
  await env.close();
});

describe('authentication', () => {
  it('rejects unauthenticated requests but serves health', async () => {
    const anon = new Client(env.app);
    expect((await anon.get('/api/health')).statusCode).toBe(200);
    expect((await anon.get('/api/clients')).statusCode).toBe(401);
  });

  it('rejects a wrong password with a generic message', async () => {
    const r = await new Client(env.app).post('/api/auth/login', { email: 'dev@acme.test', password: 'wrong-password-123' });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.message).toBe('Invalid email or password');
  });

  it('sets an httpOnly, SameSite=Strict session cookie', async () => {
    const r = await new Client(env.app).post('/api/auth/login', { email: 'dev@acme.test', password: PASSWORD });
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('never returns password hashes', async () => {
    const me = await dev.get('/api/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.body).not.toMatch(/password|argon2/i);
    expect((await admin.get('/api/users')).body).not.toMatch(/password|argon2/i);
  });

  it('logout revokes the session', async () => {
    const tmp = await Client.login(env.app, 'dev@acme.test');
    expect((await tmp.post('/api/auth/logout')).statusCode).toBe(200);
    expect((await tmp.get('/api/auth/me')).statusCode).toBe(401);
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests without the custom header', async () => {
    const r = await env.app.inject({ method: 'POST', url: '/api/clients', payload: { name: 'X' }, headers: { origin: WEB_ORIGIN } });
    expect(r.statusCode).toBe(403);
  });

  it('rejects a foreign Origin', async () => {
    const r = await env.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: 'a@b.co', password: 'x' },
      headers: { origin: 'https://evil.example', 'x-requested-with': 'x' },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('application-level isolation', () => {
  it('developer sees the client and only the application they were granted', async () => {
    const clients = (await dev.get('/api/clients')).json() as { id: string }[];
    expect(clients.map((c) => c.id)).toEqual([clientId]);
    const apps = (await dev.get(`/api/clients/${clientId}/applications`)).json() as { id: string }[];
    expect(apps.map((a) => a.id)).toEqual([paymentsId]);
  });

  it('developer gets 404 (not 403) for an application they were not granted', async () => {
    expect((await dev.get(`/api/applications/${crmId}`)).statusCode).toBe(404);
    expect((await dev.get(`/api/grants?scopeType=application&scopeId=${crmId}`)).statusCode).toBe(404);
  });

  it('developer can use development but not protected production', async () => {
    const app = (await dev.get(`/api/applications/${paymentsId}`)).json() as {
      environments: { id: string; permissions: string[] }[];
    };
    const perms = (id: string) => app.environments.find((e) => e.id === id)!.permissions;
    expect(perms(devEnvId)).toContain('environment.use');
    expect(perms(prodEnvId)).not.toContain('environment.use');
    expect(perms(prodEnvId)).toContain('environment.view');
  });

  it('developer cannot administer', async () => {
    expect((await dev.post('/api/clients', { name: 'Nope' })).statusCode).toBe(403);
    expect((await dev.patch(`/api/applications/${paymentsId}`, { name: 'Renamed' })).statusCode).toBe(403);
    expect((await dev.post('/api/grants', { userId: devUserId, role: 'app_admin', scopeType: 'application', scopeId: paymentsId })).statusCode).toBe(403);
    expect((await dev.get('/api/users')).statusCode).toBe(403);
    expect((await dev.get('/api/audit')).statusCode).toBe(403);
  });

  it('org admin has no implicit working access to an environment', async () => {
    const app = (await admin.get(`/api/applications/${paymentsId}`)).json() as { environments: { id: string; permissions: string[] }[] };
    expect(app.environments.find((e) => e.id === devEnvId)!.permissions).not.toContain('environment.use');
  });
});

describe('production guardrails for app admins', () => {
  it('app admin can grant on development', async () => {
    const r = await lead.post('/api/grants', { userId: devUserId, role: 'viewer', scopeType: 'environment', scopeId: devEnvId });
    expect(r.statusCode).toBe(201);
  });

  it('app admin cannot grant production access, including to themselves', async () => {
    const r = await lead.post('/api/grants', { userId: leadUserId, role: 'developer', scopeType: 'environment', scopeId: prodEnvId });
    expect(r.statusCode).toBe(403);
  });

  it('app admin cannot remove production protection', async () => {
    expect((await lead.patch(`/api/environments/${prodEnvId}`, { protected: false })).statusCode).toBe(403);
  });

  it('app admin cannot create an unprotected production environment', async () => {
    const r = await lead.post(`/api/applications/${paymentsId}/environments`, { name: 'prod-2', kind: 'production', protected: false });
    expect(r.statusCode).toBe(403);
  });

  it('org admin can grant production access explicitly', async () => {
    const r = await admin.post('/api/grants', { userId: leadUserId, role: 'developer', scopeType: 'environment', scopeId: prodEnvId });
    expect(r.statusCode).toBe(201);
  });

  it('app admin cannot revoke production access either', async () => {
    const grants = (await admin.get(`/api/grants?scopeType=environment&scopeId=${prodEnvId}`)).json() as { id: string; scopeType: string }[];
    const prodGrant = grants.find((g) => g.scopeType === 'environment')!;
    expect((await lead.delete(`/api/grants/${prodGrant.id}`)).statusCode).toBe(403);
  });
});

describe('membership visibility', () => {
  it('a user with access to one environment cannot list who has access to the whole application', async () => {
    await admin.post('/api/users', { email: 'envonly@acme.test', displayName: 'Env Only', password: PASSWORD });
    const users = (await admin.get('/api/users')).json() as { id: string; email: string }[];
    const envOnlyId = users.find((u) => u.email === 'envonly@acme.test')!.id;
    await admin.post('/api/grants', { userId: envOnlyId, role: 'developer', scopeType: 'environment', scopeId: devEnvId });
    const envOnly = await Client.login(env.app, 'envonly@acme.test');

    // Can still navigate to the application...
    expect((await envOnly.get(`/api/applications/${paymentsId}`)).statusCode).toBe(200);
    // ...but cannot enumerate its members or the client's members.
    expect((await envOnly.get(`/api/grants?scopeType=application&scopeId=${paymentsId}`)).statusCode).toBe(404);
    expect((await envOnly.get(`/api/grants?scopeType=client&scopeId=${clientId}`)).statusCode).toBe(404);
    // Members of their own environment are fine.
    expect((await envOnly.get(`/api/grants?scopeType=environment&scopeId=${devEnvId}`)).statusCode).toBe(200);
  });
});

describe('organization isolation', () => {
  it('another org sees nothing and gets 404 by id', async () => {
    const { adminEmail } = await seedOrg(env.db, 'other');
    const other = await Client.login(env.app, adminEmail);
    expect((await other.get('/api/clients')).json()).toEqual([]);
    expect((await other.get(`/api/clients/${clientId}`)).statusCode).toBe(404);
    expect((await other.get(`/api/applications/${paymentsId}`)).statusCode).toBe(404);
    expect((await other.post(`/api/clients/${clientId}/applications`, { name: 'Sneaky' })).statusCode).toBe(404);
    expect((await other.post('/api/grants', { userId: devUserId, role: 'viewer', scopeType: 'client', scopeId: clientId })).statusCode).toBe(404);
  });
});

describe('lifecycle and audit', () => {
  it('rejects duplicate slugs with 409', async () => {
    expect((await admin.post('/api/clients', { name: 'ABC Technologies' })).statusCode).toBe(409);
  });

  it('validates input', async () => {
    const r = await admin.post('/api/clients', { name: '' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_failed');
  });

  it('archived clients leave the default list', async () => {
    const id = (await admin.post('/api/clients', { name: 'Old Client' })).json().id;
    expect((await admin.post(`/api/clients/${id}/archive`)).statusCode).toBe(200);
    const active = (await admin.get('/api/clients')).json() as { id: string }[];
    expect(active.map((c) => c.id)).not.toContain(id);
    const archived = (await admin.get('/api/clients?archived=true')).json() as { id: string }[];
    expect(archived.map((c) => c.id)).toContain(id);
  });

  it('disabling a user ends their sessions', async () => {
    const r = await admin.post('/api/users', { email: 'temp@acme.test', displayName: 'Temp', password: PASSWORD });
    const temp = await Client.login(env.app, 'temp@acme.test');
    expect((await admin.patch(`/api/users/${r.json().id}`, { status: 'disabled' })).statusCode).toBe(200);
    expect((await temp.get('/api/auth/me')).statusCode).toBe(401);
  });

  it('records audit events without sensitive values', async () => {
    const events = (await admin.get('/api/audit?limit=200')).json() as { action: string; details: object }[];
    const actions = new Set(events.map((e) => e.action));
    for (const a of ['client.created', 'application.created', 'grant.created', 'user.created', 'auth.login']) {
      expect(actions).toContain(a);
    }
    expect(JSON.stringify(events)).not.toMatch(/correct-horse|argon2|password_hash/);
  });

  it('a non-admin creator becomes app admin of the new application', async () => {
    await admin.post('/api/grants', { userId: devUserId, role: 'app_creator', scopeType: 'client', scopeId: clientId });
    const r = await dev.post(`/api/clients/${clientId}/applications`, { name: 'Notifications', origin: 'new' });
    expect(r.statusCode).toBe(201);
    const app = (await dev.get(`/api/applications/${r.json().id}`)).json() as { permissions: string[] };
    expect(app.permissions).toContain('grant.manage');
  });
});
