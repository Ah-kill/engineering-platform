# Engineering Platform

Internal platform for managing client applications and working on them with Claude Code.
Developers sign in, pick a client, application and environment, open a workspace on a
branch, and work with Claude in a browser IDE: plan, execute, review the diff, commit,
push and open a pull request. Works on desktop and on a phone.

| Document | For |
|----------|-----|
| [docs/01-architecture-and-research.md](docs/01-architecture-and-research.md) | Design, threat model, and what is built versus the original target |
| [docs/02-what-to-ask-clients.md](docs/02-what-to-ask-clients.md) | Onboarding a client: repositories, AWS role, what we need from them |
| [docs/03-deployment.md](docs/03-deployment.md) | Running it on a server and reaching it from your phone (Caddy or Tailscale), backups |
| [docs/04-api.md](docs/04-api.md) | HTTP API reference: every endpoint, the terminal WebSocket and the Claude event stream |
| [docs/05-developer-onboarding.md](docs/05-developer-onboarding.md) | A new developer's first day: account, two-step login, credentials, daily workflow, troubleshooting |

## Status

| Area | State |
|------|-------|
| Sign-in, clients, applications, environments, developers, access control | Built |
| Two-step login (authenticator app + recovery codes, lockout, admin reset) | Built |
| Signed-in devices: see and sign out your own sessions | Built |
| Per-developer Claude credentials (API key or subscription token), live model list | Built |
| GitHub repositories, workspaces, editor, diff, commit, push, pull, branches, pull requests | Built |
| Claude Code in the workspace: plan / execute, streaming, approvals, stop, history, cost | Built |
| Container isolation: one Docker container per workspace | Built |
| Network access per application: allowlist through an egress proxy (default) or unrestricted | Built |
| Environment variables and secrets per environment, `.env` import | Built |
| Browser terminal into the workspace container | Built |
| AWS access broker: per-environment role, short-lived credentials, optional session policy | Built |
| Usage and cost dashboard | Built |
| Monthly Claude budgets per developer (org default + override) | Built; enforcement at run start being wired (see [docs/04](docs/04-api.md#budgets)) |
| Audit log with filters and CSV export | Built |
| Phone layout, home "continue where you left off" | Built |
| Production serving, deployment guide (VM + Caddy, Tailscale) | Built |
| CI (GitHub Actions) and Dependabot | Built |

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
| `WORKSPACE_RUNTIME` | `docker` | `docker`: one container per workspace. `local`: on the host, no isolation and no terminal (tests only) |
| `WORKSPACE_CPUS` / `WORKSPACE_MEMORY` / `WORKSPACE_PIDS` | `2` / `4g` / `512` | Limits per workspace container |
| `WORKSPACE_IMAGE` | `engineering-platform-workspace:<Claude Code version>` | Image to use instead of the built-in one |
| `AGENT_MAX_TURNS` / `AGENT_MAX_BUDGET_USD` | `80` / `10` | Limits per Claude run (monthly per-developer budgets are set in the app) |
| `AGENT_MAX_MINUTES` | `30` | A Claude run is stopped after this many minutes |
| `WORKSPACE_IDLE_MINUTES` | `120` | Containers of idle workspaces are stopped after this long (0 = never); they restart on next use |
| `WORKSPACE_MAX_GB` | `10` | Claude runs are refused when a workspace folder grows past this size |
| `PORT` / `HOST` | `4000` / `127.0.0.1` | API listen address; local-only by default |
| `WEB_ORIGIN` | `http://localhost:5173` | The only origin allowed to make changes or open a terminal |
| `SESSION_TTL_HOURS` | `12` | Sign-in lifetime |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS |
| `TRUST_PROXY_HOPS` | `0` | Reverse proxies in front of the API (1 for Caddy or `tailscale serve`), for per-client rate limits |
| `SERVE_WEB` | `false` | Production: the API also serves the built web app (`npm run start` sets it) |

## Using it

1. **Clients and applications:** as an org admin, create a client, then an application
   ("Existing repository" or "Build a new app from scratch"). Development, staging and
   production environments are created; production is protected.
2. **Developers and access:** add developers under *Developers* (they start with no access),
   then grant roles on a client or application: *Viewer*, *Developer*, *App admin*, *App creator*.
   Working access to a protected environment needs a grant on that exact environment, given by an org admin.
3. **Each developer, once** (step by step in [docs/05](docs/05-developer-onboarding.md)):
   - *Two-step login* under *Account*: scan the QR code with an authenticator app and keep the
     10 recovery codes. An org admin can reset it for someone who lost their phone.
   - *Claude credential* under *Claude & GitHub*: an API key from platform.claude.com (billed per
     use), or a subscription token from `claude setup-token` (confirm with Anthropic that this use
     is allowed for your plan). Never shared between developers.
   - *GitHub token*: a fine-grained token limited to the client repositories, with Contents and
     Pull requests read/write; one per GitHub organization if needed.
   - *Default model*: the list comes live from Claude Code and your account. "Default", "Opus",
     "Sonnet" and "Haiku" always mean the newest version.
4. **Repository:** an app admin connects the GitHub repository on the application page.
5. **Workspace:** *New workspace* → pick an environment and a branch → the IDE opens.
6. **With Claude:** describe the change in **Plan** mode, read the plan, press
   **Approve and execute**. Risky commands (deletes, cloud CLIs, `docker`, deploy scripts, ...) wait
   for your approval; pushing and reading credentials are always blocked. Then review in **Changes**,
   commit, push and open a pull request. Pushing to the default branch is refused.

### Features for admins and app admins

- **Network access** (application page): *Only allowed sites* (default) sends all traffic from the
  workspace container through an egress proxy that allows Anthropic, GitHub, the npm and PyPI registries,
  the hosts you list and, when AWS is configured, that region's AWS endpoints. *Unrestricted* is an
  explicit, audited choice per application.
- **Variables and secrets** (per environment): any service's settings, or paste a `.env` file. Secrets
  are encrypted, never shown again in full, and given to Claude runs and terminals in that environment.
- **Terminal** (workspace): a shell inside the workspace container, never on the host. It gets the
  environment's variables and short-lived AWS credentials, not the developer's Claude or GitHub
  credential. Up to 3 per workspace, closed after an hour idle; opening and closing are audited.
- **AWS** (per environment): the client deploys `infra/client-onboarding/readonly-role.yaml` and sends
  the role ARN; you enter it with the ExternalId and region, then *Test connection*. Each Claude run
  and terminal gets STS credentials for that role (15 minutes to 12 hours), never long-lived keys. An
  optional session policy (allowed actions, with presets) narrows what those credentials may do.
- **Usage** (everyone): cost and tokens per day, application and model; admins also see per developer.
  Developers with a monthly limit see their spend against it.
- **Organisation** (org admins): the organisation's name, a default monthly Claude budget per developer,
  and per-developer overrides with this month's spend.
- **Audit log** (org admins): every sign-in, access change, git action, Claude run, terminal session and
  setting change. Filter by action group, outcome, person and dates; *Export CSV* downloads up to
  50,000 matching rows (formula-safe for spreadsheets; the export itself is audited).

### Keeping Claude Code and models up to date

Claude Code is bundled in `@anthropic-ai/claude-agent-sdk`. *Claude & GitHub* shows the installed
version and whether a newer one exists. To update (also brings support for newly released models):

```bash
npm run update:claude   # installs the latest SDK, rebuilds the workspace image, runs the API tests
```

The update is applied deliberately rather than automatically, so a breaking change never lands in
the middle of someone's session (Dependabot opens it as a separate pull request). New models usually
work before an update anyway: aliases resolve to the newest model, and API-key users also see every
model id from Anthropic's Models API.

## Develop

```bash
npm test            # API unit + integration tests (embedded Postgres, local git, no network)
npm run test:e2e    # Playwright browser tests, desktop and phone (isolated stack on ports 4100/5273)
SCREENSHOTS=shots npx playwright test   # also saves screenshots of key screens to ./shots
npm run typecheck
npm run build
```

The Docker tests (`apps/api/test/docker.test.ts`) run when Docker is available and skip otherwise.
The Playwright stack (`apps/api/e2e/server.ts`) runs the real API and web app with a fresh database,
a local git repository in place of GitHub, and a scripted agent in place of Claude, so it needs no
credentials and costs nothing.

**CI** (`.github/workflows/ci.yml`, on pushes to `main` and every pull request): Node 22 on Ubuntu,
`npm ci`, typecheck, the workspace image build (so the Docker tests run), API tests, web build and
`npm audit --audit-level=high`; a second job runs the Playwright suite on Chromium and uploads the
report when it fails. **Dependabot** (`.github/dependabot.yml`) proposes grouped weekly updates for npm
and GitHub Actions; the Claude Agent SDK comes as its own pull request.

```
apps/api            Fastify API
  migrations/         numbered SQL migrations (schema, row-level security, grants)
  src/access          authorization policy + checks
  src/identity        passwords, sessions, signed-in devices, two-step login, users
  src/tenancy         clients, applications, environments
  src/settings        per-user Claude/GitHub credentials and model settings
  src/vault           credential encryption
  src/git             git CLI wrapper, GitHub API
  src/workspaces      workspace lifecycle, container runtime, files, git routes
  src/agents          Claude Agent SDK driver, tool policy, run manager, models, version
  src/terminal        browser terminal (WebSocket to a shell in the container)
  src/variables       environment variables, secrets, network policy
  src/aws             AWS role configuration and STS broker
  src/usage           usage and cost reports
  src/org             organisation settings and monthly budgets
  src/audit           append-only audit log, filters, CSV export
  test/               unit and integration tests
  e2e/                isolated server for Playwright
apps/web            React app (Vite), Monaco editor, xterm.js terminal
apps/runtime        Docker image for workspace containers, egress proxy, PTY bridge
e2e/                Playwright tests
docs/               architecture, client onboarding, deployment, API, developer onboarding
infra/              templates we send to clients (read-only AWS role)
.github/            CI workflow and Dependabot
```

## Security

- Every request is authorized in the API with one policy function; the UI only hides buttons.
  Queries run as an unprivileged database role with row-level security on the organization.
- Passwords use Argon2id. Sessions are random tokens stored as hashes in httpOnly, SameSite=Strict
  cookies; changes also need a custom header and the allowed Origin. Login is rate-limited.
  Two-step login uses TOTP with single-use recovery codes and pauses after 10 wrong codes.
  Developers can see and sign out their own devices; password and two-step changes sign out the others.
- Credentials (Anthropic keys, subscription tokens, GitHub tokens, environment secrets, AWS ExternalIds,
  TOTP secrets) are encrypted with AES-256-GCM and only ever shown as their last four characters.
  Git tokens are passed to git per command, never written to disk or remote URLs.
- Claude runs with its own HOME and config folder per workspace, receives only the developer's own
  credential, the environment's variables and a minimal environment (no database URL or platform keys),
  does not load settings or hooks from the repository, and works through a tool policy: no push, no git
  config, no credential reads, file tools limited to the checkout, risky commands need approval. Known
  secrets are redacted from anything stored or streamed.
- Commands that carry your GitHub token (fetch, pull, push) run only while Claude is idle, only after the
  workspace's `.git/config` passes an allowlist check, with settings that can run programs, proxy traffic
  or skip TLS checks forced off, and without submodules.
- **Workspace containers.** Claude Code and the terminal run inside a Docker container per workspace
  (`apps/runtime/Dockerfile`). The container runs as an unprivileged user with all Linux capabilities
  dropped, `no-new-privileges`, a read-only system, and CPU, memory and process limits. It sees only the
  checkout (read-write), the git directory (**read-only**: Claude can read history and diffs but cannot
  change git settings or hooks) and its own home folder. No Docker socket, no host folders, no platform
  secrets. After each run the container is restarted, which ends anything left running in the background.
  Tested in `apps/api/test/docker.test.ts`.
- **Network.** By default (*only allowed sites*) a workspace container has no route to the internet: it
  sits on an internal Docker network whose only exit is its own egress proxy, which allows only the
  built-in hosts (Anthropic, GitHub, npm, PyPI), the application's listed hosts and, with AWS configured,
  that region's AWS endpoints. *Unrestricted* is a per-application choice by an app admin and is audited.
- **AWS.** Only role ARNs with a required ExternalId are accepted, never access keys. Credentials are
  short-lived STS sessions issued per run and per terminal, optionally narrowed by a session policy.
- **Audit.** The request role can only insert and read audit events; each event commits together with
  the change it records. The CSV export prefixes cells that start with `=`, `+`, `-` or `@` so a
  spreadsheet never runs them as formulas.
- **Remaining limits.** Docker is not a hard security boundary (the container shares the host's kernel),
  and by default the containers run on the same machine as the database and vault key; move them to a
  second machine before holding many clients' credentials (see `docs/03`). The Docker bridge gateway is
  still reachable from inside, and in *unrestricted* mode so is everything else, so keep services on the
  host (such as Postgres) password-protected and bound to localhost. The developer's own Claude credential,
  the environment's variables and the short-lived AWS credentials are visible to commands Claude runs,
  as they would be in a local terminal. One vault key decrypts all saved credentials: back it up apart
  from database dumps. Secret redaction is best-effort. See the threat model in `docs/01` (section 6.4).
- The editor bundles Monaco, which ships its own copy of DOMPurify (pinned to a patched version through
  `overrides` in `package.json`). The advisories against older versions concern `IN_PLACE`,
  `SAFE_FOR_TEMPLATES` and XHTML parsing, none of which Monaco uses.
