-- Per-user credentials and agent settings, repositories, workspaces, agent sessions.

-- Encrypted with AES-256-GCM by the API (src/vault). Only ciphertext is stored;
-- `hint` holds the last 4 characters so users can recognise which key is saved.
CREATE TABLE user_credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  user_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('anthropic_api_key', 'claude_oauth_token', 'github_token')),
  ciphertext  text NOT NULL,
  hint        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE,
  UNIQUE (user_id, kind)
);

CREATE TABLE user_agent_settings (
  user_id        uuid PRIMARY KEY,
  org_id         uuid NOT NULL,
  auth_mode      text NOT NULL DEFAULT 'api_key' CHECK (auth_mode IN ('api_key', 'subscription')),
  default_model  text NOT NULL DEFAULT 'default',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);

-- One repository per application for now.
CREATE TABLE repositories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  application_id  uuid NOT NULL UNIQUE,
  provider        text NOT NULL CHECK (provider IN ('github')),
  owner           text NOT NULL,
  name            text NOT NULL,
  default_branch  text NOT NULL DEFAULT 'main',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (application_id, org_id) REFERENCES applications (id, org_id),
  UNIQUE (id, org_id)
);

CREATE TABLE workspaces (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  application_id  uuid NOT NULL,
  environment_id  uuid NOT NULL,
  repository_id   uuid NOT NULL,
  owner_id        uuid NOT NULL,
  branch          text NOT NULL,
  base_branch     text NOT NULL,
  state           text NOT NULL DEFAULT 'creating' CHECK (state IN ('creating', 'ready', 'failed', 'deleted')),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_active_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (application_id, org_id) REFERENCES applications (id, org_id),
  FOREIGN KEY (environment_id, org_id) REFERENCES environments (id, org_id),
  FOREIGN KEY (repository_id, org_id) REFERENCES repositories (id, org_id),
  FOREIGN KEY (owner_id, org_id) REFERENCES users (id, org_id),
  UNIQUE (id, org_id)
);
CREATE INDEX workspaces_app_idx ON workspaces (application_id, owner_id);

CREATE TABLE agent_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  user_id         uuid NOT NULL,
  sdk_session_id  text,
  model           text NOT NULL,
  auth_mode       text NOT NULL,
  title           text NOT NULL DEFAULT '',
  cost_usd        numeric(12, 6) NOT NULL DEFAULT 0,
  input_tokens    bigint NOT NULL DEFAULT 0,
  output_tokens   bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, org_id) REFERENCES workspaces (id, org_id) ON DELETE CASCADE,
  UNIQUE (id, org_id)
);
CREATE INDEX agent_sessions_ws_idx ON agent_sessions (workspace_id, created_at DESC);

-- One row per event shown in the chat (user prompt, assistant text, tool call, result, error).
CREATE TABLE agent_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      uuid NOT NULL,
  session_id  uuid NOT NULL,
  kind        text NOT NULL,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, org_id) REFERENCES agent_sessions (id, org_id) ON DELETE CASCADE
);
CREATE INDEX agent_events_session_idx ON agent_events (session_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_credentials', 'user_agent_settings', 'repositories', 'workspaces', 'agent_sessions', 'agent_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())',
      t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON user_credentials, user_agent_settings, repositories TO platform_app;
GRANT SELECT, INSERT, UPDATE ON workspaces, agent_sessions TO platform_app;
GRANT SELECT, INSERT ON agent_events TO platform_app;
