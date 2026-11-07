-- Project instructions for Claude, per application. Written by app admins, appended to the
-- system prompt below the platform's own rules (which always take precedence). Unlike a
-- repository's CLAUDE.md, these cannot be changed by anyone who can push to the repository.
ALTER TABLE applications
  ADD COLUMN agent_instructions text NOT NULL DEFAULT ''
    CHECK (char_length(agent_instructions) <= 20000);

-- Team activity lists conversations per application across workspaces.
CREATE INDEX IF NOT EXISTS agent_sessions_updated_idx ON agent_sessions (workspace_id, updated_at DESC);

-- Covered by the existing row-level security and grants on applications (001). Nothing to grant.
