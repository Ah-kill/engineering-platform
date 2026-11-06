export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-requested-with': 'platform-web',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string; details?: { path: string; message: string }[] } } | undefined)?.error;
    const detail = err?.details?.[0];
    throw new ApiError(
      res.status,
      err?.code ?? 'error',
      detail ? `${detail.path ? `${detail.path}: ` : ''}${detail.message}` : (err?.message ?? res.statusText),
      err?.details,
    );
  }
  return data as T;
}

// ---- shared types ---------------------------------------------------------

export type Permission =
  | 'client.view' | 'client.update' | 'client.archive'
  | 'application.create' | 'application.view' | 'application.update' | 'application.archive'
  | 'environment.view' | 'environment.manage' | 'environment.use' | 'grant.manage';

export interface Me {
  user: { id: string; email: string; displayName: string; isOrgAdmin: boolean; orgId: string };
  org: { id: string; name: string; slug: string };
}

export interface ClientRow {
  id: string; name: string; slug: string; description: string; archivedAt: string | null; createdAt: string;
  permissions?: Permission[];
}

export interface ApplicationRow {
  id: string; clientId: string; name: string; slug: string; description: string;
  origin: 'existing' | 'new'; archivedAt: string | null; createdAt: string;
}

export interface EnvironmentRow {
  id: string; applicationId: string; name: string; kind: 'development' | 'staging' | 'production';
  protected: boolean; awsRegion: string | null; permissions: Permission[];
}

export interface ApplicationDetail extends ApplicationRow {
  clientName: string; environments: EnvironmentRow[]; permissions: Permission[];
}

export type Role = 'viewer' | 'developer' | 'app_admin' | 'app_creator';

export interface GrantRow {
  id: string; userId: string; email: string; displayName: string; role: Role;
  scopeType: 'client' | 'application' | 'environment'; scopeId: string;
  expiresAt: string | null; inherited: boolean;
}

export interface UserRow {
  id: string; email: string; displayName: string; isOrgAdmin: boolean;
  status: 'active' | 'disabled'; createdAt: string; lastLoginAt: string | null;
}

export type CredentialKind = 'anthropic_api_key' | 'claude_oauth_token' | 'github_token';

export interface AgentSettings {
  authMode: 'api_key' | 'subscription';
  defaultModel: string;
  credentials: Record<CredentialKind, { saved: boolean; hint?: string; updatedAt?: string }>;
}

export interface ModelOption {
  id: string; label: string; description: string; resolvedModel?: string; source: 'claude-code' | 'anthropic-api';
}

export interface Repository { id: string; owner: string; name: string; defaultBranch: string; url: string }

export interface Workspace {
  id: string; applicationId: string; environmentId: string; branch: string; baseBranch: string;
  state: 'creating' | 'ready' | 'failed' | 'deleted'; error: string | null; createdAt: string; lastActiveAt: string;
  repoOwner: string; repoName: string; defaultBranch: string; applicationName: string; clientId: string;
  clientName: string; environmentName: string; environmentKind: string;
}

export interface TreeEntry { path: string; type: 'file' | 'dir'; skipped?: boolean }

export interface GitFile { path: string; code: string; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' }
export interface GitStatus { branch: string; ahead: number; behind: number; files: GitFile[]; baseBranch: string; defaultBranch: string }

export interface AgentSession {
  id: string; title: string; model: string; authMode: string; costUsd: number;
  inputTokens: number; outputTokens: number; createdAt: string; updatedAt: string;
}

export interface AgentEventRow { id: string; sessionId?: string; kind: string; data: Record<string, any>; createdAt: string }

export interface AuditRow {
  id: string; occurredAt: string; action: string; outcome: string; actorEmail: string | null;
  resourceType: string | null; resourceId: string | null; details: Record<string, unknown>;
}
