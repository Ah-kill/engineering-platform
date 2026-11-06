import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../access/authorize.js';
import { audit } from '../audit/audit.js';
import type { Queryable } from '../db/db.js';
import { caller, type RouteDeps } from '../http/app.js';
import { HttpError } from '../http/errors.js';
import type { AuthUser } from '../identity/sessions.js';
import { principalOf } from '../identity/user-routes.js';
import {
  assumeForPlan,
  clearAwsConfig,
  DEFAULT_SESSION_SECONDS,
  EXTERNAL_ID_RE,
  MAX_SESSION_SECONDS,
  MIN_SESSION_SECONDS,
  prepareAwsIssue,
  readAwsConfig,
  REGION_RE,
  ROLE_ARN_RE,
  saveAwsConfig,
  TEST_SESSION_SECONDS,
  type AwsIssuePlan,
} from './aws.js';
import { getStsClient, stsError, type StsClient } from './sts.js';

const envParam = z.object({ id: z.string().uuid() });
const putBody = z
  .object({
    roleArn: z.string().trim().regex(ROLE_ARN_RE, 'Not an IAM role ARN, e.g. arn:aws:iam::123456789012:role/EngineeringPlatformReadOnly'),
    externalId: z.string().trim().regex(EXTERNAL_ID_RE, 'ExternalId must be 2-1224 characters: letters, digits and +=,.@:/-_').optional(),
    region: z.string().trim().regex(REGION_RE, 'Not a valid AWS region, e.g. eu-west-1'),
    sessionSeconds: z.number().int().min(MIN_SESSION_SECONDS).max(MAX_SESSION_SECONDS).default(DEFAULT_SESSION_SECONDS),
    access: z.enum(['read', 'write']).default('read'),
  })
  .strict(); // rejects anything else, in particular AWS access keys

/**
 * Changing AWS access needs `environment.manage`. On a protected (production) environment
 * only org admins may change it, matching who may grant production access.
 */
async function requireManage(q: Queryable, user: AuthUser, environmentId: string) {
  const chain = await requirePermission(q, principalOf(user), 'environment.manage', { type: 'environment', id: environmentId });
  if (chain && 'protected' in chain && chain.protected && !user.isOrgAdmin) {
    throw HttpError.forbidden('Only an org admin can change AWS access of a protected environment');
  }
  return chain as { clientId: string; applicationId: string; environmentId: string; protected: boolean };
}

/**
 * GET/PUT/DELETE /environments/:id/aws and POST /environments/:id/aws/test.
 * STS is resolved per request: the `sts` argument, then `deps.sts`, then `setStsClient()`, then the real SDK.
 */
export async function awsRoutes(app: FastifyInstance, deps: RouteDeps, sts?: StsClient) {
  const { db, vault } = deps;
  const stsClient = () => sts ?? (deps as RouteDeps & { sts?: StsClient }).sts ?? getStsClient();

  app.get('/environments/:id/aws', async (req) => {
    const { user } = caller(req);
    const { id } = envParam.parse(req.params);
    return db.tenant(user.orgId, async (q) => {
      await requirePermission(q, principalOf(user), 'environment.view', { type: 'environment', id });
      return readAwsConfig(q, id);
    });
  });

  app.put('/environments/:id/aws', async (req) => {
    const { user } = caller(req);
    const { id } = envParam.parse(req.params);
    const body = putBody.parse(req.body);
    return db.tenant(user.orgId, async (q) => {
      const chain = await requireManage(q, user, id);
      const view = await saveAwsConfig(q, vault, id, body);
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'aws.config.updated', resourceType: 'environment', resourceId: id,
        clientId: chain.clientId, applicationId: chain.applicationId, environmentId: id,
        // never the ExternalId itself
        details: { roleArn: body.roleArn, region: body.region, sessionSeconds: body.sessionSeconds, access: body.access, externalIdChanged: body.externalId !== undefined },
      });
      return view;
    });
  });

  app.delete('/environments/:id/aws', async (req) => {
    const { user } = caller(req);
    const { id } = envParam.parse(req.params);
    return db.tenant(user.orgId, async (q) => {
      const chain = await requireManage(q, user, id);
      const view = await clearAwsConfig(q, id);
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'aws.config.cleared', resourceType: 'environment', resourceId: id,
        clientId: chain.clientId, applicationId: chain.applicationId, environmentId: id,
      });
      return view;
    });
  });

  app.post('/environments/:id/aws/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { user } = caller(req);
    const { id } = envParam.parse(req.params);
    // Short transaction for access and config; no transaction is held during the STS calls.
    const plan = await db.tenant(user.orgId, async (q) => {
      const p = await prepareAwsIssue(q, vault, { environmentId: id, userId: user.id, isOrgAdmin: user.isOrgAdmin }, { durationSeconds: TEST_SESSION_SECONDS });
      if (!p) throw HttpError.badRequest('No AWS role is configured for this environment');
      return p;
    });
    const record = (outcome: 'success' | 'failure', details: Record<string, unknown>) =>
      db.tenant(user.orgId, (q) => audit(q, testAudit(plan, outcome, details)));

    let result: { account: string; arn: string };
    try {
      const creds = await assumeForPlan(stsClient(), plan);
      try {
        result = await stsClient().getCallerIdentity(creds, plan.params.region);
      } catch (err) {
        throw stsError(err, plan.params.region);
      }
    } catch (err) {
      await record('failure', { error: (err as Error).message }).catch(() => undefined);
      throw err;
    }
    await record('success', { account: result.account, arn: result.arn });
    return { account: result.account, arn: result.arn };
  });
}

function testAudit(plan: AwsIssuePlan, outcome: 'success' | 'failure', details: Record<string, unknown>) {
  return {
    orgId: plan.orgId, actorId: plan.userId, action: 'aws.connection.tested', resourceType: 'environment', resourceId: plan.environmentId,
    clientId: plan.clientId, applicationId: plan.applicationId, environmentId: plan.environmentId, outcome,
    details: { roleArn: plan.params.roleArn, sessionName: plan.params.sessionName, ...details },
  };
}
