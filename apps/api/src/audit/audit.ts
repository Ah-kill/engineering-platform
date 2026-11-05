import type { Queryable } from '../db/db.js';

export interface AuditEvent {
  orgId: string;
  actorId: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  clientId?: string;
  applicationId?: string;
  environmentId?: string;
  outcome?: 'success' | 'denied' | 'failure';
  /** Must never contain secrets or passwords. Keys matching SENSITIVE_KEY are dropped. */
  details?: Record<string, unknown>;
}

const SENSITIVE_KEY = /pass(word)?|secret|token|key|credential|authorization|cookie/i;

export function redact(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (SENSITIVE_KEY.test(k)) continue;
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) ? redact(v as Record<string, unknown>) : v;
  }
  return out;
}

/** Records an audit event inside the caller's transaction, so it commits or rolls back with the change. */
export async function audit(q: Queryable, e: AuditEvent): Promise<void> {
  await q.query(
    `INSERT INTO audit_events
       (org_id, actor_id, action, resource_type, resource_id, client_id, application_id, environment_id, outcome, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      e.orgId,
      e.actorId,
      e.action,
      e.resourceType ?? null,
      e.resourceId ?? null,
      e.clientId ?? null,
      e.applicationId ?? null,
      e.environmentId ?? null,
      e.outcome ?? 'success',
      JSON.stringify(redact(e.details ?? {})),
    ],
  );
}
