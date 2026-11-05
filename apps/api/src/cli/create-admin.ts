/**
 * Creates the organization (if needed) and an org admin.
 *
 *   npm run create-admin -- --org "Your Company" --email you@company.com --name "Your Name"
 *
 * The password comes from ADMIN_PASSWORD, or a random one is generated and printed once.
 */
import { mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/db.js';
import { migrate } from '../db/migrate.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../identity/passwords.js';
import { audit } from '../audit/audit.js';
import { slugify } from '../tenancy/routes.js';

const { values } = parseArgs({
  options: { org: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' } },
});
if (!values.org || !values.email || !values.name) {
  console.error('Usage: npm run create-admin -- --org "Company" --email you@company.com --name "Your Name"');
  process.exit(1);
}

const generated = !process.env.ADMIN_PASSWORD;
const password = process.env.ADMIN_PASSWORD ?? randomBytes(18).toString('base64url');
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  process.exit(1);
}

const config = loadConfig();
if (!config.DATABASE_URL) await mkdir(config.DATA_DIR, { recursive: true });
const db = await openDatabase({ url: config.DATABASE_URL, dataDir: config.DATA_DIR });
await migrate(db);

const orgSlug = slugify(values.org);
const passwordHash = await hashPassword(password);
const email = values.email.trim().toLowerCase();

try {
  const result = await db.system(async (q) => {
    const [org] = await q.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = organizations.name RETURNING id`,
      [values.org, orgSlug],
    );
    const [user] = await q.query<{ id: string }>(
      `INSERT INTO users (org_id, email, display_name, password_hash, is_org_admin)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [org!.id, email, values.name, passwordHash],
    );
    await audit(q, { orgId: org!.id, actorId: null, action: 'user.created', resourceType: 'user', resourceId: user!.id, details: { email, isOrgAdmin: true, via: 'cli' } });
    return { orgId: org!.id };
  });
  console.log(`Created org admin ${email} in organization "${values.org}" (${result.orgId}).`);
  if (generated) console.log(`Password (shown once, change it after first login): ${password}`);
} catch (err) {
  if ((err as { code?: string }).code === '23505') {
    console.error(`A user with email ${email} already exists.`);
    process.exit(1);
  }
  throw err;
} finally {
  await db.close();
}
