import type { Queryable } from '../db/db.js';
import { HttpError } from '../http/errors.js';
import { hintFor, type Vault } from '../vault/vault.js';

/**
 * Generic per-environment variables. Nothing here knows about any particular service:
 * a Twilio key, an Okta client secret or an internal URL are all just NAME=value, with
 * secrets encrypted at rest and never returned by the API.
 */

export const VAR_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
export const MAX_VALUE_BYTES = 32 * 1024;

/** Names the platform or the runtime controls; letting a project override them would break or bypass isolation. */
const RESERVED = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'HOSTNAME', 'TERM', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS', 'NO_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY']);
const RESERVED_PREFIXES = ['CLAUDE_', 'ANTHROPIC_', 'GIT_', 'DOCKER_', 'NODE_USE_ENV_PROXY'];

export function validateName(name: string): string {
  if (!VAR_NAME.test(name)) throw HttpError.badRequest('Use upper-case letters, digits and underscores, e.g. PAYMENT_API_KEY');
  if (RESERVED.has(name) || RESERVED_PREFIXES.some((p) => name.startsWith(p))) {
    throw HttpError.badRequest(`${name} is reserved by the platform`);
  }
  return name;
}

export function validateValue(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) throw HttpError.badRequest('Value is too large (32 KB maximum)');
  if (value.includes('\0')) throw HttpError.badRequest('Value may not contain NUL characters');
  return value;
}

export interface VariableView {
  id: string;
  name: string;
  isSecret: boolean;
  /** Plain value, or null for secrets. */
  value: string | null;
  hint: string;
  description: string;
  updatedAt: string;
}

export async function listVariables(q: Queryable, environmentId: string): Promise<VariableView[]> {
  return q.query<VariableView>(
    `SELECT id, name, is_secret AS "isSecret", CASE WHEN is_secret THEN NULL ELSE value END AS value,
            hint, description, updated_at AS "updatedAt"
       FROM environment_variables WHERE environment_id = $1 ORDER BY name`,
    [environmentId],
  );
}

export async function upsertVariable(
  q: Queryable,
  vault: Vault,
  input: { orgId: string; environmentId: string; userId: string; name: string; value: string; isSecret: boolean; description: string },
): Promise<void> {
  const name = validateName(input.name);
  const value = validateValue(input.value);
  await q.query(
    `INSERT INTO environment_variables (org_id, environment_id, name, is_secret, value, ciphertext, hint, description, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (environment_id, name) DO UPDATE SET
       is_secret = EXCLUDED.is_secret, value = EXCLUDED.value, ciphertext = EXCLUDED.ciphertext,
       hint = EXCLUDED.hint, description = EXCLUDED.description, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [
      input.orgId,
      input.environmentId,
      name,
      input.isSecret,
      input.isSecret ? null : value,
      input.isSecret ? vault.encrypt(value) : null,
      input.isSecret ? hintFor(value) : '',
      input.description,
      input.userId,
    ],
  );
}

/** All variables of an environment with secrets decrypted, for injecting into a workspace. Server-side only. */
export async function resolveVariables(q: Queryable, vault: Vault, environmentId: string): Promise<{ env: Record<string, string>; secretValues: string[] }> {
  const rows = await q.query<{ name: string; is_secret: boolean; value: string | null; ciphertext: string | null }>(
    'SELECT name, is_secret, value, ciphertext FROM environment_variables WHERE environment_id = $1',
    [environmentId],
  );
  const env: Record<string, string> = {};
  const secretValues: string[] = [];
  for (const r of rows) {
    const v = r.is_secret ? vault.decrypt(r.ciphertext!) : r.value!;
    env[r.name] = v;
    if (r.is_secret) secretValues.push(v);
  }
  return { env, secretValues };
}

/** Parses .env text: KEY=value, optional `export`, quotes, # comments. Returns entries in order. */
export function parseDotEnv(text: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) throw HttpError.badRequest(`Cannot read this line: ${line.slice(0, 60)}`);
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out.push({ name: m[1]!.toUpperCase(), value });
  }
  return out;
}
