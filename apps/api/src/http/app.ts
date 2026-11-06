import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../db/db.js';
import { lookupSession, type AuthContext } from '../identity/sessions.js';
import { identityRoutes } from '../identity/routes.js';
import { userRoutes } from '../identity/user-routes.js';
import { tenancyRoutes } from '../tenancy/routes.js';
import { grantRoutes } from '../access/routes.js';
import { auditRoutes } from '../audit/routes.js';
import { settingsRoutes } from '../settings/routes.js';
import { workspaceRoutes } from '../workspaces/routes.js';
import { agentRoutes } from '../agents/routes.js';
import { AgentManager } from '../agents/manager.js';
import { ClaudeSdkDriver, type AgentDriver } from '../agents/driver.js';
import { githubRemote, type RemoteResolver } from '../workspaces/service.js';
import type { Vault } from '../vault/vault.js';
import { localRuntime, type WorkspaceRuntime } from '../workspaces/runtime.js';
import { HttpError } from './errors.js';

export const SESSION_COOKIE = 'ep_session';
/** Custom header required on every state-changing request. Cross-site forms cannot set it. */
export const CSRF_HEADER = 'x-requested-with';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export interface AppDeps {
  config: Config;
  db: Database;
  vault: Vault;
  workspacesDir: string;
  /** Where workspaces clone from. Defaults to GitHub; tests use local repositories. */
  remoteFor?: RemoteResolver;
  /** The agent implementation. Defaults to Claude Code via the Agent SDK. */
  agentDriver?: AgentDriver;
  /** Where Claude runs. main.ts passes Docker; omitted (tests) means local. */
  runtime?: WorkspaceRuntime;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(appDeps: AppDeps): Promise<FastifyInstance> {
  const { config, db } = appDeps;
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    trustProxy: false,
    bodyLimit: 6 * 1024 * 1024,
  });

  // File saves from the editor can be large; other routes stay small via per-route validation.
  // Only JSON bodies are accepted.
  app.removeContentTypeParser('text/plain');

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.addHook('onRequest', async (req) => {
    if (MUTATING.has(req.method)) {
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== config.WEB_ORIGIN) throw HttpError.forbidden('Origin not allowed');
      if (req.headers[CSRF_HEADER] === undefined) throw HttpError.forbidden('Missing CSRF header');
    }

    const token = req.cookies[SESSION_COOKIE];
    if (token) req.auth = await lookupSession(db, token);

    if (!req.routeOptions.config.public && !req.auth) throw HttpError.unauthorized();
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'validation_failed', message: 'Invalid request', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many requests, try again later' } });
    }
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'bad_request', message: (err as Error).message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  app.get('/api/health', { config: { public: true } }, async () => ({ ok: true }));

  const runtime = appDeps.runtime ?? localRuntime;
  const agents = new AgentManager(db, appDeps.agentDriver ?? new ClaudeSdkDriver(), runtime, {
    maxTurns: config.AGENT_MAX_TURNS,
    maxBudgetUsd: config.AGENT_MAX_BUDGET_USD,
  });
  const deps: RouteDeps = { ...appDeps, remoteFor: appDeps.remoteFor ?? githubRemote, agents, runtime };
  await app.register(async (api) => {
    await identityRoutes(api, deps);
    await userRoutes(api, deps);
    await tenancyRoutes(api, deps);
    await grantRoutes(api, deps);
    await auditRoutes(api, deps);
    await settingsRoutes(api, deps);
    await workspaceRoutes(api, deps);
    await agentRoutes(api, deps);
  }, { prefix: '/api' });

  return app;
}

/** The authenticated caller. Only call from non-public routes. */
export function caller(req: FastifyRequest): AuthContext {
  if (!req.auth) throw HttpError.unauthorized();
  return req.auth;
}

export type RouteDeps = AppDeps & { remoteFor: RemoteResolver; agents: AgentManager; runtime: WorkspaceRuntime };
