import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { caller, type RouteDeps } from '../http/app.js';
import { CREDENTIAL_KINDS, MODEL_ID, readAgentSettings, saveCredential, validateCredential } from './credentials.js';

const settingsBody = z
  .object({
    authMode: z.enum(['api_key', 'subscription']),
    defaultModel: z.string().regex(MODEL_ID, 'Not a valid model id'),
  })
  .partial();

const kindParam = z.object({ kind: z.enum(CREDENTIAL_KINDS) });
const credentialBody = z.object({ value: z.string().min(1).max(4096) });

export async function settingsRoutes(app: FastifyInstance, { db, vault }: RouteDeps) {

  /** The caller's agent settings and which credentials are saved (hints only, never values). */
  app.get('/me/settings', async (req) => {
    const { user } = caller(req);
    return db.tenant(user.orgId, async (q) => {
      const settings = await readAgentSettings(q, user.id);
      const creds = await q.query<{ kind: string; hint: string; updated_at: Date }>(
        'SELECT kind, hint, updated_at FROM user_credentials WHERE user_id = $1',
        [user.id],
      );
      const credentials = Object.fromEntries(
        CREDENTIAL_KINDS.map((k) => {
          const c = creds.find((r) => r.kind === k);
          return [k, c ? { saved: true, hint: c.hint, updatedAt: c.updated_at } : { saved: false }];
        }),
      );
      return { ...settings, credentials };
    });
  });

  app.put('/me/settings', async (req) => {
    const { user } = caller(req);
    const body = settingsBody.parse(req.body);
    return db.tenant(user.orgId, async (q) => {
      const current = await readAgentSettings(q, user.id);
      const next = { ...current, ...body };
      await q.query(
        `INSERT INTO user_agent_settings (user_id, org_id, auth_mode, default_model) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET auth_mode = EXCLUDED.auth_mode, default_model = EXCLUDED.default_model, updated_at = now()`,
        [user.id, user.orgId, next.authMode, next.defaultModel],
      );
      await audit(q, { orgId: user.orgId, actorId: user.id, action: 'settings.updated', resourceType: 'user', resourceId: user.id, details: body });
      return next;
    });
  });

  app.put('/me/credentials/:kind', async (req) => {
    const { user } = caller(req);
    const { kind } = kindParam.parse(req.params);
    const value = validateCredential(kind, credentialBody.parse(req.body).value);
    await db.tenant(user.orgId, async (q) => {
      await saveCredential(q, vault, user.orgId, user.id, kind, value);
      await audit(q, { orgId: user.orgId, actorId: user.id, action: 'credential.saved', resourceType: 'user', resourceId: user.id, details: { kind } });
    });
    return { ok: true };
  });

  app.delete('/me/credentials/:kind', async (req) => {
    const { user } = caller(req);
    const { kind } = kindParam.parse(req.params);
    await db.tenant(user.orgId, async (q) => {
      await q.query('DELETE FROM user_credentials WHERE user_id = $1 AND kind = $2', [user.id, kind]);
      await audit(q, { orgId: user.orgId, actorId: user.id, action: 'credential.deleted', resourceType: 'user', resourceId: user.id, details: { kind } });
    });
    return { ok: true };
  });
}
