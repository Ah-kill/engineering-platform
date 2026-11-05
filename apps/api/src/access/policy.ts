/**
 * Authorization policy. This module is pure: it decides from data handed to it,
 * so every rule here is unit-testable without a database.
 *
 * Rules:
 * 1. Deny by default.
 * 2. A grant on a client covers its applications and their environments.
 *    A grant on an application covers its environments. Grants never flow upward.
 * 3. Org admins manage metadata (clients, apps, environments, users, grants) but get
 *    no implicit *working* access. `environment.use` (open workspaces, and later
 *    code, AWS and secrets) always needs an explicit grant.
 * 4. On a protected environment (typically production), `environment.use` needs a
 *    grant on that exact environment. Broader client/app grants do not reach it.
 */

export const ROLES = ['viewer', 'developer', 'app_admin', 'app_creator'] as const;
export type Role = (typeof ROLES)[number];

export type ScopeType = 'client' | 'application' | 'environment';

export type Permission =
  // org-level, admin only
  | 'org.manage_users'
  | 'org.read_audit'
  | 'client.create'
  | 'client.update'
  | 'client.archive'
  // resource-level
  | 'client.view'
  | 'application.create'
  | 'application.view'
  | 'application.update'
  | 'application.archive'
  | 'environment.view'
  | 'environment.manage'
  | 'environment.use'
  | 'grant.manage';

const VIEW: Permission[] = ['client.view', 'application.view', 'environment.view'];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: VIEW,
  developer: [...VIEW, 'environment.use'],
  app_admin: [
    ...VIEW,
    'environment.use',
    'application.update',
    'application.archive',
    'environment.manage',
    'grant.manage',
  ],
  app_creator: ['client.view', 'application.create'],
};

/** What an org admin may do anywhere in the org. Note: no `environment.use`. */
export const ORG_ADMIN_PERMISSIONS: readonly Permission[] = [
  'org.manage_users',
  'org.read_audit',
  'client.create',
  'client.update',
  'client.archive',
  'client.view',
  'application.create',
  'application.view',
  'application.update',
  'application.archive',
  'environment.view',
  'environment.manage',
  'grant.manage',
];

const ORG_ONLY: ReadonlySet<Permission> = new Set([
  'org.manage_users',
  'org.read_audit',
  'client.create',
  'client.update',
  'client.archive',
]);

/** Permissions that, on a protected environment, require an environment-scoped grant. */
const PROTECTED_ENV_PERMISSIONS: ReadonlySet<Permission> = new Set(['environment.use']);

export interface Principal {
  userId: string;
  isOrgAdmin: boolean;
}

/** The ancestry of the resource being accessed. `null` resource = the org itself. */
export type ResourceChain =
  | null
  | { clientId: string }
  | { clientId: string; applicationId: string }
  | { clientId: string; applicationId: string; environmentId: string; protected: boolean };

export interface GrantRow {
  role: Role;
  scopeType: ScopeType;
  scopeId: string;
  expiresAt?: Date | null;
}

export function rolesWith(permission: Permission): Role[] {
  return ROLES.filter((r) => ROLE_PERMISSIONS[r].includes(permission));
}

export function decide(
  principal: Principal,
  permission: Permission,
  resource: ResourceChain,
  grants: readonly GrantRow[],
  now: Date = new Date(),
): boolean {
  if (principal.isOrgAdmin && ORG_ADMIN_PERMISSIONS.includes(permission)) return true;
  if (ORG_ONLY.has(permission) || resource === null) return false;

  const envProtected = 'environmentId' in resource && resource.protected;
  const requireExactEnv = envProtected && PROTECTED_ENV_PERMISSIONS.has(permission);

  return grants.some((g) => {
    if (g.expiresAt && g.expiresAt <= now) return false;
    if (!ROLE_PERMISSIONS[g.role].includes(permission)) return false;
    if (requireExactEnv) {
      return g.scopeType === 'environment' && 'environmentId' in resource && g.scopeId === resource.environmentId;
    }
    return grantCovers(g, resource);
  });
}

function grantCovers(g: GrantRow, resource: NonNullable<ResourceChain>): boolean {
  switch (g.scopeType) {
    case 'client':
      return g.scopeId === resource.clientId;
    case 'application':
      return 'applicationId' in resource && g.scopeId === resource.applicationId;
    case 'environment':
      return 'environmentId' in resource && g.scopeId === resource.environmentId;
  }
}
