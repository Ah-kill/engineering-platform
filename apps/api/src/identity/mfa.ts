import { createHash, randomBytes } from 'node:crypto';
import type { Database, Queryable } from '../db/db.js';
import type { Vault } from '../vault/vault.js';
import { base32Encode, verifyTotp } from './mfa-totp.js';

export const MFA_ISSUER = 'Engineering Platform';
export const RECOVERY_CODE_COUNT = 10;
export const CHALLENGE_TTL_MINUTES = 5;
export const CHALLENGE_MAX_ATTEMPTS = 5;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

// ---- recovery codes -------------------------------------------------------

/**
 * 16 base32 characters (80 random bits) shown as XXXX-XXXX-XXXX-XXXX. That is far beyond
 * guessing or offline brute force, so a plain SHA-256 hash is a safe way to store them.
 */
export function generateRecoveryCode(): string {
  return base32Encode(randomBytes(10)).match(/.{4}/g)!.join('-');
}

/** Accepts any case, with or without the dashes and spaces. Null if it cannot be a recovery code. */
export function normalizeRecoveryCode(code: string): string | null {
  const clean = code.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z2-7]{16}$/.test(clean) ? clean : null;
}

/** Replaces all of a user's recovery codes. The returned plaintext codes are shown once and never stored. */
export async function replaceRecoveryCodes(q: Queryable, user: { id: string; orgId: string }): Promise<string[]> {
  await q.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [user.id]);
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  for (const code of codes) {
    await q.query('INSERT INTO mfa_recovery_codes (org_id, user_id, code_hash) VALUES ($1, $2, $3)', [
      user.orgId,
      user.id,
      sha256(normalizeRecoveryCode(code)!),
    ]);
  }
  return codes;
}

// ---- per-user state -------------------------------------------------------

export interface MfaUser {
  id: string;
  orgId: string;
  status: string;
  passwordHash: string;
  mfaEnabled: boolean;
  /** Vault ciphertext. */
  totpSecret: string | null;
  /** Vault ciphertext, set between setup and enable. */
  totpPendingSecret: string | null;
  totpLastStep: number | null;
}

/** Loads a user's two-step state. Internal only: never return this object from a route. */
export async function loadMfaUser(q: Queryable, userId: string): Promise<MfaUser | undefined> {
  const [r] = await q.query<{
    id: string;
    org_id: string;
    status: string;
    password_hash: string;
    mfa_enabled: boolean;
    totp_secret: string | null;
    totp_pending_secret: string | null;
    totp_last_step: string | null;
  }>(
    `SELECT id, org_id, status, password_hash, mfa_enabled, totp_secret, totp_pending_secret,
            totp_last_step::text AS totp_last_step
       FROM users WHERE id = $1`,
    [userId],
  );
  if (!r) return undefined;
  return {
    id: r.id,
    orgId: r.org_id,
    status: r.status,
    passwordHash: r.password_hash,
    mfaEnabled: r.mfa_enabled,
    totpSecret: r.totp_secret,
    totpPendingSecret: r.totp_pending_secret,
    totpLastStep: r.totp_last_step === null ? null : Number(r.totp_last_step),
  };
}

export type SecondFactor = 'totp' | 'recovery_code';

/**
 * Checks a 6-digit authenticator code or a recovery code and spends it. Both updates are
 * conditional, so two requests racing with the same code cannot both succeed.
 */
export async function verifySecondFactor(
  q: Queryable,
  vault: Vault,
  user: MfaUser,
  code: string,
): Promise<SecondFactor | null> {
  const digits = code.replace(/\s/g, '');
  if (/^\d{6}$/.test(digits)) {
    if (!user.totpSecret) return null;
    const step = verifyTotp(vault.decrypt(user.totpSecret), digits, { lastStep: user.totpLastStep });
    if (step === null) return null;
    const rows = await q.query(
      `UPDATE users SET totp_last_step = $2
        WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id`,
      [user.id, step],
    );
    return rows.length > 0 ? 'totp' : null;
  }

  const recovery = normalizeRecoveryCode(code);
  if (!recovery) return null;
  const rows = await q.query(
    `UPDATE mfa_recovery_codes SET used_at = now()
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`,
    [user.id, sha256(recovery)],
  );
  return rows.length > 0 ? 'recovery_code' : null;
}

/** Turns two-step login off and forgets the secret and recovery codes (own disable or admin reset). */
export async function clearMfa(q: Queryable, userId: string): Promise<void> {
  await q.query(
    `UPDATE users SET mfa_enabled = false, totp_secret = NULL, totp_pending_secret = NULL,
            totp_last_step = NULL, updated_at = now()
      WHERE id = $1`,
    [userId],
  );
  await q.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
}

// ---- login challenges -----------------------------------------------------
// Bridge between the password step and the code step. Like sessions, these are only
// touched during authentication, through db.system, and stored as SHA-256 hashes.

export async function createChallenge(db: Database, user: { id: string; orgId: string }): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.system(async (q) => {
    await q.query('DELETE FROM mfa_challenges WHERE expires_at < now()');
    await q.query(
      `INSERT INTO mfa_challenges (user_id, org_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + $4::int * interval '1 minute')`,
      [user.id, user.orgId, sha256(token), CHALLENGE_TTL_MINUTES],
    );
  });
  return token;
}

/**
 * Counts one attempt against a live challenge and returns it, or undefined if it is unknown,
 * expired or out of attempts. Counting before checking the code means parallel guesses
 * cannot get past the limit.
 */
export async function takeChallengeAttempt(
  db: Database,
  token: string,
): Promise<{ id: string; userId: string; orgId: string; attempts: number } | undefined> {
  const rows = await db.system((q) =>
    q.query<{ id: string; user_id: string; org_id: string; attempts: number }>(
      `UPDATE mfa_challenges SET attempts = attempts + 1
        WHERE token_hash = $1 AND expires_at > now() AND attempts < $2
        RETURNING id, user_id, org_id, attempts`,
      [sha256(token), CHALLENGE_MAX_ATTEMPTS],
    ),
  );
  const r = rows[0];
  return r && { id: r.id, userId: r.user_id, orgId: r.org_id, attempts: r.attempts };
}

/** Deletes a challenge; true if this call removed it (so only one request can finish a sign-in). */
export async function finishChallenge(db: Database, id: string): Promise<boolean> {
  const rows = await db.system((q) => q.query('DELETE FROM mfa_challenges WHERE id = $1 RETURNING id', [id]));
  return rows.length > 0;
}

export async function clearChallenges(db: Database, userId: string): Promise<void> {
  await db.system((q) => q.query('DELETE FROM mfa_challenges WHERE user_id = $1', [userId]));
}
