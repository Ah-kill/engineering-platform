-- Per-environment variables and secrets, and per-application outbound network policy.

-- One row per variable. Plain values live in `value`; secret values only as AES-256-GCM
-- ciphertext (see src/vault) with a short hint. Exactly one of value/ciphertext is set.
CREATE TABLE environment_variables (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  environment_id  uuid NOT NULL,
  name            text NOT NULL CHECK (name ~ '^[A-Z_][A-Z0-9_]{0,127}$'),
  is_secret       boolean NOT NULL,
  value           text,
  ciphertext      text,
  hint            text NOT NULL DEFAULT '',
  description     text NOT NULL DEFAULT '',
  updated_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id, org_id) REFERENCES environments (id, org_id) ON DELETE CASCADE,
  UNIQUE (environment_id, name),
  CHECK ((is_secret AND ciphertext IS NOT NULL AND value IS NULL) OR (NOT is_secret AND value IS NOT NULL AND ciphertext IS NULL))
);

ALTER TABLE environment_variables ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON environment_variables
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON environment_variables TO platform_app;

-- restricted: workspace containers reach only the built-in hosts plus egress_hosts.
-- open: unrestricted internet access.
ALTER TABLE applications
  ADD COLUMN egress_mode text NOT NULL DEFAULT 'restricted' CHECK (egress_mode IN ('restricted', 'open')),
  ADD COLUMN egress_hosts text[] NOT NULL DEFAULT '{}';
