import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authorize, permissionsOn, requirePermission, requireVisible } from '../access/authorize.js';
import { audit } from '../audit/audit.js';
import type { Queryable } from '../db/db.js';
import { caller, type RouteDeps } from '../http/app.js';
import { HttpError, mapDbError } from '../http/errors.js';
import { principalOf } from '../identity/user-routes.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

const name = z.string().trim().min(1).max(120);
const slug = z.string().trim().regex(SLUG, 'Lowercase letters, digits and dashes only');
const description = z.string().trim().max(2000);
const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({ archived: z.enum(['true', 'false']).default('false') });
const ENV_KINDS = ['development', 'staging', 'production'] as const;
const awsRegion = z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'Not a valid AWS region').nullable();

const createClientBody = z.object({ name, slug: slug.optional(), description: description.default('') });
const updateClientBody = z.object({ name, description }).partial();

const createAppBody = z.object({
  name,
  slug: slug.optional(),
  description: description.default(''),
  origin: z.enum(['existing', 'new']).default('existing'),
  /** Creates development, staging and production (protected) environments. */
  createDefaultEnvironments: z.boolean().default(true),
});
const updateAppBody = z.object({ name, description }).partial();

const createEnvBody = z.object({
  name: slug,
  kind: z.enum(ENV_KINDS),
  protected: z.boolean().optional(),
  awsRegion: awsRegion.optional(),
});
const updateEnvBody = z.object({ protected: z.boolean(), awsRegion }).partial();

const CLIENT_COLS = `c.id, c.name, c.slug, c.description, c.archived_at AS "archivedAt", c.created_at AS "createdAt"`;
const APP_COLS = `a.id, a.client_id AS "clientId", a.name, a.slug, a.description, a.origin,
  a.archived_at AS "archivedAt", a.created_at AS "createdAt"`;
const ENV_COLS = `e.id, e.application_id AS "applicationId", e.name, e.kind, e.protected,
  e.aws_region AS "awsRegion", e.archived_at AS "archivedAt"`;

const ACTIVE_GRANT = `(g.expires_at IS NULL OR g.expires_at > now())`;

function resolveSlug(given: string | undefined, fromName: string): string {
  const s = given ?? slugify(fromName);
  if (!SLUG.test(s)) throw HttpError.badRequest('Could not derive a valid slug from the name; provide one');
  return s;
}

async function insertEnvironment(
  q: Queryable,
  orgId: string,
  applicationId: string,
  env: { name: string; kind: (typeof ENV_KINDS)[number]; protected?: boolean; awsRegion?: string | null },
) {
  const [row] = await q
    .query<{ id: string }>(
      `INSERT INTO environments (org_id, application_id, name, kind, protected, aws_region)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, application_id AS "applicationId", name, kind, protected, aws_region AS "awsRegion", archived_at AS "archivedAt"`,
      [orgId, applicationId, env.name, env.kind, env.protected ?? env.kind === 'production', env.awsRegion ?? null],
    )
    .catch((e) => mapDbError(e, `An environment named "${env.name}" already exists`));
  return row!;
}

export async function tenancyRoutes(app: FastifyInstance, { db }: RouteDeps) {
  // ---- clients ------------------------------------------------------------

  app.get('/clients', async (req) => {
    const { user } = caller(req);
    const { archived } = listQuery.parse(req.query);
    return db.tenant(user.orgId, (q) =>
      q.query(
        `SELECT ${CLIENT_COLS} FROM clients c
          WHERE (c.archived_at IS NOT NULL) = $3
            AND ($2 OR EXISTS (
              SELECT 1 FROM grants g WHERE g.user_id = $1 AND ${ACTIVE_GRANT} AND (
                   (g.scope_type = 'client' AND g.scope_id = c.id)
                OR (g.scope_type = 'application' AND g.scope_id IN (SELECT id FROM applications WHERE client_id = c.id))
                OR (g.scope_type = 'environment' AND g.scope_id IN (
                      SELECT e.id FROM environments e JOIN applications a ON a.id = e.application_id WHERE a.client_id = c.id)))))
          ORDER BY c.name`,
        [user.id, user.isOrgAdmin, archived === 'true'],
      ),
    );
  });

  app.post('/clients', async (req, reply) => {
    const { user } = caller(req);
    const body = createClientBody.parse(req.body);
    const clientSlug = resolveSlug(body.slug, body.name);
    const created = await db.tenant(user.orgId, async (q) => {
      await requirePermission(q, principalOf(user), 'client.create', { type: 'org' });
      const [row] = await q
        .query<{ id: string }>(
          `INSERT INTO clients AS c (org_id, name, slug, description) VALUES ($1, $2, $3, $4) RETURNING ${CLIENT_COLS}`,
          [user.orgId, body.name, clientSlug, body.description],
        )
        .catch((e) => mapDbError(e, `A client with slug "${clientSlug}" already exists`));
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'client.created',
        resourceType: 'client', resourceId: row!.id, clientId: row!.id, details: { name: body.name, slug: clientSlug },
      });
      return row;
    });
    return reply.status(201).send(created);
  });

  app.get('/clients/:id', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    return db.tenant(user.orgId, async (q) => {
      const principal = principalOf(user);
      await requireVisible(q, principal, { type: 'client', id });
      const [client] = await q.query(`SELECT ${CLIENT_COLS} FROM clients c WHERE c.id = $1`, [id]);
      return { ...client, permissions: await permissionsOn(q, principal, { type: 'client', id }) };
    });
  });

  app.patch('/clients/:id', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    const body = updateClientBody.parse(req.body);
    return db.tenant(user.orgId, async (q) => {
      await requirePermission(q, principalOf(user), 'client.update', { type: 'client', id });
      const [row] = await q.query(
        `UPDATE clients c SET name = coalesce($2, name), description = coalesce($3, description), updated_at = now()
          WHERE c.id = $1 RETURNING ${CLIENT_COLS}`,
        [id, body.name ?? null, body.description ?? null],
      );
      await audit(q, { orgId: user.orgId, actorId: user.id, action: 'client.updated', resourceType: 'client', resourceId: id, clientId: id, details: body });
      return row;
    });
  });

  for (const [verb, archived] of [['archive', true], ['unarchive', false]] as const) {
    app.post(`/clients/:id/${verb}`, async (req) => {
      const { user } = caller(req);
      const { id } = idParam.parse(req.params);
      return db.tenant(user.orgId, async (q) => {
        await requirePermission(q, principalOf(user), 'client.archive', { type: 'client', id });
        const [row] = await q.query(
          `UPDATE clients c SET archived_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now()
            WHERE c.id = $1 RETURNING ${CLIENT_COLS}`,
          [id, archived],
        );
        await audit(q, { orgId: user.orgId, actorId: user.id, action: `client.${verb}d`, resourceType: 'client', resourceId: id, clientId: id });
        return row;
      });
    });
  }

  // ---- applications -------------------------------------------------------

  app.get('/clients/:id/applications', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    const { archived } = listQuery.parse(req.query);
    return db.tenant(user.orgId, async (q) => {
      const principal = principalOf(user);
      await requireVisible(q, principal, { type: 'client', id });
      // Org admins and client-wide viewers see every application; others see what they hold grants in.
      const seesAll = (await authorize(q, principal, 'application.view', { type: 'client', id })).allowed;
      return q.query(
        `SELECT ${APP_COLS} FROM applications a
          WHERE a.client_id = $1 AND (a.archived_at IS NOT NULL) = $4
            AND ($3 OR EXISTS (
              SELECT 1 FROM grants g WHERE g.user_id = $2 AND ${ACTIVE_GRANT} AND (
                   (g.scope_type = 'application' AND g.scope_id = a.id)
                OR (g.scope_type = 'environment' AND g.scope_id IN (SELECT id FROM environments WHERE application_id = a.id)))))
          ORDER BY a.name`,
        [id, user.id, seesAll, archived === 'true'],
      );
    });
  });

  app.post('/clients/:id/applications', async (req, reply) => {
    const { user } = caller(req);
    const { id: clientId } = idParam.parse(req.params);
    const body = createAppBody.parse(req.body);
    const appSlug = resolveSlug(body.slug, body.name);

    const created = await db.tenant(user.orgId, async (q) => {
      await requirePermission(q, principalOf(user), 'application.create', { type: 'client', id: clientId });
      const [client] = await q.query<{ archived_at: Date | null }>('SELECT archived_at FROM clients WHERE id = $1', [clientId]);
      if (client?.archived_at) throw HttpError.badRequest('Client is archived');

      const [application] = await q
        .query<{ id: string }>(
          `INSERT INTO applications AS a (org_id, client_id, name, slug, description, origin)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${APP_COLS}`,
          [user.orgId, clientId, body.name, appSlug, body.description, body.origin],
        )
        .catch((e) => mapDbError(e, `An application with slug "${appSlug}" already exists for this client`));
      const appId = application!.id;

      const environments = body.createDefaultEnvironments
        ? [
            await insertEnvironment(q, user.orgId, appId, { name: 'development', kind: 'development' }),
            await insertEnvironment(q, user.orgId, appId, { name: 'staging', kind: 'staging' }),
            await insertEnvironment(q, user.orgId, appId, { name: 'production', kind: 'production' }),
          ]
        : [];

      // A non-admin creator becomes the application's admin; org admins grant themselves explicitly.
      if (!user.isOrgAdmin) {
        await q.query(
          `INSERT INTO grants (org_id, user_id, role, scope_type, scope_id, granted_by)
           VALUES ($1, $2, 'app_admin', 'application', $3, $2)`,
          [user.orgId, user.id, appId],
        );
      }

      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'application.created',
        resourceType: 'application', resourceId: appId, clientId, applicationId: appId,
        details: { name: body.name, slug: appSlug, origin: body.origin, environments: environments.length },
      });
      return { ...application, environments };
    });
    return reply.status(201).send(created);
  });

  app.get('/applications/:id', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    return db.tenant(user.orgId, async (q) => {
      const principal = principalOf(user);
      await requireVisible(q, principal, { type: 'application', id });
      const [application] = await q.query(
        `SELECT ${APP_COLS}, c.name AS "clientName" FROM applications a JOIN clients c ON c.id = a.client_id WHERE a.id = $1`,
        [id],
      );
      const seesAll = (await authorize(q, principal, 'environment.view', { type: 'application', id })).allowed;
      const envs = await q.query<{ id: string }>(
        `SELECT ${ENV_COLS} FROM environments e
          WHERE e.application_id = $1 AND e.archived_at IS NULL
            AND ($3 OR EXISTS (SELECT 1 FROM grants g WHERE g.user_id = $2 AND ${ACTIVE_GRANT}
                                 AND g.scope_type = 'environment' AND g.scope_id = e.id))
          ORDER BY CASE e.kind WHEN 'development' THEN 1 WHEN 'staging' THEN 2 ELSE 3 END, e.name`,
        [id, user.id, seesAll],
      );
      const environments = [];
      for (const env of envs) {
        environments.push({ ...env, permissions: await permissionsOn(q, principal, { type: 'environment', id: env.id }) });
      }
      return { ...application, environments, permissions: await permissionsOn(q, principal, { type: 'application', id }) };
    });
  });

  app.patch('/applications/:id', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    const body = updateAppBody.parse(req.body);
    return db.tenant(user.orgId, async (q) => {
      const chain = await requirePermission(q, principalOf(user), 'application.update', { type: 'application', id });
      const [row] = await q.query(
        `UPDATE applications a SET name = coalesce($2, name), description = coalesce($3, description), updated_at = now()
          WHERE a.id = $1 RETURNING ${APP_COLS}`,
        [id, body.name ?? null, body.description ?? null],
      );
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'application.updated', resourceType: 'application',
        resourceId: id, clientId: chain?.clientId, applicationId: id, details: body,
      });
      return row;
    });
  });

  for (const [verb, archived] of [['archive', true], ['unarchive', false]] as const) {
    app.post(`/applications/:id/${verb}`, async (req) => {
      const { user } = caller(req);
      const { id } = idParam.parse(req.params);
      return db.tenant(user.orgId, async (q) => {
        const chain = await requirePermission(q, principalOf(user), 'application.archive', { type: 'application', id });
        const [row] = await q.query(
          `UPDATE applications a SET archived_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now()
            WHERE a.id = $1 RETURNING ${APP_COLS}`,
          [id, archived],
        );
        await audit(q, {
          orgId: user.orgId, actorId: user.id, action: `application.${verb}d`, resourceType: 'application',
          resourceId: id, clientId: chain?.clientId, applicationId: id,
        });
        return row;
      });
    });
  }

  // ---- environments -------------------------------------------------------

  app.post('/applications/:id/environments', async (req, reply) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    const body = createEnvBody.parse(req.body);
    if (body.kind === 'production' && body.protected === false && !user.isOrgAdmin) {
      throw HttpError.forbidden('Only an org admin can create an unprotected production environment');
    }
    const created = await db.tenant(user.orgId, async (q) => {
      const chain = await requirePermission(q, principalOf(user), 'environment.manage', { type: 'application', id });
      const env = await insertEnvironment(q, user.orgId, id, body);
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'environment.created', resourceType: 'environment',
        resourceId: env.id, clientId: chain?.clientId, applicationId: id, environmentId: env.id,
        details: { name: body.name, kind: body.kind, protected: body.protected ?? body.kind === 'production' },
      });
      return env;
    });
    return reply.status(201).send(created);
  });

  app.patch('/environments/:id', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    const body = updateEnvBody.parse(req.body);
    return db.tenant(user.orgId, async (q) => {
      const chain = await requirePermission(q, principalOf(user), 'environment.manage', { type: 'environment', id });
      // Protection gates who can use the environment, so only org admins may change it.
      // Otherwise an app admin could unprotect production and reach it without an explicit grant.
      if (body.protected !== undefined && !user.isOrgAdmin) {
        throw HttpError.forbidden('Only an org admin can change environment protection');
      }
      const [row] = await q.query(
        `UPDATE environments e SET
           protected  = coalesce($2, protected),
           aws_region = CASE WHEN $3 THEN $4 ELSE aws_region END,
           updated_at = now()
         WHERE e.id = $1 RETURNING ${ENV_COLS}`,
        [id, body.protected ?? null, body.awsRegion !== undefined, body.awsRegion ?? null],
      );
      await audit(q, {
        orgId: user.orgId, actorId: user.id,
        action: body.protected === false ? 'environment.unprotected' : 'environment.updated',
        resourceType: 'environment', resourceId: id,
        clientId: chain?.clientId,
        applicationId: chain && 'applicationId' in chain ? chain.applicationId : undefined,
        environmentId: id, details: body,
      });
      return row;
    });
  });
}
