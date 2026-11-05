# Engineering Platform

Internal platform for managing client applications and working on them with Claude.
Developers sign in, pick a client, application and environment, and (in later phases)
open an isolated workspace with Claude Code, Git and scoped AWS access.

**Status:** Phase 1 (Foundation) is built: sign-in, clients, applications, environments,
per-application access control, and the audit log. Git, workspaces, Claude, AWS and secrets
are next. See [docs/01-architecture-and-research.md](docs/01-architecture-and-research.md).

## Run it locally

Requirements: Node.js 22 or newer. Nothing else: the database is embedded Postgres
(PGlite) stored in `apps/api/.data/`.

```bash
npm install

# One-time: create your organization and the first admin.
# Prints a generated password; or set ADMIN_PASSWORD (12+ characters) first.
npm run create-admin -- --org "So N So" --email you@example.com --name "Your Name"

# Start the API (port 4000) and the web app (port 5173)
npm run dev
```

Open http://localhost:5173 and sign in.

To use a real Postgres server instead of the embedded one, set `DATABASE_URL`
(for example `postgres://user:pass@localhost:5432/platform`) before `create-admin` and `dev`.
Migrations run automatically at startup.

### Settings (environment variables, all optional)

| Variable | Default | Meaning |
|----------|---------|---------|
| `DATABASE_URL` | unset | Postgres connection string. Unset = embedded PGlite |
| `DATA_DIR` | `.data/pg` | Where embedded Postgres keeps its files (relative to `apps/api`) |
| `PORT` / `HOST` | `4000` / `127.0.0.1` | API listen address; local-only by default |
| `WEB_ORIGIN` | `http://localhost:5173` | The only origin allowed to make changes |
| `SESSION_TTL_HOURS` | `12` | Sign-in lifetime |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS |

## Using it

1. **Clients:** as an org admin, create a client (for example "ABC Technologies").
2. **Applications:** inside the client, create an application. Choose "Existing repository"
   or "Build a new app from scratch". Development, staging and production environments
   are created for you; production is protected.
3. **Developers:** add developers under *Developers*. They start with **no access**.
4. **Access:** on a client or application page, grant a developer a role:
   - *Viewer*: can see it.
   - *Developer*: can work in its environments (except protected ones).
   - *App admin*: can also edit the app, its environments and who has access.
   - *App creator* (client only): can create new applications under that client.
5. **Production:** working access to a protected environment needs a grant on that exact
   environment, and only an org admin can give it.
6. **Audit log:** every change and sign-in is recorded (admins only).

Org admins manage everything but do not automatically get working access to any
environment; they grant it to themselves explicitly, and that is audited.

## Develop

```bash
npm test            # API unit + integration tests (embedded Postgres, no setup)
npm run typecheck   # both apps
npm run build
```

Layout:

```
apps/api      Fastify API
  migrations/   numbered SQL migrations (schema, row-level security, grants)
  src/access    authorization policy (pure) + database-backed checks
  src/identity  passwords, sessions, users
  src/tenancy   clients, applications, environments
  src/audit     append-only audit log
  test/         policy unit tests and HTTP integration tests
apps/web      React app (Vite)
docs/         architecture, research, client onboarding checklist
infra/        templates we send to clients (read-only AWS role)
```

## Security model in one paragraph

Every request is authorized in the API with a single policy function; the UI only hides
buttons. All queries run as an unprivileged database role with row-level security on the
organization, so a missing filter cannot leak another organization's data. Passwords use
Argon2id; sessions are random tokens stored only as hashes in httpOnly SameSite=Strict
cookies; state-changing requests also need a custom header and the allowed Origin (CSRF).
Login is rate-limited. The audit table is insert-only for the application role.
