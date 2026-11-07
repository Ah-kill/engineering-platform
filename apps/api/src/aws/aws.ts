import { requirePermission } from '../access/authorize.js';
import { audit } from '../audit/audit.js';
import type { Database, Queryable } from '../db/db.js';
import { HttpError } from '../http/errors.js';
import { hintFor, type Vault } from '../vault/vault.js';
import { stsError, type AssumeRoleParams, type AwsTemporaryCredentials, type StsClient } from './sts.js';

/**
 * Per-environment AWS access broker. Each environment may name one IAM role in the client's
 * account (deployed from infra/client-onboarding/readonly-role.yaml). The platform assumes it
 * with STS and hands out only short-lived credentials; no AWS access keys are ever accepted,
 * stored or returned. The ExternalId is stored encrypted and never leaves the server.
 */

export const ROLE_ARN_RE = /^arn:aws(-cn|-us-gov)?:iam::\d{12}:role\/[\w+=,.@\/-]{1,512}$/;
export const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
/** AWS's own constraint on sts:ExternalId. */
export const EXTERNAL_ID_RE = /^[\w+=,.@:\/-]{2,1224}$/;
export const MIN_SESSION_SECONDS = 900;
export const MAX_SESSION_SECONDS = 43_200;
export const DEFAULT_SESSION_SECONDS = 3600;
/** The connection test asks for the shortest session STS allows. */
export const TEST_SESSION_SECONDS = 900;

/** Environment variable names that hold credential material, for redaction lists. */
export const AWS_SECRET_ENV_NAMES = ['AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'] as const;

export type AwsAccess = 'read' | 'write';

export interface AwsConfigView {
  roleArn: string | null;
  region: string | null;
  sessionSeconds: number;
  access: AwsAccess;
  externalIdSet: boolean;
  /** Short hint of the stored ExternalId (like other secrets), '' when none. */
  hint: string;
}

export interface AwsConfigInput {
  roleArn: string;
  /** undefined keeps the stored ExternalId; a string replaces it. */
  externalId?: string;
  region: string;
  sessionSeconds: number;
  access: AwsAccess;
}

/** The ARN partition must match the region's partition (aws-cn ↔ cn-*, aws-us-gov ↔ us-gov-*). */
export function checkPartition(roleArn: string, region: string): void {
  const partition = /^arn:(aws(?:-cn|-us-gov)?):/.exec(roleArn)?.[1];
  const regionPartition = region.startsWith('cn-') ? 'aws-cn' : region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws';
  if (partition !== regionPartition) {
    throw HttpError.badRequest(`Region ${region} is not in the role's AWS partition (${partition})`);
  }
}

/** RoleSessionName: only [\w+=,.@-], 2-64 chars. Appears in the client's CloudTrail. */
export function sessionNameFor(userId: string, workspaceId?: string | null): string {
  const part = (s: string) => s.replace(/-/g, '').slice(0, 8).replace(/[^\w+=,.@-]/g, '');
  return `ep-${part(userId)}-${workspaceId ? part(workspaceId) : 'test'}`.slice(0, 64);
}

interface ConfigRow {
  org_id: string;
  aws_role_arn: string | null;
  aws_external_id: string | null;
  aws_external_id_hint: string;
  aws_region: string | null;
  aws_session_seconds: number;
  aws_access: AwsAccess;
}

async function loadRow(q: Queryable, environmentId: string): Promise<ConfigRow> {
  const [row] = await q.query<ConfigRow>(
    `SELECT org_id, aws_role_arn, aws_external_id, aws_external_id_hint, aws_region, aws_session_seconds, aws_access
       FROM environments WHERE id = $1`,
    [environmentId],
  );
  if (!row) throw HttpError.notFound();
  return row;
}

function toView(r: ConfigRow): AwsConfigView {
  return {
    roleArn: r.aws_role_arn,
    region: r.aws_region,
    sessionSeconds: r.aws_session_seconds,
    access: r.aws_access,
    externalIdSet: r.aws_external_id !== null,
    hint: r.aws_external_id !== null ? r.aws_external_id_hint : '',
  };
}

export async function readAwsConfig(q: Queryable, environmentId: string): Promise<AwsConfigView> {
  return toView(await loadRow(q, environmentId));
}

/** Validates and stores the configuration. The caller checks permissions and audits. */
export async function saveAwsConfig(q: Queryable, vault: Vault, environmentId: string, input: AwsConfigInput): Promise<AwsConfigView> {
  if (!ROLE_ARN_RE.test(input.roleArn)) throw HttpError.badRequest('Not an IAM role ARN');
  if (!REGION_RE.test(input.region)) throw HttpError.badRequest('Not a valid AWS region');
  if (!Number.isInteger(input.sessionSeconds) || input.sessionSeconds < MIN_SESSION_SECONDS || input.sessionSeconds > MAX_SESSION_SECONDS) {
    throw HttpError.badRequest('Session length must be between 900 and 43200 seconds');
  }
  checkPartition(input.roleArn, input.region);
  const current = await loadRow(q, environmentId);
  if (input.externalId !== undefined && !EXTERNAL_ID_RE.test(input.externalId)) {
    throw HttpError.badRequest('ExternalId must be 2-1224 characters: letters, digits and +=,.@:/-_');
  }
  if (input.externalId === undefined && current.aws_external_id === null) {
    // A role without an ExternalId condition is open to confused-deputy misuse; refuse to use one.
    throw HttpError.badRequest('ExternalId is required');
  }
  const replace = input.externalId !== undefined;
  await q.query(
    `UPDATE environments SET
        aws_role_arn = $2,
        aws_region = $3,
        aws_session_seconds = $4,
        aws_access = $5,
        aws_external_id = CASE WHEN $6 THEN $7 ELSE aws_external_id END,
        aws_external_id_hint = CASE WHEN $6 THEN $8 ELSE aws_external_id_hint END,
        updated_at = now()
      WHERE id = $1`,
    [
      environmentId,
      input.roleArn,
      input.region,
      input.sessionSeconds,
      input.access,
      replace,
      replace ? vault.encrypt(input.externalId!) : null,
      replace ? hintFor(input.externalId!) : '',
    ],
  );
  return readAwsConfig(q, environmentId);
}

/** Removes the role and ExternalId. The environment's region is kept; it is used elsewhere. */
export async function clearAwsConfig(q: Queryable, environmentId: string): Promise<AwsConfigView> {
  await q.query(
    `UPDATE environments SET aws_role_arn = NULL, aws_external_id = NULL, aws_external_id_hint = '',
        aws_session_seconds = ${DEFAULT_SESSION_SECONDS}, aws_access = 'read', updated_at = now()
      WHERE id = $1`,
    [environmentId],
  );
  return readAwsConfig(q, environmentId);
}

// ---- broker -----------------------------------------------------------------

export interface IssueInput {
  environmentId: string;
  userId: string;
  /** The workspace the credentials are for. Must belong to the environment. Omit for a connection test. */
  workspaceId?: string | null;
  /** Only changes 403 vs 404 for org admins: they never get implicit `environment.use`. */
  isOrgAdmin?: boolean;
}

/** Everything needed to call STS, resolved inside a transaction. Holds the decrypted ExternalId: server-side only. */
export interface AwsIssuePlan {
  orgId: string;
  clientId: string;
  applicationId: string;
  environmentId: string;
  userId: string;
  workspaceId: string | null;
  access: AwsAccess;
  params: AssumeRoleParams;
}

/**
 * Checks `environment.use` for the user, resolves the role and decrypts the ExternalId.
 * Returns null when the environment has no AWS role configured.
 */
export async function prepareAwsIssue(
  q: Queryable,
  vault: Vault,
  input: IssueInput,
  opts: { durationSeconds?: number } = {},
): Promise<AwsIssuePlan | null> {
  // Org admins get no implicit environment.use (see access/policy.ts); the flag only affects 403 vs 404.
  const chain = (await requirePermission(q, { userId: input.userId, isOrgAdmin: input.isOrgAdmin ?? false }, 'environment.use', {
    type: 'environment',
    id: input.environmentId,
  })) as { clientId: string; applicationId: string; environmentId: string };
  if (input.workspaceId) {
    const ws = await q.query('SELECT 1 FROM workspaces WHERE id = $1 AND environment_id = $2', [input.workspaceId, input.environmentId]);
    if (!ws.length) throw HttpError.badRequest('Workspace does not belong to this environment');
  }
  const row = await loadRow(q, input.environmentId);
  if (!row.aws_role_arn) return null;
  if (!row.aws_external_id) throw HttpError.badRequest('The AWS role of this environment has no ExternalId. Set one first.');
  if (!row.aws_region) throw HttpError.badRequest('The environment has no AWS region. Set one first.');
  return {
    orgId: row.org_id,
    clientId: chain.clientId,
    applicationId: chain.applicationId,
    environmentId: input.environmentId,
    userId: input.userId,
    workspaceId: input.workspaceId ?? null,
    access: row.aws_access,
    params: {
      roleArn: row.aws_role_arn,
      externalId: vault.decrypt(row.aws_external_id),
      sessionName: sessionNameFor(input.userId, input.workspaceId),
      durationSeconds: opts.durationSeconds ?? row.aws_session_seconds,
      region: row.aws_region,
    },
  };
}

/** Calls STS for a prepared plan. Maps SDK errors to readable HttpErrors. */
export async function assumeForPlan(sts: StsClient, plan: AwsIssuePlan): Promise<AwsTemporaryCredentials> {
  try {
    return await sts.assumeRole(plan.params);
  } catch (err) {
    throw stsError(err, plan.params.region);
  }
}

/** The environment variables the AWS CLI and SDKs read. */
export function awsEnvFrom(creds: AwsTemporaryCredentials, region: string): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    AWS_SESSION_TOKEN: creds.sessionToken,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
  };
}

/** Values to add to a redaction list (e.g. RunContext.appSecrets) so they never show in output. */
export function awsSecretValues(env: Record<string, string> | null): string[] {
  if (!env) return [];
  return AWS_SECRET_ENV_NAMES.map((k) => env[k]).filter((v): v is string => !!v);
}

async function auditIssue(q: Queryable, plan: AwsIssuePlan, outcome: { creds: AwsTemporaryCredentials } | { error: string }) {
  await audit(q, {
    orgId: plan.orgId,
    actorId: plan.userId,
    action: 'aws.credentials.issued',
    resourceType: 'environment',
    resourceId: plan.environmentId,
    clientId: plan.clientId,
    applicationId: plan.applicationId,
    environmentId: plan.environmentId,
    outcome: 'creds' in outcome ? 'success' : 'failure',
    // Never the keys, the session token or the ExternalId.
    details: {
      roleArn: plan.params.roleArn,
      sessionName: plan.params.sessionName,
      durationSeconds: plan.params.durationSeconds,
      access: plan.access,
      workspaceId: plan.workspaceId,
      ...('creds' in outcome ? { expiresAt: outcome.creds.expiration.toISOString() } : { error: outcome.error }),
    },
  });
}

/**
 * Assumes the environment's role for one user and workspace and returns AWS_* environment
 * variables, or null when no role is configured. Needs `environment.use`. Audits
 * `aws.credentials.issued` (role, session name, expiry; never the keys).
 *
 * Runs entirely inside the caller's transaction, including the STS network call. With the
 * embedded database a transaction blocks other requests, so prefer `issueAwsEnvForRun`
 * from request handlers.
 */
export async function issueAwsEnv(q: Queryable, vault: Vault, sts: StsClient, input: IssueInput): Promise<Record<string, string> | null> {
  const plan = await prepareAwsIssue(q, vault, input);
  if (!plan) return null;
  const creds = await assumeForPlan(sts, plan);
  await auditIssue(q, plan, { creds });
  return awsEnvFrom(creds, plan.params.region);
}

/**
 * Same as `issueAwsEnv`, but holds no database transaction during the STS call: one short
 * transaction to check access and read the role, the STS call, then one to audit. Failures
 * are audited (outcome 'failure') and rethrown as HttpErrors with a readable message.
 */
export async function issueAwsEnvForRun(
  db: Database,
  orgId: string,
  vault: Vault,
  sts: StsClient,
  input: IssueInput,
): Promise<Record<string, string> | null> {
  const plan = await db.tenant(orgId, (q) => prepareAwsIssue(q, vault, input));
  if (!plan) return null;
  let creds: AwsTemporaryCredentials;
  try {
    creds = await assumeForPlan(sts, plan);
  } catch (err) {
    await db.tenant(orgId, (q) => auditIssue(q, plan, { error: (err as Error).message })).catch(() => undefined);
    throw err;
  }
  await db.tenant(orgId, (q) => auditIssue(q, plan, { creds }));
  return awsEnvFrom(creds, plan.params.region);
}

/**
 * AWS endpoints opened in restricted network mode once credentials are issued: STS plus the
 * regional endpoints of services a read-only investigation typically uses, and IAM. No
 * wildcards: *.amazonaws.com would also allow S3 bucket hosts and Lambda/API Gateway URLs
 * in anyone's account, an easy way to carry data out. Other services can be added to the
 * application's allowed hosts explicitly. Residual risk: any allowed AWS API can still reach
 * another account's resources that grant public access; see docs/03-deployment.md.
 */
export const AWS_SERVICES = [
  'sts', 'logs', 'monitoring', 'lambda', 'apigateway', 'dynamodb', 'ecs', 'eks', 'ec2',
  'cloudformation', 'ssm', 'rds', 'elasticloadbalancing', 'events', 'states', 'tagging',
];

export function awsHostsFor(region: string): string[] {
  return ['sts.amazonaws.com', 'iam.amazonaws.com', ...AWS_SERVICES.map((svc) => `${svc}.${region}.amazonaws.com`)];
}

