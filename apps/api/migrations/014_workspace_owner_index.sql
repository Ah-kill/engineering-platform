-- Lookups of a user's own workspaces (recent work, sharing checks) filter on owner_id alone;
-- the existing (application_id, owner_id) index cannot serve them.
CREATE INDEX IF NOT EXISTS workspaces_owner_idx ON workspaces (owner_id);
-- Already created in 009; kept here so databases that missed it get it too.
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members (user_id);
