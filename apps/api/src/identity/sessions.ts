import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db/db.js';

export interface AuthUser {
  id: string;
  orgId: string;
  email: string;
  displayName: string;
  isOrgAdmin: boolean;
}

export interface AuthContext {
  user: AuthUser;
  sessionId: string;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(
  db: Database,
  input: { userId: string; orgId: string; ttlHours: number; ip?: string; userAgent?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + input.ttlHours * 3600_000);
  await db.system((q) =>
    q.query(
      `INSERT INTO sessions (user_id, org_id, token_hash, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.userId, input.orgId, hashToken(token), expiresAt, input.ip ?? null, input.userAgent ?? null],
    ),
  );
  return { token, expiresAt };
}

export async function lookupSession(db: Database, token: string): Promise<AuthContext | undefined> {
  const rows = await db.system((q) =>
    q.query<{
      session_id: string;
      id: string;
      org_id: string;
      email: string;
      display_name: string;
      is_org_admin: boolean;
    }>(
      `SELECT s.id AS session_id, u.id, u.org_id, u.email, u.display_name, u.is_org_admin
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.status = 'active'`,
      [hashToken(token)],
    ),
  );
  const r = rows[0];
  if (!r) return undefined;
  // Record use for "Signed-in devices", at most every 5 minutes per session.
  await db.system((q) =>
    q.query(
      `UPDATE sessions SET last_used_at = now()
        WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`,
      [r.session_id],
    ),
  );
  return {
    sessionId: r.session_id,
    user: { id: r.id, orgId: r.org_id, email: r.email, displayName: r.display_name, isOrgAdmin: r.is_org_admin },
  };
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.system((q) => q.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sessionId]));
}

export async function revokeUserSessions(db: Database, userId: string, exceptSessionId?: string): Promise<void> {
  await db.system((q) =>
    q.query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id IS DISTINCT FROM $2',
      [userId, exceptSessionId ?? null],
    ),
  );
}
