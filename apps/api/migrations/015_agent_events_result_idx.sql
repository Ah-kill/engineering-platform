-- Monthly budgets add up the cost of each Claude run (`result` events) by when it happened.
CREATE INDEX IF NOT EXISTS agent_events_result_idx ON agent_events (org_id, created_at) WHERE kind = 'result';
