import { HttpError } from '../http/errors.js';

/**
 * Enforced AWS permissions: an inline STS session policy passed to AssumeRole.
 *
 * The session's effective permissions are the intersection of the client's role and this
 * policy, so it can only take permissions away; it can never grant something the role does
 * not allow. `environments.aws_access` ('read'/'write') is informational; this policy (when
 * set) is what is enforced on the platform side.
 */

/** service:Action, with * wildcards in the action part. */
export const ACTION_RE = /^[a-z0-9-]+:[A-Za-z0-9*]+$/;
export const MAX_ALLOWED_ACTIONS = 100;
/**
 * STS: "The plaintext that you use for both inline and managed session policies can't exceed
 * 2,048 characters." AWS also compresses the policy into the session token and can still
 * reject it as PackedPolicyTooLarge; that error is mapped to a readable message in sts.ts.
 */
export const MAX_SESSION_POLICY_CHARS = 2048;

export type PresetId = 'read-only' | 'deploy';

export interface SessionPolicyPreset {
  id: PresetId;
  name: string;
  description: string;
  actions: string[];
}

const READ_ONLY_ACTIONS = [
  'logs:Describe*',
  'logs:Get*',
  'logs:FilterLogEvents',
  'logs:StartQuery',
  'logs:GetQueryResults',
  'cloudwatch:Get*',
  'cloudwatch:List*',
  'cloudwatch:Describe*',
  'lambda:Get*',
  'lambda:List*',
  'apigateway:GET',
  'dynamodb:Describe*',
  'dynamodb:List*',
  'ecs:Describe*',
  'ecs:List*',
  'eks:Describe*',
  'eks:List*',
  'cloudformation:Describe*',
  'cloudformation:List*',
  'cloudformation:Get*',
  'ec2:Describe*',
  's3:List*',
  's3:GetBucket*',
  'sts:GetCallerIdentity',
];

const DEPLOY_ACTIONS = [
  ...READ_ONLY_ACTIONS,
  'lambda:Update*',
  'lambda:Publish*',
  'cloudformation:CreateStack',
  'cloudformation:UpdateStack',
  'cloudformation:CreateChangeSet',
  'cloudformation:ExecuteChangeSet',
  's3:PutObject',
  'iam:PassRole',
];

export const SESSION_POLICY_PRESETS: readonly SessionPolicyPreset[] = [
  {
    id: 'read-only',
    name: 'Read-only investigation',
    description: 'Logs, metrics and describe/list calls for Lambda, API Gateway, DynamoDB, ECS, EKS, CloudFormation, EC2 and S3 buckets. No changes.',
    actions: READ_ONLY_ACTIONS,
  },
  {
    id: 'deploy',
    name: 'Deploy (Lambda + CloudFormation)',
    description: 'Everything in read-only, plus updating and publishing Lambda functions, CloudFormation stacks and change sets, uploading deployment artifacts to S3 and passing roles.',
    actions: DEPLOY_ACTIONS,
  },
];

/** Trims and removes duplicates, keeping the first occurrence's order. */
export function normalizeActions(actions: readonly string[]): string[] {
  return [...new Set(actions.map((a) => a.trim()).filter(Boolean))];
}

export function sessionPolicyDocument(actions: readonly string[]): string {
  return JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: [...actions], Resource: '*' }] });
}

/**
 * Validates an allowed-actions list and returns it normalized. Throws a 400 that says what
 * to fix: a bad action string, too many entries, or a policy too large for STS.
 */
export function validateAllowedActions(input: readonly string[]): string[] {
  const actions = normalizeActions(input);
  if (!actions.length) {
    throw HttpError.badRequest('List at least one AWS action, or choose "Use the role as-is" to pass no session policy');
  }
  if (actions.length > MAX_ALLOWED_ACTIONS) {
    throw HttpError.badRequest(`At most ${MAX_ALLOWED_ACTIONS} AWS actions are allowed (got ${actions.length}). Use wildcards such as logs:Describe*.`);
  }
  const bad = actions.filter((a) => !ACTION_RE.test(a));
  if (bad.length) {
    const shown = bad.slice(0, 5).map((a) => JSON.stringify(a.slice(0, 80))).join(', ');
    throw HttpError.badRequest(`Not an AWS action (expected service:Action, e.g. logs:FilterLogEvents or ec2:Describe*): ${shown}`);
  }
  const size = sessionPolicyDocument(actions).length;
  if (size > MAX_SESSION_POLICY_CHARS) {
    throw HttpError.badRequest(
      `The session policy would be ${size} characters; AWS STS allows at most ${MAX_SESSION_POLICY_CHARS}. Remove actions or combine them with wildcards such as lambda:Get*.`,
    );
  }
  return actions;
}

/** The preset a stored list matches exactly (as a set), 'custom' otherwise, null when there is no policy. */
export function presetFor(actions: readonly string[] | null): PresetId | 'custom' | null {
  if (!actions) return null;
  const set = new Set(actions);
  for (const p of SESSION_POLICY_PRESETS) {
    if (p.actions.length === set.size && p.actions.every((a) => set.has(a))) return p.id;
  }
  return 'custom';
}
