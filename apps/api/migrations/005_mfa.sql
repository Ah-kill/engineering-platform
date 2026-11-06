-- Two-step login: TOTP authenticator apps (RFC 6238) and single-use recovery codes.

-- Secrets are AES-256-GCM ciphertext from the API (src/vault), never plaintext.
-- totp_pending_secret holds the secret during enrolment until the first code confirms it.
-- totp_last_step is the last accepted 30-second step; codes for it or earlier are refused (replay).
ALTER TABLE users
  ADD COLUMN mfa_enabled          boolean NOT NULL DEFAULT false,
  ADD COLUMN totp_secret          text,
  ADD COLUMN totp_pending_secret  text,
  ADD COLUMN totp_last_step       bigint;

-- Recovery codes are random and high-entropy, so a SHA-256 hash is enough (no slow hash needed).
CREATE TABLE mfa_recovery_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  user_id     uuid NOT NULL,
  code_hash   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz,
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE,
  UNIQUE (user_id, code_hash)
);

ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mfa_recovery_codes
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_recovery_codes TO platform_app;

-- Issued after a correct password when the user has two-step login on; exchanged for a
-- session by a valid code. Tokens are stored only as SHA-256 hashes. Like sessions, this
-- table is used only during authentication (db.system) and is deliberately not granted.
CREATE TABLE mfa_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES organizations(id),
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0
);
CREATE INDEX mfa_challenges_user_idx ON mfa_challenges (user_id);
