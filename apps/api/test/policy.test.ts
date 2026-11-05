import { describe, expect, it } from 'vitest';
import { decide, type GrantRow, type ResourceChain } from '../src/access/policy.js';

const dev = { userId: 'u1', isOrgAdmin: false };
const admin = { userId: 'a1', isOrgAdmin: true };

const client: ResourceChain = { clientId: 'c1' };
const app: ResourceChain = { clientId: 'c1', applicationId: 'app1' };
const otherApp: ResourceChain = { clientId: 'c1', applicationId: 'app2' };
const devEnv: ResourceChain = { clientId: 'c1', applicationId: 'app1', environmentId: 'e-dev', protected: false };
const prodEnv: ResourceChain = { clientId: 'c1', applicationId: 'app1', environmentId: 'e-prod', protected: true };

const g = (role: GrantRow['role'], scopeType: GrantRow['scopeType'], scopeId: string, expiresAt?: Date): GrantRow => ({
  role, scopeType, scopeId, expiresAt: expiresAt ?? null,
});

describe('decide', () => {
  it('denies by default', () => {
    expect(decide(dev, 'application.view', app, [])).toBe(false);
  });

  it('application grant covers the app and its environments but not siblings or the client', () => {
    const grants = [g('developer', 'application', 'app1')];
    expect(decide(dev, 'application.view', app, grants)).toBe(true);
    expect(decide(dev, 'environment.use', devEnv, grants)).toBe(true);
    expect(decide(dev, 'application.view', otherApp, grants)).toBe(false);
    expect(decide(dev, 'client.view', client, grants)).toBe(false);
  });

  it('client grant flows down to applications', () => {
    expect(decide(dev, 'application.view', otherApp, [g('viewer', 'client', 'c1')])).toBe(true);
  });

  it('environment grant does not flow up to the application', () => {
    expect(decide(dev, 'application.view', app, [g('developer', 'environment', 'e-dev')])).toBe(false);
  });

  it('protected environment needs an exact environment grant for environment.use', () => {
    expect(decide(dev, 'environment.use', prodEnv, [g('developer', 'application', 'app1')])).toBe(false);
    expect(decide(dev, 'environment.use', prodEnv, [g('developer', 'client', 'c1')])).toBe(false);
    expect(decide(dev, 'environment.use', prodEnv, [g('developer', 'environment', 'e-prod')])).toBe(true);
    // Viewing is still covered by the broader grant.
    expect(decide(dev, 'environment.view', prodEnv, [g('developer', 'application', 'app1')])).toBe(true);
  });

  it('org admin manages metadata but has no implicit working access', () => {
    expect(decide(admin, 'client.create', null, [])).toBe(true);
    expect(decide(admin, 'grant.manage', prodEnv, [])).toBe(true);
    expect(decide(admin, 'environment.use', devEnv, [])).toBe(false);
  });

  it('org-only permissions are never granted through resource grants', () => {
    expect(decide(dev, 'client.create', null, [g('app_admin', 'client', 'c1')])).toBe(false);
    expect(decide(dev, 'client.update', client, [g('app_admin', 'client', 'c1')])).toBe(false);
  });

  it('role bundles are respected', () => {
    expect(decide(dev, 'environment.use', devEnv, [g('viewer', 'application', 'app1')])).toBe(false);
    expect(decide(dev, 'grant.manage', app, [g('developer', 'application', 'app1')])).toBe(false);
    expect(decide(dev, 'grant.manage', app, [g('app_admin', 'application', 'app1')])).toBe(true);
    expect(decide(dev, 'application.create', client, [g('app_creator', 'client', 'c1')])).toBe(true);
    expect(decide(dev, 'application.view', app, [g('app_creator', 'client', 'c1')])).toBe(false);
  });

  it('expired grants are ignored', () => {
    const past = new Date(Date.now() - 1000);
    expect(decide(dev, 'application.view', app, [g('viewer', 'application', 'app1', past)])).toBe(false);
  });
});
