import type { FastifyInstance, InjectOptions } from 'fastify';
import { loadConfig } from '../src/config.js';
import { openPglite, type Database } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/http/app.js';
import { hashPassword } from '../src/identity/passwords.js';

export const WEB_ORIGIN = 'http://localhost:5173';
export const PASSWORD = 'correct-horse-battery';

export interface TestEnv {
  app: FastifyInstance;
  db: Database;
  close(): Promise<void>;
}

export async function setup(): Promise<TestEnv> {
  const db = await openPglite();
  await migrate(db);
  const config = loadConfig({ WEB_ORIGIN, LOG_LEVEL: 'silent' });
  const app = await buildApp({ config, db });
  return { app, db, close: async () => { await app.close(); await db.close(); } };
}

let passwordHash: Promise<string> | undefined;

/** Creates an organization with an org admin directly in the database. */
export async function seedOrg(db: Database, slug: string): Promise<{ orgId: string; adminEmail: string }> {
  passwordHash ??= hashPassword(PASSWORD);
  const hash = await passwordHash;
  const adminEmail = `admin@${slug}.test`;
  const orgId = await db.system(async (q) => {
    const [org] = await q.query<{ id: string }>('INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING id', [slug]);
    await q.query(
      `INSERT INTO users (org_id, email, display_name, password_hash, is_org_admin) VALUES ($1, $2, 'Admin', $3, true)`,
      [org!.id, adminEmail, hash],
    );
    return org!.id;
  });
  return { orgId, adminEmail };
}

/** A logged-in HTTP client that sends the CSRF header and same-origin Origin. */
export class Client {
  constructor(private readonly app: FastifyInstance, private cookie?: string) {}

  static async login(app: FastifyInstance, email: string, password = PASSWORD): Promise<Client> {
    const res = await new Client(app).post('/api/auth/login', { email, password });
    if (res.statusCode !== 200) throw new Error(`login failed for ${email}: ${res.statusCode} ${res.body}`);
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    return new Client(app, raw!.split(';')[0]);
  }

  request(method: InjectOptions['method'], url: string, payload?: unknown) {
    const headers: Record<string, string> = { origin: WEB_ORIGIN, 'x-requested-with': 'platform' };
    if (this.cookie) headers.cookie = this.cookie;
    return this.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  }
  get(url: string) { return this.request('GET', url); }
  post(url: string, body: unknown = {}) { return this.request('POST', url, body); }
  patch(url: string, body: unknown) { return this.request('PATCH', url, body); }
  delete(url: string) { return this.request('DELETE', url); }
}
