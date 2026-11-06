import { z } from 'zod';

const schema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(4000),
  /** Postgres connection string. When unset, an embedded Postgres (PGlite) is stored in DATA_DIR. */
  DATABASE_URL: z.string().optional(),
  DATA_DIR: z.string().default('.data/pg'),
  /** The browser origin allowed to make state-changing requests. */
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Master key for encrypting saved credentials (base64, 32 bytes). Unset = generated into VAULT_KEY_FILE. */
  VAULT_KEY: z.string().optional(),
  VAULT_KEY_FILE: z.string().default('.data/vault.key'),
  /** Where workspace checkouts live. Default is outside the project folder. */
  WORKSPACES_DIR: z.string().optional(),
  AGENT_MAX_TURNS: z.coerce.number().int().positive().default(80),
  AGENT_MAX_BUDGET_USD: z.coerce.number().positive().default(10),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
