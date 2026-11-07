import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { openDatabase } from './db/db.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './http/app.js';
import { Vault } from './vault/vault.js';
import { readSdkPackage } from './agents/version.js';
import { startIdleReaper } from './agents/housekeeping.js';
import { defaultImage, DockerRuntime, localRuntime, type WorkspaceRuntime } from './workspaces/runtime.js';

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

// Claude Code runs in a container per workspace. The image is tagged with the Claude Code
// version bundled in the SDK, so `npm run update:claude` also produces a fresh image.
let runtime: WorkspaceRuntime = localRuntime;
if (config.WORKSPACE_RUNTIME === 'docker') {
  const sdk = await readSdkPackage();
  const claudeCodeVersion = sdk.claudeCodeVersion ?? 'latest';
  runtime = new DockerRuntime({
    image: config.WORKSPACE_IMAGE ?? defaultImage(claudeCodeVersion),
    claudeCodeVersion,
    cpus: config.WORKSPACE_CPUS,
    memory: config.WORKSPACE_MEMORY,
    pidsLimit: config.WORKSPACE_PIDS,
  });
}

const app = await buildApp({ config, db, vault, workspacesDir, runtime });
if (applied.length) app.log.info({ applied }, 'applied migrations');
if (runtime.kind === 'docker') {
  if (await DockerRuntime.available()) app.log.info('workspaces run in Docker containers');
  else app.log.warn('Docker is not running: workspaces cannot be opened until Docker Desktop is started');
} else {
  app.log.warn('WORKSPACE_RUNTIME=local: Claude runs directly on this machine without isolation');
}
if (vaultCreated) app.log.warn(`generated a new credential encryption key at ${config.VAULT_KEY_FILE}; back it up, saved credentials cannot be decrypted without it`);
app.log.info(config.DATABASE_URL ? 'using Postgres from DATABASE_URL' : `using embedded Postgres in ${config.DATA_DIR}`);
app.log.info(`workspaces in ${workspacesDir}`);
if (config.SERVE_WEB) {
  app.log.info(`serving the web app for ${config.WEB_ORIGIN}`);
  // The browser origin must equal WEB_ORIGIN exactly, or every change is refused.
  if (new URL(config.WEB_ORIGIN).port === '5173') app.log.warn('SERVE_WEB=true but WEB_ORIGIN still points at the Vite dev server; set it to the public URL');
}

// Stop the containers of workspaces nobody has used for a while (files are kept; the next
// request starts the container again). Never while Claude runs or a terminal is open.
const stopReaper =
  config.WORKSPACE_IDLE_MINUTES > 0
    ? startIdleReaper(db, runtime, { idleMinutes: config.WORKSPACE_IDLE_MINUTES, log: app.log })
    : () => undefined;
if (config.WORKSPACE_IDLE_MINUTES > 0) app.log.info(`idle workspace containers stop after ${config.WORKSPACE_IDLE_MINUTES} minutes`);

const shutdown = async () => {
  stopReaper();
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
