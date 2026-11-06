import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { openDatabase } from './db/db.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './http/app.js';
import { Vault } from './vault/vault.js';

const config = loadConfig();
if (!config.DATABASE_URL) await mkdir(config.DATA_DIR, { recursive: true });
const db = await openDatabase({ url: config.DATABASE_URL, dataDir: config.DATA_DIR });
const applied = await migrate(db);

const { vault, created: vaultCreated } = config.VAULT_KEY
  ? { vault: Vault.fromKey(config.VAULT_KEY), created: false }
  : await Vault.fromKeyFile(path.resolve(config.VAULT_KEY_FILE));

// Outside the project folder by default, so an agent working in a checkout is not
// sitting next to the platform's own .env and key files.
const workspacesDir = path.resolve(config.WORKSPACES_DIR ?? path.join(os.homedir(), '.engineering-platform', 'workspaces'));
await mkdir(workspacesDir, { recursive: true });

const app = await buildApp({ config, db, vault, workspacesDir });
if (applied.length) app.log.info({ applied }, 'applied migrations');
if (vaultCreated) app.log.warn(`generated a new credential encryption key at ${config.VAULT_KEY_FILE}; back it up, saved credentials cannot be decrypted without it`);
app.log.info(config.DATABASE_URL ? 'using Postgres from DATABASE_URL' : `using embedded Postgres in ${config.DATA_DIR}`);
app.log.info(`workspaces in ${workspacesDir}`);

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
