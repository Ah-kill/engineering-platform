import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authorize, requirePermission } from '../access/authorize.js';
import { audit } from '../audit/audit.js';
import type { Queryable } from '../db/db.js';
import { caller, type RouteDeps } from '../http/app.js';
import { HttpError } from '../http/errors.js';
import type { AuthUser } from '../identity/sessions.js';
import { principalOf } from '../identity/user-routes.js';
import { budgetDetail, cents, monthBounds } from './budgets.js';

export { checkMonthlyBudget, requireWithinBudget, budgetExceeded, type BudgetStatus } from './budgets.js';

/**
 * Organisation settings and monthly budgets.
 *
 *   GET   /org                  any member: name and default monthly budget
 *   PATCH /org                  org admin: rename, set or clear the default budget
 *   GET   /org/budgets          org admin: every developer's limit and spend this month
 *   GET   /org/budgets/:userId  org admin: one developer
 *   PUT   /org/budgets/:userId  org admin: set or clear one developer's override
 *   GET   /me/budget            any member: their own limit and spend this month
 *
 * Changes need `org.manage_users`, the admin-only permission for organisation settings.
 */

/** Largest budget accepted, in US dollars. */
export const MAX_BUDGET_USD = 1_000_000;
const budget = z.number().finite().min(0).max(MAX_BUDGET_USD).transform(cents);

const patchBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    /** null clears the default (no limit). */
    monthlyBudgetUsd: budget.nullable(),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

const putBudgetBody = z
  .object({
    /** null removes the override, so the organisation default applies. */
    monthlyBudgetUsd: budget.nullable(),
  })
  .strict();

const userParam = z.object({ userId: z.string().uuid() });

interface OrgView {
  id: string;
  name: string;
  slug: string;
  monthlyBudgetUsd: number | null;
}

const ORG_COLS = `id, name, slug, monthly_budget_usd::float8 AS "monthlyBudgetUsd"`;

async function requireAdmin(q: Queryable, user: AuthUser) {
  await requirePermission(q, principalOf(user), 'org.manage_users', { type: 'org' });
}

async function loadUser(q: Queryable, userId: string) {
  const [u] = await q.query<{ id: string; email: string; displayName: string; status: string }>(
    `SELECT id, email, display_name AS "displayName", status FROM users WHERE id = $1`,
    [userId],
  );
  if (!u) throw HttpError.notFound('User not found');
  return u;
}

export async function orgRoutes(app: FastifyInstance, { db }: RouteDeps) {
  app.get('/org', async (req) => {
    const { user } = caller(req);
    return db.tenant(user.orgId, async (q) => {
      const [org] = await q.query<OrgView>(`SELECT ${ORG_COLS} FROM organizations WHERE id = $1`, [user.orgId]);
      if (!org) throw HttpError.notFound();
      const { allowed } = await authorize(q, principalOf(user), 'org.manage_users', { type: 'org' });
      return { ...org, canManage: allowed };
    });
  });

  app.patch('/org', async (req) => {
    const { user } = caller(req);
    const body = patchBody.parse(req.body);
    return db.tenant(user.orgId, async (q) => {
      await requireAdmin(q, user);
      const [org] = await q.query<OrgView>(
        `UPDATE organizations SET
           name = coalesce($2, name),
           monthly_budget_usd = CASE WHEN $3 THEN $4::numeric ELSE monthly_budget_usd END
         WHERE id = $1 RETURNING ${ORG_COLS}`,
        [user.orgId, body.name ?? null, body.monthlyBudgetUsd !== undefined, body.monthlyBudgetUsd ?? null],
      );
      if (!org) throw HttpError.notFound();
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'org.updated', resourceType: 'organization', resourceId: user.orgId,
        details: body,
      });
      return { ...org, canManage: true };
    });
  });

  app.get('/org/budgets', async (req) => {
    const { user } = caller(req);
    return db.tenant(user.orgId, async (q) => {
      await requireAdmin(q, user);
      const { start, end, month } = monthBounds();
      const [org] = await q.query<{ monthlyBudgetUsd: number | null }>(
        `SELECT monthly_budget_usd::float8 AS "monthlyBudgetUsd" FROM organizations WHERE id = $1`,
        [user.orgId],
      );
      const defaultUsd = org?.monthlyBudgetUsd ?? null;
      const rows = await q.query<{ userId: string; email: string; displayName: string; status: string; overrideUsd: number | null; spentUsd: number }>(
        `SELECT u.id AS "userId", u.email, u.display_name AS "displayName", u.status,
                ub.monthly_budget_usd::float8 AS "overrideUsd",
                coalesce(sp.spent, 0)::float8 AS "spentUsd"
           FROM users u
           LEFT JOIN user_budgets ub ON ub.user_id = u.id
           LEFT JOIN (SELECT user_id, sum(cost_usd) AS spent FROM agent_sessions
                       WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz GROUP BY user_id) sp ON sp.user_id = u.id
          ORDER BY u.status, u.display_name`,
        [start.toISOString(), end.toISOString()],
      );
      return {
        month,
        defaultUsd,
        users: rows.map((r) => {
          const limitUsd = r.overrideUsd ?? defaultUsd;
          const spentUsd = Math.round(r.spentUsd * 1e6) / 1e6;
          return { ...r, spentUsd, limitUsd, allowed: limitUsd === null || spentUsd < limitUsd };
        }),
      };
    });
  });

  app.get('/org/budgets/:userId', async (req) => {
    const { user } = caller(req);
    const { userId } = userParam.parse(req.params);
    return db.tenant(user.orgId, async (q) => {
      await requireAdmin(q, user);
      const target = await loadUser(q, userId);
      return { userId, email: target.email, displayName: target.displayName, ...(await budgetDetail(q, user.orgId, userId)) };
    });
  });

  app.put('/org/budgets/:userId', async (req) => {
    const { user } = caller(req);
    const { userId } = userParam.parse(req.params);
    const { monthlyBudgetUsd } = putBudgetBody.parse(req.body);
    return db.tenant(user.orgId, async (q) => {
      await requireAdmin(q, user);
      const target = await loadUser(q, userId);
      if (monthlyBudgetUsd === null) {
        await q.query('DELETE FROM user_budgets WHERE user_id = $1', [userId]);
      } else {
        await q.query(
          `INSERT INTO user_budgets (user_id, org_id, monthly_budget_usd, updated_by) VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id) DO UPDATE SET monthly_budget_usd = EXCLUDED.monthly_budget_usd,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [userId, user.orgId, monthlyBudgetUsd, user.id],
        );
      }
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: monthlyBudgetUsd === null ? 'budget.cleared' : 'budget.set',
        resourceType: 'user', resourceId: userId, details: { email: target.email, monthlyBudgetUsd },
      });
      return { userId, email: target.email, displayName: target.displayName, ...(await budgetDetail(q, user.orgId, userId)) };
    });
  });

  app.get('/me/budget', async (req) => {
    const { user } = caller(req);
    return db.tenant(user.orgId, (q) => budgetDetail(q, user.orgId, user.id));
  });
}
