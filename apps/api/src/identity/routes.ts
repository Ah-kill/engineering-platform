import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { caller, SESSION_COOKIE, type RouteDeps } from '../http/app.js';
import { HttpError } from '../http/errors.js';
import { createChallenge, finishChallenge, loadMfaUser, takeChallengeAttempt, verifySecondFactor } from './mfa.js';
import { mfaRoutes } from './mfa-routes.js';
import { dummyVerify, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './passwords.js';
import { createSession, revokeSession, revokeUserSessions } from './sessions.js';

const loginBody = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1024),
});

const mfaLoginBody = z.object({
  challenge: z.string().min(1).max(200),
  code: z.string().trim().min(1).max(64),
});

const challengeExpired = () => new HttpError(401, 'mfa_expired', 'This sign-in has expired. Sign in again.');

/** Wrong codes allowed in a row (across all sign-in attempts) before two-step sign-in pauses. */
const MFA_MAX_FAILURES = 10;
const MFA_LOCK_MINUTES = 15;
const mfaLocked = (until: Date) =>
  new HttpError(429, 'mfa_locked', `Too many wrong codes. Two-step sign-in is paused until ${until.toISOString().slice(11, 16)} UTC.`);

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
});

export async function identityRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { config, db, vault } = deps;
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: config.COOKIE_SECURE,
  };

  /** Creates the session and sets the cookie; the same for password-only and two-step sign-in. */
  async function startSession(
    req: FastifyRequest,
    reply: FastifyReply,
    user: { id: string; orgId: string },
    details?: Record<string, unknown>,
  ): Promise<void> {
    const session = await createSession(db, {
      userId: user.id,
      orgId: user.orgId,
      ttlHours: config.SESSION_TTL_HOURS,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    await db.tenant(user.orgId, async (q) => {
      await q.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
      await audit(q, { orgId: user.orgId, actorId: user.id, action: 'auth.login', ...(details ? { details } : {}) });
    });
    reply.setCookie(SESSION_COOKIE, session.token, { ...cookieOptions, expires: session.expiresAt });
  }

  app.post(
    '/auth/login',
    { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = loginBody.parse(req.body);
      const rows = await db.system((q) =>
        q.query<{ id: string; org_id: string; password_hash: string; status: string; mfa_enabled: boolean; mfa_locked_until: Date | null }>(
          'SELECT id, org_id, password_hash, status, mfa_enabled, mfa_locked_until FROM users WHERE lower(email) = lower($1)',
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

      // With two-step login on, the password alone gives no session, only a short-lived challenge.
      if (user.mfa_enabled) {
        if (user.mfa_locked_until && user.mfa_locked_until > new Date()) throw mfaLocked(user.mfa_locked_until);
        const challenge = await createChallenge(db, { id: user.id, orgId: user.org_id });
        return { mfaRequired: true, challenge };
      }

      await startSession(req, reply, { id: user.id, orgId: user.org_id });
      return { ok: true };
    },
  );

  /** Second step: exchanges a challenge and an authenticator or recovery code for a session. */
  app.post(
    '/auth/login/mfa',
    { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = mfaLoginBody.parse(req.body);
      const challenge = await takeChallengeAttempt(db, body.challenge);
      if (!challenge) throw challengeExpired();

      const outcome = await db.tenant(challenge.orgId, async (q) => {
        const user = await loadMfaUser(q, challenge.userId);
        if (!user || user.status !== 'active' || !user.mfaEnabled) return 'gone' as const;
        const [lock] = await q.query<{ mfa_locked_until: Date | null }>('SELECT mfa_locked_until FROM users WHERE id = $1', [user.id]);
        if (lock?.mfa_locked_until && lock.mfa_locked_until > new Date()) return { locked: lock.mfa_locked_until };
        const method = await verifySecondFactor(q, vault, user, body.code);
        // Count wrong codes per user across challenges; pause after too many in a row.
        if (method) {
          await q.query('UPDATE users SET mfa_failures = 0 WHERE id = $1', [user.id]);
        } else {
          await q.query(
            `UPDATE users SET
               mfa_failures = CASE WHEN mfa_failures + 1 >= $2 THEN 0 ELSE mfa_failures + 1 END,
               mfa_locked_until = CASE WHEN mfa_failures + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE mfa_locked_until END
             WHERE id = $1`,
            [user.id, MFA_MAX_FAILURES, MFA_LOCK_MINUTES],
          );
        }
        await audit(q, {
          orgId: challenge.orgId,
          actorId: user.id,
          action: 'auth.mfa',
          outcome: method ? 'success' : 'denied',
          details: method ? { method } : { attempt: challenge.attempts },
        });
        return method;
      });

      if (outcome && typeof outcome === 'object') {
        await finishChallenge(db, challenge.id);
        throw mfaLocked(outcome.locked);
      }
      if (outcome === 'gone') {
        await finishChallenge(db, challenge.id);
        throw challengeExpired();
      }
      if (!outcome) throw HttpError.unauthorized('Invalid code');
      if (!(await finishChallenge(db, challenge.id))) throw challengeExpired();

      await startSession(req, reply, { id: challenge.userId, orgId: challenge.orgId }, { mfa: outcome });
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

  await mfaRoutes(app, deps);
}
