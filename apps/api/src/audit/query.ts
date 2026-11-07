import { z } from 'zod';

/**
 * Filters shared by GET /audit and GET /audit/export.csv. Every value is validated here
 * and reaches SQL only as a bound parameter.
 */

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` (a UTC day) or a full ISO 8601 timestamp with a time zone. */
const dateOrTimestamp = z
  .string()
  .trim()
  .max(40)
  .refine((s) => {
    if (DATE_ONLY.test(s)) {
      const d = new Date(`${s}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
    }
    return z.iso.datetime({ offset: true }).safeParse(s).success;
  }, 'Use YYYY-MM-DD or an ISO 8601 timestamp');

/** Lower-case dotted action names such as `git.`, `git.push` or `auth.login`. */
export const ACTION_PREFIX = /^[a-z][a-z0-9_]*(\.[a-z0-9_]*)*$/;

export const auditFilterShape = {
  clientId: z.string().uuid().optional(),
  applicationId: z.string().uuid().optional(),
  environmentId: z.string().uuid().optional(),
  /** Events about this workspace: its resource id, or `details.workspaceId` (agent runs). */
  workspaceId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  /** Action prefix: `git.` matches every git action, `git.push` that action (and `git.push_*`). */
  action: z.string().trim().max(64).regex(ACTION_PREFIX, 'Lower-case action prefix such as git. or auth.login').optional(),
  outcome: z.enum(['success', 'denied', 'failure']).optional(),
  /** Inclusive. A plain date means the start of that UTC day. */
  from: dateOrTimestamp.optional(),
  /** Inclusive. A plain date means the whole of that UTC day. */
  to: dateOrTimestamp.optional(),
  /** Only events with an id lower than this (cursor pagination, "Load older"). */
  before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
};

type RawFilters = z.infer<z.ZodObject<typeof auditFilterShape>>;

export interface AuditFilters extends Omit<RawFilters, 'from' | 'to'> {
  /** Inclusive lower bound. */
  fromTs?: Date;
  /** Exclusive upper bound. */
  toTs?: Date;
}

function bounds<T extends RawFilters>(f: T, ctx: z.RefinementCtx): Omit<T, 'from' | 'to'> & { fromTs?: Date; toTs?: Date } {
  const { from, to, ...rest } = f;
  const fromTs = from === undefined ? undefined : new Date(DATE_ONLY.test(from) ? `${from}T00:00:00Z` : from);
  // Exclusive upper bound: the next UTC day for a date, one millisecond later for a timestamp.
  const toTs =
    to === undefined
      ? undefined
      : DATE_ONLY.test(to)
        ? new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS)
        : new Date(Date.parse(to) + 1);
  if (fromTs && toTs && fromTs >= toTs) {
    ctx.addIssue({ code: 'custom', path: ['from'], message: '`from` must be before `to`' });
  }
  return { ...rest, ...(fromTs ? { fromTs } : {}), ...(toTs ? { toTs } : {}) };
}

export const MAX_PAGE = 200;
export const MAX_EXPORT_ROWS = 50_000;

export const listQuery = z
  .object({ ...auditFilterShape, limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(50) })
  .strict()
  .transform(bounds);

export const exportQuery = z
  .object({ ...auditFilterShape, limit: z.coerce.number().int().min(1).max(MAX_EXPORT_ROWS).default(MAX_EXPORT_ROWS) })
  .strict()
  .transform(bounds);

/** The WHERE clause for the filters, with `$1..$n` placeholders in `params` order. */
export function auditWhere(f: AuditFilters): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const conds: string[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.clientId) conds.push(`ae.client_id = ${p(f.clientId)}::uuid`);
  if (f.applicationId) conds.push(`ae.application_id = ${p(f.applicationId)}::uuid`);
  if (f.environmentId) conds.push(`ae.environment_id = ${p(f.environmentId)}::uuid`);
  if (f.workspaceId) {
    const ref = p(f.workspaceId);
    conds.push(`(ae.resource_id = ${ref}::uuid OR ae.details->>'workspaceId' = ${ref}::text)`);
  }
  if (f.actorId) conds.push(`ae.actor_id = ${p(f.actorId)}::uuid`);
  // starts_with, not LIKE: `_` is a LIKE wildcard and appears in action names.
  if (f.action) conds.push(`starts_with(ae.action, ${p(f.action)}::text)`);
  if (f.outcome) conds.push(`ae.outcome = ${p(f.outcome)}::text`);
  if (f.fromTs) conds.push(`ae.occurred_at >= ${p(f.fromTs.toISOString())}::timestamptz`);
  if (f.toTs) conds.push(`ae.occurred_at < ${p(f.toTs.toISOString())}::timestamptz`);
  if (f.before) conds.push(`ae.id < ${p(f.before)}::bigint`);
  return { sql: conds.length ? conds.join(' AND ') : 'true', params };
}

export const AUDIT_COLUMNS = `ae.id::text AS id, ae.occurred_at AS "occurredAt", ae.action, ae.outcome,
  ae.resource_type AS "resourceType", ae.resource_id AS "resourceId",
  ae.client_id AS "clientId", c.name AS "clientName",
  ae.application_id AS "applicationId", a.name AS "applicationName",
  ae.environment_id AS "environmentId", e.name AS "environmentName",
  ae.actor_id AS "actorId", u.email AS "actorEmail", ae.details`;

export const AUDIT_FROM = `audit_events ae
  LEFT JOIN users u ON u.id = ae.actor_id
  LEFT JOIN clients c ON c.id = ae.client_id
  LEFT JOIN applications a ON a.id = ae.application_id
  LEFT JOIN environments e ON e.id = ae.environment_id`;

export interface AuditRow {
  id: string;
  occurredAt: Date | string;
  action: string;
  outcome: string;
  resourceType: string | null;
  resourceId: string | null;
  clientId: string | null;
  clientName: string | null;
  applicationId: string | null;
  applicationName: string | null;
  environmentId: string | null;
  environmentName: string | null;
  actorId: string | null;
  actorEmail: string | null;
  details: unknown;
}

// ---- CSV ----------------------------------------------------------------------

/**
 * One CSV cell. Text a spreadsheet would read as a formula (starting with = + - @, or a
 * tab or carriage return) gets a leading apostrophe; then RFC 4180 quoting.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADER = [
  'id', 'occurred_at', 'actor_email', 'actor_id', 'action', 'outcome', 'resource_type', 'resource_id',
  'client', 'client_id', 'application', 'application_id', 'environment', 'environment_id', 'details',
];

export function csvLine(r: AuditRow): string {
  const occurred = r.occurredAt instanceof Date ? r.occurredAt : new Date(r.occurredAt);
  return [
    r.id, occurred.toISOString(), r.actorEmail, r.actorId, r.action, r.outcome, r.resourceType, r.resourceId,
    r.clientName, r.clientId, r.applicationName, r.applicationId, r.environmentName, r.environmentId, r.details ?? {},
  ].map(csvCell).join(',') + '\r\n';
}
