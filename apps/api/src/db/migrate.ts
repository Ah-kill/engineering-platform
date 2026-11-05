import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Database } from './db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** Applies every `migrations/*.sql` file not yet recorded, in filename order. */
export async function migrate(db: Database, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await db.script(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const applied = new Set(
    (await db.system((q) => q.query<{ name: string }>('SELECT name FROM schema_migrations'))).map((r) => r.name),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    const name = file.replace(/'/g, "''");
    await db.script(`${sql}\nINSERT INTO schema_migrations (name) VALUES ('${name}');`);
    ran.push(file);
  }
  return ran;
}
