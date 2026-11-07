-- Organisation settings and monthly Claude budgets per developer.
--
-- organizations.monthly_budget_usd is the default monthly limit for every developer
-- (NULL = no limit). user_budgets overrides it for one developer. Spend is the sum of
-- agent_sessions.cost_usd started in the current UTC calendar month (src/org/budgets.ts).

ALTER TABLE organizations
  ADD COLUMN monthly_budget_usd numeric(12, 2) CHECK (monthly_budget_usd IS NULL OR monthly_budget_usd >= 0);

-- Admins rename the organisation and set the default budget from the app. RLS on
-- organizations (org_isolation, 001) already limits every command to the caller's org.
GRANT UPDATE (name, monthly_budget_usd) ON organizations TO platform_app;

CREATE TABLE user_budgets (
  user_id             uuid PRIMARY KEY,
  org_id              uuid NOT NULL,
  monthly_budget_usd  numeric(12, 2) NOT NULL CHECK (monthly_budget_usd >= 0),
  updated_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);

ALTER TABLE user_budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_budgets
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON user_budgets TO platform_app;

-- The audit log is read newest-first by id within an org (list, "Load older", CSV export).
CREATE INDEX IF NOT EXISTS audit_org_id_idx ON audit_events (org_id, id DESC);
