-- Foundation schema: identity, tenancy, access grants, audit.
-- Every tenant table carries org_id and is protected by row-level security.
-- The API runs request queries as the unprivileged role platform_app with
-- app.org_id set per transaction (see src/db/db.ts).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    CREATE ROLE platform_app NOLOGIN;
  END IF;
END
$$;
GRANT platform_app TO CURRENT_USER;

CREATE OR REPLACE FUNCTION current_org_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  email          text NOT NULL,
  display_name   text NOT NULL,
  password_hash  text NOT NULL,
  is_org_admin   boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

-- Session tokens are stored only as SHA-256 hashes.
CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES organizations(id),
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  ip          text,
  user_agent  text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE clients (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  name         text NOT NULL,
  slug         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug),
  UNIQUE (id, org_id)
);

-- Composite foreign keys make it impossible to attach a child to a parent in another org.
CREATE TABLE applications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  client_id    uuid NOT NULL,
  name         text NOT NULL,
  slug         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  origin       text NOT NULL DEFAULT 'existing' CHECK (origin IN ('existing', 'new')),
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, org_id) REFERENCES clients (id, org_id),
  UNIQUE (client_id, slug),
  UNIQUE (id, org_id)
);
CREATE INDEX applications_client_idx ON applications (client_id);

CREATE TABLE environments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  application_id  uuid NOT NULL,
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('development', 'staging', 'production')),
  protected       boolean NOT NULL DEFAULT false,
  aws_region      text,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (application_id, org_id) REFERENCES applications (id, org_id),
  UNIQUE (application_id, name),
  UNIQUE (id, org_id)
);
CREATE INDEX environments_app_idx ON environments (application_id);

-- A grant gives one user one role on one client, application or environment.
-- Grants never flow upward and org admins get no implicit data access (see src/access).
CREATE TABLE grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  user_id     uuid NOT NULL,
  role        text NOT NULL CHECK (role IN ('viewer', 'developer', 'app_admin', 'app_creator')),
  scope_type  text NOT NULL CHECK (scope_type IN ('client', 'application', 'environment')),
  scope_id    uuid NOT NULL,
  granted_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE,
  UNIQUE (user_id, role, scope_type, scope_id)
);
CREATE INDEX grants_lookup_idx ON grants (user_id, scope_type, scope_id);
CREATE INDEX grants_scope_idx ON grants (scope_type, scope_id);

-- Append-only: platform_app may INSERT and SELECT, never UPDATE or DELETE.
CREATE TABLE audit_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          uuid NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_id        uuid,
  action          text NOT NULL,
  resource_type   text,
  resource_id     uuid,
  client_id       uuid,
  application_id  uuid,
  environment_id  uuid,
  outcome         text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'denied', 'failure')),
  details         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_org_time_idx ON audit_events (org_id, occurred_at DESC);
CREATE INDEX audit_app_time_idx ON audit_events (application_id, occurred_at DESC);

-- Row-level security -------------------------------------------------------

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON organizations
  USING (id = current_org_id());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'clients', 'applications', 'environments', 'grants', 'audit_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())',
      t);
  END LOOP;
END
$$;

-- Privileges for the request role. sessions is deliberately not granted.
GRANT USAGE ON SCHEMA public TO platform_app;
GRANT SELECT ON organizations TO platform_app;
GRANT SELECT, INSERT, UPDATE ON users TO platform_app;
GRANT SELECT, INSERT, UPDATE ON clients, applications, environments TO platform_app;
GRANT SELECT, INSERT, DELETE ON grants TO platform_app;
GRANT SELECT, INSERT ON audit_events TO platform_app;
GRANT EXECUTE ON FUNCTION current_org_id() TO platform_app;
