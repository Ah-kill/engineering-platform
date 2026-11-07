import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { caller, type RouteDeps } from '../http/app.js';
import { authorize } from '../access/authorize.js';
import { audit } from '../audit/audit.js';
import { principalOf } from '../identity/user-routes.js';
import { HttpError } from '../http/errors.js';
import { claudeAuthEnv, MODEL_ID, readAgentSettings, readCredential } from '../settings/credentials.js';
import { loadWorkspace, networkPolicyFor } from '../workspaces/service.js';
import { workspacePaths } from '../workspaces/paths.js';
import { agentEnv } from './driver.js';
import { listModels } from './models.js';
import { claudeCodeVersions } from './version.js';
import { resolveVariables } from '../variables/variables.js';
import { awsSecretValues, issueAwsEnvForRun } from '../aws/aws.js';
import { getStsClient } from '../aws/sts.js';
import path from 'node:path';

const idParam = z.object({ id: z.string().uuid() });

const runBody = z.object({
  prompt: z.string().trim().min(1).max(50_000),
  mode: z.enum(['plan', 'execute']),
  model: z.string().regex(MODEL_ID).optional(),
  sessionId: z.string().uuid().optional(),
});

const eventsQuery = z.object({ after: z.coerce.number().int().nonnegative().default(0) });

export async function agentRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, vault, agents, workspacesDir } = deps;

  /** Models available to the caller's account, discovered live (see agents/models.ts). */
  app.get('/models', async (req) => {
    const { user } = caller(req);
    const refresh = (req.query as { refresh?: string }).refresh === 'true';
    const { auth, apiKey } = await db.tenant(user.orgId, async (q) => {
      const settings = await readAgentSettings(q, user.id);
      const auth = await claudeAuthEnv(q, vault, user.id).catch(() => ({ env: {}, mode: settings.authMode }));
      const apiKey = settings.authMode === 'api_key' ? await readCredential(q, vault, user.id, 'anthropic_api_key') : undefined;
      return { auth, apiKey };
    });
    const probeDir = path.join(workspacesDir, '.model-probe', user.id);
    return listModels(`${user.id}:${auth.mode}`, { env: agentEnv(probeDir, auth.env), probeDir, apiKey, refresh });
  });

  app.get('/system/claude-code', async () => claudeCodeVersions());

  /**
   * The caller's recent workspaces across all applications, each with its latest
   * conversation, for "continue where you left off". Only workspaces the caller can
   * still work in are returned.
   */
  app.get('/me/recent', async (req) => {
    const { user } = caller(req);
    return db.tenant(user.orgId, async (q) => {
      const rows = await q.query<{ id: string; environmentId: string } & Record<string, unknown>>(
        `SELECT w.id, w.branch, w.state, w.last_active_at AS "lastActiveAt", w.environment_id AS "environmentId",
                a.id AS "applicationId", a.name AS "applicationName", c.name AS "clientName", e.name AS "environmentName",
                s.id AS "sessionId", s.title AS "sessionTitle", s.updated_at AS "sessionUpdatedAt",
                (SELECT count(*)::int FROM agent_sessions x WHERE x.workspace_id = w.id) AS "sessionCount"
           FROM workspaces w
           JOIN applications a ON a.id = w.application_id
           JOIN clients c ON c.id = a.client_id
           JOIN environments e ON e.id = w.environment_id
           LEFT JOIN LATERAL (
             SELECT id, title, updated_at FROM agent_sessions WHERE workspace_id = w.id ORDER BY updated_at DESC LIMIT 1
           ) s ON true
          WHERE w.owner_id = $1 AND w.state <> 'deleted' AND a.archived_at IS NULL AND c.archived_at IS NULL
          ORDER BY greatest(w.last_active_at, coalesce(s.updated_at, w.last_active_at)) DESC
          LIMIT 12`,
        [user.id],
      );
      const visible = [];
      for (const r of rows) {
        const { allowed } = await authorize(q, principalOf(user), 'environment.use', { type: 'environment', id: r.environmentId });
        if (allowed) visible.push({ ...r, running: agents.isRunning(r.id) });
      }
      return visible;
    });
  });

  app.delete('/agent/sessions/:id', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    await db.tenant(user.orgId, async (q) => {
      const [s] = await q.query<{ workspace_id: string; user_id: string; title: string }>(
        'SELECT workspace_id, user_id, title FROM agent_sessions WHERE id = $1',
        [id],
      );
      if (!s || s.user_id !== user.id) throw HttpError.notFound('Conversation not found');
      const ws = await loadWorkspace(q, user, s.workspace_id, { allowNotReady: true });
      if (agents.activeSession(s.workspace_id) === id) throw HttpError.conflict('Stop Claude before deleting this conversation');
      await q.query('DELETE FROM agent_sessions WHERE id = $1', [id]);
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'agent.session.deleted', resourceType: 'agent_session', resourceId: id,
        clientId: ws.clientId, applicationId: ws.applicationId, environmentId: ws.environmentId, details: { title: s.title.slice(0, 80) },
      });
    });
    return { ok: true };
  });

  app.get('/workspaces/:id/agent/sessions', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    return db.tenant(user.orgId, async (q) => {
      await loadWorkspace(q, user, id);
      const sessions = await q.query(
        `SELECT id, title, model, auth_mode AS "authMode", cost_usd::float AS "costUsd",
                input_tokens::int AS "inputTokens", output_tokens::int AS "outputTokens",
                created_at AS "createdAt", updated_at AS "updatedAt"
           FROM agent_sessions WHERE workspace_id = $1 AND user_id = $2 ORDER BY updated_at DESC LIMIT 50`,
        [id, user.id],
      );
      return { sessions, running: agents.isRunning(id), activeSessionId: agents.activeSession(id) ?? null };
    });
  });

  app.post('/workspaces/:id/agent/run', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    const body = runBody.parse(req.body);
    const ctx = await db.tenant(user.orgId, async (q) => {
      const ws = await loadWorkspace(q, user, id);
      const settings = await readAgentSettings(q, user.id);
      const auth = await claudeAuthEnv(q, vault, user.id);
      const vars = await resolveVariables(q, vault, ws.environmentId);
      return { ws, model: body.model ?? settings.defaultModel, auth, vars };
    });
    const paths = workspacePaths(workspacesDir, id);
    // Short-lived AWS credentials when the environment has a role configured. A failure is
    // audited by the broker; the run continues without AWS rather than failing outright.
    const aws = agents.isRunning(id)
      ? null
      : await issueAwsEnvForRun(db, user.orgId, vault, getStsClient(), {
          environmentId: ctx.ws.environmentId, userId: user.id, workspaceId: id, isOrgAdmin: user.isOrgAdmin,
        }).catch((err: Error) => {
          req.log.warn({ err: err.message }, 'AWS credentials not issued');
          return null;
        });
    return agents.start(
      {
        orgId: user.orgId,
        userId: user.id,
        workspaceId: id,
        repoDir: paths.repo,
        homeDir: paths.home,
        dirs: paths,
        clientId: ctx.ws.clientId,
        applicationId: ctx.ws.applicationId,
        environmentId: ctx.ws.environmentId,
        labels: { client: ctx.ws.clientName, application: ctx.ws.applicationName, environment: ctx.ws.environmentName, branch: ctx.ws.branch },
        authEnv: ctx.auth.env,
        authMode: ctx.auth.mode,
        // Broker values win over any same-named variable.
        appEnv: { ...ctx.vars.env, ...(aws ?? {}) },
        appSecrets: [...ctx.vars.secretValues, ...awsSecretValues(aws)],
        network: networkPolicyFor(ctx.ws),
      },
      { prompt: body.prompt, mode: body.mode, model: ctx.model, sessionId: body.sessionId },
    );
  });

  app.post('/workspaces/:id/agent/cancel', async (req) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    await db.tenant(user.orgId, (q) => loadWorkspace(q, user, id));
    return { cancelled: agents.cancel(id) };
  });

  app.post('/workspaces/:id/agent/approvals/:approvalId', async (req) => {
    const { user } = caller(req);
    const { id, approvalId } = z.object({ id: z.string().uuid(), approvalId: z.string().uuid() }).parse(req.params);
    const { allow } = z.object({ allow: z.boolean() }).parse(req.body);
    await db.tenant(user.orgId, (q) => loadWorkspace(q, user, id));
    if (!agents.decide(id, approvalId, allow)) throw HttpError.notFound('No pending approval with that id');
    return { ok: true };
  });

  /**
   * Server-sent events for one conversation: replays stored events after `after`, then
   * streams new ones live. The browser reconnects with the last id it saw.
   */
  app.get('/agent/sessions/:id/events', async (req, reply) => {
    const { user } = caller(req);
    const { id } = idParam.parse(req.params);
    const { after } = eventsQuery.parse(req.query);
    const history = await db.tenant(user.orgId, async (q) => {
      const [s] = await q.query<{ workspace_id: string; user_id: string }>('SELECT workspace_id, user_id FROM agent_sessions WHERE id = $1', [id]);
      if (!s || s.user_id !== user.id) throw HttpError.notFound();
      await loadWorkspace(q, user, s.workspace_id);
      return q.query<{ id: string; kind: string; data: unknown; created_at: Date }>(
        'SELECT e.id::text AS id, e.kind, e.data, e.created_at FROM agent_events e WHERE e.session_id = $1 AND e.id > $2 ORDER BY e.id',
        [id, after],
      );
    });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let lastId = after;
    const send = (e: { id: string; kind: string; data: unknown; createdAt: string }) => {
      if (Number(e.id) <= lastId) return;
      lastId = Number(e.id);
      res.write(`id: ${e.id}\nevent: agent\ndata: ${JSON.stringify(e)}\n\n`);
    };
    const unsubscribe = agents.subscribe(id, (e) => send(e));
    for (const e of history) send({ id: e.id, kind: e.kind, data: e.data, createdAt: new Date(e.created_at).toISOString() });
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });
}
