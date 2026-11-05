import { mkdir } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { openDatabase } from './db/db.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './http/app.js';

const config = loadConfig();
if (!config.DATABASE_URL) await mkdir(config.DATA_DIR, { recursive: true });
const db = await openDatabase({ url: config.DATABASE_URL, dataDir: config.DATA_DIR });
const applied = await migrate(db);

const app = await buildApp({ config, db });
if (applied.length) app.log.info({ applied }, 'applied migrations');
app.log.info(config.DATABASE_URL ? 'using Postgres from DATABASE_URL' : `using embedded Postgres in ${config.DATA_DIR}`);

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
