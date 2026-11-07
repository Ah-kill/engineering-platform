import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { HttpError } from '../http/errors.js';

/**
 * The only way the platform talks to AWS: STS AssumeRole into a client's role, and
 * GetCallerIdentity to prove the resulting credentials work.
 *
 * The platform's OWN base credentials come from the standard AWS credential chain of the
 * API process (environment, shared profile, SSO, container or instance role). They are
 * used only to sign AssumeRole here and are never read, stored, returned or forwarded.
 * Only the temporary credentials of the assumed role ever leave this module.
 */

export interface AssumeRoleParams {
  roleArn: string;
  externalId: string;
  /** RoleSessionName: 2-64 chars of [\w+=,.@-]; shows up in the client's CloudTrail. */
  sessionName: string;
  durationSeconds: number;
  region: string;
  /**
   * Inline session policy (JSON). The session gets the intersection of the role's permissions
   * and this policy, so it can only narrow access. Omitted = the role's permissions as they are.
   */
  policy?: string;
}

export interface AwsTemporaryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
  /** arn:aws:sts::<account>:assumed-role/<role>/<session>, when STS returned it. */
  assumedRoleArn?: string;
}

export interface CallerIdentity {
  account: string;
  arn: string;
}

/** Injectable so tests (and the e2e stack) never reach AWS. */
export interface StsClient {
  assumeRole(params: AssumeRoleParams): Promise<AwsTemporaryCredentials>;
  /** Calls GetCallerIdentity signed with the given temporary credentials. */
  getCallerIdentity(credentials: AwsTemporaryCredentials, region: string): Promise<CallerIdentity>;
}

const HTTP = { requestHandler: { connectionTimeout: 5_000, requestTimeout: 10_000 }, maxAttempts: 2 } as const;

/** Real implementation backed by @aws-sdk/client-sts. */
export class AwsSdkSts implements StsClient {
  /** One base-credential client per region; the SDK caches and refreshes base credentials itself. */
  private readonly clients = new Map<string, STSClient>();

  private baseClient(region: string): STSClient {
    let c = this.clients.get(region);
    if (!c) {
      // No `credentials`: the SDK resolves the default provider chain of this process.
      c = new STSClient({ region, ...HTTP });
      this.clients.set(region, c);
    }
    return c;
  }

  async assumeRole(p: AssumeRoleParams): Promise<AwsTemporaryCredentials> {
    const out = await this.baseClient(p.region).send(
      new AssumeRoleCommand({
        RoleArn: p.roleArn,
        RoleSessionName: p.sessionName,
        ExternalId: p.externalId,
        DurationSeconds: p.durationSeconds,
        ...(p.policy ? { Policy: p.policy } : {}),
      }),
    );
    const c = out.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
      throw new Error('STS returned no credentials');
    }
    return {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: new Date(c.Expiration),
      ...(out.AssumedRoleUser?.Arn ? { assumedRoleArn: out.AssumedRoleUser.Arn } : {}),
    };
  }

  async getCallerIdentity(creds: AwsTemporaryCredentials, region: string): Promise<CallerIdentity> {
    const client = new STSClient({
      region,
      ...HTTP,
      credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken },
    });
    try {
      const out = await client.send(new GetCallerIdentityCommand({}));
      return { account: out.Account ?? '', arn: out.Arn ?? '' };
    } finally {
      client.destroy();
    }
  }
}

let defaultSts: StsClient | undefined;
let override: StsClient | undefined;

/** The STS client routes and the broker use: a test override if set, else the real SDK client. */
export function getStsClient(): StsClient {
  if (override) return override;
  defaultSts ??= new AwsSdkSts();
  return defaultSts;
}

/** Tests (or the e2e stack) replace STS with a fake. Pass undefined to restore the real client. */
export function setStsClient(sts: StsClient | undefined): void {
  override = sts;
}

/**
 * Turns an STS/SDK failure into a message a person can act on. Never includes credentials;
 * AWS error messages name the role and caller ARN at most.
 */
export function stsError(err: unknown, region: string): HttpError {
  if (err instanceof HttpError) return err;
  const e = (err ?? {}) as { name?: string; Code?: string; code?: string; message?: string };
  const name = e.name ?? e.Code ?? e.code ?? '';
  const message = typeof e.message === 'string' ? e.message : '';
  const aws = (status: number, msg: string) => new HttpError(status, 'aws_error', msg);

  switch (name) {
    case 'AccessDenied':
    case 'AccessDeniedException':
      return aws(400, 'Access denied: check the role trust policy and ExternalId');
    case 'ValidationError':
      if (/DurationSeconds|MaxSessionDuration/i.test(message)) {
        return aws(400, "Session length is longer than the role's maximum session duration. Shorten it here or raise MaxSessionDuration on the role.");
      }
      return aws(400, `AWS rejected the request: ${message.slice(0, 300) || 'validation error'}`);
    case 'MalformedPolicyDocument':
    case 'MalformedPolicyDocumentException':
      return aws(400, `AWS rejected the session policy: ${message.slice(0, 300)}`);
    case 'PackedPolicyTooLarge':
    case 'PackedPolicyTooLargeException':
      return aws(
        400,
        'AWS says the session policy is too large once packed into the session token. Use fewer allowed actions or combine them with wildcards (for example lambda:Get*).',
      );
    case 'RegionDisabledException':
      return aws(400, `STS is not activated in ${region} for the platform account. Choose another region or activate it in IAM.`);
    case 'ExpiredToken':
    case 'ExpiredTokenException':
    case 'InvalidClientTokenId':
    case 'SignatureDoesNotMatch':
    case 'UnrecognizedClientException':
      return aws(503, "The platform's own AWS credentials are invalid or expired. Ask an administrator to check the server's AWS configuration.");
    case 'CredentialsProviderError':
      return aws(503, 'The platform has no AWS credentials configured. Ask an administrator to set up the server\'s AWS credentials.');
    case 'TimeoutError':
    case 'RequestTimeout':
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ETIMEDOUT':
      return aws(502, `Could not reach AWS STS in ${region}. Try again shortly.`);
    case 'Throttling':
    case 'ThrottlingException':
      return aws(503, 'AWS STS is throttling requests. Try again shortly.');
  }
  if (/Could not load credentials/i.test(message)) {
    return aws(503, 'The platform has no AWS credentials configured. Ask an administrator to set up the server\'s AWS credentials.');
  }
  return aws(502, 'The AWS STS request failed. Try again, or check the role configuration.');
}
