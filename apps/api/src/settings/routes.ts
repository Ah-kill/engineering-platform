import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { caller, type RouteDeps } from '../http/app.js';
import { HttpError } from '../http/errors.js';
import { listUserRepos } from '../git/github.js';
import {
  CREDENTIAL_KINDS, deleteCredential, listGithubTokens, MODEL_ID, normaliseGithubOwner, readAgentSettings, readGithubToken,
  saveCredential, validateCredential,
} from './credentials.js';

const settingsBody = z
  .object({
    authMode: z.enum(['api_key', 'subscription']),
    defaultModel: z.string().regex(MODEL_ID, 'Not a valid model id'),
  })
  .partial();

const kindParam = z.object({ kind: z.enum(CREDENTIAL_KINDS) });
/** `owner` (GitHub tokens only): the organization or user the token is for; omitted = default token. */
const credentialBody = z.object({ value: z.string().min(1).max(4096), owner: z.string().max(39).optional() });
const ownerQuery = z.object({ owner: z.string().max(39).optional() });

export async function settingsRoutes(app: FastifyInstance, { db, vault }: RouteDeps) {

  /**
   * The caller's agent settings and which credentials are saved (hints only, never values).
   * `credentials.github_token` is the default token; `githubTokens` lists every GitHub token by owner.
   */
  app.get('/me/settings', async (req) => {
    const { user } = caller(req);
    return db.tenant(user.orgId, async (q) => {
      const settings = await readAgentSettings(q, user.id);
      const creds = await q.query<{ kind: string; hint: string; updated_at: Date }>(
        'SELECT kind, hint, updated_at FROM user_credentials WHERE user_id = $1 AND github_owner IS NULL',
        [user.id],
      );
      const credentials = Object.fromEntries(
        CREDENTIAL_KINDS.map((k) => {
          const c = creds.find((r) => r.kind === k);
          return [k, c ? { saved: true, hint: c.hint, updatedAt: c.updated_at } : { saved: false }];
        }),
      );
      return { ...settings, credentials, githubTokens: await listGithubTokens(q, user.id) };
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
    const body = credentialBody.parse(req.body);
    const value = validateCredential(kind, body.value);
    const owner = normaliseGithubOwner(body.owner);
    if (owner && kind !== 'github_token') throw HttpError.badRequest('Only GitHub tokens can be saved per owner');
    await db.tenant(user.orgId, async (q) => {
      await saveCredential(q, vault, user.orgId, user.id, kind, value, owner);
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'credential.saved', resourceType: 'user', resourceId: user.id,
        details: { kind, ...(owner ? { githubOwner: owner } : {}) },
      });
    });
    return { ok: true };
  });

  app.delete('/me/credentials/:kind', async (req) => {
    const { user } = caller(req);
    const { kind } = kindParam.parse(req.params);
    const owner = normaliseGithubOwner(ownerQuery.parse(req.query).owner);
    await db.tenant(user.orgId, async (q) => {
      await deleteCredential(q, user.id, kind, owner);
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'credential.deleted', resourceType: 'user', resourceId: user.id,
        details: { kind, ...(owner ? { githubOwner: owner } : {}) },
      });
    });
    return { ok: true };
  });

  /**
   * Repositories the caller's GitHub token can reach, for the repository picker. With
   * `owner`, uses that owner's token (or the default one) and lists only its repositories.
   */
  app.get('/me/github/repos', async (req) => {
    const { user } = caller(req);
    const owner = normaliseGithubOwner(ownerQuery.parse(req.query).owner);
    const token = await db.tenant(user.orgId, (q) => readGithubToken(q, vault, user.id, owner));
    if (!token) throw HttpError.badRequest('Add a GitHub token in Settings to list your repositories');
    return listUserRepos(token, owner ?? undefined);
  });
}
