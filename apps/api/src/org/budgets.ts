import type { Queryable } from '../db/db.js';
import { HttpError } from '../http/errors.js';

/**
 * Monthly Claude budgets per developer.
 *
 * The limit is the developer's own override (user_budgets) or else the organisation's
 * default (organizations.monthly_budget_usd); null means no limit. Spend is the sum of
 * agent_sessions.cost_usd for conversations the developer started in the current UTC
 * calendar month, the same day-bucketing as the Usage page (a conversation counts in the
 * month it started, including cost added later).
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

export async function budgetDetail(q: Queryable, orgId: string, userId: string, now: Date = new Date()): Promise<BudgetDetail> {
  const { start, end, month } = monthBounds(now);
  const [row] = await q.query<{ override: number | null; fallback: number | null; spent: number }>(
    `SELECT (SELECT ub.monthly_budget_usd::float8 FROM user_budgets ub WHERE ub.user_id = $2 AND ub.org_id = $1) AS override,
            (SELECT o.monthly_budget_usd::float8 FROM organizations o WHERE o.id = $1) AS fallback,
            (SELECT coalesce(sum(s.cost_usd), 0)::float8 FROM agent_sessions s
              WHERE s.org_id = $1 AND s.user_id = $2 AND s.created_at >= $3::timestamptz AND s.created_at < $4::timestamptz) AS spent`,
    [orgId, userId, start.toISOString(), end.toISOString()],
  );
  const overrideUsd = row?.override ?? null;
  const defaultUsd = row?.fallback ?? null;
  const limitUsd = overrideUsd ?? defaultUsd;
  // cost_usd has 6 decimals; compare and report in micro-dollars to avoid float noise.
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
