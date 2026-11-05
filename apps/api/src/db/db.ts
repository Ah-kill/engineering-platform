import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

/** A connection bound to one open transaction. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * All data access goes through one of two entry points:
 *
 * - `tenant(orgId, fn)` switches to the unprivileged `platform_app` role and sets
 *   `app.org_id`, so Postgres row-level security confines every query to one org.
 *   Use this for everything a request does once the user is known.
 * - `system(fn)` runs as the owning role and bypasses RLS. Use it only for
 *   authentication bootstrap (login, session lookup), migrations and the admin CLI.
 */
export interface Database {
  tenant<T>(orgId: string, fn: (q: Queryable) => Promise<T>): Promise<T>;
  system<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Runs a multi-statement script in one transaction (migrations). */
  script(sql: string): Promise<void>;
  close(): Promise<void>;
}

export const APP_ROLE = 'platform_app';

async function enterTenant(q: Queryable, orgId: string): Promise<void> {
  await q.query(`SET LOCAL ROLE ${APP_ROLE}`);
  await q.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
}

/** Embedded Postgres stored in a local folder. Used when DATABASE_URL is not set. */
export async function openPglite(dataDir?: string): Promise<Database> {
  const pgl = dataDir ? new PGlite(dataDir) : new PGlite();
  await pgl.waitReady;

  const wrap = (tx: { query: PGlite['query'] }): Queryable => ({
    async query<T>(sql: string, params?: unknown[]) {
      const res = await tx.query<T>(sql, params as unknown[] | undefined);
      return res.rows;
    },
  });

  return {
    tenant: (orgId, fn) =>
      pgl.transaction(async (tx) => {
        const q = wrap(tx);
        await enterTenant(q, orgId);
        return fn(q);
      }),
    system: (fn) => pgl.transaction(async (tx) => fn(wrap(tx))),
    script: async (sql) => {
      await pgl.transaction(async (tx) => {
        await tx.exec(sql);
      });
    },
    close: () => pgl.close(),
  };
}

/** A regular Postgres server (local install or managed). */
export async function openPostgres(connectionString: string): Promise<Database> {
  const pool = new pg.Pool({ connectionString, max: 10 });

  async function inTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  const wrap = (client: pg.PoolClient): Queryable => ({
    async query<T>(sql: string, params?: unknown[]) {
      const res = await client.query(sql, params as unknown[] | undefined);
      return res.rows as T[];
    },
  });

  return {
    tenant: (orgId, fn) =>
      inTx(async (client) => {
        const q = wrap(client);
        await enterTenant(q, orgId);
        return fn(q);
      }),
    system: (fn) => inTx((client) => fn(wrap(client))),
    script: async (sql) => {
      await inTx(async (client) => {
        await client.query(sql);
      });
    },
    close: () => pool.end(),
  };
}

export async function openDatabase(opts: { url?: string; dataDir?: string }): Promise<Database> {
  return opts.url ? openPostgres(opts.url) : openPglite(opts.dataDir);
}
