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

export async function api<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
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

export interface AuditRow {
  id: string; occurredAt: string; action: string; outcome: string; actorEmail: string | null;
  resourceType: string | null; resourceId: string | null; details: Record<string, unknown>;
}
