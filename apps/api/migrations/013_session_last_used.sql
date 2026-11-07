-- When each session was last used (updated at most every few minutes), for "Signed-in devices".
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
