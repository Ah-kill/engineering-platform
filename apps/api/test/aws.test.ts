import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openPglite, type Database } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/http/app.js';
import { Vault } from '../src/vault/vault.js';
import { awsSecretValues, issueAwsEnv, issueAwsEnvForRun, sessionNameFor } from '../src/aws/aws.js';
import { setStsClient, stsError, type AssumeRoleParams, type AwsTemporaryCredentials, type StsClient } from '../src/aws/sts.js';
import { Client, PASSWORD, seedOrg, WEB_ORIGIN } from './helpers.js';

/**
 * AWS access broker, with a fake STS (no AWS calls). Scenario: org "awsco", one application
 * with development/staging/production. dev = developer, lead = app_admin, viewer = viewer,
 * all on the application. Production is protected.
 */

const ROLE = 'arn:aws:iam::123456789012:role/EngineeringPlatformReadOnly';
const EXTERNAL_ID = 'ep-ext-0123456789abcdef-SECRET';

class FakeSts implements StsClient {
  assumed: AssumeRoleParams[] = [];
  identities: { creds: AwsTemporaryCredentials; region: string }[] = [];
  assumeError: unknown;
  identityError: unknown;
  issued: AwsTemporaryCredentials[] = [];

  async assumeRole(p: AssumeRoleParams): Promise<AwsTemporaryCredentials> {
    this.assumed.push(p);
    if (this.assumeError) throw this.assumeError;
    const n = this.issued.length;
    const creds = {
      accessKeyId: `ASIAFAKEKEY${n}`,
      secretAccessKey: `fake-secret-access-key-${n}`,
      sessionToken: `fake-session-token-${n}`,
      expiration: new Date(Date.now() + p.durationSeconds * 1000),
    };
    this.issued.push(creds);
    return creds;
  }

  async getCallerIdentity(creds: AwsTemporaryCredentials, region: string) {
    this.identities.push({ creds, region });
    if (this.identityError) throw this.identityError;
    return { account: '123456789012', arn: 'arn:aws:sts::123456789012:assumed-role/EngineeringPlatformReadOnly/ep-test' };
  }

  reset() {
    this.assumed = [];
    this.identities = [];
    this.assumeError = undefined;
    this.identityError = undefined;
  }
}

const awsError = (name: string, message = name) => Object.assign(new Error(message), { name });

let app: FastifyInstance;
let db: Database;
let vault: Vault;
let workspacesDir: string;
const sts = new FakeSts();

let orgId: string;
let admin: Client;
let dev: Client;
let lead: Client;
let viewer: Client;
let devUserId: string;
let viewerUserId: string;
let devEnvId: string;
let stagingEnvId: string;
let prodEnvId: string;
let workspaceId: string;

const put = (c: Client, envId: string, body: unknown) => c.request('PUT', `/api/environments/${envId}/aws`, body);
const good = (extra: Record<string, unknown> = {}) => ({ roleArn: ROLE, externalId: EXTERNAL_ID, region: 'eu-west-1', sessionSeconds: 3600, access: 'read', ...extra });

beforeAll(async () => {
  // Like helpers.setup(), but keeps the vault so the broker can be called directly.
  db = await openPglite();
  await migrate(db);
  vault = Vault.fromKey(randomBytes(32).toString('base64'));
  workspacesDir = await mkdtemp(path.join(os.tmpdir(), 'ep-aws-'));
  app = await buildApp({ config: loadConfig({ WEB_ORIGIN, LOG_LEVEL: 'silent' }), db, vault, workspacesDir });
  setStsClient(sts);

  const seeded = await seedOrg(db, 'awsco');
  orgId = seeded.orgId;
  admin = await Client.login(app, seeded.adminEmail);
  const clientId = (await admin.post('/api/clients', { name: 'AWS Client' })).json().id;
  const created = await admin.post(`/api/clients/${clientId}/applications`, { name: 'Billing' });
  expect(created.statusCode).toBe(201);
  const appId = created.json().id as string;
  const envs = created.json().environments as { id: string; kind: string }[];
  devEnvId = envs.find((e) => e.kind === 'development')!.id;
  stagingEnvId = envs.find((e) => e.kind === 'staging')!.id;
  prodEnvId = envs.find((e) => e.kind === 'production')!.id;

  const ids: Record<string, string> = {};
  for (const [email, role] of [['dev@awsco.test', 'developer'], ['lead@awsco.test', 'app_admin'], ['viewer@awsco.test', 'viewer']] as const) {
    const r = await admin.post('/api/users', { email, displayName: email, password: PASSWORD });
    expect(r.statusCode).toBe(201);
    ids[email] = r.json().id;
    expect((await admin.post('/api/grants', { userId: ids[email], role, scopeType: 'application', scopeId: appId })).statusCode).toBe(201);
  }
  devUserId = ids['dev@awsco.test']!;
  viewerUserId = ids['viewer@awsco.test']!;
  dev = await Client.login(app, 'dev@awsco.test');
  lead = await Client.login(app, 'lead@awsco.test');
  viewer = await Client.login(app, 'viewer@awsco.test');

  workspaceId = await db.system(async (q) => {
    const [repo] = await q.query<{ id: string }>(
      `INSERT INTO repositories (org_id, application_id, provider, owner, name) VALUES ($1, $2, 'github', 'acme', 'billing') RETURNING id`,
      [orgId, appId],
    );
    const [ws] = await q.query<{ id: string }>(
      `INSERT INTO workspaces (org_id, application_id, environment_id, repository_id, owner_id, branch, base_branch, state)
       VALUES ($1, $2, $3, $4, $5, 'feature/x', 'main', 'ready') RETURNING id`,
      [orgId, appId, devEnvId, repo!.id, devUserId],
    );
    return ws!.id;
  });
});

afterAll(async () => {
  setStsClient(undefined);
  await app.close();
  await db.close();
  await rm(workspacesDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
});

beforeEach(() => sts.reset());

describe('validation', () => {
  it('rejects malformed ARNs, regions and session lengths', async () => {
    for (const roleArn of ['arn:aws:iam::12345:role/X', 'arn:aws:iam::123456789012:user/alice', 'arn:aws:s3:::bucket', 'role/X', 'arn:aws:iam::123456789012:role/']) {
      expect((await put(lead, devEnvId, good({ roleArn }))).statusCode, roleArn).toBe(400);
    }
    for (const region of ['EU-WEST-1', 'eu-west', 'euwest1', 'eu-west-1a', '']) {
      expect((await put(lead, devEnvId, good({ region }))).statusCode, region).toBe(400);
    }
    for (const sessionSeconds of [899, 43201, 1000.5, '3600']) {
      expect((await put(lead, devEnvId, good({ sessionSeconds }))).statusCode, String(sessionSeconds)).toBe(400);
    }
    expect((await put(lead, devEnvId, good({ access: 'admin' }))).statusCode).toBe(400);
    expect((await put(lead, devEnvId, good({ externalId: 'x' }))).statusCode).toBe(400);
    expect((await put(lead, devEnvId, good({ externalId: 'has spaces in it' }))).statusCode).toBe(400);
    // the role and region must be in the same partition
    expect((await put(lead, devEnvId, good({ roleArn: 'arn:aws-cn:iam::123456789012:role/R' }))).statusCode).toBe(400);
    expect((await put(lead, devEnvId, good({ roleArn: 'arn:aws-cn:iam::123456789012:role/R', region: 'cn-north-1' }))).statusCode).toBe(200);
  });

  it('never accepts AWS access keys through the API', async () => {
    const r = await put(lead, devEnvId, good({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'nope' }));
    expect(r.statusCode).toBe(400);
  });

  it('requires an ExternalId the first time', async () => {
    const r = await put(lead, stagingEnvId, { roleArn: ROLE, region: 'eu-west-1', sessionSeconds: 3600, access: 'read' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/ExternalId/);
  });

  it('accepts a valid configuration with paths in the role name', async () => {
    const r = await put(lead, devEnvId, good({ roleArn: 'arn:aws:iam::123456789012:role/platform/ReadOnly+x=y,z.@-1', sessionSeconds: 900, access: 'write' }));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ roleArn: 'arn:aws:iam::123456789012:role/platform/ReadOnly+x=y,z.@-1', region: 'eu-west-1', sessionSeconds: 900, access: 'write', externalIdSet: true });
  });
});

describe('permissions', () => {
  it('lets viewers read but not change', async () => {
    expect((await put(lead, devEnvId, good())).statusCode).toBe(200);
    expect((await viewer.get(`/api/environments/${devEnvId}/aws`)).statusCode).toBe(200);
    expect((await put(viewer, devEnvId, good())).statusCode).toBe(403);
    expect((await viewer.delete(`/api/environments/${devEnvId}/aws`)).statusCode).toBe(403);
    expect((await put(dev, devEnvId, good())).statusCode).toBe(403);
  });

  it('only an org admin can change a protected (production) environment', async () => {
    const byLead = await put(lead, prodEnvId, good());
    expect(byLead.statusCode).toBe(403);
    expect(byLead.json().error.message).toMatch(/org admin/);
    expect((await lead.delete(`/api/environments/${prodEnvId}/aws`)).statusCode).toBe(403);
    expect((await put(admin, prodEnvId, good({ access: 'write' }))).statusCode).toBe(200);
    expect((await lead.get(`/api/environments/${prodEnvId}/aws`)).json()).toMatchObject({ roleArn: ROLE, access: 'write' });
  });

  it('hides environments of other organizations', async () => {
    const { adminEmail } = await seedOrg(db, 'otherco');
    const other = await Client.login(app, adminEmail);
    expect((await other.get(`/api/environments/${devEnvId}/aws`)).statusCode).toBe(404);
    expect((await put(other, devEnvId, good())).statusCode).toBe(404);
  });

  it('writes audit events for changes without the ExternalId', async () => {
    await put(lead, devEnvId, good());
    const events = await db.system((q) => q.query<{ action: string; details: unknown }>(
      `SELECT action, details FROM audit_events WHERE environment_id = $1 AND action LIKE 'aws.config.%'`, [devEnvId]));
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(EXTERNAL_ID);
  });
});

describe('external id', () => {
  it('is never returned and is stored encrypted', async () => {
    const saved = await put(lead, devEnvId, good());
    expect(saved.body).not.toContain(EXTERNAL_ID);
    const got = await dev.get(`/api/environments/${devEnvId}/aws`);
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual({ roleArn: ROLE, region: 'eu-west-1', sessionSeconds: 3600, access: 'read', externalIdSet: true, hint: '…CRET' });
    expect(got.body).not.toContain(EXTERNAL_ID);

    const [row] = await db.system((q) => q.query<{ aws_external_id: string }>('SELECT aws_external_id FROM environments WHERE id = $1', [devEnvId]));
    expect(row!.aws_external_id).not.toContain(EXTERNAL_ID);
    expect(row!.aws_external_id).toMatch(/^v1\./);
    expect(vault.decrypt(row!.aws_external_id)).toBe(EXTERNAL_ID);
  });

  it('is kept when an update omits it, and cleared by DELETE', async () => {
    await put(lead, devEnvId, good());
    const r = await put(lead, devEnvId, { roleArn: ROLE, region: 'us-east-1', sessionSeconds: 7200, access: 'read' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ region: 'us-east-1', sessionSeconds: 7200, externalIdSet: true });

    const cleared = await lead.delete(`/api/environments/${devEnvId}/aws`);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ roleArn: null, region: 'us-east-1', sessionSeconds: 3600, access: 'read', externalIdSet: false, hint: '' });
    const [row] = await db.system((q) => q.query<{ aws_external_id: string | null }>('SELECT aws_external_id FROM environments WHERE id = $1', [devEnvId]));
    expect(row!.aws_external_id).toBeNull();
  });
});

describe('connection test', () => {
  it('assumes the role for 900 s and returns the caller identity', async () => {
    await put(lead, devEnvId, good({ sessionSeconds: 7200 }));
    const r = await dev.post(`/api/environments/${devEnvId}/aws/test`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ account: '123456789012', arn: 'arn:aws:sts::123456789012:assumed-role/EngineeringPlatformReadOnly/ep-test' });
    expect(sts.assumed).toHaveLength(1);
    expect(sts.assumed[0]).toMatchObject({ roleArn: ROLE, externalId: EXTERNAL_ID, durationSeconds: 900, region: 'eu-west-1' });
    // GetCallerIdentity is signed with the temporary credentials, not the platform's own.
    expect(sts.identities[0]!.creds.sessionToken).toMatch(/^fake-session-token-/);
    expect(r.body).not.toMatch(/fake-secret|fake-session-token|ASIAFAKE/);
  });

  it('maps STS errors to clear messages', async () => {
    await put(lead, devEnvId, good());
    sts.assumeError = awsError('AccessDenied', 'User: arn:aws:iam::999999999999:user/platform is not authorized to perform: sts:AssumeRole');
    let r = await dev.post(`/api/environments/${devEnvId}/aws/test`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe('Access denied: check the role trust policy and ExternalId');

    sts.assumeError = awsError('ValidationError', 'The requested DurationSeconds exceeds the MaxSessionDuration set for this role.');
    r = await dev.post(`/api/environments/${devEnvId}/aws/test`);
    expect(r.json().error.message).toMatch(/maximum session duration/);

    sts.assumeError = awsError('CredentialsProviderError', 'Could not load credentials from any providers');
    r = await dev.post(`/api/environments/${devEnvId}/aws/test`);
    expect(r.statusCode).toBe(503);
    expect(r.json().error.message).toMatch(/no AWS credentials configured/);

    sts.assumeError = undefined;
    sts.identityError = awsError('ExpiredTokenException');
    r = await dev.post(`/api/environments/${devEnvId}/aws/test`);
    expect(r.statusCode).toBe(503);

    expect(stsError(awsError('ENOTFOUND'), 'eu-west-1').message).toMatch(/Could not reach AWS STS in eu-west-1/);
    expect(stsError(new Error('weird'), 'eu-west-1').statusCode).toBe(502);
  });

  it('reports a missing role clearly', async () => {
    await lead.delete(`/api/environments/${stagingEnvId}/aws`);
    const r = await dev.post(`/api/environments/${stagingEnvId}/aws/test`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/No AWS role/);
    expect(sts.assumed).toHaveLength(0);
  });

  it('needs environment.use', async () => {
    await put(lead, devEnvId, good());
    expect((await viewer.post(`/api/environments/${devEnvId}/aws/test`)).statusCode).toBe(403);
    // Org admins manage configuration but get no implicit working access.
    expect((await admin.post(`/api/environments/${devEnvId}/aws/test`)).statusCode).toBe(403);
    // Production needs a grant on that exact environment, even for the app admin.
    await put(admin, prodEnvId, good());
    expect((await lead.post(`/api/environments/${prodEnvId}/aws/test`)).statusCode).toBe(403);
    expect(sts.assumed).toHaveLength(0);
  });
});

describe('issueAwsEnv', () => {
  it('returns AWS_* variables using the ExternalId, duration and a valid session name, and audits without keys', async () => {
    await put(lead, devEnvId, good({ sessionSeconds: 5400 }));
    const env = await db.tenant(orgId, (q) => issueAwsEnv(q, vault, sts, { environmentId: devEnvId, userId: devUserId, workspaceId }));
    expect(env).not.toBeNull();
    expect(Object.keys(env!).sort()).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_DEFAULT_REGION', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']);
    expect(env!.AWS_REGION).toBe('eu-west-1');
    expect(env!.AWS_DEFAULT_REGION).toBe('eu-west-1');
    expect(env!.AWS_ACCESS_KEY_ID).toMatch(/^ASIAFAKEKEY/);
    expect(awsSecretValues(env)).toEqual([env!.AWS_SECRET_ACCESS_KEY, env!.AWS_SESSION_TOKEN]);

    const call = sts.assumed[0]!;
    expect(call).toMatchObject({ roleArn: ROLE, externalId: EXTERNAL_ID, durationSeconds: 5400, region: 'eu-west-1' });
    expect(call.sessionName).toBe(`ep-${devUserId.replace(/-/g, '').slice(0, 8)}-${workspaceId.replace(/-/g, '').slice(0, 8)}`);
    expect(call.sessionName).toMatch(/^[\w+=,.@-]{2,64}$/);

    const [event] = await db.system((q) => q.query<{ actor_id: string; outcome: string; details: Record<string, unknown> }>(
      `SELECT actor_id, outcome, details FROM audit_events WHERE action = 'aws.credentials.issued' ORDER BY occurred_at DESC LIMIT 1`));
    expect(event).toMatchObject({ actor_id: devUserId, outcome: 'success' });
    expect(event!.details).toMatchObject({ roleArn: ROLE, sessionName: call.sessionName, durationSeconds: 5400, workspaceId });
    expect(typeof event!.details.expiresAt).toBe('string');
    const text = JSON.stringify(event);
    for (const secret of [env!.AWS_ACCESS_KEY_ID, env!.AWS_SECRET_ACCESS_KEY, env!.AWS_SESSION_TOKEN, EXTERNAL_ID]) {
      expect(text).not.toContain(secret);
    }
  });

  it('returns null when no role is configured', async () => {
    await lead.delete(`/api/environments/${devEnvId}/aws`);
    const env = await db.tenant(orgId, (q) => issueAwsEnv(q, vault, sts, { environmentId: devEnvId, userId: devUserId, workspaceId }));
    expect(env).toBeNull();
    expect(sts.assumed).toHaveLength(0);
  });

  it('refuses a user without environment.use, and a workspace from another environment', async () => {
    await put(lead, devEnvId, good());
    await expect(db.tenant(orgId, (q) => issueAwsEnv(q, vault, sts, { environmentId: devEnvId, userId: viewerUserId, workspaceId })))
      .rejects.toMatchObject({ statusCode: 403 });
    await put(lead, stagingEnvId, good());
    await expect(db.tenant(orgId, (q) => issueAwsEnv(q, vault, sts, { environmentId: stagingEnvId, userId: devUserId, workspaceId })))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(sts.assumed).toHaveLength(0);
  });

  it('issueAwsEnvForRun works outside a transaction and audits failures', async () => {
    await put(lead, devEnvId, good());
    const env = await issueAwsEnvForRun(db, orgId, vault, sts, { environmentId: devEnvId, userId: devUserId, workspaceId });
    expect(env?.AWS_SESSION_TOKEN).toMatch(/^fake-session-token-/);

    sts.assumeError = awsError('AccessDenied');
    await expect(issueAwsEnvForRun(db, orgId, vault, sts, { environmentId: devEnvId, userId: devUserId, workspaceId }))
      .rejects.toMatchObject({ statusCode: 400, message: 'Access denied: check the role trust policy and ExternalId' });
    const [failed] = await db.system((q) => q.query<{ outcome: string }>(
      `SELECT outcome FROM audit_events WHERE action = 'aws.credentials.issued' ORDER BY occurred_at DESC LIMIT 1`));
    expect(failed!.outcome).toBe('failure');

    await expect(issueAwsEnvForRun(db, orgId, vault, sts, { environmentId: devEnvId, userId: viewerUserId, workspaceId }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('builds valid session names', () => {
    expect(sessionNameFor('0a1b2c3d-0000-0000-0000-000000000000', 'ffeeddcc-1111-1111-1111-111111111111')).toBe('ep-0a1b2c3d-ffeeddcc');
    expect(sessionNameFor('0a1b2c3d-0000-0000-0000-000000000000')).toBe('ep-0a1b2c3d-test');
  });
});
