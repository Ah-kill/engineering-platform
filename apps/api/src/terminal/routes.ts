import websocket from '@fastify/websocket';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { caller, type RouteDeps } from '../http/app.js';
import { HttpError } from '../http/errors.js';
import type { AuthUser } from '../identity/sessions.js';
import { resolveVariables } from '../variables/variables.js';
import { issueAwsEnvForRun } from '../aws/aws.js';
import { registerTerminalCounter } from '../workspaces/terminal-registry.js';
import { getStsClient } from '../aws/sts.js';
import { workspacePaths } from '../workspaces/paths.js';
import { loadWorkspace, type WorkspaceRow, networkPolicyFor } from '../workspaces/service.js';
import { ContainerShell } from './shell.js';

/**
 * Browser terminal: a WebSocket to an interactive shell inside the workspace's container.
 *
 *   GET /api/workspaces/:id/terminal   (WebSocket upgrade)  opens a shell
 *   GET /api/workspaces/:id/terminal   (plain request)      says whether one can be opened
 *
 * Browser to server: JSON text messages, {type:'input',data} and {type:'resize',cols,rows}.
 * Server to browser: raw terminal output as binary messages.
 *
 * The shell only ever runs in the container (uid 1000, no capabilities, the workspace's
 * network policy), never on the host. It gets the environment's variables but not the
 * developer's Claude or GitHub credentials. Terminal contents are never logged or audited.
 */

export const MAX_TERMINALS_PER_WORKSPACE = 3;
export const IDLE_TIMEOUT_MS = 60 * 60_000;
/** Largest message accepted from the browser; the web app splits bigger pastes. */
export const MAX_MESSAGE_BYTES = 64 * 1024;
const PING_INTERVAL_MS = 30_000;
/** Output waiting to reach a slow browser before we stop reading from the shell. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_QUEUED_MESSAGES = 200;

const idParam = z.object({ id: z.string().uuid() });
const sizeQuery = z.object({
  cols: z.coerce.number().int().min(2).max(1000).default(80),
  rows: z.coerce.number().int().min(1).max(500).default(24),
});
const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(MAX_MESSAGE_BYTES) }),
  z.object({ type: z.literal('resize'), cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(500) }),
]);
type ClientMessage = z.infer<typeof clientMessage>;
type EndFn = (reason: string, code?: number, message?: string) => void;

interface Prepared {
  user: AuthUser;
  ws: WorkspaceRow;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/** Writes a notice in the terminal itself, dimmed, on its own line. */
const notice = (text: string) => Buffer.from(`\r\n\x1b[2m[${text}]\x1b[0m\r\n`, 'utf8');

export async function terminalRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { config, db, vault, runtime, workspacesDir } = deps;
  /** Open terminals per workspace; a terminal counts from the upgrade until its shell is gone. */
  const open = new Map<string, Set<EndFn>>();
  const prepared = new WeakMap<FastifyRequest, Prepared>();
  const countFor = (id: string) => open.get(id)?.size ?? 0;
  registerTerminalCounter(countFor);

  const record = (p: Prepared, action: string, details: Record<string, unknown>, outcome: 'success' | 'failure' = 'success') =>
    db
      .tenant(p.user.orgId, (q) =>
        audit(q, {
          orgId: p.user.orgId, actorId: p.user.id, action, resourceType: 'workspace', resourceId: p.ws.id,
          clientId: p.ws.clientId, applicationId: p.ws.applicationId, environmentId: p.ws.environmentId, outcome, details,
        }),
      )
      .catch((err) => app.log.error({ err }, `audit ${action} failed`));

  // Own scope, so the WebSocket plugin only wraps this route.
  await app.register(async (scope) => {
    await scope.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });

    // The plugin answers refused upgrades (401, 403, 404, ...) with a normal HTTP response on
    // the raw socket, but only closes that socket when its own onRequest hook ran. A request
    // rejected earlier (by the global session check) or sent to another path would stay
    // half-open forever and block shutdown. This listener runs after the plugin's, once the
    // response object is attached: when a response finishes without upgrading, close the socket.
    const closeRefused = (_req: IncomingMessage, socket: Duplex) => {
      const res = (socket as Duplex & { _httpMessage?: ServerResponse })._httpMessage;
      res?.once('finish', () => {
        socket.end();
        setTimeout(() => socket.destroy(), 1000).unref();
      });
    };
    scope.server.on('upgrade', closeRefused);
    scope.addHook('preClose', async () => {
      scope.server.removeListener('upgrade', closeRefused);
    });

    scope.addHook('onClose', async () => {
      for (const set of open.values()) for (const end of [...set]) end('server_shutdown', 1001, 'Server shutting down');
    });

    scope.route({
      method: 'GET',
      url: '/workspaces/:id/terminal',
      // The session cookie is SameSite=Strict, but GETs skip the CSRF check, so a WebSocket
      // upgrade must come from our own web app (no cross-site WebSocket hijacking).
      onRequest: async (req) => {
        if (req.ws && req.headers.origin !== config.WEB_ORIGIN) throw HttpError.forbidden('Origin not allowed');
      },
      preHandler: async (req) => {
        const { user } = caller(req);
        const { id } = idParam.parse(req.params);
        const size = sizeQuery.parse(req.query);
        const p = await db.tenant(user.orgId, async (q) => {
          const ws = await loadWorkspace(q, user, id);
          if (runtime.kind !== 'docker') {
            throw new HttpError(
              400,
              'terminal_unavailable',
              'The terminal needs workspace containers (WORKSPACE_RUNTIME=docker). This server runs workspaces on the host, and the platform never opens a shell on the host.',
            );
          }
          const vars = req.ws ? await resolveVariables(q, vault, ws.environmentId) : { env: {} };
          return { user, ws, env: vars.env, ...size };
        });
        if (req.ws) {
          const aws = await issueAwsEnvForRun(db, user.orgId, vault, getStsClient(), {
            environmentId: p.ws.environmentId, userId: user.id, workspaceId: id, isOrgAdmin: user.isOrgAdmin,
          }).catch(() => null); // failure is audited by the broker; the terminal still opens
          if (aws) p.env = { ...p.env, ...aws };
        }
        if (req.ws && countFor(id) >= MAX_TERMINALS_PER_WORKSPACE) {
          throw new HttpError(409, 'too_many_terminals', `At most ${MAX_TERMINALS_PER_WORKSPACE} terminals can be open in a workspace. Close one and try again.`);
        }
        prepared.set(req, p);
      },
      handler: async (req) => {
        const { id } = idParam.parse(req.params);
        return { available: true, open: countFor(id), max: MAX_TERMINALS_PER_WORKSPACE };
      },
      wsHandler: (socket, req) => {
        const p = prepared.get(req);
        prepared.delete(req);
        if (!p) return socket.close(1011, 'Not prepared');
        serve(socket, p);
      },
    });
  });

  function serve(socket: WebSocket, p: Prepared) {
    const wsId = p.ws.id;
    const set = open.get(wsId) ?? new Set();
    open.set(wsId, set);
    // Re-checked here: two upgrades may have passed the preHandler at the same time.
    if (set.size >= MAX_TERMINALS_PER_WORKSPACE) {
      socket.close(4409, 'Too many terminals in this workspace');
      return;
    }

    let shell: ContainerShell | undefined;
    let ended = false;
    let openedAt: number | undefined;
    let lastActivity = Date.now();
    let alive = true;
    const queue: ClientMessage[] = [];

    const send = (data: Buffer) => {
      if (socket.readyState === socket.OPEN) socket.send(data, { binary: true });
    };

    const end: EndFn = (reason, code = 1000, message = '') => {
      if (ended) return;
      ended = true;
      set.delete(end);
      if (!set.size) open.delete(wsId);
      clearInterval(timers);
      shell?.close();
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(code, message.slice(0, 120));
      if (openedAt !== undefined) {
        void record(p, 'terminal.closed', { reason, durationSec: Math.round((Date.now() - openedAt) / 1000) });
      }
    };
    set.add(end);

    const handle = (m: ClientMessage) => {
      if (m.type === 'input') {
        lastActivity = Date.now();
        shell!.write(m.data);
      } else {
        shell!.resize(m.cols, m.rows);
      }
    };

    socket.on('message', (raw: RawData, isBinary: boolean) => {
      if (isBinary) return end('protocol_error', 1003, 'Send JSON text messages');
      let parsed: ClientMessage;
      try {
        const r = clientMessage.safeParse(JSON.parse(raw.toString()));
        if (!r.success) return end('protocol_error', 1008, 'Invalid message');
        parsed = r.data;
      } catch {
        return end('protocol_error', 1008, 'Invalid message');
      }
      if (shell) return handle(parsed);
      if (queue.length >= MAX_QUEUED_MESSAGES) return end('protocol_error', 1008, 'Too many messages before the shell started');
      queue.push(parsed);
    });
    socket.on('close', () => end('closed'));
    socket.on('pong', () => {
      alive = true;
    });

    // Keep-alive through proxies, dead-peer detection and the idle limit.
    let ticks = 0;
    const timers = setInterval(() => {
      if (++ticks % (PING_INTERVAL_MS / 1000) === 0) {
        if (!alive) return end('connection_lost');
        alive = false;
        socket.ping();
      }
      if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
        send(notice(`Closed after ${Math.round(IDLE_TIMEOUT_MS / 60_000)} minutes without activity`));
        end('idle', 4000, 'Closed after a period without activity');
      }
    }, 1000);
    timers.unref();

    void (async () => {
      // The container may be stopped (after a restart) or need creating: bring it up first.
      const slow = setTimeout(() => send(Buffer.from('\x1b[2mStarting the workspace container…\x1b[0m\r\n')), 1500);
      try {
        await runtime.ensure(workspacePaths(workspacesDir, wsId), networkPolicyFor(p.ws));
      } catch (err) {
        const message = err instanceof HttpError ? err.message : 'The workspace container could not be started.';
        if (!(err instanceof HttpError)) app.log.error({ err }, 'terminal: runtime.ensure failed');
        send(notice(message));
        return end('runtime_error', 1011, message);
      } finally {
        clearTimeout(slow);
      }
      if (ended) return;

      const sh = new ContainerShell({ workspaceId: wsId, env: p.env, cols: p.cols, rows: p.rows });
      shell = sh;
      openedAt = Date.now();
      void record(p, 'terminal.opened', { cols: p.cols, rows: p.rows, variables: Object.keys(p.env).length });

      const relay = (chunk: Buffer) => {
        lastActivity = Date.now();
        send(chunk);
        // Backpressure: stop reading from the shell while the browser falls behind.
        if (socket.bufferedAmount > MAX_BUFFERED_BYTES && !sh.stdout.isPaused()) {
          sh.stdout.pause();
          const wait = setInterval(() => {
            if (ended || socket.bufferedAmount < MAX_BUFFERED_BYTES / 4) {
              clearInterval(wait);
              sh.stdout.resume();
            }
          }, 50);
        }
      };
      sh.stdout.on('data', relay);
      sh.stderr.on('data', relay);
      sh.onExit((code) => {
        if (ended) return;
        send(notice(code === 0 ? 'Shell exited' : code === null ? 'Shell could not be started' : `Shell exited with code ${code}`));
        end('exited', 1000, 'Shell exited');
      });
      for (const m of queue.splice(0)) handle(m);
    })();
  }
}
