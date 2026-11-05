import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../access/authorize.js';
import { audit } from '../audit/audit.js';
import { caller, type RouteDeps } from '../http/app.js';
import { HttpError, mapDbError } from '../http/errors.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from './passwords.js';
import { revokeUserSessions } from './sessions.js';

const USER_COLUMNS = `id, email, display_name AS "displayName", is_org_admin AS "isOrgAdmin",
  status, created_at AS "createdAt", last_login_at AS "lastLoginAt"`;

const createUserBody = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
  isOrgAdmin: z.boolean().default(false),
});

const updateUserBody = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    isOrgAdmin: z.boolean(),
    status: z.enum(['active', 'disabled']),
    password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
  })
  .partial();

const idParam = z.object({ id: z.string().uuid() });

export async function userRoutes(app: FastifyInstance, { db }: RouteDeps) {
  /** Minimal list of active colleagues, used by any user to pick grant recipients. */
  app.get('/users/directory', async (req) => {
    const { user } = caller(req);
    return db.tenant(user.orgId, (q) =>
      q.query(`SELECT id, email, display_name AS "displayName" FROM users WHERE status = 'active' ORDER BY display_name`),
    );
  });

  app.get('/users', async (req) => {
    const { user } = caller(req);
    return db.tenant(user.orgId, async (q) => {
      await requirePermission(q, principalOf(user), 'org.manage_users', { type: 'org' });
      return q.query(`SELECT ${USER_COLUMNS} FROM users ORDER BY display_name`);
    });
  });

  app.post('/users', async (req, reply) => {
    const { user } = caller(req);
    const body = createUserBody.parse(req.body);
    const passwordHash = await hashPassword(body.password);
    const created = await db.tenant(user.orgId, async (q) => {
      await requirePermission(q, principalOf(user), 'org.manage_users', { type: 'org' });
      const [row] = await q
        .query<{ id: string }>(
          `INSERT INTO users (org_id, email, display_name, password_hash, is_org_admin)
           VALUES ($1, $2, $3, $4, $5) RETURNING ${USER_COLUMNS}`,
          [user.orgId, body.email, body.displayName, passwordHash, body.isOrgAdmin],
        )
        .catch((e) => mapDbError(e, 'A user with this email already exists'));
      await audit(q, {
        orgId: user.orgId,
        actorId: user.id,
        action: 'user.created',
        resourceType: 'user',
        resourceId: row!.id,
        details: { email: body.email, isOrgAdmin: body.isOrgAdmin },
      });
      return row;
    });
    return reply.status(201).send(created);
  });

  app.patch('/users/:id', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    const body = updateUserBody.parse(req.body);
    if (id === user.id && (body.status === 'disabled' || body.isOrgAdmin === false)) {
      throw HttpError.badRequest('You cannot disable yourself or remove your own admin role');
    }
    const passwordHash = body.password ? await hashPassword(body.password) : null;

    const updated = await db.tenant(user.orgId, async (q) => {
      await requirePermission(q, principalOf(user), 'org.manage_users', { type: 'org' });
      const [row] = await q.query(
        `UPDATE users SET
           display_name  = coalesce($2, display_name),
           is_org_admin  = coalesce($3, is_org_admin),
           status        = coalesce($4, status),
           password_hash = coalesce($5, password_hash),
           updated_at    = now()
         WHERE id = $1 RETURNING ${USER_COLUMNS}`,
        [id, body.displayName ?? null, body.isOrgAdmin ?? null, body.status ?? null, passwordHash],
      );
      if (!row) throw HttpError.notFound();
      await audit(q, {
        orgId: user.orgId,
        actorId: user.id,
        action: 'user.updated',
        resourceType: 'user',
        resourceId: id,
        details: {
          displayName: body.displayName,
          isOrgAdmin: body.isOrgAdmin,
          status: body.status,
          passwordReset: passwordHash !== null,
        },
      });
      return row;
    });

    if (body.status === 'disabled' || passwordHash) await revokeUserSessions(db, id);
    return updated;
  });
}

export function principalOf(user: { id: string; isOrgAdmin: boolean }) {
  return { userId: user.id, isOrgAdmin: user.isOrgAdmin };
}
