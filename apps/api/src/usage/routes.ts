import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authorize } from '../access/authorize.js';
import type { Queryable } from '../db/db.js';
import { caller, type RouteDeps } from '../http/app.js';
import { principalOf } from '../identity/user-routes.js';

/** Longest range one request may cover, in days (inclusive). */
export const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;
const DAY_MS = 86_400_000;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Not a real date');

const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (s: string) => Date.parse(`${s}T00:00:00Z`);

/**
 * `from` and `to` are inclusive UTC days. Either may be omitted: the default is the
 * last 30 days ending today, and a lone `from` or `to` is completed from the other end.
 */
export const usageQuery = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .transform(({ from, to }, ctx) => {
    const end = to ?? (from ? toDay(Math.max(dayMs(from), Date.now())) : toDay(Date.now()));
    const start = from ?? toDay(dayMs(end) - (DEFAULT_RANGE_DAYS - 1) * DAY_MS);
    const days = (dayMs(end) - dayMs(start)) / DAY_MS + 1;
    if (days < 1) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: '`from` must be on or before `to`' });
      return z.NEVER;
    }
    if (days > MAX_RANGE_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: `The range can cover at most ${MAX_RANGE_DAYS} days` });
      return z.NEVER;
    }
    return { from: start, to: end, days };
  });

export interface UsageNumbers {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  sessions: number;
}

export interface UsageReport {
  from: string;
  to: string;
  /** `org`: every developer in the organization (org admins). `self`: only the caller's own usage. */
  scope: 'org' | 'self';
  totals: UsageNumbers;
  /** One entry per UTC day in the range, zero-filled. */
  byDay: (UsageNumbers & { day: string })[];
  byUser: (UsageNumbers & { userId: string; email: string; displayName: string })[];
  byApplication: (UsageNumbers & { applicationId: string; applicationName: string; clientId: string; clientName: string })[];
  byModel: (UsageNumbers & { model: string })[];
}

// Sums come back as numeric/bigint, which drivers return as strings; cast to float8 so the
// JSON carries numbers. float8 is exact for token counts far beyond anything realistic.
const SUMS = `coalesce(sum(s.cost_usd), 0)::float8 AS "costUsd",
              coalesce(sum(s.input_tokens), 0)::float8 AS "inputTokens",
              coalesce(sum(s.output_tokens), 0)::float8 AS "outputTokens",
              count(s.id)::int AS "sessions"`;

// $1 start (inclusive), $2 end (exclusive), $3 user filter or null. A conversation counts
// on the UTC day it started; its cost accumulates on that row as it continues.
const FILTER = `s.created_at >= $1::timestamptz AND s.created_at < $2::timestamptz AND ($3::uuid IS NULL OR s.user_id = $3::uuid)`;
const ORDER = `ORDER BY "costUsd" DESC, "sessions" DESC`;

export async function usageReport(q: Queryable, range: { from: string; to: string }, userId: string | null): Promise<Omit<UsageReport, 'scope'>> {
  const params = [`${range.from}T00:00:00Z`, new Date(dayMs(range.to) + DAY_MS).toISOString(), userId];

  const [totals] = await q.query<UsageNumbers>(`SELECT ${SUMS} FROM agent_sessions s WHERE ${FILTER}`, params);

  const byDay = await q.query<UsageNumbers & { day: string }>(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, ${SUMS}
       FROM generate_series($4::timestamp, $5::timestamp, interval '1 day') AS d(day)
       LEFT JOIN agent_sessions s ON (s.created_at AT TIME ZONE 'UTC')::date = d.day::date AND ${FILTER}
      GROUP BY d.day
      ORDER BY d.day`,
    [...params, range.from, range.to],
  );

  const byUser = await q.query<UsageReport['byUser'][number]>(
    `SELECT u.id AS "userId", u.email, u.display_name AS "displayName", ${SUMS}
       FROM agent_sessions s JOIN users u ON u.id = s.user_id
      WHERE ${FILTER}
      GROUP BY u.id, u.email, u.display_name
      ${ORDER}, u.email`,
    params,
  );

  const byApplication = await q.query<UsageReport['byApplication'][number]>(
    `SELECT a.id AS "applicationId", a.name AS "applicationName", c.id AS "clientId", c.name AS "clientName", ${SUMS}
       FROM agent_sessions s
       JOIN workspaces w ON w.id = s.workspace_id
       JOIN applications a ON a.id = w.application_id
       JOIN clients c ON c.id = a.client_id
      WHERE ${FILTER}
      GROUP BY a.id, a.name, c.id, c.name
      ${ORDER}, c.name, a.name`,
    params,
  );

  const byModel = await q.query<UsageReport['byModel'][number]>(
    `SELECT s.model, ${SUMS} FROM agent_sessions s WHERE ${FILTER} GROUP BY s.model ${ORDER}, s.model`,
    params,
  );

  return { from: range.from, to: range.to, totals: totals!, byDay, byUser, byApplication, byModel };
}

export async function usageRoutes(app: FastifyInstance, { db }: RouteDeps) {
  /**
   * Agent usage and cost. Org admins (who may read the audit log) see the whole
   * organization; everyone else sees only their own conversations.
   */
  app.get('/usage', async (req): Promise<UsageReport> => {
    const { user } = caller(req);
    const range = usageQuery.parse(req.query);
    return db.tenant(user.orgId, async (q) => {
      const { allowed } = await authorize(q, principalOf(user), 'org.read_audit', { type: 'org' });
      const report = await usageReport(q, range, allowed ? null : user.id);
      return { ...report, scope: allowed ? 'org' : 'self' };
    });
  });
}
