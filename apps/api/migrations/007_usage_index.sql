-- Usage reports aggregate agent sessions by organization and date.
CREATE INDEX IF NOT EXISTS agent_sessions_org_created_idx ON agent_sessions (org_id, created_at);
