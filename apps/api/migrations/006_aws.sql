-- Per-environment AWS access: the client's IAM role the platform assumes with STS to hand
-- short-lived credentials to Claude runs and terminals. No long-lived AWS keys are stored.
--
-- aws_external_id is AES-256-GCM ciphertext (see src/vault), never returned by the API;
-- aws_external_id_hint is its short hint for the UI. aws_access is informational: which
-- kind of role the client gave us. aws_region already exists on environments (001).
ALTER TABLE environments
  ADD COLUMN aws_role_arn         text CHECK (aws_role_arn IS NULL OR aws_role_arn ~ '^arn:aws(-cn|-us-gov)?:iam::[0-9]{12}:role/'),
  ADD COLUMN aws_external_id      text,
  ADD COLUMN aws_external_id_hint text NOT NULL DEFAULT '',
  ADD COLUMN aws_session_seconds  integer NOT NULL DEFAULT 3600 CHECK (aws_session_seconds BETWEEN 900 AND 43200),
  ADD COLUMN aws_access           text NOT NULL DEFAULT 'read' CHECK (aws_access IN ('read', 'write'));

-- environments already has row-level security (tenant_isolation, 001) and platform_app
-- holds SELECT, INSERT, UPDATE on it; new columns are covered by both. Nothing to grant.
