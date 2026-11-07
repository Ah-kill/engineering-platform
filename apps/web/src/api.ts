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
  status: 'active' | 'disabled'; createdAt: string; lastLoginAt: string | null; mfaEnabled: boolean;
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

// ---- git and workspace features --------------------------------------------

export interface GithubTokenInfo { owner: string | null; hint: string; updatedAt: string }
export interface SettingsWithGithub extends AgentSettings { githubTokens: GithubTokenInfo[] }

export interface GithubRepoSummary {
  owner: string; name: string; fullName: string; private: boolean; defaultBranch: string;
  description: string; updatedAt: string; url: string;
}

export type WorkspaceRole = 'owner' | 'editor' | 'viewer';
export interface SharedWorkspace extends Workspace { access: WorkspaceRole; ownerName: string; ownerId: string }

export interface WorkspaceMember { userId: string; displayName: string; email: string; role: 'viewer' | 'editor'; createdAt: string }
export interface WorkspaceMembers { owner: { id: string; displayName: string; email: string }; members: WorkspaceMember[]; canManage: boolean }
export interface ShareCandidate { id: string; displayName: string; email: string }

export interface CommitSummary { sha: string; author: string; date: string; subject: string }

export interface FileVersions {
  path: string; oldPath?: string; status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';
  original: string; modified: string; binary: boolean; omitted?: boolean;
}

export interface CommitDetail {
  sha: string; parent: string | null; author: string; email: string; date: string; subject: string; body: string;
  files: FileVersions[]; truncated: boolean;
}

export interface Comparison {
  base: string; head: string; mergeBase: string | null; commits: CommitSummary[]; files: FileVersions[]; truncated: boolean;
}

export interface SearchHit { path: string; line: number; text: string }
export interface SearchResult { hits: SearchHit[]; truncated: boolean }

export interface PullRequestSummary {
  number: number; title: string; state: 'open' | 'closed' | 'merged'; draft: boolean; author: string;
  head: string; base: string; url: string; createdAt: string; updatedAt: string;
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string; headSha: string; mergeable: boolean | null; mergeableState: string;
  checks: { state: 'success' | 'pending' | 'failure' | 'none'; total: number; failed: number; pending: number } | null;
  files: { path: string; status: string; additions: number; deletions: number; patch?: string }[];
  filesTruncated: boolean; canMerge: boolean;
}

export interface BranchList { current: string; local: string[]; remote: string[] }
