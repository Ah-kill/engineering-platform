import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openPglite, type Database } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/http/app.js';
import { Vault } from '../src/vault/vault.js';
import { WEB_ORIGIN } from './helpers.js';

/** Serving the built web app from the API (SERVE_WEB=true), as in production. */

const INDEX = '<!doctype html><html><head><script type="module" src="/assets/x.js"></script></head><body><div id="root"></div></body></html>';

let tmp: string;
let dist: string;
let db: Database;
let app: FastifyInstance;

async function build(dir: string): Promise<FastifyInstance> {
  const config = loadConfig({ WEB_ORIGIN, LOG_LEVEL: 'silent', SERVE_WEB: 'true', WEB_DIST_DIR: dir });
  const vault = Vault.fromKey(randomBytes(32).toString('base64'));
  return buildApp({ config, db, vault, workspacesDir: path.join(tmp, 'ws') });
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'ep-web-'));
  dist = path.join(tmp, 'dist');
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await writeFile(path.join(dist, 'index.html'), INDEX);
  await writeFile(path.join(dist, 'assets', 'x.js'), 'console.log("x");\n');
  await writeFile(path.join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(path.join(tmp, 'secret.txt'), 'outside the web root');
  db = await openPglite();
  await migrate(db);
  app = await build(dist);
});

afterAll(async () => {
  await app.close();
  await db.close();
  await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

const get = (url: string) => app.inject({ method: 'GET', url });

function expectIndex(res: Awaited<ReturnType<typeof get>>) {
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toMatch(/^text\/html/);
  expect(res.body).toBe(INDEX);
  expect(res.headers['cache-control']).toBe('no-cache');
  const csp = String(res.headers['content-security-policy']);
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self';");
  expect(csp).toContain("worker-src 'self' blob:");
  expect(csp).toContain("connect-src 'self' ws: wss:");
  expect(csp).toContain("frame-ancestors 'none'");
}

describe('SERVE_WEB', () => {
  it('serves index.html at / without signing in, with the CSP and no-cache', async () => {
    expectIndex(await get('/'));
  });

  it('falls back to index.html for client-side routes', async () => {
    expectIndex(await get('/clients/123'));
    expectIndex(await get('/workspaces/abc?file=src/index.ts'));
  });

  it('serves hashed assets with a long, immutable cache', async () => {
    const res = await get('/assets/x.js');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.body).toContain('console.log');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('revalidates other static files', async () => {
    const res = await get('/favicon.svg');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('answers a missing asset with 404, not the HTML', async () => {
    const res = await get('/assets/missing.js');
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('<html');
  });

  it('keeps /api JSON: unknown API routes are JSON 404s, never the HTML', async () => {
    for (const url of ['/api/nope', '/api/clients/123/nope', '/api']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).toMatch(/^application\/json/);
      expect(res.body).not.toContain('<html');
      expect(res.json().error.code).toBe('not_found');
    }
    const health = await get('/api/health');
    expect(health.json()).toEqual({ ok: true });
    // Real API routes still require sign-in.
    expect((await get('/api/clients')).statusCode).toBe(401);
  });

  it('never serves files outside the web root', async () => {
    for (const url of ['/..%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt']) {
      const res = await get(url);
      expect(res.body, url).not.toContain('outside the web root');
    }
  });

  it('refuses to start without a built index.html', async () => {
    await expect(build(path.join(tmp, 'missing'))).rejects.toThrow(/npm run build/);
  });
});
