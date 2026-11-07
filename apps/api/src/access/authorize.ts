import type { Queryable } from '../db/db.js';
import { HttpError } from '../http/errors.js';
import { decide, type GrantRow, type Permission, type Principal, type ResourceChain, type Role, type ScopeType } from './policy.js';

/**
 * Database-backed authorization. Every route calls `authorize` (or one of the
 * `require*` helpers) before touching data; controllers never inspect roles.
 */

export type ResourceRef =
  | { type: 'org' }
  | { type: 'client'; id: string }
  | { type: 'application'; id: string }
  | { type: 'environment'; id: string };

/** Resolves a resource to its ancestry. Returns undefined if it does not exist in this org. */
export async function resolveChain(q: Queryable, ref: ResourceRef): Promise<ResourceChain | undefined> {
  switch (ref.type) {
    case 'org':
      return null;
    case 'client': {
      const rows = await q.query<{ id: string }>('SELECT id FROM clients WHERE id = $1', [ref.id]);
      return rows[0] ? { clientId: rows[0].id } : undefined;
    }
    case 'application': {
      const rows = await q.query<{ id: string; client_id: string }>(
        'SELECT id, client_id FROM applications WHERE id = $1',
        [ref.id],
      );
      return rows[0] ? { clientId: rows[0].client_id, applicationId: rows[0].id } : undefined;
    }
    case 'environment': {
      const rows = await q.query<{ id: string; application_id: string; client_id: string; protected: boolean }>(
        `SELECT e.id, e.application_id, a.client_id, e.protected
           FROM environments e JOIN applications a ON a.id = e.application_id
          WHERE e.id = $1`,
        [ref.id],
      );
      const r = rows[0];
      return r
        ? { clientId: r.client_id, applicationId: r.application_id, environmentId: r.id, protected: r.protected }
        : undefined;
    }
  }
}

export async function loadGrants(q: Queryable, userId: string, chain: ResourceChain): Promise<GrantRow[]> {
  if (chain === null) return [];
  const ids = [chain.clientId];
  if ('applicationId' in chain) ids.push(chain.applicationId);
  if ('environmentId' in chain) ids.push(chain.environmentId);
  const rows = await q.query<{ role: Role; scope_type: ScopeType; scope_id: string; expires_at: Date | null }>(
    'SELECT role, scope_type, scope_id, expires_at FROM grants WHERE user_id = $1 AND scope_id = ANY($2::uuid[])',
    [userId, ids],
  );
  return rows.map((r) => ({ role: r.role, scopeType: r.scope_type, scopeId: r.scope_id, expiresAt: r.expires_at }));
}

export async function authorize(
  q: Queryable,
  principal: Principal,
  permission: Permission,
  ref: ResourceRef,
): Promise<{ allowed: boolean; chain: ResourceChain | undefined }> {
  const chain = await resolveChain(q, ref);
  if (chain === undefined) return { allowed: false, chain };
  const grants = await loadGrants(q, principal.userId, chain);
  return { allowed: decide(principal, permission, chain, grants), chain };
}

/**
 * True if the user holds an active grant somewhere *below* this resource. Such a
 * user may see the resource's name to navigate to what they can access, but the
 * grant gives them no permissions on the resource itself.
 */
async function hasDescendantGrant(q: Queryable, userId: string, ref: ResourceRef): Promise<boolean> {
  let sql: string;
  switch (ref.type) {
    case 'client':
      sql = `SELECT 1 FROM grants g WHERE g.user_id = $1 AND (g.expires_at IS NULL OR g.expires_at > now()) AND (
               (g.scope_type = 'application' AND g.scope_id IN (SELECT id FROM applications WHERE client_id = $2))
            OR (g.scope_type = 'environment' AND g.scope_id IN (
                  SELECT e.id FROM environments e JOIN applications a ON a.id = e.application_id WHERE a.client_id = $2)))
             LIMIT 1`;
      break;
    case 'application':
      sql = `SELECT 1 FROM grants g WHERE g.user_id = $1 AND (g.expires_at IS NULL OR g.expires_at > now())
               AND g.scope_type = 'environment'
               AND g.scope_id IN (SELECT id FROM environments WHERE application_id = $2)
             LIMIT 1`;
      break;
    default:
      return false;
  }
  return (await q.query(sql, [userId, ref.id])).length > 0;
}

type ViewableRef = Exclude<ResourceRef, { type: 'org' }>;

/** Whether the resource is visible: view permission on it, or a grant on something inside it. */
export async function canView(q: Queryable, principal: Principal, ref: ViewableRef): Promise<boolean> {
  const { allowed, chain } = await authorize(q, principal, `${ref.type}.view` as Permission, ref);
  if (allowed) return true;
  if (chain === undefined) return false;
  return hasDescendantGrant(q, principal.userId, ref);
}

/** Throws 404 unless the resource is visible to the caller. */
export async function requireVisible(q: Queryable, principal: Principal, ref: ViewableRef): Promise<void> {
  if (!(await canView(q, principal, ref))) throw HttpError.notFound();
}

/**
 * Throws 404 when the caller cannot even see the resource (so existence is not
 * leaked) and 403 when they can see it but lack the requested permission.
 */
export async function requirePermission(
  q: Queryable,
  principal: Principal,
  permission: Permission,
  ref: ResourceRef,
): Promise<NonNullable<ResourceChain> | null> {
  const { allowed, chain } = await authorize(q, principal, permission, ref);
  if (allowed) return chain ?? null;
  if (chain === undefined) throw HttpError.notFound();
  if (ref.type !== 'org' && !(await canView(q, principal, ref))) throw HttpError.notFound();
  throw HttpError.forbidden();
}

/** Every permission the caller holds on a resource; the UI uses this to show or hide actions. */
export async function permissionsOn(q: Queryable, principal: Principal, ref: ViewableRef): Promise<Permission[]> {
  const chain = await resolveChain(q, ref);
  if (!chain) return [];
  const grants = await loadGrants(q, principal.userId, chain);
  return ALL_PERMISSIONS.filter((p) => decide(principal, p, chain, grants));
}

const ALL_PERMISSIONS: Permission[] = [
  'client.view',
  'client.update',
  'client.archive',
  'application.create',
  'application.view',
  'application.update',
  'application.archive',
  'application.merge',
  'environment.view',
  'environment.manage',
  'environment.use',
  'grant.manage',
];
