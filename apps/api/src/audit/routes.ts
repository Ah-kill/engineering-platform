import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../access/authorize.js';
import { caller, type RouteDeps } from '../http/app.js';
import { principalOf } from '../identity/user-routes.js';

const query = z.object({
  clientId: z.string().uuid().optional(),
  applicationId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  /** Return events with id lower than this (cursor pagination). */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function auditRoutes(app: FastifyInstance, { db }: RouteDeps) {
  app.get('/audit', async (req) => {
    const { user } = caller(req);
    const f = query.parse(req.query);
    return db.tenant(user.orgId, async (q) => {
      await requirePermission(q, principalOf(user), 'org.read_audit', { type: 'org' });
      return q.query(
        `SELECT ae.id::text AS id, ae.occurred_at AS "occurredAt", ae.action, ae.outcome,
                ae.resource_type AS "resourceType", ae.resource_id AS "resourceId",
                ae.client_id AS "clientId", ae.application_id AS "applicationId", ae.environment_id AS "environmentId",
                ae.actor_id AS "actorId", u.email AS "actorEmail", ae.details
           FROM audit_events ae LEFT JOIN users u ON u.id = ae.actor_id
          WHERE ($1::uuid IS NULL OR ae.client_id = $1)
            AND ($2::uuid IS NULL OR ae.application_id = $2)
            AND ($3::uuid IS NULL OR ae.actor_id = $3)
            AND ($4::bigint IS NULL OR ae.id < $4)
          ORDER BY ae.id DESC
          LIMIT $5`,
        [f.clientId ?? null, f.applicationId ?? null, f.actorId ?? null, f.before ?? null, f.limit],
      );
    });
  });
}
