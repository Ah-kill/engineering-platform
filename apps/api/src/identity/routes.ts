import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { caller, SESSION_COOKIE, type RouteDeps } from '../http/app.js';
import { HttpError } from '../http/errors.js';
import { dummyVerify, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './passwords.js';
import { createSession, revokeSession, revokeUserSessions } from './sessions.js';

const loginBody = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1024),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
});

export async function identityRoutes(app: FastifyInstance, { config, db }: RouteDeps) {
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: config.COOKIE_SECURE,
  };

  app.post(
    '/auth/login',
    { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = loginBody.parse(req.body);
      const rows = await db.system((q) =>
        q.query<{ id: string; org_id: string; password_hash: string; status: string }>(
          'SELECT id, org_id, password_hash, status FROM users WHERE lower(email) = lower($1)',
          [body.email],
        ),
      );
      const user = rows[0];
      const ok = user ? await verifyPassword(user.password_hash, body.password) : await dummyVerify(body.password);

      if (!user || !ok || user.status !== 'active') {
        if (user) {
          await db.tenant(user.org_id, (q) =>
            audit(q, { orgId: user.org_id, actorId: user.id, action: 'auth.login', outcome: 'denied' }),
          );
        }
        throw HttpError.unauthorized('Invalid email or password');
      }

      const session = await createSession(db, {
        userId: user.id,
        orgId: user.org_id,
        ttlHours: config.SESSION_TTL_HOURS,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      await db.tenant(user.org_id, async (q) => {
        await q.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
        await audit(q, { orgId: user.org_id, actorId: user.id, action: 'auth.login' });
      });

      reply.setCookie(SESSION_COOKIE, session.token, { ...cookieOptions, expires: session.expiresAt });
      return { ok: true };
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    const { sessionId, user } = caller(req);
    await revokeSession(db, sessionId);
    await db.tenant(user.orgId, (q) => audit(q, { orgId: user.orgId, actorId: user.id, action: 'auth.logout' }));
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const { user } = caller(req);
    const [org] = await db.tenant(user.orgId, (q) =>
      q.query<{ id: string; name: string; slug: string }>('SELECT id, name, slug FROM organizations'),
    );
    return { user, org };
  });

  app.post(
    '/auth/password',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => {
      const { user, sessionId } = caller(req);
      const body = changePasswordBody.parse(req.body);
      await db.tenant(user.orgId, async (q) => {
        const [row] = await q.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [user.id]);
        if (!row || !(await verifyPassword(row.password_hash, body.currentPassword))) {
          throw HttpError.badRequest('Current password is incorrect');
        }
        await q.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [
          await hashPassword(body.newPassword),
          user.id,
        ]);
        await audit(q, { orgId: user.orgId, actorId: user.id, action: 'auth.password_changed', resourceType: 'user', resourceId: user.id });
      });
      // Other devices are signed out; this session stays.
      await revokeUserSessions(db, user.id, sessionId);
      return { ok: true };
    },
  );
}
