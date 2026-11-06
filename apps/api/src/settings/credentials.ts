import type { Queryable } from '../db/db.js';
import { HttpError } from '../http/errors.js';
import { hintFor, type Vault } from '../vault/vault.js';

export const CREDENTIAL_KINDS = ['anthropic_api_key', 'claude_oauth_token', 'github_token'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/**
 * Model ids are passed to Claude Code. The list offered in the UI is fetched live
 * (see src/agents/models.ts); aliases like "default", "opus", "sonnet" always resolve
 * to the newest model, and any id shaped like a model name is accepted.
 */
export const MODEL_ID = /^[a-z0-9][a-z0-9.\-\[\]]{1,62}$/;
export const DEFAULT_MODEL = 'default';

export type AuthMode = 'api_key' | 'subscription';

const FORMAT: Record<CredentialKind, { test: RegExp; message: string }> = {
  anthropic_api_key: { test: /^sk-ant-api\d{2}-[A-Za-z0-9_\-]{20,}$/, message: 'Anthropic API keys start with "sk-ant-api"' },
  claude_oauth_token: { test: /^sk-ant-oat\d{2}-[A-Za-z0-9_\-]{20,}$/, message: 'Tokens from "claude setup-token" start with "sk-ant-oat"' },
  github_token: { test: /^(ghp_|github_pat_|gho_|ghu_)[A-Za-z0-9_]{20,}$/, message: 'GitHub tokens start with "github_pat_" or "ghp_"' },
};

export function validateCredential(kind: CredentialKind, value: string): string {
  const v = value.trim();
  if (!FORMAT[kind].test.test(v)) throw HttpError.badRequest(FORMAT[kind].message);
  return v;
}

export async function saveCredential(q: Queryable, vault: Vault, orgId: string, userId: string, kind: CredentialKind, value: string) {
  await q.query(
    `INSERT INTO user_credentials (org_id, user_id, kind, ciphertext, hint) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, kind) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, hint = EXCLUDED.hint, updated_at = now()`,
    [orgId, userId, kind, vault.encrypt(value), hintFor(value)],
  );
}

/** Decrypts a credential for server-side use. Never return the result to a client. */
export async function readCredential(q: Queryable, vault: Vault, userId: string, kind: CredentialKind): Promise<string | undefined> {
  const [row] = await q.query<{ ciphertext: string }>('SELECT ciphertext FROM user_credentials WHERE user_id = $1 AND kind = $2', [userId, kind]);
  return row ? vault.decrypt(row.ciphertext) : undefined;
}

export interface AgentSettings {
  authMode: AuthMode;
  defaultModel: string;
}

export async function readAgentSettings(q: Queryable, userId: string): Promise<AgentSettings> {
  const [row] = await q.query<{ auth_mode: AuthMode; default_model: string }>(
    'SELECT auth_mode, default_model FROM user_agent_settings WHERE user_id = $1',
    [userId],
  );
  return { authMode: row?.auth_mode ?? 'api_key', defaultModel: row?.default_model ?? DEFAULT_MODEL };
}

/** Environment variables that authenticate Claude Code for this user, per their chosen mode. */
export async function claudeAuthEnv(q: Queryable, vault: Vault, userId: string): Promise<{ env: Record<string, string>; mode: AuthMode }> {
  const { authMode } = await readAgentSettings(q, userId);
  if (authMode === 'subscription') {
    const token = await readCredential(q, vault, userId, 'claude_oauth_token');
    if (!token) throw HttpError.badRequest('No Claude subscription token saved. Add one in Settings.');
    return { env: { CLAUDE_CODE_OAUTH_TOKEN: token }, mode: authMode };
  }
  const key = await readCredential(q, vault, userId, 'anthropic_api_key');
  if (!key) throw HttpError.badRequest('No Anthropic API key saved. Add one in Settings.');
  return { env: { ANTHROPIC_API_KEY: key }, mode: authMode };
}
