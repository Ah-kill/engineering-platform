# API reference

Hand-written from the route files in `apps/api/src/*/routes.ts` (no generator; check the code when in
doubt, it wins). Grouped by module. Endpoints added while this was written are in
[Recently added](#recently-added) at the end.

## Conventions

| Topic | Rule |
|-------|------|
| Base path | Everything is under `/api` (e.g. `GET /api/clients`). In production the same server serves the web app; any other non-`/api` GET returns `index.html`. |
| Authentication | Session cookie `ep_session` (httpOnly, SameSite=Strict, `Secure` when `COOKIE_SECURE=true`), set by `POST /auth/login` or `POST /auth/login/mfa`. Every route needs it unless marked **public**. Missing or expired: `401 unauthorized`. |
| CSRF | `POST`, `PUT`, `PATCH`, `DELETE` must send an `x-requested-with` header (any value) and, if the browser sends `Origin`, it must equal `WEB_ORIGIN`. Otherwise `403 forbidden`. The terminal WebSocket upgrade also requires `Origin` = `WEB_ORIGIN`. |
| Bodies | JSON only (`content-type: application/json`), up to 6 MB (file saves); most bodies are far smaller and validated with zod. |
| Ids | UUIDs, except audit event ids (stringified bigint) and agent event ids (stringified bigint). A malformed id is `400`. |
| Errors | `{"error": {"code": string, "message": string, "details"?: unknown}}`. Validation failures: `400 validation_failed` with `details: [{path, message}]`. |
| 404 vs 403 | A resource you cannot see is `404 not_found` (existence is not leaked). A resource you can see but may not change is `403 forbidden`. |
| Rate limits | Marked per endpoint. Exceeded: `429 rate_limited` (or `429 mfa_locked`). Behind a proxy set `TRUST_PROXY_HOPS` so limits are per client. |
| Dates | ISO 8601 strings in UTC. Money: US dollars as numbers. |
| Audit | Every change is recorded in the audit log in the same transaction; the action name is given per endpoint. |

### Permissions

Org-level (org admins only): `org.manage_users`, `org.read_audit`, `client.create`, `client.update`,
`client.archive`. Resource-level, from grants (`viewer`, `developer`, `app_admin`, `app_creator`) on a
client, application or environment; grants flow down, never up:

| Permission | viewer | developer | app_admin | app_creator | org admin |
|------------|:-:|:-:|:-:|:-:|:-:|
| `client.view` / `application.view` / `environment.view` | yes | yes | yes | client only | yes |
| `environment.use` (workspaces, Claude, terminal, AWS credentials) | | yes | yes | | **no** |
| `application.update`, `application.archive`, `application.merge` (merge PRs), `environment.manage`, `grant.manage` | | | yes | | yes |
| `application.create` | | | | yes | yes |

On a **protected** environment (production), `environment.use` needs a grant on that exact environment,
and only org admins may grant it or change that environment's protection, variables or AWS settings.

"Workspace access" below means: you own the workspace (or it was shared with you, see Recently added)
**and** you still hold `environment.use` on its environment. Otherwise `404`.

---

## Health

| Method | Path | Auth | Response |
|--------|------|------|----------|
| GET | `/health` | public | `{ "ok": true }` |

## Identity: sign-in, account

### `POST /auth/login` (public, 10/min per client)
Body `{ email: string (email, ≤320), password: string (1-1024) }`.
- Without two-step login: sets the session cookie, `200 { ok: true }`. Audit `auth.login`.
- With two-step login: no cookie; `200 { mfaRequired: true, challenge: string }` (valid 5 minutes, a few attempts).
- Errors: `401 unauthorized` "Invalid email or password" (same for unknown users, wrong passwords and
  disabled accounts; audited as `auth.login` denied), `429 mfa_locked` while two-step sign-in is paused.

### `POST /auth/login/mfa` (public, 10/min per client)
Body `{ challenge: string, code: string (6-digit TOTP or a recovery code) }`. Sets the cookie, `{ ok: true }`.
Audit `auth.mfa` (success with `method`, or denied) and `auth.login`.
Errors: `401 mfa_expired` (challenge expired, used up or user gone), `401 unauthorized` "Invalid code",
`429 mfa_locked` after 10 wrong codes in a row for that user (paused 15 minutes).

### `POST /auth/logout`
Revokes the current session and clears the cookie. `{ ok: true }`. Audit `auth.logout`.

### `GET /auth/me`
`{ user: { id, orgId, email, displayName, isOrgAdmin }, org: { id, name, slug } }`.

### `POST /auth/password` (5/min)
Body `{ currentPassword, newPassword (12-1024) }`. Signs out every other session of the user.
`{ ok: true }`. Errors: `400` "Current password is incorrect". Audit `auth.password_changed`.

### Two-step login (the signed-in user)

| Method | Path | Limit | Body | Response | Errors / audit |
|--------|------|-------|------|----------|----------------|
| GET | `/me/mfa` | | | `{ enabled: boolean, recoveryCodesLeft: number }` | |
| POST | `/me/mfa/setup` | 10/min per user | | `{ otpauthUrl, qrDataUrl (PNG data URL), secret }`, `cache-control: no-store`. The secret stays pending until enabled | `409` already on. `mfa.setup` |
| POST | `/me/mfa/enable` | 10/min per user | `{ code }` | `{ recoveryCodes: string[10] }` (shown once); signs out other sessions | `400` no setup / wrong code, `409` already on. `mfa.enable` |
| POST | `/me/mfa/disable` | 5/min per user | `{ password, code }` (code may be a recovery code) | `{ ok: true }` | `400` not on / wrong password or code. `mfa.disable` |
| POST | `/me/mfa/recovery-codes` | 5/min per user | `{ code }` | `{ recoveryCodes: string[10] }`; old codes stop working | `400`. `mfa.recovery_codes` |

### Signed-in devices (the signed-in user)

Sessions are only ever read and changed for the caller's own user id. Tokens and token hashes are never returned.

| Method | Path | Response | Errors / audit |
|--------|------|----------|----------------|
| GET | `/me/sessions` | Active (not revoked, not expired) sessions, newest first, at most 100: `[{ id, createdAt, lastUsedAt, expiresAt, ip, userAgent (≤300 chars), current }]`. `lastUsedAt` equals `createdAt` until last use is recorded. `current` marks the session making the request | |
| DELETE | `/me/sessions/:id` | Revokes one of your sessions: `{ ok: true, signedOut: boolean }`. Revoking the current one also clears the cookie (`signedOut: true`) | `404` unknown, already revoked, or another user's session. `auth.session_revoked` (`details.current`) |
| POST | `/me/sessions/revoke-others` | Revokes every other active session of yours: `{ ok: true, revoked: number }` | `auth.sessions_revoked` (`details.count`) |

## Users (developers)

| Method | Path | Permission | Body / query | Response | Errors / audit |
|--------|------|-----------|--------------|----------|----------------|
| GET | `/users/directory` | any user | | Active colleagues `[{ id, email, displayName }]` (for grant pickers) | |
| GET | `/users` | `org.manage_users` | | `[{ id, email, displayName, isOrgAdmin, status, mfaEnabled, createdAt, lastLoginAt }]` | `403` |
| POST | `/users` | `org.manage_users` | `{ email, displayName (1-120), password (12+), isOrgAdmin? }` | `201` user | `409` email exists. `user.created` |
| PATCH | `/users/:id` | `org.manage_users` | Any of `{ displayName, isOrgAdmin, status: 'active'\|'disabled', password, resetMfa: boolean }` | user | `400` disabling/demoting yourself or resetting your own MFA, `404`. Disabling, a new password or `resetMfa` signs the user out everywhere. `user.updated` |

## Tenancy: clients, applications, environments

Lists show only what you can see (org admins see everything; others see what they hold grants in,
including parents of what they hold grants in, by name only).

| Method | Path | Permission | Body / query | Response | Audit |
|--------|------|-----------|--------------|----------|-------|
| GET | `/clients` | visible | `?archived=true\|false` (default false) | `[{ id, name, slug, description, archivedAt, createdAt }]` | |
| POST | `/clients` | `client.create` | `{ name (1-120), slug? (lowercase, digits, dashes; derived from name), description? (≤2000) }` | `201` client. `409` slug taken | `client.created` |
| GET | `/clients/:id` | visible | | client + `permissions: Permission[]` | |
| PATCH | `/clients/:id` | `client.update` | `{ name?, description? }` | client | `client.updated` |
| POST | `/clients/:id/archive`, `/clients/:id/unarchive` | `client.archive` | | client | `client.archived` / `client.unarchived` |
| GET | `/clients/:id/applications` | client visible | `?archived=` | `[{ id, clientId, name, slug, description, origin, archivedAt, createdAt }]` | |
| POST | `/clients/:id/applications` | `application.create` | `{ name, slug?, description?, origin?: 'existing'\|'new', createDefaultEnvironments? (default true) }` | `201` application + `environments` (development, staging, production; production protected). A non-admin creator becomes its `app_admin`. `400` client archived, `409` slug taken | `application.created` |
| GET | `/applications/:id` | visible | | application + `clientName`, `environments[]` (each with `permissions`), `permissions` | |
| PATCH | `/applications/:id` | `application.update` | `{ name?, description? }` | application | `application.updated` |
| POST | `/applications/:id/archive`, `/unarchive` | `application.archive` | | application | `application.archived` / `application.unarchived` |
| POST | `/applications/:id/environments` | `environment.manage` | `{ name (slug), kind: 'development'\|'staging'\|'production', protected?, awsRegion? }` | `201` environment. `403` unprotected production by a non-admin, `409` name taken | `environment.created` |
| PATCH | `/environments/:id` | `environment.manage`; `protected` only by org admins | `{ protected?, awsRegion? (null clears) }` | environment `{ id, applicationId, name, kind, protected, awsRegion, archivedAt }` | `environment.updated` / `environment.unprotected` |

## Access grants

| Method | Path | Permission | Body / query | Response | Errors / audit |
|--------|------|-----------|--------------|----------|----------------|
| GET | `/grants` | real `*.view` on the scope (not navigation-only) | `?scopeType=client\|application\|environment&scopeId=` | `[{ id, userId, email, displayName, role, scopeType, scopeId, expiresAt, createdAt, inherited }]`: grants on the scope, inherited ones from ancestors, and for an application its environments' grants | `404` |
| POST | `/grants` | `grant.manage` on the scope; protected environment: org admin | `{ userId, role, scopeType, scopeId, expiresAt? (future) }`. `app_creator` only on a client | `201` grant | `400` unknown/disabled user, `403`, `409` duplicate. `grant.created` |
| DELETE | `/grants/:id` | as above | | `{ ok: true }` | `grant.revoked` |

## Settings: Claude and GitHub credentials (the signed-in user)

| Method | Path | Body | Response | Audit |
|--------|------|------|----------|-------|
| GET | `/me/settings` | | `{ authMode: 'api_key'\|'subscription', defaultModel, credentials: { anthropic_api_key, claude_oauth_token, github_token: { saved, hint?, updatedAt? } } }` plus `githubTokens` (see Recently added). Values are never returned | |
| PUT | `/me/settings` | `{ authMode?, defaultModel? (model id or alias) }` | the settings | `settings.updated` |
| PUT | `/me/credentials/:kind` | `{ value (1-4096) }`; `kind` = `anthropic_api_key` \| `claude_oauth_token` \| `github_token`. The format is checked per kind | `{ ok: true }`. `400` wrong format | `credential.saved` (`kind`, never the value) |
| DELETE | `/me/credentials/:kind` | | `{ ok: true }` | `credential.deleted` |

## Agents: models, conversations, runs

| Method | Path | Auth | Body / query | Response | Errors / audit |
|--------|------|------|--------------|----------|----------------|
| GET | `/models` | any user | `?refresh=true` bypasses the cache | `{ models: [{ id, label, description, resolvedModel?, source: 'claude-code'\|'anthropic-api' }], fetchedAt, errors: string[] }`, discovered with the caller's own credential | |
| GET | `/system/claude-code` | any user | | `{ sdk, claudeCode, latestSdk \| null, updateAvailable }` | |
| GET | `/me/recent` | any user | | Up to 12 of your workspaces you can still use, each with its latest conversation: `[{ id, branch, state, lastActiveAt, environmentId, applicationId, applicationName, clientName, environmentName, sessionId, sessionTitle, sessionUpdatedAt, sessionCount, running }]` | |
| GET | `/workspaces/:id/agent/sessions` | workspace access | | `{ sessions: [{ id, title, model, authMode, costUsd, inputTokens, outputTokens, createdAt, updatedAt }] (yours, ≤50), running, activeSessionId }` | |
| POST | `/workspaces/:id/agent/run` | workspace access (write) | `{ prompt (1-50,000), mode: 'plan'\|'execute', model?, sessionId? (continue a conversation) }` | `{ sessionId }` immediately; the run continues in the background, follow it with the event stream | `409` already running or a git operation in progress, `400` no Claude credential / workspace not ready, `404` unknown conversation. `agent.run.plan` / `agent.run.execute`. Short-lived AWS credentials are issued when the environment has a role (`aws.credentials.issued`) |
| POST | `/workspaces/:id/agent/cancel` | workspace access | | `{ cancelled: boolean }` (pending approvals are refused) | |
| POST | `/workspaces/:id/agent/approvals/:approvalId` | workspace access | `{ allow: boolean }` | `{ ok: true }` | `404` no such pending approval (answered, timed out after 15 min, or run ended) |
| DELETE | `/agent/sessions/:id` | your conversation, workspace access | | `{ ok: true }` (events deleted with it) | `404`, `409` while it is running. `agent.session.deleted` |

### Server-sent events: `GET /agent/sessions/:id/events`

Your own conversation, with workspace access. Query `?after=<event id>` (default 0). Response
`content-type: text/event-stream`: first every stored event with an id greater than `after`, then new
events live. The browser reconnects with the last id it saw (`EventSource` sends `Last-Event-ID`; the
web app passes it as `after`). A comment `: ping` every 20 seconds keeps proxies open.

```
id: 1042
event: agent
data: {"id":"1042","kind":"text","data":{"text":"Reading the payment module…"},"createdAt":"2026-11-07T10:01:02.000Z"}
```

`data.kind` and its `data`:

| kind | data |
|------|------|
| `user` | `{ prompt, mode, model }`, the developer's message |
| `status` | `{ state: 'running', mode }` or `{ state: 'idle' }` (the run finished, failed or was stopped) |
| `text` | `{ text }`, assistant text |
| `tool_use` | `{ toolUseId, name, input }` |
| `tool_result` | `{ toolUseId, isError, output }` (clipped, secrets redacted) |
| `plan` | `{ plan }`, plan mode's proposed plan, waiting for *Approve and execute* |
| `approval_request` | `{ approvalId, tool, input, reason }`; answer with the approvals endpoint |
| `approval_decision` | `{ approvalId, allow }` |
| `policy_denied` | `{ tool, input, reason }`, blocked by the tool policy without asking |
| `result` | `{ isError, subtype, costUsd, inputTokens, outputTokens, durationMs, text? }`, end of a turn; cost is added to the conversation |
| `error` / `cancelled` | `{ message }` |

Errors before the stream starts are normal JSON (`404` not your conversation or no workspace access).

## Workspaces, files and git

| Method | Path | Auth | Body / query | Response | Errors / audit |
|--------|------|------|--------------|----------|----------------|
| GET | `/applications/:id/repository` | `application.view` | | `{ id, provider: 'github', owner, name, defaultBranch, url } \| null` | |
| PUT | `/applications/:id/repository` | `application.update` | `{ url ('https://github.com/owner/repo' or 'owner/repo'), defaultBranch? }`; checked with your GitHub token when you have one | repository | `400` not a GitHub repository. `repository.connected` |
| GET | `/applications/:id/workspaces` | `application.view` | | Your workspaces in the application (and shared ones) that you can still use | |
| POST | `/applications/:id/workspaces` | `application.view` + `environment.use` on the environment | `{ environmentId, branch, createBranch? (default true), baseBranch? }` | `202 { id, state: 'creating' }`; cloning continues in the background, poll `GET /workspaces/:id` | `400` environment of another application / no repository / bad branch name, `403`. `workspace.created` |
| GET | `/workspaces/:id` | workspace access | | `{ id, applicationId, environmentId, branch, baseBranch, state: 'creating'\|'ready'\|'failed', error, repoOwner, repoName, defaultBranch, applicationName, clientId, clientName, environmentName, environmentKind, createdAt, lastActiveAt, … }` | |
| DELETE | `/workspaces/:id` | owner | | `{ ok: true }`; stops Claude, removes the container and files | `workspace.deleted` |
| GET | `/workspaces/:id/tree` | workspace access, ready | | `{ entries: [{ path, type: 'file'\|'dir', skipped? }], truncated }` | |
| GET | `/workspaces/:id/file` | as above | `?path=` | `{ path, content, binary, size }` | `400` outside the checkout / not a file |
| PUT | `/workspaces/:id/file` | write | `{ path, content (≤5 MB) }` | `{ ok: true }` | `409` while Claude runs |
| DELETE | `/workspaces/:id/file` | write | `?path=` | `{ ok: true }` | `409` while Claude runs |
| GET | `/workspaces/:id/git/status` | workspace access | | `{ branch, ahead, behind, files: [{ path, code, status: 'modified'\|'added'\|'deleted'\|'renamed'\|'untracked' }], baseBranch, defaultBranch }` | |
| GET | `/workspaces/:id/git/diff` | workspace access | `?path=` | `{ path, original (HEAD), modified (working tree), binary }` | |
| GET | `/workspaces/:id/git/branches` | workspace access | | `{ current, local: string[], remote: string[] }` | |
| GET | `/workspaces/:id/git/log` | workspace access | | Last 50 commits `[{ sha, author, date, subject }]` | |
| POST | `/workspaces/:id/git/discard` | write | `{ path }` | `{ ok: true }` (untracked/new files deleted, others restored from HEAD) | `git.discard` |
| POST | `/workspaces/:id/git/fetch` | write; uses your GitHub token | | branches | `409` while Claude runs; the repository's git config must pass the allowlist |
| POST | `/workspaces/:id/git/pull` | write; token | | `{ output }` (fast-forward only) | `400` not pushed yet / not fast-forward, `409`. `git.pull` |
| POST | `/workspaces/:id/git/checkout` | write | `{ branch, create? }` | branches | `400` uncommitted changes, `409`. `git.checkout` / `git.branch_created` |
| POST | `/workspaces/:id/git/commit` | write | `{ message (1-5000) }` | `{ sha }`, authored as you | `400` nothing to commit, `409`. `git.commit` |
| POST | `/workspaces/:id/git/push` | write; token | | `{ ok: true, branch }` | `403` default branch or `main`/`master`/`production`/`prod`/`release`, `400` rejected by GitHub, `409`. `git.push` |
| POST | `/workspaces/:id/pull-request` | write; token | `{ title (1-250), body?, draft? }` | `{ number, url }` against the workspace's base branch | `400` no GitHub token. `git.pull_request` |

## Terminal (WebSocket)

`GET /workspaces/:id/terminal`, workspace access (write), Docker runtime only.

- **Plain GET** (no upgrade): `{ available: true, open: number, max: 3 }`. Lets the UI show whether a terminal can open.
- **WebSocket upgrade** (`ws:`/`wss:` on the same origin; `Origin` must equal `WEB_ORIGIN`, otherwise `403`).
  Query `?cols=80&rows=24` (2-1000 by 1-500).
  - Browser to server: JSON **text** frames, at most 64 KB each: `{"type":"input","data":"ls\r"}` and
    `{"type":"resize","cols":120,"rows":40}`. Binary frames close with 1003; invalid JSON with 1008.
    Messages sent before the shell starts are queued (up to 200).
  - Server to browser: raw terminal output as **binary** frames. Status notices (starting the container,
    shell exited, idle) are written into the terminal itself.
  - The shell runs in the workspace container as uid 1000 with the workspace's network policy, the
    environment's variables and short-lived AWS credentials (when configured), never the developer's
    Claude or GitHub credential.
  - Limits: 3 terminals per workspace (`409 too_many_terminals` before the upgrade, close code 4409 in a
    race), closed after 60 minutes without input or output (close code 4000), ping every 30 seconds,
    output paused while the browser falls behind.
  - Close codes: 1000 normal / shell exited, 1001 server shutdown, 1003/1008 protocol error,
    1011 container could not start, 4000 idle, 4409 too many terminals.
- Errors before the upgrade: `400 terminal_unavailable` (`WORKSPACE_RUNTIME=local`), `404`, `403`, `409`.
- Audit: `terminal.opened` (`cols`, `rows`, number of variables) and `terminal.closed` (`reason`,
  `durationSec`). What is typed and shown is never logged.

## Variables, secrets and network access

| Method | Path | Permission | Body / query | Response | Audit |
|--------|------|-----------|--------------|----------|-------|
| GET | `/environments/:id/variables` | `environment.view` | | `[{ id, name, isSecret, value (null for secrets), hint, description, updatedAt }]` | |
| PUT | `/environments/:id/variables/:name` | `environment.manage`; protected: org admin | `{ value, isSecret? (default true), description? (≤500) }`. Name `^[A-Z_][A-Z0-9_]{0,127}$`; reserved names refused | the full list | `variable.set` (name and secret flag, never the value) |
| POST | `/environments/:id/variables/import` | as above | `{ text (.env, ≤256 KB), isSecret? }`, up to 500 variables | the full list | `variable.imported` |
| DELETE | `/environments/:id/variables/:name` | as above | | the full list. `404` | `variable.deleted` |
| GET | `/applications/:id/network` | `application.view` | | `{ mode: 'restricted'\|'open', hosts: string[], builtin: string[] }` | |
| PUT | `/applications/:id/network` | `application.update` | `{ mode, hosts? (≤100; `api.example.com`, `*.example.com` or `host:port`, no IPs or URLs) }` | as GET. Running containers pick up the policy on their next start | `network.updated` |

## AWS access broker

| Method | Path | Permission | Body | Response | Errors / audit |
|--------|------|-----------|------|----------|----------------|
| GET | `/environments/:id/aws` | `environment.view` | | `{ roleArn, region, sessionSeconds, access: 'read'\|'write', externalIdSet, hint }` plus the session policy fields (Recently added). The ExternalId is never returned | |
| PUT | `/environments/:id/aws` | `environment.manage`; protected: org admin | Strict: `{ roleArn, externalId? (required the first time, kept when omitted), region, sessionSeconds? (900-43200, default 3600), access? }`. Unknown keys (e.g. access keys) are refused | as GET | `400` bad ARN/region/partition, missing ExternalId. `aws.config.updated` |
| DELETE | `/environments/:id/aws` | as PUT | | as GET (cleared) | `aws.config.cleared` |
| POST | `/environments/:id/aws/test` (10/min) | `environment.use` (org admins get a clear refusal) | | `{ account, arn }` from STS GetCallerIdentity with a 15-minute session | `400` no role, STS errors mapped to readable `400`s. `aws.connection.tested` (success or failure) |

Credentials issued to runs and terminals are STS AssumeRole sessions named `ep-<user>-<workspace>`
(visible in the client's CloudTrail), never stored, and redacted from agent output.

## Usage

### `GET /usage`
Query `from`, `to` (`YYYY-MM-DD`, inclusive UTC days; default the last 30 days; at most 366 days).
Org admins (`org.read_audit`) get the whole organization (`scope: 'org'`), everyone else only their own
conversations (`scope: 'self'`).

```
{ from, to, scope, totals: { costUsd, inputTokens, outputTokens, sessions },
  byDay: [{ day, …totals }],            // every day in the range, zero-filled
  byUser: [{ userId, email, displayName, …totals }],
  byApplication: [{ applicationId, applicationName, clientId, clientName, …totals }],
  byModel: [{ model, …totals }] }
```
A conversation counts on the UTC day it started; later cost is added to that day. Errors: `400`
(bad date, `from` after `to`, range too long).

## Organisation and budgets

Changes need `org.manage_users` (org admins). Amounts are US dollars, 0 to 1,000,000, rounded to cents.

| Method | Path | Permission | Body | Response | Errors / audit |
|--------|------|-----------|------|----------|----------------|
| GET | `/org` | any user | | `{ id, name, slug, monthlyBudgetUsd: number \| null, canManage }` | |
| PATCH | `/org` | org admin | Strict, at least one of `{ name (1-120), monthlyBudgetUsd: number \| null }` (null = no default limit) | as GET | `400`, `403`. `org.updated` |
| GET | `/org/budgets` | org admin | | `{ month: 'YYYY-MM', defaultUsd, users: [{ userId, email, displayName, status, overrideUsd, limitUsd, spentUsd, allowed }] }` | `403` |
| GET | `/org/budgets/:userId` | org admin | | `{ userId, email, displayName, limitUsd, spentUsd, allowed, overrideUsd, defaultUsd, month }` | `404` unknown user (or another org's) |
| PUT | `/org/budgets/:userId` | org admin | Strict `{ monthlyBudgetUsd: number \| null }` (null removes the override) | as GET | `400`, `404`. `budget.set` / `budget.cleared` |
| GET | `/me/budget` | any user | | Your own `{ limitUsd, spentUsd, allowed, overrideUsd, defaultUsd, month }` | |

### Budgets

The monthly limit is the developer's override, else the organisation default, else none. Spend is the
sum of `agent_sessions.cost_usd` of conversations the developer **started** in the current UTC calendar
month (the same rule as the Usage page). `allowed` is false once spend reaches the limit.

Server-side check, exported from `apps/api/src/org/budgets.ts` (re-exported by `src/org/routes.ts`):

```ts
checkMonthlyBudget(q: Queryable, orgId: string, userId: string, now?: Date)
  : Promise<{ limitUsd: number | null; spentUsd: number; allowed: boolean }>
requireWithinBudget(q, orgId, userId)   // throws 403 budget_exceeded when !allowed
```

Run start enforcement belongs in `POST /workspaces/:id/agent/run`, inside its `db.tenant` block, before
`agents.start`: `await requireWithinBudget(q, user.orgId, user.id);`. Once wired, a refused run returns
`403 { error: { code: 'budget_exceeded', message, details: { limitUsd, spentUsd } } }`. The per-run cap
`AGENT_MAX_BUDGET_USD` applies independently.

## Audit log

Org admins only (`org.read_audit`); others `403`.

### Filters (both endpoints)

| Query | Meaning |
|-------|---------|
| `clientId`, `applicationId`, `environmentId`, `actorId` | UUIDs; exact match |
| `workspaceId` | UUID; events whose resource is that workspace, or whose `details.workspaceId` is it (Claude runs) |
| `action` | Prefix of lower-case dotted action names, e.g. `git.` (all git actions), `auth.login`. `_` is not a wildcard |
| `outcome` | `success`, `denied` or `failure` |
| `from`, `to` | Inclusive. `YYYY-MM-DD` is a whole UTC day; an ISO timestamp with an offset is exact. `from` must be before `to` |
| `before` | Only events with a smaller id (cursor) |

Unknown query keys and malformed values are `400 validation_failed`.

### `GET /audit`
Plus `limit` (1-200, default 50). Newest first:
`[{ id, occurredAt, action, outcome, resourceType, resourceId, clientId, clientName, applicationId,
applicationName, environmentId, environmentName, actorId, actorEmail, details }]`.
For the next page pass `before=<last id>`.

### `GET /audit/export.csv` (10/min)
Plus `limit` (1-50,000, default 50,000). `200 text/csv; charset=utf-8`,
`content-disposition: attachment; filename="audit-<timestamp>.csv"`, `cache-control: no-store`. Streamed
in batches of 1,000 rows, newest first; events recorded after the export started are left out. UTF-8 with
a byte-order mark (for Excel), CRLF line ends, RFC 4180 quoting. Columns:

`id, occurred_at, actor_email, actor_id, action, outcome, resource_type, resource_id, client, client_id,
application, application_id, environment, environment_id, details` (details as JSON).

Cells starting with `=`, `+`, `-`, `@`, tab or carriage return get a leading `'` so spreadsheets do not
evaluate them. The export is audited as `audit.exported` with its filters. Permission and validation
errors are JSON, before any CSV is sent.

### Common action names

`auth.login`, `auth.logout`, `auth.mfa`, `auth.password_changed`, `auth.session_revoked`,
`auth.sessions_revoked`, `mfa.*`, `user.*`, `client.*`, `application.*`, `environment.*`, `grant.*`,
`repository.connected`, `workspace.*`, `git.*`, `agent.run.plan`, `agent.run.execute`,
`agent.session.deleted`, `terminal.opened`, `terminal.closed`, `variable.*`, `network.updated`,
`aws.*`, `credential.*`, `settings.updated`, `org.updated`, `budget.set`, `budget.cleared`,
`audit.exported`. Details never contain secrets: keys that look like passwords, tokens, keys or
credentials are dropped before writing.

---

## Recently added

Collected by re-reading the route files at the end of this documentation pass (2026-11-07). These
endpoints were being built in parallel; their request and response shapes come from the code at that
moment and may still move. Check the route file named in each heading.

### Workspace sharing (`src/workspaces/routes.ts`, migration 009)

A workspace owner can share it. Members still need `environment.use` on the workspace's environment
(checked when added and on every request). Access levels used by the workspace endpoints:
**read** (owner, editor, viewer: tree, file, search, status, diff, branches, log, commits, compare,
pull requests, members), **write** (owner, editor: file and git changes, Claude, terminal) and
**owner** (delete the workspace, manage members). A viewer calling a write endpoint gets `403`.

| Method | Path | Access | Body | Response | Audit |
|--------|------|--------|------|----------|-------|
| GET | `/workspaces/:id/members` | read | | `{ owner: { id, displayName, email }, members: [{ userId, displayName, email, role: 'viewer'\|'editor', createdAt }], canManage }` | |
| GET | `/workspaces/:id/members/candidates` | owner | | Active colleagues with `environment.use` who are not members yet: `[{ id, displayName, email }]` | |
| PUT | `/workspaces/:id/members/:userId` | owner | `{ role: 'viewer'\|'editor' }` | member list. `400` the owner, or no working access to the environment; `404` unknown user | `workspace.member_added` |
| DELETE | `/workspaces/:id/members/:userId` | owner, or the member leaving | | member list. `404` not a member | `workspace.member_removed` |

### Git history, compare, search, reset (`src/workspaces/routes.ts`)

| Method | Path | Access | Query / body | Response | Errors / audit |
|--------|------|--------|--------------|----------|----------------|
| GET | `/workspaces/:id/search` | read | `?q=` (1-200, one line) `&regex=true\|false` | `{ hits: [{ path, line, text }] (≤200), truncated }` (git grep over the checkout) | `400` |
| GET | `/workspaces/:id/git/commit/:sha` | read | `sha`: a commit id | `{ sha, parent, author, email, date, subject, body, files }` with each file's content before and after | `404` |
| GET | `/workspaces/:id/git/compare` | read | `?base=&head=` (branches or refs) | `{ base, head, mergeBase, commits: [{ sha, author, date, subject }], files, truncated }`: what `head` adds since it forked from `base` (three-dot) | `400` |
| DELETE | `/workspaces/:id/git/branches/<name>` | write | `?force=true` for an unmerged branch | branches. Local branch only, never the remote one | `403` default, base or protected branch; `400` current branch; `404`; `409` unmerged without `force`, or Claude running. `git.branch_deleted` |
| POST | `/workspaces/:id/git/reset` | write | `{ to: 'head'\|'remote' }` (`remote` fetches with your token first) | git status. Discards all uncommitted changes and untracked files | `400`, `409`. `git.reset` |

### Pull requests and repository creation (`src/workspaces/routes.ts`, `src/settings/routes.ts`)

New permission **`application.merge`** (app admins and org admins).

| Method | Path | Auth | Query / body | Response | Errors / audit |
|--------|------|------|--------------|----------|----------------|
| GET | `/workspaces/:id/pull-requests` | read; your GitHub token | `?state=open\|closed\|all` (default open) | `[{ number, title, state: 'open'\|'closed'\|'merged', draft, author, head, base, url, createdAt, updatedAt, … }]` (≤50, recently updated first) | `400` no token |
| GET | `/workspaces/:id/pull-requests/:number` | read; token | | summary plus `{ body, headSha, mergeable, mergeableState, checks, files: [{ path, status, additions, deletions, patch? }], filesTruncated, canMerge }` | `404` |
| POST | `/workspaces/:id/pull-requests/:number/merge` | write + `application.merge`; token | `{ method: 'merge'\|'squash'\|'rebase' }` (default squash) | `{ merged, sha, message }`; merges only the head commit that was checked | `409` closed, draft, still being checked, conflicts, or blocked by required reviews/checks. `git.pull_request_merged` |
| POST | `/applications/:id/repository/create` | `application.update`; your token for that owner | `{ owner, name, private? (default true), description? (≤350) }` | the connected repository (as `GET /applications/:id/repository`) | `400` no token, `409` already connected. `repository.created` |
| GET | `/me/github/repos` | any user; token | `?owner=` (that owner's token, else the default one) | `{ repos: [{ owner, name, fullName, private, defaultBranch, description, updatedAt, url }], truncated }` | `400` no token |

GitHub tokens per owner (migration 009): `PUT /me/credentials/github_token` and
`DELETE /me/credentials/github_token` accept an `owner` (body / query) to save or remove the token for
one GitHub organization or user; without it they act on the default token. `GET /me/settings` adds
`githubTokens: [{ owner, hint, updatedAt }]`. The platform uses the repository owner's token and falls
back to the default one.

### Agent instructions and team activity (`src/tenancy/routes.ts`, `src/agents/routes.ts`, migration 010)

`PATCH /applications/:id` also accepts `agentInstructions` (≤20,000 characters, trimmed): project
instructions for Claude, added to the system prompt below the platform's own rules. `GET /applications/:id`
returns `agentInstructions`. The audit event records only their length (`agentInstructionsChars`).

| Method | Path | Permission | Response | Audit |
|--------|------|-----------|----------|-------|
| GET | `/applications/:id/agent/sessions` | `application.update` (app and org admins) | `{ sessions: [{ id, title, model, authMode, costUsd, inputTokens, outputTokens, createdAt, updatedAt, userId, userName, userEmail, workspaceId, branch, workspaceState, environmentName, environmentKind, running }] }` (≤200, recently updated first; metadata only) | |
| GET | `/agent/sessions/:id/transcript` | the conversation's owner (still holding `environment.use`), or `application.update` on its application | `{ session: { id, title, model, userId, userName, workspaceId, branch, applicationId, environmentId, environmentName, costUsd, inputTokens, outputTokens, createdAt, updatedAt }, events: [{ id, kind, data, createdAt }] (≤5,000), truncated }`; `404` for anyone else | `agent.transcript.viewed` when someone other than the owner reads it |

### AWS session policies (`src/aws/routes.ts`, migration 011)

`PUT /environments/:id/aws` also accepts `allowedActions: string[] | null` (omitted = keep, null = no
session policy). Each entry is `service:Action` (wildcards allowed in the action part), at most 100, and
the resulting policy must fit STS's 2,048-character limit. When set, every STS session carries an inline
policy allowing exactly these actions; it can only narrow the client's role. `GET /environments/:id/aws`
adds `allowedActions` and `policyPreset: 'read-only' | 'deploy' | 'custom' | null`.

| Method | Path | Auth | Response |
|--------|------|------|----------|
| GET | `/aws/session-policy-presets` | any user | `{ presets: [{ id, name, description, actions }], maxActions, maxPolicyChars }` |

### Behaviour added without new endpoints

- Run limits in `apps/api/src/config.ts`: `AGENT_MAX_MINUTES` (wall-clock limit per Claude run, default 30),
  `WORKSPACE_MAX_GB` (Claude does not start in a workspace folder larger than this, default 10) and
  `WORKSPACE_IDLE_MINUTES` (idle workspace containers are stopped, files kept, default 120; the reaper is in
  `src/agents/housekeeping.ts` and was not yet started from `main.ts` when this was written).
- Monthly budget enforcement at run start is not wired yet; see [Budgets](#budgets).
