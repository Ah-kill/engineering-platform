import type { Queryable } from '../db/db.js';
import { HttpError } from '../http/errors.js';

/**
 * Monthly Claude budgets per developer.
 *
 * The limit is the developer's own override (user_budgets) or else the organisation's
 * default (organizations.monthly_budget_usd); null means no limit. Spend is the cost of
 * every Claude run that finished in the current UTC calendar month in the developer's
 * conversations: the `costUsd` of their `result` events. Counting by run, not by when the
 * conversation started, means resuming an older conversation still counts this month.
 */

export interface BudgetStatus {
  /** null = no limit. */
  limitUsd: number | null;
  spentUsd: number;
  /** False once spend has reached the limit. */
  allowed: boolean;
}

export interface BudgetDetail extends BudgetStatus {
  /** The developer's own override, if any. */
  overrideUsd: number | null;
  /** The organisation-wide default, if any. */
  defaultUsd: number | null;
  /** YYYY-MM (UTC). */
  month: string;
}

/** Start (inclusive) and end (exclusive) of the UTC calendar month containing `now`. */
export function monthBounds(now: Date = new Date()): { start: Date; end: Date; month: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end, month: start.toISOString().slice(0, 7) };
}

/** Rounds to whole cents, which is what the database stores. */
export const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * This month's spend for user $2 in org $1, between $3 (inclusive) and $4 (exclusive): the
 * cost of each run (`result` event) recorded in that window. Uses agent_events_result_idx.
 */
const SPENT_SQL = `SELECT coalesce(sum(CASE WHEN jsonb_typeof(e.data->'costUsd') = 'number' THEN (e.data->>'costUsd')::numeric ELSE 0 END), 0)::float8
       FROM agent_events e JOIN agent_sessions s ON s.id = e.session_id AND s.org_id = e.org_id
      WHERE e.org_id = $1 AND e.kind = 'result' AND s.user_id = $2
        AND e.created_at >= $3::timestamptz AND e.created_at < $4::timestamptz`;

/**
 * This month's spend per user in the caller's org (RLS), same rules as `budgetDetail`, for
 * lists of developers. Call inside `db.tenant(orgId, …)`.
 */
export async function spendByUser(q: Queryable, now: Date = new Date()): Promise<Map<string, number>> {
  const { start, end } = monthBounds(now);
  const rows = await q.query<{ userId: string; spent: number }>(
    `SELECT s.user_id AS "userId",
            sum(CASE WHEN jsonb_typeof(e.data->'costUsd') = 'number' THEN (e.data->>'costUsd')::numeric ELSE 0 END)::float8 AS spent
       FROM agent_events e JOIN agent_sessions s ON s.id = e.session_id AND s.org_id = e.org_id
      WHERE e.kind = 'result' AND e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz
      GROUP BY s.user_id`,
    [start.toISOString(), end.toISOString()],
  );
  return new Map(rows.map((r) => [r.userId, Math.round(r.spent * 1e6) / 1e6]));
}

export async function budgetDetail(q: Queryable, orgId: string, userId: string, now: Date = new Date()): Promise<BudgetDetail> {
  const { start, end, month } = monthBounds(now);
  const [row] = await q.query<{ override: number | null; fallback: number | null; spent: number }>(
    `SELECT (SELECT ub.monthly_budget_usd::float8 FROM user_budgets ub WHERE ub.user_id = $2 AND ub.org_id = $1) AS override,
            (SELECT o.monthly_budget_usd::float8 FROM organizations o WHERE o.id = $1) AS fallback,
            (${SPENT_SQL}) AS spent`,
    [orgId, userId, start.toISOString(), end.toISOString()],
  );
  const overrideUsd = row?.override ?? null;
  const defaultUsd = row?.fallback ?? null;
  const limitUsd = overrideUsd ?? defaultUsd;
  // Compare and report in micro-dollars (cost_usd's precision) to avoid float noise.
  const spentUsd = Math.round((row?.spent ?? 0) * 1e6) / 1e6;
  return { limitUsd, spentUsd, allowed: limitUsd === null || spentUsd < limitUsd, overrideUsd, defaultUsd, month };
}

/**
 * The developer's monthly limit, this month's spend, and whether another run is allowed.
 * Call inside `db.tenant(orgId, …)`.
 */
export async function checkMonthlyBudget(q: Queryable, orgId: string, userId: string, now: Date = new Date()): Promise<BudgetStatus> {
  const { limitUsd, spentUsd, allowed } = await budgetDetail(q, orgId, userId, now);
  return { limitUsd, spentUsd, allowed };
}

/** The error to throw when a run would exceed the monthly budget. */
export function budgetExceeded(b: BudgetStatus): HttpError {
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  return new HttpError(
    403,
    'budget_exceeded',
    `You have used ${fmt(b.spentUsd)} of your ${fmt(b.limitUsd ?? 0)} monthly Claude budget. Ask an org admin to raise it, or wait until next month.`,
    { limitUsd: b.limitUsd, spentUsd: b.spentUsd },
  );
}

/** Throws `budget_exceeded` (403) when the developer has used up this month's budget. */
export async function requireWithinBudget(q: Queryable, orgId: string, userId: string): Promise<BudgetStatus> {
  const b = await checkMonthlyBudget(q, orgId, userId);
  if (!b.allowed) throw budgetExceeded(b);
  return b;
}
