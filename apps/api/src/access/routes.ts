import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { caller, type RouteDeps } from '../http/app.js';
import { HttpError, mapDbError } from '../http/errors.js';
import { principalOf } from '../identity/user-routes.js';
import { authorize, requirePermission, type ResourceRef } from './authorize.js';
import { ROLES } from './policy.js';

const scopeType = z.enum(['client', 'application', 'environment']);

const listQuery = z.object({ scopeType, scopeId: z.string().uuid() });

const createBody = z.object({
  userId: z.string().uuid(),
  role: z.enum(ROLES),
  scopeType,
  scopeId: z.string().uuid(),
  expiresAt: z.coerce.date().optional(),
});

const GRANT_COLS = `g.id, g.user_id AS "userId", u.email, u.display_name AS "displayName", g.role,
  g.scope_type AS "scopeType", g.scope_id AS "scopeId", g.expires_at AS "expiresAt", g.created_at AS "createdAt"`;

function chainIds(chain: { clientId: string; applicationId?: string; environmentId?: string }) {
  return {
    clientId: chain.clientId,
    applicationId: chain.applicationId,
    environmentId: chain.environmentId,
  };
}

export async function grantRoutes(app: FastifyInstance, { db }: RouteDeps) {
  /**
   * Members of a resource: grants on it, grants inherited from its ancestors
   * (`inherited: true`), and for an application, grants on its environments.
   */
  app.get('/grants', async (req) => {
    const { user } = caller(req);
    const { scopeType: type, scopeId } = listQuery.parse(req.query);
    return db.tenant(user.orgId, async (q) => {
      // Membership needs real view permission on the scope. Navigation-only visibility
      // (holding a grant on something inside it) is not enough to list who else has access.
      const { allowed } = await authorize(q, principalOf(user), `${type}.view`, { type, id: scopeId });
      if (!allowed) throw HttpError.notFound();
      let sql: string;
      switch (type) {
        case 'client':
          sql = `SELECT ${GRANT_COLS}, false AS inherited FROM grants g JOIN users u ON u.id = g.user_id
                  WHERE g.scope_type = 'client' AND g.scope_id = $1`;
          break;
        case 'application':
          sql = `SELECT ${GRANT_COLS}, (g.scope_type = 'client') AS inherited FROM grants g JOIN users u ON u.id = g.user_id
                  WHERE (g.scope_type = 'application' AND g.scope_id = $1)
                     OR (g.scope_type = 'environment' AND g.scope_id IN (SELECT id FROM environments WHERE application_id = $1))
                     OR (g.scope_type = 'client' AND g.scope_id = (SELECT client_id FROM applications WHERE id = $1))`;
          break;
        case 'environment':
          sql = `SELECT ${GRANT_COLS}, (g.scope_type <> 'environment') AS inherited FROM grants g JOIN users u ON u.id = g.user_id
                  WHERE (g.scope_type = 'environment' AND g.scope_id = $1)
                     OR (g.scope_type = 'application' AND g.scope_id = (SELECT application_id FROM environments WHERE id = $1))
                     OR (g.scope_type = 'client' AND g.scope_id = (
                           SELECT a.client_id FROM environments e JOIN applications a ON a.id = e.application_id WHERE e.id = $1))`;
          break;
      }
      return q.query(`${sql} ORDER BY u.display_name, g.role`, [scopeId]);
    });
  });

  app.post('/grants', async (req, reply) => {
    const { user } = caller(req);
    const body = createBody.parse(req.body);
    if (body.role === 'app_creator' && body.scopeType !== 'client') {
      throw HttpError.badRequest('app_creator can only be granted on a client');
    }
    if (body.expiresAt && body.expiresAt <= new Date()) throw HttpError.badRequest('expiresAt must be in the future');

    const ref: ResourceRef = { type: body.scopeType, id: body.scopeId };
    const created = await db.tenant(user.orgId, async (q) => {
      const chain = await requirePermission(q, principalOf(user), 'grant.manage', ref);
      // Access to a protected (production) environment is granted only by org admins,
      // so an app admin cannot hand themselves or others production access.
      if (chain && 'protected' in chain && chain.protected && !user.isOrgAdmin) {
        throw HttpError.forbidden('Only an org admin can grant access to a protected environment');
      }
      const [target] = await q.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [body.userId]);
      if (!target) throw HttpError.badRequest('Unknown user');
      if (target.status !== 'active') throw HttpError.badRequest('User is disabled');

      const [row] = await q
        .query<{ id: string }>(
          `INSERT INTO grants (org_id, user_id, role, scope_type, scope_id, granted_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [user.orgId, body.userId, body.role, body.scopeType, body.scopeId, user.id, body.expiresAt ?? null],
        )
        .catch((e) => mapDbError(e, 'This user already has that role here'));

      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'grant.created', resourceType: 'grant', resourceId: row!.id,
        ...chainIds(chain!), details: { userId: body.userId, role: body.role, scopeType: body.scopeType, scopeId: body.scopeId },
      });
      const [full] = await q.query(`SELECT ${GRANT_COLS} FROM grants g JOIN users u ON u.id = g.user_id WHERE g.id = $1`, [row!.id]);
      return full;
    });
    return reply.status(201).send(created);
  });

  app.delete('/grants/:id', async (req) => {
    const { user } = caller(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return db.tenant(user.orgId, async (q) => {
      const [grant] = await q.query<{ scope_type: 'client' | 'application' | 'environment'; scope_id: string; user_id: string; role: string }>(
        'SELECT scope_type, scope_id, user_id, role FROM grants WHERE id = $1',
        [id],
      );
      if (!grant) throw HttpError.notFound();
      const chain = await requirePermission(q, principalOf(user), 'grant.manage', { type: grant.scope_type, id: grant.scope_id });
      // Same rule as granting: only org admins control access to protected environments.
      if (chain && 'protected' in chain && chain.protected && !user.isOrgAdmin) {
        throw HttpError.forbidden('Only an org admin can change access to a protected environment');
      }
      await q.query('DELETE FROM grants WHERE id = $1', [id]);
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'grant.revoked', resourceType: 'grant', resourceId: id,
        ...chainIds(chain!), details: { userId: grant.user_id, role: grant.role, scopeType: grant.scope_type, scopeId: grant.scope_id },
      });
      return { ok: true };
    });
  });
}
