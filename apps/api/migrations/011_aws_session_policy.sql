-- Enforced AWS permissions per environment: the IAM actions an STS session may use.
--
-- When set, the platform passes an inline session policy allowing exactly these actions
-- (Resource "*") to AssumeRole. A session policy can only narrow what the client's role
-- already allows, never widen it. NULL = no session policy: the role's own permissions apply.
-- Values are validated by the API (service:Action, at most 100, packed under STS's limit).
ALTER TABLE environments
  ADD COLUMN aws_allowed_actions text[]
    CHECK (aws_allowed_actions IS NULL OR (cardinality(aws_allowed_actions) BETWEEN 1 AND 100));

-- Covered by the existing row-level security and grants on environments (001). Nothing to grant.
