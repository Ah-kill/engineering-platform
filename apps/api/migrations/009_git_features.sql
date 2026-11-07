-- GitHub tokens per GitHub owner, and workspace sharing.

-- Developers work for several clients in different GitHub organizations, and fine-grained
-- tokens are scoped to one owner. `github_owner` (lower case) names the organization or user
-- a github_token is for; NULL is the default token, used for any owner without its own.
ALTER TABLE user_credentials
  ADD COLUMN github_owner text
    CHECK (github_owner IS NULL OR (kind = 'github_token' AND github_owner ~ '^[a-z0-9-]{1,39}$'));
ALTER TABLE user_credentials DROP CONSTRAINT user_credentials_user_id_kind_key;
CREATE UNIQUE INDEX user_credentials_owner_key ON user_credentials (user_id, kind, coalesce(github_owner, ''));

-- People the owner shared a workspace with. Viewers read files, git history and diffs;
-- editors may also change files, run git and Claude. Members still need `environment.use`
-- on the workspace's environment, checked when added and on every request.
CREATE TABLE workspace_members (
  org_id        uuid NOT NULL,
  workspace_id  uuid NOT NULL,
  user_id       uuid NOT NULL,
  role          text NOT NULL CHECK (role IN ('viewer', 'editor')),
  added_by      uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id, org_id) REFERENCES workspaces (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_members
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_members TO platform_app;
