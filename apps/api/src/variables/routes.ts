import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../access/authorize.js';
import { audit } from '../audit/audit.js';
import type { Queryable } from '../db/db.js';
import { caller, type RouteDeps } from '../http/app.js';
import { HttpError } from '../http/errors.js';
import type { AuthUser } from '../identity/sessions.js';
import { principalOf } from '../identity/user-routes.js';
import { BUILTIN_HOSTS, HOST_RULE } from '../workspaces/runtime.js';
import { listVariables, parseDotEnv, upsertVariable, validateName } from './variables.js';

const envParam = z.object({ id: z.string().uuid() });
const nameParam = z.object({ id: z.string().uuid(), name: z.string().max(128) });
const putBody = z.object({
  value: z.string(),
  isSecret: z.boolean().default(true),
  description: z.string().trim().max(500).default(''),
});
const importBody = z.object({ text: z.string().max(256 * 1024), isSecret: z.boolean().default(true) });
const networkBody = z.object({
  mode: z.enum(['restricted', 'open']),
  hosts: z.array(z.string().trim().toLowerCase()).max(100).default([]),
});

/**
 * Changing variables needs `environment.manage`. On a protected (production) environment
 * only org admins may change them, matching who may grant production access.
 */
async function requireManage(q: Queryable, user: AuthUser, environmentId: string) {
  const chain = await requirePermission(q, principalOf(user), 'environment.manage', { type: 'environment', id: environmentId });
  if (chain && 'protected' in chain && chain.protected && !user.isOrgAdmin) {
    throw HttpError.forbidden('Only an org admin can change variables of a protected environment');
  }
  return chain as { clientId: string; applicationId: string; environmentId: string; protected: boolean };
}

export async function variableRoutes(app: FastifyInstance, { db, vault }: RouteDeps) {
  app.get('/environments/:id/variables', async (req) => {
    const { user } = caller(req);
    const { id } = envParam.parse(req.params);
    return db.tenant(user.orgId, async (q) => {
      await requirePermission(q, principalOf(user), 'environment.view', { type: 'environment', id });
      return listVariables(q, id);
    });
  });

  app.put('/environments/:id/variables/:name', async (req) => {
    const { user } = caller(req);
    const { id, name } = nameParam.parse(req.params);
    const body = putBody.parse(req.body);
    validateName(name);
    return db.tenant(user.orgId, async (q) => {
      const chain = await requireManage(q, user, id);
      await upsertVariable(q, vault, { orgId: user.orgId, environmentId: id, userId: user.id, name, value: body.value, isSecret: body.isSecret, description: body.description });
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'variable.set', resourceType: 'environment', resourceId: id,
        clientId: chain.clientId, applicationId: chain.applicationId, environmentId: id,
        details: { name, secret: body.isSecret }, // never the value
      });
      return listVariables(q, id);
    });
  });

  app.post('/environments/:id/variables/import', async (req) => {
    const { user } = caller(req);
    const { id } = envParam.parse(req.params);
    const body = importBody.parse(req.body);
    const entries = parseDotEnv(body.text);
    if (!entries.length) throw HttpError.badRequest('No variables found');
    if (entries.length > 500) throw HttpError.badRequest('Too many variables (500 maximum)');
    for (const e of entries) validateName(e.name);
    return db.tenant(user.orgId, async (q) => {
      const chain = await requireManage(q, user, id);
      for (const e of entries) {
        await upsertVariable(q, vault, { orgId: user.orgId, environmentId: id, userId: user.id, name: e.name, value: e.value, isSecret: body.isSecret, description: '' });
      }
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'variable.imported', resourceType: 'environment', resourceId: id,
        clientId: chain.clientId, applicationId: chain.applicationId, environmentId: id,
        details: { names: entries.map((e) => e.name), secret: body.isSecret },
      });
      return listVariables(q, id);
    });
  });

  app.delete('/environments/:id/variables/:name', async (req) => {
    const { user } = caller(req);
    const { id, name } = nameParam.parse(req.params);
    return db.tenant(user.orgId, async (q) => {
      const chain = await requireManage(q, user, id);
      const [row] = await q.query('DELETE FROM environment_variables WHERE environment_id = $1 AND name = $2 RETURNING id', [id, name]);
      if (!row) throw HttpError.notFound('Variable not found');
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'variable.deleted', resourceType: 'environment', resourceId: id,
        clientId: chain.clientId, applicationId: chain.applicationId, environmentId: id, details: { name },
      });
      return listVariables(q, id);
    });
  });

  // ---- network policy ----------------------------------------------------

  app.get('/applications/:id/network', async (req) => {
    const { user } = caller(req);
    const { id } = envParam.parse(req.params);
    return db.tenant(user.orgId, async (q) => {
      await requirePermission(q, principalOf(user), 'application.view', { type: 'application', id });
      const [row] = await q.query<{ mode: string; hosts: string[] }>('SELECT egress_mode AS mode, egress_hosts AS hosts FROM applications WHERE id = $1', [id]);
      return { ...row, builtin: BUILTIN_HOSTS };
    });
  });

  app.put('/applications/:id/network', async (req) => {
    const { user } = caller(req);
    const { id } = envParam.parse(req.params);
    const body = networkBody.parse(req.body);
    const hosts = [...new Set(body.hosts.filter(Boolean))];
    const bad = hosts.filter((h) => !HOST_RULE.test(h));
    if (bad.length) throw HttpError.badRequest(`Not a host name: ${bad.slice(0, 3).join(', ')}. Use api.example.com, *.example.com or host:port.`);
    return db.tenant(user.orgId, async (q) => {
      const chain = await requirePermission(q, principalOf(user), 'application.update', { type: 'application', id });
      await q.query('UPDATE applications SET egress_mode = $2, egress_hosts = $3, updated_at = now() WHERE id = $1', [id, body.mode, hosts]);
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'network.updated', resourceType: 'application', resourceId: id,
        clientId: chain?.clientId, applicationId: id, details: { mode: body.mode, hosts },
      });
      return { mode: body.mode, hosts, builtin: BUILTIN_HOSTS };
    });
  });
}
