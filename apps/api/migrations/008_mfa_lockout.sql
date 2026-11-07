-- Per-user limit on wrong second-factor codes, across all sign-in attempts.
ALTER TABLE users
  ADD COLUMN mfa_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN mfa_locked_until timestamptz;
