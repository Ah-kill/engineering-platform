/**
 * Starts the real API for Playwright tests, isolated from development data:
 * - a fresh embedded Postgres in a temp folder
 * - a seeded org with an admin and a developer
 * - a local bare git repository standing in for GitHub (no network, no tokens)
 * - a scripted agent instead of Claude (no credentials, no cost)
 *
 * Everything else (HTTP, auth, permissions, git, files, streaming) is the production code.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openPglite } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/http/app.js';
import { hashPassword } from '../src/identity/passwords.js';
import { runGit } from '../src/git/git.js';
import { Vault } from '../src/vault/vault.js';
import { ScriptedDriver } from './scripted-driver.js';

const PORT = Number(process.env.E2E_API_PORT ?? 4100);
const WEB_ORIGIN = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:5273';
export const E2E_PASSWORD = 'e2e-password-123';

const root = await mkdtemp(path.join(os.tmpdir(), 'ep-e2e-'));
const remotes = path.join(root, 'remotes');
const workspacesDir = path.join(root, 'workspaces');
await mkdir(workspacesDir, { recursive: true });

// "GitHub": acme/payments with a couple of files on main.
const bare = path.join(remotes, 'acme', 'payments.git');
await mkdir(path.dirname(bare), { recursive: true });
await runGit(['init', '--bare', '-b', 'main', bare], { cwd: root });
const seed = path.join(root, 'seed');
await runGit(['clone', bare, seed], { cwd: root, allowLocalRemote: true });
await mkdir(path.join(seed, 'src'));
await writeFile(path.join(seed, 'README.md'), '# Payment Service\n');
await writeFile(path.join(seed, 'src', 'retry.js'), 'export const MAX_RETRIES = 3;\n');
await runGit(['add', '-A'], { cwd: seed });
await runGit(['commit', '-m', 'Initial commit'], { cwd: seed, author: { name: 'Seed', email: 'seed@example.com' } });
await runGit(['push', 'origin', 'HEAD:main'], { cwd: seed, allowLocalRemote: true });

const db = await openPglite(path.join(root, 'pg'));
await migrate(db);
const hash = await hashPassword(E2E_PASSWORD);
await db.system(async (q) => {
  const [org] = await q.query<{ id: string }>(`INSERT INTO organizations (name, slug) VALUES ('E2E Co', 'e2e-co') RETURNING id`);
  await q.query(
    `INSERT INTO users (org_id, email, display_name, password_hash, is_org_admin) VALUES
       ($1, 'admin@e2e.test', 'Ada Admin', $2, true),
       ($1, 'dev@e2e.test', 'Dev Dana', $2, false)`,
    [org!.id, hash],
  );
});

const app = await buildApp({
  config: loadConfig({ WEB_ORIGIN, LOG_LEVEL: 'warn' }),
  db,
  vault: Vault.fromKey(randomBytes(32).toString('base64')),
  workspacesDir,
  remoteFor: (owner, name) => path.join(remotes, owner, `${name}.git`),
  agentDriver: new ScriptedDriver(),
});

// Lets tests inspect the fake GitHub remote.
app.get('/e2e/remote-branches', { config: { public: true } }, async () => {
  const out = await runGit(['branch', '--list', '--format=%(refname:short)'], { cwd: bare });
  return out.split('\n').filter(Boolean);
});

await app.listen({ host: '127.0.0.1', port: PORT });
console.log(`e2e api ready on ${PORT} (data in ${root})`);
