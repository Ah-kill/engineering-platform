import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { caller, SESSION_COOKIE, type RouteDeps } from '../http/app.js';
import { HttpError } from '../http/errors.js';

/**
 * The signed-in user's own sessions ("Signed-in devices" on the Account page).
 *
 *   GET    /me/sessions                active sessions, newest first
 *   DELETE /me/sessions/:id            signs out one of them (may be this one)
 *   POST   /me/sessions/revoke-others  signs out everywhere except here
 *
 * The sessions table is only reachable by the owning role (it is not granted to the
 * request role), so these queries run through db.system and are always limited to the
 * caller's own user id. Tokens and token hashes are never selected.
 */

const idParam = z.object({ id: z.string().uuid() });

export interface SessionView {
  id: string;
  createdAt: string;
  /** When the session was last used, or when it was created if that is not recorded. */
  lastUsedAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  /** The session making this request. */
  current: boolean;
}

export async function sessionRoutes(app: FastifyInstance, { db, config }: RouteDeps) {
  const cookieOptions = { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: config.COOKIE_SECURE };

  app.get('/me/sessions', async (req): Promise<SessionView[]> => {
    const { user, sessionId } = caller(req);
    const rows = await db.system((q) =>
      q.query<{ id: string; created_at: Date; last_used_at: Date | null; expires_at: Date; ip: string | null; user_agent: string | null }>(
        `SELECT s.id, s.created_at, s.last_used_at, s.expires_at, s.ip, s.user_agent
           FROM sessions s
          WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          ORDER BY s.created_at DESC
          LIMIT 100`,
        [user.id],
      ),
    );
    return rows.map((r) => {
      const created = new Date(r.created_at);
      const used = r.last_used_at ? new Date(r.last_used_at) : created;
      return {
        id: r.id,
        createdAt: created.toISOString(),
        lastUsedAt: (Number.isNaN(used.getTime()) ? created : used).toISOString(),
        expiresAt: new Date(r.expires_at).toISOString(),
        ip: r.ip,
        userAgent: r.user_agent ? r.user_agent.slice(0, 300) : null,
        current: r.id === sessionId,
      };
    });
  });

  app.delete('/me/sessions/:id', async (req, reply) => {
    const { user, sessionId } = caller(req);
    const { id } = idParam.parse(req.params);
    // Someone else's session id matches no row here and gets the same 404 as an unknown one.
    const [row] = await db.system((q) =>
      q.query<{ id: string }>(
        'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now() RETURNING id',
        [id, user.id],
      ),
    );
    if (!row) throw HttpError.notFound('Session not found');
    const current = id === sessionId;
    await db.tenant(user.orgId, (q) =>
      audit(q, { orgId: user.orgId, actorId: user.id, action: 'auth.session_revoked', resourceType: 'session', resourceId: id, details: { current } }),
    );
    if (current) reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return { ok: true, signedOut: current };
  });

  app.post('/me/sessions/revoke-others', async (req) => {
    const { user, sessionId } = caller(req);
    const rows = await db.system((q) =>
      q.query<{ id: string }>(
        'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL AND expires_at > now() RETURNING id',
        [user.id, sessionId],
      ),
    );
    await db.tenant(user.orgId, (q) =>
      audit(q, { orgId: user.orgId, actorId: user.id, action: 'auth.sessions_revoked', resourceType: 'user', resourceId: user.id, details: { count: rows.length } }),
    );
    return { ok: true, revoked: rows.length };
  });
}
