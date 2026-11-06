import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import type { Queryable } from '../db/db.js';
import { caller, type RouteDeps } from '../http/app.js';
import { HttpError } from '../http/errors.js';
import { clearChallenges, clearMfa, loadMfaUser, MFA_ISSUER, replaceRecoveryCodes, verifySecondFactor, type MfaUser } from './mfa.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './mfa-totp.js';
import { verifyPassword } from './passwords.js';
import { revokeUserSessions } from './sessions.js';

const codeBody = z.object({ code: z.string().trim().min(1).max(64) });
const disableBody = z.object({ password: z.string().min(1).max(1024), code: z.string().trim().min(1).max(64) });

/** Code-checking routes are limited per user, so one person cannot guess codes quickly. */
const perUser = (max: number) => ({
  rateLimit: { max, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => req.auth?.user.id ?? req.ip },
});

/** Two-step login (authenticator app) for the signed-in user. */
export async function mfaRoutes(app: FastifyInstance, { db, vault }: RouteDeps) {
  async function load(q: Queryable, userId: string): Promise<MfaUser> {
    const u = await loadMfaUser(q, userId);
    if (!u) throw HttpError.notFound();
    return u;
  }

  app.get('/me/mfa', async (req) => {
    const { user } = caller(req);
    const [row] = await db.tenant(user.orgId, (q) =>
      q.query<{ enabled: boolean; recoveryCodesLeft: number }>(
        `SELECT u.mfa_enabled AS enabled,
                (SELECT count(*) FROM mfa_recovery_codes c WHERE c.user_id = u.id AND c.used_at IS NULL)::int AS "recoveryCodesLeft"
           FROM users u WHERE u.id = $1`,
        [user.id],
      ),
    );
    if (!row) throw HttpError.notFound();
    return row;
  });

  /** Starts enrolment: a new secret is kept as pending until a code from it confirms the app works. */
  app.post('/me/mfa/setup', { config: perUser(10) }, async (req, reply) => {
    const { user } = caller(req);
    const secret = generateTotpSecret();
    await db.tenant(user.orgId, async (q) => {
      const u = await load(q, user.id);
      if (u.mfaEnabled) throw HttpError.conflict('Two-step login is already on. Turn it off first to set it up again.');
      await q.query('UPDATE users SET totp_pending_secret = $2, updated_at = now() WHERE id = $1', [user.id, vault.encrypt(secret)]);
      await audit(q, { orgId: user.orgId, actorId: user.id, action: 'mfa.setup', resourceType: 'user', resourceId: user.id });
    });
    const url = otpauthUrl({ secret, issuer: MFA_ISSUER, account: user.email });
    const qrDataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
    reply.header('cache-control', 'no-store');
    return { otpauthUrl: url, qrDataUrl, secret };
  });

  /** Confirms the pending secret with a code, turns two-step login on and returns recovery codes once. */
  app.post('/me/mfa/enable', { config: perUser(10) }, async (req, reply) => {
    const { user, sessionId } = caller(req);
    const { code } = codeBody.parse(req.body);
    const codes = await db.tenant(user.orgId, async (q) => {
      const u = await load(q, user.id);
      if (u.mfaEnabled) throw HttpError.conflict('Two-step login is already on');
      if (!u.totpPendingSecret) throw HttpError.badRequest('Start the setup first');
      const step = verifyTotp(vault.decrypt(u.totpPendingSecret), code.replace(/\s/g, ''));
      if (step === null) {
        await audit(q, { orgId: user.orgId, actorId: user.id, action: 'mfa.enable', resourceType: 'user', resourceId: user.id, outcome: 'denied' });
        return null;
      }
      // The confirming code's step is recorded, so the same code cannot then be used to sign in.
      await q.query(
        `UPDATE users SET mfa_enabled = true, totp_secret = totp_pending_secret, totp_pending_secret = NULL,
                totp_last_step = $2, updated_at = now()
          WHERE id = $1`,
        [user.id, step],
      );
      const recoveryCodes = await replaceRecoveryCodes(q, user);
      await audit(q, { orgId: user.orgId, actorId: user.id, action: 'mfa.enable', resourceType: 'user', resourceId: user.id });
      return recoveryCodes;
    });
    if (!codes) throw HttpError.badRequest('That code is not right. Check that the time on your phone is set automatically, then try again.');
    // Other devices were signed in with the password alone; they are signed out. This session stays.
    await revokeUserSessions(db, user.id, sessionId);
    reply.header('cache-control', 'no-store');
    return { recoveryCodes: codes };
  });

  /** Needs both the password and a current code (or a recovery code). */
  app.post('/me/mfa/disable', { config: perUser(5) }, async (req) => {
    const { user } = caller(req);
    const body = disableBody.parse(req.body);
    const ok = await db.tenant(user.orgId, async (q) => {
      const u = await load(q, user.id);
      if (!u.mfaEnabled) throw HttpError.badRequest('Two-step login is not on');
      const method = (await verifyPassword(u.passwordHash, body.password)) ? await verifySecondFactor(q, vault, u, body.code) : null;
      if (!method) {
        await audit(q, { orgId: user.orgId, actorId: user.id, action: 'mfa.disable', resourceType: 'user', resourceId: user.id, outcome: 'denied' });
        return false;
      }
      await clearMfa(q, user.id);
      await audit(q, { orgId: user.orgId, actorId: user.id, action: 'mfa.disable', resourceType: 'user', resourceId: user.id, details: { method } });
      return true;
    });
    if (!ok) throw HttpError.badRequest('Password or code is incorrect');
    await clearChallenges(db, user.id);
    return { ok: true };
  });

  /** Replaces all recovery codes (old ones stop working) after a current code. */
  app.post('/me/mfa/recovery-codes', { config: perUser(5) }, async (req, reply) => {
    const { user } = caller(req);
    const { code } = codeBody.parse(req.body);
    const codes = await db.tenant(user.orgId, async (q) => {
      const u = await load(q, user.id);
      if (!u.mfaEnabled) throw HttpError.badRequest('Two-step login is not on');
      const method = await verifySecondFactor(q, vault, u, code);
      if (!method) {
        await audit(q, { orgId: user.orgId, actorId: user.id, action: 'mfa.recovery_codes', resourceType: 'user', resourceId: user.id, outcome: 'denied' });
        return null;
      }
      const recoveryCodes = await replaceRecoveryCodes(q, user);
      await audit(q, { orgId: user.orgId, actorId: user.id, action: 'mfa.recovery_codes', resourceType: 'user', resourceId: user.id, details: { method } });
      return recoveryCodes;
    });
    if (!codes) throw HttpError.badRequest('That code is not right');
    reply.header('cache-control', 'no-store');
    return { recoveryCodes: codes };
  });
}
