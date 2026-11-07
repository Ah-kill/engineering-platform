# Engineering Platform

Internal platform for managing client applications and working on them with Claude Code.
Developers sign in, pick a client, application and environment, open a workspace on a
branch, and work with Claude in a browser IDE: plan, execute, review the diff, commit,
push and open a pull request. Works on desktop and on a phone.

See [docs/01-architecture-and-research.md](docs/01-architecture-and-research.md) for the
design, [docs/02-what-to-ask-clients.md](docs/02-what-to-ask-clients.md) for client onboarding and
[docs/03-deployment.md](docs/03-deployment.md) for running it on a server and reaching it from your phone.

## Status

| Area | State |
|------|-------|
| Sign-in, clients, applications, environments, developers, access control, audit | Built |
| Per-developer Claude credentials (API key or subscription token), live model list | Built |
| GitHub repositories, workspaces, editor, diff, commit, push, pull, branches, pull requests | Built |
| Claude Code in the workspace: plan / execute, streaming, approvals, stop, history, cost | Built |
| Phone layout | Built |
| Home: continue where you left off; delete conversations and workspaces | Built |
| Container isolation: Claude Code runs in a Docker container per workspace | Built |
| Environment variables and secrets per environment (any service), `.env` import | Built |
| Network access per application: only allowed sites (default) or unrestricted | Built |
| Browser terminal into the workspace container | Built |
| Two-step login (authenticator app + recovery codes) | Built |
| AWS access broker: per-environment role, short-lived credentials | Built |
| Usage and cost dashboard | Built |
| Production serving, deployment guide (VM + Caddy, Tailscale) | Built |

## Run it locally

Requirements: Node.js 22 or newer, git, and **Docker Desktop running** (workspaces run in containers).
The database is embedded Postgres unless you set `DATABASE_URL`. The workspace image is built automatically
the first time a workspace opens (a few minutes), or ahead of time with `npm run runtime:build`.

```bash
npm install

# One-time: create your organization and the first admin.
# Prints a generated password; or set ADMIN_PASSWORD (12+ characters) first.
npm run create-admin -- --org "So N So" --email you@example.com --name "Your Name"

# Start the API (port 4000) and the web app (port 5173)
npm run dev
```

Open http://localhost:5173 and sign in.

To use a Postgres server, copy `apps/api/.env.example` to `apps/api/.env` and set `DATABASE_URL`
(for example `postgres://platform:pass@localhost:5432/engineering_platform`). `.env` is git-ignored.
Migrations run automatically at startup. The database user needs `CREATEROLE` the first time,
because the schema creates the restricted `platform_app` role.

### Settings (environment variables in `apps/api/.env`, all optional)

| Variable | Default | Meaning |
|----------|---------|---------|
| `DATABASE_URL` | unset | Postgres connection string. Unset = embedded PGlite in `DATA_DIR` |
| `DATA_DIR` | `.data/pg` | Embedded Postgres files (relative to `apps/api`) |
| `VAULT_KEY` | unset | Base64 32-byte key that encrypts saved credentials. Unset = generated into `VAULT_KEY_FILE` |
| `VAULT_KEY_FILE` | `.data/vault.key` | **Back this file up.** Saved keys and tokens cannot be decrypted without it |
| `WORKSPACES_DIR` | `~/.engineering-platform/workspaces` | Where workspace checkouts live |
| `WORKSPACE_RUNTIME` | `docker` | `docker`: one container per workspace. `local`: on the host, no isolation (tests only) |
| `WORKSPACE_CPUS` / `WORKSPACE_MEMORY` / `WORKSPACE_PIDS` | `2` / `4g` / `512` | Limits per workspace container |
| `WORKSPACE_IMAGE` | `engineering-platform-workspace:<Claude Code version>` | Image to use instead of the built-in one |
| `AGENT_MAX_TURNS` / `AGENT_MAX_BUDGET_USD` | `80` / `10` | Limits per Claude run |
| `PORT` / `HOST` | `4000` / `127.0.0.1` | API listen address; local-only by default |
| `WEB_ORIGIN` | `http://localhost:5173` | The only origin allowed to make changes |
| `SESSION_TTL_HOURS` | `12` | Sign-in lifetime |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS |

## Using it

1. **Clients and applications:** as an org admin, create a client, then an application
   ("Existing repository" or "Build a new app from scratch"). Development, staging and
   production environments are created; production is protected.
2. **Developers and access:** add developers under *Developers* (they start with no access),
   then grant roles on a client or application: *Viewer*, *Developer*, *App admin*, *App creator*.
   Working access to a protected environment needs a grant on that exact environment, given by an org admin.
3. **Claude & GitHub** (each developer, once):
   - *API key*: paste a key from platform.claude.com. Billed per use.
   - *Claude subscription*: run `claude setup-token` on your own computer. It opens the same
     sign-in page as `/login` and prints a token valid for a year; paste it. Confirm with
     Anthropic that this use is allowed for your plan.
   - *Default model*: the list comes live from Claude Code and your account, so new models appear
     automatically. "Default", "Opus", "Sonnet" and "Haiku" always mean the newest version.
   - *GitHub token*: a fine-grained token limited to the client repositories, with
     Contents and Pull requests read/write.
4. **Repository:** an app admin connects the GitHub repository on the application page.
5. **Workspace:** *New workspace* → pick an environment and a branch → the IDE opens.
6. **With Claude:** describe the change in **Plan** mode, read the plan, press
   **Approve and execute**. Risky commands (deletes, cloud CLIs, `docker`, ...) wait for your
   approval; pushing and reading credentials are always blocked. Then review in **Changes**,
   commit, push and open a pull request. Pushing to the default branch is refused.

### Keeping Claude Code and models up to date

Claude Code is bundled in `@anthropic-ai/claude-agent-sdk`. *Claude & GitHub* shows the installed
version and whether a newer one exists. To update (also brings support for newly released models):

```bash
npm run update:claude   # installs the latest SDK, rebuilds the workspace image, runs the API tests
```

The update is applied deliberately rather than automatically, so a breaking change never lands in
the middle of someone's session. New models usually work before an update anyway: aliases resolve to
the newest model, and API-key users also see every model id from Anthropic's Models API.

## Develop

```bash
npm test            # API unit + integration tests (embedded Postgres, local git, no network)
npm run test:e2e    # Playwright browser tests, desktop and phone (isolated stack on ports 4100/5273)
SCREENSHOTS=shots npx playwright test   # also saves screenshots of key screens to ./shots
npm run typecheck
npm run build
```

The Playwright stack (`apps/api/e2e/server.ts`) runs the real API and web app with a fresh database,
a local git repository in place of GitHub, and a scripted agent in place of Claude, so it needs no
credentials and costs nothing.

```
apps/api            Fastify API
  migrations/         numbered SQL migrations (schema, row-level security, grants)
  src/access          authorization policy + checks
  src/identity        passwords, sessions, users
  src/tenancy         clients, applications, environments
  src/settings        per-user Claude/GitHub credentials and model settings
  src/vault           credential encryption
  src/git             git CLI wrapper, GitHub API
  src/workspaces      workspace lifecycle, files, git routes
  src/agents          Claude Agent SDK driver, tool policy, run manager, models, version
  src/audit           append-only audit log
  test/               unit and integration tests
  e2e/                isolated server for Playwright
apps/web            React app (Vite), Monaco editor
apps/runtime        Docker image for workspace containers
e2e/                Playwright tests
docs/               architecture, research, client onboarding
infra/              templates we send to clients (read-only AWS role)
```

## Security

- Every request is authorized in the API with one policy function; the UI only hides buttons.
  Queries run as an unprivileged database role with row-level security on the organization.
- Passwords use Argon2id. Sessions are random tokens stored as hashes in httpOnly, SameSite=Strict
  cookies; changes also need a custom header and the allowed Origin. Login is rate-limited.
- Credentials (Anthropic keys, subscription tokens, GitHub tokens) are encrypted with AES-256-GCM
  and only ever shown as their last four characters. Git tokens are passed to git per command,
  never written to disk or remote URLs.
- Claude runs with its own HOME and config folder per workspace, receives only the developer's own
  credential and a minimal environment (no database URL or platform keys), does not load settings or
  hooks from the repository, and works through a tool policy: no push, no git config, no credential
  reads, file tools limited to the checkout, risky commands need approval. Known secrets are redacted
  from anything stored or streamed.
- Commands that carry your GitHub token (fetch, pull, push) run only while Claude is idle, only after the
  workspace's `.git/config` passes an allowlist check, with settings that can run programs, proxy traffic
  or skip TLS checks forced off, and without submodules.
- **Workspace containers.** Claude Code runs inside a Docker container per workspace (`apps/runtime/Dockerfile`),
  so every command it runs stays inside. The container runs as an unprivileged user with all Linux
  capabilities dropped, `no-new-privileges`, a read-only system, and CPU, memory and process limits. It sees
  only the checkout (read-write), the git directory (**read-only**: Claude can read history and diffs but cannot
  change git settings or hooks) and its own home folder. No Docker socket, no host folders, no platform
  secrets. Docker Desktop's host aliases point back at the container. After each run the container is
  restarted, which ends anything left running in the background. Tested in `apps/api/test/docker.test.ts`.
- **Remaining limits.** Network access from the container is open (needed for package installs and the
  Anthropic API); a per-application allowlist comes with environment secrets. The Docker bridge gateway is
  still reachable from inside, so keep services on your machine (such as Postgres) password-protected and
  bound to localhost. The developer's own Claude credential is visible to commands Claude runs, as it is
  when using Claude Code in a terminal.
- The editor bundles Monaco, which ships its own copy of DOMPurify 3.4.15. The advisories against that
  version concern `IN_PLACE`, `SAFE_FOR_TEMPLATES` and XHTML parsing, none of which Monaco uses.
