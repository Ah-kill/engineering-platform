# What to ask a new client

A checklist for onboarding a client. Each item says what we need, why, and what to
accept as a fallback. Nothing here asks for passwords, personal logins or long-lived
cloud keys, and the client can withdraw every kind of access on their own at any time.

Copy the "Message to the client" section at the end into an email, fill in the
brackets, and track the answers per application in the platform.

## At a glance

| Area | What the client gives us | Where it goes in the platform |
|------|--------------------------|-------------------------------|
| Code | A fine-grained GitHub token per GitHub owner (organization or user), limited to the agreed repositories | Entered per GitHub owner by the developer it belongs to |
| AWS | A read-only role in each AWS account (from our template), its Role ARN and the region | Application page → *AWS access*, per environment |
| Secrets | Names of the environment variables per environment; values handed over securely | Application page → *Environment variables*, entered by an admin |
| Network | The external services the application calls | Application page → *Network access*, allowed sites |
| People | A technical contact, who approves production releases, compliance limits | Our notes for the application |
| AI | Written consent to use Claude (Anthropic) on their code | Our notes for the application |

---

## 1. Source code (GitHub)

Our developers work on the client's code through the platform, which needs a GitHub
token to fetch the repository, push working branches and open pull requests.

**What we ask for:** a **fine-grained personal access token** that can only see the
client's repositories we work on. One of two ways, whichever the client prefers:

| Option | How it works | Good for |
|--------|--------------|----------|
| **A. Client-side machine user** (preferred) | The client creates a GitHub account they own for this purpose (for example `acme-platform-bot`), gives it access to the agreed repositories, creates the token from that account and sends it to us securely | The client keeps full control: they own the account and can revoke it at any time without involving us |
| **B. Our developer's own account** | The client invites our developer's GitHub account to the agreed repositories; the developer creates the token, with the client's organization as the resource owner | Small engagements, or when the client prefers named people |

The token's settings, in GitHub under *Settings → Developer settings → Fine-grained tokens*:

- **Resource owner:** the client's organization (or user, if the repositories are personal).
- **Repository access:** *Only select repositories* → the agreed repositories.
- **Repository permissions:** **Contents: Read and write**, **Pull requests: Read and write**,
  **Metadata: Read** (GitHub adds this one automatically). Nothing else.
- **Expiration:** a date, ideally 90 days or less. We put a reminder in to renew it.

If the client's organization requires approval of fine-grained tokens, an organization
owner approves the request once (*Organization settings → Personal access tokens*).

**One token per GitHub owner.** A fine-grained token belongs to exactly one organization
or user, so a client with repositories under two GitHub organizations gives us two tokens.
Each token is entered in the platform under its GitHub owner, encrypted (AES-256-GCM),
and only ever shown as its last four characters. It is never written into the repository,
the git configuration or the workspace.

**What we do and do not do with it:**
- We never push to the default branch or other protected branches; the platform refuses it.
  We push working branches and open pull requests, which the client reviews and merges.
- The AI assistant cannot push and never sees the token.

**We also ask:**

| Question | Example |
|----------|---------|
| Branch rules | Protected branches (usually `main`, `release/*`) and who approves merges |
| Default branch per repository | `main` or `develop` |
| CI | What runs on pull requests (GitHub Actions, Jenkins, other) |

**Not acceptable:** a password, a classic token with the `repo` scope (it reaches every
repository the account can see), or a token for an account that can see unrelated repositories.

*Future work, optional:* a GitHub App that the client installs on selected repositories.
It does not exist yet; tokens are how access works today. For GitLab, Bitbucket or
CodeCommit the idea is the same (a scoped token for the listed repositories only); these
come after GitHub, so tell the client we will confirm the exact method.

## 2. AWS access

Some work needs to look at the client's AWS resources: reading logs and metrics while
investigating an issue, checking how a Lambda function or stack is set up, and, only if
agreed, deploying.

**What we ask for, per AWS account:**

| We need | Notes |
|---------|-------|
| Which AWS account is development, staging and production | One account per environment is best; one shared account with clear separation also works |
| The **region** each environment runs in | e.g. `eu-west-1`, `ap-south-1` |
| A **role we can assume** | The client deploys our CloudFormation template `infra/client-onboarding/readonly-role.yaml` in the account and sends back the **RoleArn** from the stack outputs. Fallback: they create an equivalent role by hand with the same trust policy and ExternalId |

**How the role works:**
- We send the client our **platform AWS account ID** and an **ExternalId**, a random
  value the platform generates for them. The role trusts only our account, and only when
  that ExternalId is presented, so no other customer of ours can be tricked into using it.
- It is **read-only**: it can list and describe resources and read logs and metrics. It
  explicitly cannot read secret values, S3 object contents or database items, cannot read
  Lambda or ECS configuration (those return environment variables that often hold
  secrets), and cannot change anything.
- We never receive or store AWS access keys. The platform asks AWS for **short-lived
  credentials** (1 hour by default, 15 minutes to 12 hours if the client allows it) each
  time one of our developers starts work in that environment, and only for developers who
  have been given access to that exact environment.
- Every use is visible on both sides: in our audit log (who, which workspace, when) and in
  the client's CloudTrail, where the session name shows as `ep-<developer>-<workspace>`.
- The client can delete the role (or the stack) at any time to cut access instantly.
- The template is a **draft** until we have deployed it in a test account.

**Optional extra limit (session policy).** On top of the client's role, the platform
can narrow each session to a fixed list of AWS actions. This can only take permissions
away, never add any beyond what the role allows. Presets:

| Preset | Allows |
|--------|--------|
| **Read-only investigation** | CloudWatch Logs (describe, get, filter, Logs Insights queries), CloudWatch metrics and alarms, Lambda/API Gateway/DynamoDB/ECS/EKS/CloudFormation/EC2 describe and list calls, S3 bucket listing and bucket settings, `sts:GetCallerIdentity` |
| **Deploy (Lambda + CloudFormation)** | Everything above, plus updating and publishing Lambda functions, creating and updating CloudFormation stacks and change sets, uploading deployment artifacts to S3, and passing a role (`iam:PassRole`) |
| **Custom** | A list of actions we agree with the client |

Tell the client which preset we will use per environment. Choosing or changing it for a
production environment needs one of our organization admins.

**Write access (deployments)** is a separate step, only after we agree on scope. The
draft template `infra/client-onboarding/deploy-role.yaml` creates a role limited to
Lambda and CloudFormation deployments, with the same ExternalId trust. Production writes
always require an organization admin on our side, on top of the client's own approvals.

**Our side: protecting the platform's own AWS identity.** The platform signs these
requests with its own AWS identity. When we run the platform on an EC2 instance, that
identity is the instance role, and the instance metadata service hands its credentials to
anything that can reach `169.254.169.254` from the machine. Workspaces in the
"Unrestricted" network mode are not blocked from that address by the platform
itself. We therefore require **IMDSv2 with a hop limit of 1** on the instance: IMDSv2
needs a session token first, and with a hop limit of 1 the token reply cannot cross the
extra network hop into a workspace container, so code running in a workspace cannot obtain
the platform's credentials. Workspaces in the default "Only allowed sites" mode cannot reach
that address at all. Details: `docs/03-deployment.md`, section "Running on EC2".

## 3. Secrets and configuration

| We need | Notes |
|---------|-------|
| The environment variables per environment | Names first, e.g. `DATABASE_URL`, `REDIS_URL`, `STRIPE_SECRET_KEY` |
| Which of them are secrets | Only these need the secure handover below |
| Preferably, separate non-production values | Test or sandbox keys for development and staging, so production secrets are needed as rarely as possible |

**How secrets are handled:**
- One of our admins enters the values in the platform (typed in, or imported from a
  `.env` file). The client does not need an account.
- Secret values are **encrypted at rest** (AES-256-GCM) in the platform's own database,
  and are **never shown again** after saving, not even to admins; only a short hint is
  displayed.
- Each value is given **only to that environment's workspaces**: production secrets never
  reach a development workspace. Known secret values are also masked in anything the
  platform records or displays.
- Please **never send values by email or chat.** Use a one-time secret link or a shared
  vault item from the client's password manager, which we delete after entering the value.

## 4. Network access

Workspaces only reach **allowed sites** by default: Anthropic's API, GitHub, the npm and
PyPI package registries, and the client's AWS endpoints once AWS access is set up.
Everything else is blocked.

| We need | Examples |
|---------|----------|
| The external services the application calls during development and tests | Payment providers, email/SMS APIs, third-party REST APIs, auth providers |
| Other package registries or private registries | A private npm registry, Maven Central, Docker Hub |
| Test databases or services reachable over the internet | A staging database host |

We add these to the application's allow-list. An application can also be switched to
unrestricted internet access when the allow-list is impractical; we agree that with the
client first.

## 5. People, approvals and AI consent

- A **technical contact** on the client side who can approve access and answer architecture questions.
- **Who approves production releases** on their side, and how (pull request review, change ticket, sign-off).
- Any **compliance constraints**: data residency, PCI, HIPAA, no data leaving a region.
- **Whether they allow AI coding assistants on their code. Ask this explicitly and get it
  in writing.** Our developers work with Claude, and the platform sends the relevant code,
  and any command output it reads, to Anthropic's API for processing.

## 6. New applications (built from scratch)

If we are building something new for the client:
- Where the repository should live (their GitHub organization, or ours and transferred later).
- Their preferred stack and cloud services, or permission for us to propose one.
- The AWS account the new application will deploy into, with the same role setup as section 2.

---

## Message to the client (template)

> Hi [name],
>
> To start work on [application], we need the following. None of it involves sharing passwords, and you can withdraw any of it at any time.
>
> 1. **Code access (GitHub):** please create a fine-grained personal access token limited to these repositories: [repo list]. Ideally create it from a GitHub account your team owns for this purpose (a "machine user"); alternatively, invite [developer's GitHub username] to the repositories and they will create the token. Settings: resource owner [organization], *Only select repositories*, permissions **Contents: Read and write**, **Pull requests: Read and write**, **Metadata: Read**, and an expiry date of 90 days or less. If your repositories live under more than one GitHub organization, we need one token per organization. Please share the token through [one-time secret link / password manager], not by email. We never push to protected branches; all changes come to you as pull requests.
> 2. **AWS access (read-only):** please deploy the attached CloudFormation template (`readonly-role.yaml`) in each of these accounts: [dev / staging / prod]. Use platform account ID `[our account id]` and ExternalId `[ExternalId from the platform]`. Send us the RoleArn shown in the stack outputs and the region each environment runs in. The role can only view resources and read logs and metrics; it cannot change anything or read your secrets or data. We only ever use short-lived credentials from it, every use appears in your CloudTrail, and you can delete the stack at any time to cut access. [Optional: We will additionally limit our sessions to the "[Read-only investigation]" preset.]
> 3. **Configuration:** the list of environment variable names per environment, and which ones are secrets. For the secret values, please use [one-time secret link / password manager]; please do not email them. They are stored encrypted, never displayed again, and used only by the matching environment.
> 4. **Network:** the external services and APIs the application calls (and any private package registries), so we can allow them.
> 5. **Approvals:** who on your side approves production releases, and how.
> 6. **AI tooling:** please confirm in writing that you are comfortable with us using AI coding assistants (Anthropic's Claude) on this codebase. The relevant code is sent to Anthropic's API for processing.
>
> Thanks,
> [you]
