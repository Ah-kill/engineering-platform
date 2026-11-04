# Engineering Platform: Phase 1 Architecture and Research

Status: draft for review, 2026-11-04
Scope: research, architecture, security model, tenancy, schema, roadmap, risks. No application code yet.

Evidence note: the open-source review below is based on each project's LICENSE file, GitHub metadata and README, read on 2026-11-04. I did not audit source code. Every "reuse" claim is therefore a hypothesis to confirm in a time-boxed spike (see section 11), not a finding.

---

## 1. Summary of decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | Build our own control plane. Reuse libraries and patterns, do not fork a platform. | No surveyed project has per-client AWS brokering, KMS-backed secrets, environment-scoped RBAC and audit. Two are AGPL and one is BSL, which constrains forking. |
| D2 | Treat the **application** as the security boundary, not the organization. | We are one company serving many clients. The real threat is client A's data reaching client B or a developer who was never assigned. |
| D3 | Modular monolith control plane (NestJS) plus a separate **execution worker** service. | Strict module boundaries now, extraction later. The worker is separate because it is the dangerous part. |
| D4 | The agent container never holds long-lived credentials. | Git tokens, AWS keys and the Anthropic key stay on the control plane or an egress proxy. The agent gets only short-lived, scoped, per-session grants. |
| D5 | Drive Claude Code through the official **Claude Agent SDK** (fall back to the CLI in headless/stream-json mode). | Official, supported, streams tool events, supports permission callbacks and plan mode. |
| D6 | Use an **Anthropic API key or Bedrock/Vertex**, not employees' personal Claude subscriptions. | A shared multi-user service on personal subscription logins is very likely outside Anthropic's terms. Confirm with Anthropic before launch. Bedrock fits the AWS-first design. |
| D7 | MVP supports **GitHub only** and one AWS path (AssumeRole with ExternalId). Others sit behind adapter interfaces. | Six Git providers and every AWS auth variant at once is how this project stalls. |
| D8 | Production AWS access is **read-only** in v1. Writes go through an explicit approval workflow in a later phase. | The spec's own risk list (prod deploys, IAM changes, deletes) is the largest blast radius. |
| D9 | Authentication through OIDC (Cognito or Keycloak behind an interface). We do not store passwords. | MFA and SSO come for free and the audit story is simpler. |
| D10 | Support **creating new applications from scratch**, not only attaching existing repos. Creation is a template-driven, approval-gated flow (section 4.4). | Added at your request. Greenfield apps need repo creation, scaffolding and optionally cloud infrastructure, which are all higher-risk writes. |

---

## 2. Decomposition into sub-projects

The spec is about ten independent subsystems. Each sub-project below gets its own design, plan and test cycle. The order follows dependency and risk: the sandbox and credential model come early because everything else depends on them.

| Phase | Sub-project | Exit criterion |
|-------|-------------|----------------|
| 0 | Research and architecture (this document) | Reviewed and approved |
| 1 | **Foundation**: monorepo, OIDC login, org/client/application/environment CRUD, grants-based RBAC, Postgres with RLS, audit log skeleton | Cross-tenant authorization tests pass in CI |
| 2 | **Execution sandbox**: worker service, rootless container per workspace, resource limits, egress proxy, git worktree, PTY terminal | A hostile repo cannot reach the host, other workspaces, or the metadata endpoint |
| 3 | **Git service (GitHub)**: GitHub App, per-user identity, clone/branch/commit/push/PR through the control plane | Push works with no token ever inside the container |
| 4 | **Agent orchestration**: Agent SDK runner, plan and execution modes, streaming, approvals, cancellation, cost tracking | End-to-end task: plan, approve, edit, test, diff |
| 5 | **IDE UI**: Monaco, file tree, diff review, chat, terminal, status | Developer completes the full workflow in the browser |
| 5b | **New-app bootstrap**: templates, repo creation, scaffold, onboarding wizard (section 4.4) | A new app goes from "create" to a reviewed first PR without leaving the platform |
| 6 | **AWS broker** (read-only) | Dev-environment read-only inspection with 15-minute scoped sessions |
| 7 | **Secrets**: Secrets Manager plus KMS, references only, redaction | No plaintext in DB, logs or prompts (verified by a leak test) |
| 8 | **Collaboration and sharing**, usage dashboards | Two developers on one app, no filesystem interference |
| 9 | **Hardening**: pen test, escape test, prompt-injection suite | Findings triaged and fixed |
| 10 | **Production deployment**: Terraform, CI/CD, monitoring, backups, DR | Runbook exercised |
| later | Additional Git providers, AWS write/deploy with approvals, Firecracker, Kubernetes, additional agents | Demand-driven |

Phases 6 and 7 are listed after 4 and 5 because the agent can be useful on code alone. Secrets and AWS can follow once the isolation model is proven.

---

## 3. Open-source comparison

### 3.1 Snapshot

| Project | License | Stars | Language | Last push | Shape |
|---------|---------|-------|----------|-----------|-------|
| OpenHands (`OpenHands/OpenHands`, formerly All-Hands-AI) | MIT | ~92.6k | Python/TS | 2026-11-04 | Self-hosted "Agent Canvas" control center, agent-server backends, ACP agents, automations |
| Proliferate | AGPL-3.0 | ~520 | TypeScript | 2026-10-29 | AI IDE (desktop app, macOS download), worktree workspaces, parallel agents |
| Kandev (`kdlbs/kandev`) | AGPL-3.0 | ~1.1k | Go + web UI | active | Kanban-style task runner, worktrees, Docker/SSH runtimes, single Go binary |
| Agor | BSL 1.1 (converts to Apache-2.0 on 2029-01-15) | ~1.5k | TypeScript | 2026-11-03 | Multiplayer "spatial board" for agent sessions on git branches |
| claude-code-web (`fafawlf`) | MIT | ~8 | TypeScript | 2026-09-23 | Single-user web chat UI for Claude Code over an SSH tunnel |

Correction to the brief: `kandev/kandev` does not exist. The project is `kdlbs/kandev`.

### 3.2 Per-project assessment

**OpenHands (MIT)**
- Reuse: permissive license allows commercial and internal use. Its agent-server and sandbox-backend concept (Docker, VM, remote) is the closest to our execution tier. ACP (Agent-Client Protocol) support is a good model for our agent abstraction. Worth a spike on whether its agent server can serve as our execution worker runtime.
- Extend: its multi-backend switching and automations map to our "agent backend" abstraction.
- Build ourselves: client/application/environment hierarchy, per-application grants, AWS broker, KMS secrets, audit, approvals, tenant isolation.
- Security gaps: its own docs warn that "Option 1: Without a Sandbox" gives the agent full filesystem access, and point to a self-hosting security section for hardening, so safe defaults are not guaranteed. Multi-tenant isolation is not its design center (it targets a developer or a team sharing a backend). I did not verify enterprise features; confirm whether any directories carry a different license before reusing code.
- License verdict: safe for internal use and for embedding. Check subdirectory licenses.

**Proliferate (AGPL-3.0)**
- Reuse: UX ideas only (worktree-per-task, parallel agents, review state per task). It is positioned as a desktop IDE, which is the wrong shape for a multi-user server.
- Extend: nothing; forking drags AGPL in.
- Build ourselves: everything server-side.
- Security gaps: single-user desktop trust model, no tenant model.
- License verdict: AGPL section 13 applies if we modify it and let users interact with it over a network. For purely internal use by our own staff the obligation is arguable, but any client access or resale triggers source disclosure. Treat as "read, do not copy" and get legal advice before any reuse.

**Kandev (AGPL-3.0)**
- Reuse: architecture ideas (worktree isolation, Docker/SSH executors, `agentctl` helper inside task environments, review-first UX, workflow-as-YAML). The `agentctl` pattern of a small in-environment helper is worth emulating.
- Extend: nothing directly; same AGPL concern.
- Build ourselves: all multi-tenancy, AWS, secrets, RBAC, audit. Its "Office mode" (roles, approvals, budgets) is explicitly experimental.
- Security gaps: positioned for power users and small teams. Secrets are runtime settings, not KMS-backed per-client references. No per-client isolation model documented in the README.
- License verdict: same as Proliferate. Study, do not copy.

**Agor (BSL 1.1)**
- Reuse: multiplayer concepts (shared sessions, live viewers, branches as the unit of work). Best collaboration reference of the five.
- Extend: n/a.
- Build ourselves: everything security-sensitive.
- Security gaps: collaboration product, not a client-isolation product.
- License verdict: the Additional Use Grant allows production use except an "Agor Offering", defined as a product or service offered to third parties whose primary purpose is to provide Agor's functionality, including bundling it for customers to operate. It explicitly says operating a deployment for a specific customer's own internal use is not an Offering. Our use is an internal tool, so likely permitted, but modifying and extending it into our own agent-management platform sits near the line. Get a lawyer's read, or contact Preset for a commercial arrangement. Reading it for ideas is fine.

**claude-code-web (MIT)**
- Reuse: small enough to read in an afternoon: reconnect with event replay, diff cards with approve/reject, viewer-vs-takeover mode for historical sessions. These are good UI patterns.
- Extend/Build: no auth, no multi-user, no isolation, 8 stars. It is a personal tool, not a base.
- Security gaps: assumes localhost or SSH tunnel trust. Not suitable as-is.
- License verdict: MIT, free to borrow ideas or small pieces with attribution.

### 3.3 Other projects to evaluate in the spike (not yet reviewed)

I have not reviewed these; they are candidates, not recommendations.
- Claude Agent SDK and Claude Code CLI (headless / stream-json): the primary agent runtime.
- gVisor, Sysbox, Firecracker, Kata Containers: sandbox runtimes.
- Coder / code-server / Eclipse Che / DevPod: existing remote workspace platforms, relevant as an alternative to building workspace provisioning.
- Monaco Editor, xterm.js, node-pty: UI and terminal components (all permissive).
- Octokit, `@aws-sdk/*`, `simple-git` or the plain git CLI: integrations.

### 3.4 Conclusion

No project covers the hard requirements: per-application credentials, environment-scoped authorization, KMS-backed secrets, a short-lived AWS broker, approval gates and audit. We build the control plane. We borrow UX patterns from all five and evaluate OpenHands' agent-server and Coder as possible workspace runtimes. Nothing is vendored until its license and code are reviewed.

---

## 4. Architecture

### 4.1 Component view

```
                    Browser (Next.js, Monaco, xterm.js)
                          |  HTTPS + SSE/WebSocket
                  +-------v--------------------------------+
                  |        CONTROL PLANE (NestJS)          |
                  |  auth | org/client/app | rbac/policy   |
                  |  git  | aws-broker | secrets | agents  |
                  |  workspaces | approvals | audit | jobs |
                  +---+-----------+-----------+-------+----+
                      |           |           |       |
              Postgres (RLS)   Redis     S3 (logs)   AWS: STS, KMS,
                                                     Secrets Manager
                      |  mTLS, signed requests (no Docker socket)
            +---------v----------------------------------+
            |   EXECUTION WORKER (separate hosts/VPC)    |
            |  rootless runtime (gVisor/Sysbox) per task |
            |  +-------------------------------+         |
            |  | Workspace container           |         |
            |  |  worktree, PTY, agent runner  |         |
            |  |  no creds, no docker.sock     |         |
            |  +---------------+---------------+         |
            |          egress proxy (allowlist,          |
            |          credential injection, logging)    |
            +--------------------+-----------------------+
                                 |
                  GitHub / package registries / Anthropic API
```

### 4.2 Module boundaries (control plane)

Each module owns its tables and exposes a TypeScript interface. Other modules call the interface, never the tables.

| Module | Responsibility | Depends on |
|--------|----------------|------------|
| `identity` | OIDC login, sessions, MFA state, API tokens | none |
| `tenancy` | orgs, clients, applications, environments | identity |
| `access` | grants, policy evaluation (`can(user, action, resource)`) | tenancy |
| `git` | provider adapters, per-user and per-app connections, PR operations | access, secrets |
| `aws` | account/role registry, STS broker, allowlists | access, secrets |
| `secrets` | Secrets Manager/KMS references, rotation, redaction rules | access |
| `workspaces` | lifecycle, worker scheduling, quotas | access, git |
| `agents` | runner abstraction, sessions, messages, tool executions, cost | workspaces, access |
| `approvals` | approval requests, decisions, expiry | access |
| `audit` | append-only event writer and query | all (write-only dependency) |
| `jobs` | queue workers for clone, cleanup, rotation | all |
| `notifications` | email/Slack hooks | approvals |

### 4.3 Request and data flow: the core workflow

1. User opens a workspace for (client, application, environment, repo, branch). `access.can(workspace.create)` is checked against that exact application and environment.
2. `workspaces` asks a worker to create a container. The control plane clones with a short-lived GitHub App installation token **in the worker's git sidecar**, then checks out a worktree into a volume. The token is not placed in the container.
3. `agents` starts the runner in the container in **plan mode**. The Agent SDK's permission callback calls back to the control plane, which enforces policy independently of the model.
4. Events stream (SSE) to the browser and are persisted as `agent_messages` and `agent_tool_executions`.
5. The developer approves the plan. The runner switches to execution mode. Every high-risk tool call creates an `approval` and pauses.
6. The diff is computed from the worktree. The developer reviews, optionally requests changes, then approves commit/push.
7. Commit and push are performed by the control plane's `git` module (not the agent), using the developer's identity, then optionally a PR.

Step 7 is a deliberate choice: **push is never something the agent can do by itself.** This one rule removes most of the prompt-injection-to-exfiltration risk on the Git side.

### 4.4 Creating a new application from scratch

An application can start in one of two ways, recorded as `applications.origin`:

- `existing`: attach a repository that already exists (flow in 4.3).
- `new`: the platform bootstraps it.

Bootstrap flow for `origin = new`:

1. The developer chooses a client, a name and a **template** (for example Node API, Next.js app, Python service, Lambda function, or "blank"). Templates are versioned records owned by the org, stored in a template repository we control, never fetched from arbitrary URLs.
2. The developer describes the app to Claude in plan mode ("an order service with Postgres and a REST API"). The plan lists the stack, folder layout, dependencies and any cloud resources needed.
3. After plan approval, the control plane creates the **remote repository** through the Git adapter using the application's connection. This needs a separate `repo.create` permission and, for the first version, an approver.
4. A workspace is provisioned. The agent generates the scaffold from the template inside the sandbox, runs install and tests, and the developer reviews the diff.
5. The control plane makes the initial commit and push (same rule as 4.3: the agent never pushes), configures branch protection, and optionally opens the first PR.
6. Optional infrastructure (AWS resources, CI pipeline) is generated as Terraform or CloudFormation **in the repo as code**. Applying it is a separate approval-gated action. In v1 the platform proposes the infrastructure code but does not apply it. Apply arrives with the AWS write phase (D8).
7. The environments (dev, staging, prod), secret references and developer grants are created in the same onboarding wizard so a new app is usable immediately.

Security notes specific to new apps:
- Repo creation, branch protection changes and org-level GitHub App permissions are high-risk and audited. The GitHub App for creation is scoped to the client's organization only.
- Template content is trusted only because we own and review it. The agent's generated code is untrusted until reviewed.
- Generated apps must never contain secrets. A pre-commit scan in the control plane blocks pushes containing credential patterns.
- Naming and ownership are validated, and the new repo is registered under exactly one application so a template run cannot touch another client's repository.

---

## 5. Technology choices

| Area | Choice | Notes and alternatives considered |
|------|--------|-----------------------------------|
| Monorepo | pnpm workspaces + Turborepo | Shared types between API, worker and UI |
| Language | TypeScript, `strict` | |
| Backend | NestJS on Fastify | Structured modules map to our boundaries. Alternative: Hono/Fastify plain, less structure |
| Frontend | Next.js (App Router), Tailwind, shadcn/ui | |
| Editor/terminal | Monaco, xterm.js, node-pty | Per the brief |
| DB | PostgreSQL 16, Drizzle or Kysely, SQL migrations | Prefer a typed query builder over a heavy ORM so RLS and `SET LOCAL` stay explicit |
| Queue/cache | Redis + BullMQ | Postgres-backed queue (graphile-worker) is a lower-ops alternative; choose in Phase 1 |
| Realtime | SSE for agent events, WebSocket for terminal | SSE is simpler to proxy and replay |
| AuthN | OIDC (Cognito or Keycloak) | Interface so either works |
| AuthZ | In-house policy module over a `grants` table | OpenFGA/Cedar considered; revisit if rules outgrow a table |
| Sandbox | Rootless containers on gVisor or Sysbox, dedicated worker hosts | Firecracker later. Plain Docker is not a sufficient boundary for untrusted code |
| Agent | Claude Agent SDK | CLI headless as fallback. Runner interface for Codex/OpenHands later |
| Cloud | AWS: STS, KMS, Secrets Manager, S3, ECS (control plane), EC2 (workers) | Terraform |
| Observability | OpenTelemetry, structured logs with redaction, CloudWatch | |

---

## 6. Security model

### 6.1 Principles

1. **Deny by default.** No grant means no access, and access to a client does not imply access to any other.
2. **The backend decides.** UI visibility is cosmetic.
3. **Credentials do not enter the agent's world.** Tokens live in the control plane or the egress proxy.
4. **The model is untrusted.** Repo files, READMEs, `CLAUDE.md`, tool output and MCP results can all carry injected instructions. Policy is enforced outside the model.
5. **High-risk actions are two-key.** The requester and an authorized approver are different people where policy requires it.
6. **Everything is audited, nothing secret is logged.**

### 6.2 Credential handling

| Credential | Where it lives | How the agent/workspace uses it |
|------------|----------------|---------------------------------|
| Platform secrets (DB, signing keys) | AWS Secrets Manager, control plane only | Never reachable from workers |
| Anthropic key / Bedrock role | Control plane or egress proxy | Proxy injects the auth header; container sees only a proxy URL and a session token |
| Git (GitHub App installation, user OAuth) | Control plane, encrypted at rest with KMS | Used by the git module and the worker's git sidecar; **not** exposed as env vars in the container |
| Client AWS access | STS AssumeRole with ExternalId, 15-60 minute sessions, session policy narrowing the role | Issued per operation; read-only in v1; never written to disk in the container |
| Client app secrets | Secrets Manager (per client/app/env path), KMS key per client where feasible | Injected only for an approved operation; DB stores ARN and metadata |

Never-do list: no Docker socket in any container; no host mounts of `~/.ssh`, `~/.aws`, or any credential directory; no secrets in prompts; no secrets in env vars of long-lived containers.

### 6.3 Sandbox requirements

- One container per workspace, rootless, user-namespace remapped, `no-new-privileges`, dropped capabilities, read-only root filesystem with a writable workspace volume, seccomp profile.
- Isolation runtime: gVisor or Sysbox as the minimum; dedicated worker hosts so a container escape reaches no control-plane assets.
- Limits: CPU, memory, pids, disk quota, wall-clock timeout, idle reaper.
- Network: default deny. Egress only through a proxy with an allowlist (git host, package registries, Anthropic endpoint). Block link-local `169.254.169.254` and the VPC's internal ranges so a workspace cannot reach the instance metadata service or the control plane.
- Separate Docker networks per workspace so workspaces cannot reach each other.

### 6.4 Threat model (abbreviated)

| Threat | Example | Mitigation |
|--------|---------|------------|
| Cross-tenant data access | Developer A reads client B's repo or secrets | Grants checked per resource, Postgres RLS on org scope, per-app credentials, tests that assert denial |
| Prompt injection | Malicious README tells the agent to print secrets or push code | Agent holds no credentials, cannot push, egress allowlist, tool policy outside model, approvals for risky tools |
| Sandbox escape | Hostile repo build script attacks the host | gVisor/Sysbox, rootless, dedicated worker hosts, no sockets mounted |
| SSRF | User supplies a Git URL pointing at internal services | Validate URLs, resolve and block private ranges, use fixed provider adapters |
| Credential theft from the platform | DB dump exposes tokens | KMS envelope encryption, secret values never in DB, short-lived tokens |
| Privilege escalation via role design | Org admin silently reads prod secrets | Admin can administer but secret-read is a separate grant, audited |
| Confused deputy | Agent asks the broker for another environment's credentials | Broker binds each request to the session's (app, env) and the requesting user's grants |
| Insider misuse | Developer pushes to protected branch | Branch protection plus platform approval, audit |
| Supply chain | Malicious dependency in a client repo | Runs in the sandbox with no credentials; dependency scanning in CI |
| Denial of service | Runaway agent or fork bomb | Resource limits, per-user and per-app quotas, budgets |
| Log leakage | Secret appears in terminal output | Output redaction from known secret values plus pattern rules; best-effort, so values are not injected unless required |
| Audit tampering | Admin edits audit rows | Append-only table, restricted DB role, periodic export to S3 with object lock |

Residual risk worth saying plainly: redaction is best-effort. The primary control is not giving the agent secrets in the first place.

---

## 7. Multi-tenant design

**Terminology.** The company is the single organization. Clients are the isolation units we care about. The brief calls this multi-tenant, but the real boundary is client and application. The schema keeps an `org_id` everywhere so a second organization is possible, and applies the stricter rules at application level.

**Hierarchy:** `organization > client > application > environment`. Workspaces belong to an application and an environment.

**Access model.** A single `grants` table: `(principal, role, scope_type, scope_id)`. Scope types are `org`, `client`, `application`, `environment`. Rules:

- No inheritance **down** from org to clients for data access. An `org_admin` can manage users, grants and settings, but reading code, secrets or AWS needs an explicit client/application/environment grant. This is the "developers must not automatically inherit access" requirement, applied to admins as well.
- A grant at `client` scope covers that client's applications, a grant at `application` covers its environments, and so on. Narrower grants never widen.
- Roles are bundles of permissions: `viewer`, `developer`, `reviewer`, `deployer`, `secret_admin`, `app_admin`, `app_creator` (create applications and remote repos under a client). Production environments require explicit environment-scope grants.
- `can(user, action, resource)` is the only entry point. Controllers never check roles directly.

**Enforcement layers (defense in depth).**
1. Policy check in the service layer for every operation.
2. Postgres RLS on every tenant table using `org_id = current_setting('app.org_id')::uuid`, set with `SET LOCAL` inside each transaction by the request context. This protects against a missing `WHERE`. RLS alone does not enforce per-application grants, so layer 1 stays mandatory.
3. Per-application credentials and per-application workers/containers, so even a policy bug cannot reach another application's tokens.
4. Automated tests: for each endpoint, a user with grants only on app A must get 403/404 on app B.

---

## 8. Database schema

Conventions: UUID primary keys, `org_id` on every tenant row, `created_at/updated_at`, soft-archive via `archived_at`. All secret-bearing columns hold **references or KMS ciphertext metadata only**.

### 8.1 Core tables

```sql
-- identity and tenancy
organizations(id pk, name, slug unique, settings jsonb, created_at)
users(id pk, org_id fk, email citext unique, display_name, oidc_subject unique,
      status, mfa_enrolled bool, last_login_at)
clients(id pk, org_id fk, name, slug, archived_at,
        unique(org_id, slug))
applications(id pk, org_id fk, client_id fk, name, slug, archived_at,
             origin enum('existing','new'), template_id fk null,
             agent_config jsonb, workspace_defaults jsonb,
             unique(client_id, slug))
app_templates(id pk, org_id fk, key, version, source_repo_ref, description,
              default_stack jsonb, reviewed_by fk, reviewed_at,
              unique(org_id, key, version))
environments(id pk, org_id fk, application_id fk, kind enum('dev','staging','prod'),
             name, aws_role_id fk null, aws_region, protected bool,
             env_vars jsonb,                -- non-secret only, validated
             unique(application_id, name))

-- authorization
roles(id pk, org_id fk, key unique per org, permissions text[])
grants(id pk, org_id fk, principal_type enum('user','group'), principal_id,
       role_id fk, scope_type enum('org','client','application','environment'),
       scope_id, expires_at null, granted_by fk,
       unique(principal_id, role_id, scope_type, scope_id))
memberships(id pk, org_id fk, user_id fk, org_role)   -- coarse org-level role only

-- git
git_integrations(id pk, org_id fk, application_id fk null, user_id fk null,
                 provider enum(...), kind enum('app','oauth','pat'),
                 credential_ref text,       -- Secrets Manager ARN, not the token
                 scopes text[], expires_at, rotated_at)
repositories(id pk, org_id fk, application_id fk, integration_id fk,
             remote_url, default_branch, provider_repo_id,
             unique(application_id, remote_url))
git_branches(id pk, repository_id fk, name, created_by, protected bool)
commits(id pk, workspace_id fk, repository_id fk, sha, author_id fk, message,
        pushed_at null)
pull_requests(id pk, repository_id fk, provider_pr_id, branch_id fk, state,
              created_by fk, merged_by fk null)

-- aws
aws_accounts(id pk, org_id fk, application_id fk, account_id, label)
aws_roles(id pk, org_id fk, aws_account_id fk, role_arn, external_id_ref,
          max_session_seconds, allowed_services text[], allowed_actions text[],
          access_level enum('read','write'))

-- secrets (references only)
secret_references(id pk, org_id fk, application_id fk, environment_id fk,
                  name, secrets_manager_arn, kms_key_arn, version_id,
                  rotated_at, expires_at, created_by,
                  unique(environment_id, name))

-- execution
workspaces(id pk, org_id fk, application_id fk, environment_id fk,
           repository_id fk, owner_id fk, branch, base_branch,
           state enum(...), worker_id, volume_ref, resource_limits jsonb,
           last_active_at)
workspace_members(id pk, workspace_id fk, user_id fk, permission enum('view','edit'))
workspace_sessions(id pk, workspace_id fk, user_id fk, kind enum('terminal','ide'),
                   started_at, ended_at)

-- agents
agent_sessions(id pk, org_id fk, workspace_id fk, user_id fk, runner enum('claude'),
               mode enum('plan','execute'), model, state, sdk_session_id,
               started_at, ended_at)
agent_messages(id pk, session_id fk, seq int, role, content jsonb, token_in, token_out,
               unique(session_id, seq))
agent_tasks(id pk, session_id fk, prompt, plan jsonb, status, approved_by fk null)
agent_tool_executions(id pk, session_id fk, task_id fk, tool, input_redacted jsonb,
                      decision enum('auto','approved','denied'), output_ref, exit_code)

-- governance
approvals(id pk, org_id fk, application_id fk, environment_id fk,
          requested_by fk, action, payload_hash, status, decided_by fk null,
          decided_at, expires_at)
audit_events(id pk bigserial, org_id, occurred_at, actor_id, client_id,
             application_id, environment_id, workspace_id, agent_session_id,
             action, resource_type, resource_id, approval_id null,
             outcome, details jsonb)       -- details are redacted before insert
usage_records(id pk, org_id fk, application_id fk, user_id fk, session_id fk,
              model, tokens_in, tokens_out, cost_usd numeric, occurred_at)
```

### 8.2 Indexes and constraints worth calling out

- `grants(principal_id, scope_type, scope_id)` for the hot `can()` lookup.
- `agent_messages(session_id, seq)` unique for ordered replay and idempotent writes.
- `audit_events(org_id, occurred_at)` and `(application_id, occurred_at)`, partitioned monthly. The app's DB role has `INSERT` and `SELECT` only, never `UPDATE` or `DELETE`.
- `approvals.payload_hash` binds an approval to the exact action, so an approval cannot be reused for a different command.
- Idempotency: sensitive endpoints take an idempotency key stored with a unique index.
- A check constraint or trigger ensures `environments.application_id`, `repositories.application_id` and `secret_references.application_id` agree with their environment's application, preventing cross-application references.

---

## 9. Agent execution design

- **Runner interface:** `AgentRunner { start(ctx), send(msg), cancel(), onEvent(cb) }`. The Claude implementation wraps the Agent SDK inside the workspace container.
- **Plan mode:** tools restricted to read-only (Read, Grep, Glob, and read-only Bash allowlist). Output is a structured plan (files, changes, risks, tests) stored in `agent_tasks.plan`.
- **Execution mode:** edit tools and an allowlisted command set. A permission callback in the control plane evaluates every tool call: allow, deny or require approval. Policy is data (per application) and cannot be changed by repo content.
- **Project instructions:** platform instructions come from application settings and are loaded after, and cannot be overridden by, a repo's `CLAUDE.md`. Repo-provided instructions are treated as untrusted context.
- **Streaming and recovery:** events carry a sequence number, so a reconnecting browser asks for events after `seq=N`. The SDK session ID is stored to resume.
- **Cancellation:** a cancel signal to the runner, then the container process group is killed after a grace period. The state change is audited.
- **Cost:** token usage from SDK result events goes into `usage_records`. Per-user and per-application budgets halt a session.

Approval-required actions (v1 list): pushing, any write to an environment other than dev, secret changes, destructive shell patterns (`rm -rf` outside the workspace, `git push --force`, `terraform destroy`, and so on), network access outside the allowlist.

---

## 10. Technical risks

| # | Risk | Likelihood | Impact | Response |
|---|------|-----------|--------|----------|
| R1 | Anthropic terms for multi-user hosting and credential type | Medium | High | Confirm in writing; use API key or Bedrock; model cost budgets |
| R2 | Sandbox escape or egress bypass | Low-Med | Critical | gVisor/Sysbox, dedicated hosts, escape tests in Phase 9 |
| R3 | Prompt injection leads to data leaks or harmful actions | High | High | No creds in agent, no agent push, allowlist, approvals, injection test suite |
| R4 | Scope creep from supporting all Git providers and AWS modes | High | Medium | GitHub plus AssumeRole first, adapters later |
| R5 | AGPL/BSL contamination from copying code | Medium | High | Study only, no copying without legal review |
| R6 | Cost overruns from long agent sessions | High | Medium | Budgets, timeouts, per-app quotas |
| R7 | Agent SDK/CLI behavior changes | Medium | Medium | Runner interface, pin versions, contract tests |
| R8 | RBAC complexity produces bugs and lock-outs | Medium | High | Single `can()` function, exhaustive denial tests, break-glass admin audited |
| R9 | Worker capacity and cold-start latency | Medium | Medium | Warm pool and persistent volumes; measure in Phase 2 |
| R10 | Redaction misses a secret | Medium | High | Treat as defense in depth; minimize secret injection |
| R11 | Single-person bus factor on security design | Medium | High | Independent review before production |

---

## 11. Immediate next steps

1. You review this document and correct anything wrong, especially D2, D6, D7 and D8.
2. One-day spikes, each producing a short written note:
   - OpenHands agent-server as a workspace runtime versus our own worker.
   - Claude Agent SDK: plan mode, permission callbacks, streaming and resume, in a container.
   - gVisor versus Sysbox on the worker host, with an escape smoke test.
   - Coder or Eclipse Che as a workspace provisioner, in case it replaces part of Phase 2.
3. Legal check on AGPL and BSL positions, and on Anthropic's terms for this use.
4. Start Phase 1 (Foundation) with its own design and plan.

### Questions that block parts of the design

- Will **clients or their staff** ever log in, or only your developers? If clients log in, the AGPL position, the UI model and the tenant isolation requirements all tighten.
- Which AWS organization hosts the platform itself, and do client accounts already have roles you can use, or would you need to create them (for example with a CloudFormation template clients run)?
- Expected scale in the first year (developers, concurrent workspaces)? This decides whether one worker host is enough.
- Is the deployment target AWS only, and is a Kubernetes cluster available or desired later?

---

## 12. Where this differs from the original ChatGPT brief

| Brief | This document |
|-------|---------------|
| All six Git providers and every AWS auth method up front | GitHub and AssumeRole first, adapters for the rest |
| "Multi-tenant" at organization level | Application is the security boundary, admins don't implicitly read data |
| Agent can create branches and commit from chat | Agent proposes, **control plane** commits and pushes after human approval |
| Prefer reusing existing platforms | Reuse libraries and patterns, build the control plane; two of five are AGPL and one is BSL |
| `kandev/kandev` | Actual repo is `kdlbs/kandev` |
| Brief only covers attaching existing repos | Also supports creating new apps from templates (4.4), added at your request. Infrastructure is proposed as code but not applied in v1 |
| Implementation of Phases 1 and 2 right after the document | Held until you approve this document, then each phase gets its own design and plan |
