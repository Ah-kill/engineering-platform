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
  /**
   * Set to the number of reverse proxies in front of the API (e.g. 1 for Caddy or Tailscale
   * serve) so client IPs, and therefore login rate limits, are per user. 0 = do not trust.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /** Master key for encrypting saved credentials (base64, 32 bytes). Unset = generated into VAULT_KEY_FILE. */
  VAULT_KEY: z.string().optional(),
  VAULT_KEY_FILE: z.string().default('.data/vault.key'),
  /** Where workspace checkouts live. Default is outside the project folder. */
  WORKSPACES_DIR: z.string().optional(),
  /** docker (default): Claude Code runs in a container per workspace. local: on the host (tests only). */
  WORKSPACE_RUNTIME: z.enum(['docker', 'local']).default('docker'),
  WORKSPACE_IMAGE: z.string().optional(),
  WORKSPACE_CPUS: z.string().default('2'),
  WORKSPACE_MEMORY: z.string().default('4g'),
  WORKSPACE_PIDS: z.coerce.number().int().positive().default(512),
  AGENT_MAX_TURNS: z.coerce.number().int().positive().default(80),
  AGENT_MAX_BUDGET_USD: z.coerce.number().positive().default(10),
  /** Production: serve the built web app (apps/web/dist) from this server, with SPA fallback. */
  SERVE_WEB: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Where the built web app lives. Default: apps/web/dist next to this API. */
  WEB_DIST_DIR: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
