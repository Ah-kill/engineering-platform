# What to ask a new client

A checklist to send when onboarding a client. Each item says what we need, the
preferred option, and what to accept as a fallback. Nothing here asks for
passwords or personal accounts.

Copy the "Message to the client" section into an email, fill in the brackets,
and track answers per application in the platform.

---

## 1. Source code (Git)

| We need | Preferred | Fallback |
|---------|-----------|----------|
| Access to the repositories we will work on | Client installs our **GitHub App** on their organization, limited to the selected repositories | A **fine-grained token** from a dedicated machine user, limited to those repositories, with an expiry date |
| Branch rules | Their protected branches (usually `main`, `release/*`) and who approves merges | We default to: we never push to protected branches, we open pull requests |
| Default branch per repo | e.g. `main` or `develop` | |
| CI | Which CI runs on PRs (GitHub Actions, Jenkins, other) | |

Not acceptable: a developer's personal password or a token with access to all their repositories.

For GitLab, Bitbucket or CodeCommit: same idea, a scoped token or app with access to the listed repositories only. These providers come after GitHub in our roadmap; tell the client we will confirm the exact method.

## 2. AWS access

| We need | Preferred | Fallback |
|---------|-----------|----------|
| Which AWS accounts map to dev, staging, production | One account per environment, or one account with clear separation | |
| A role we can assume | Client deploys our CloudFormation template `infra/client-onboarding/readonly-role.yaml` in each account and sends back the **Role ARN** | They create an equivalent role by hand with the same trust policy and ExternalId |
| Region(s) | e.g. `ap-south-1` | |

How the role works:
- We give the client our **platform AWS account ID** and a unique **ExternalId** for them.
- The role trusts only our account, and only with that ExternalId.
- It is **read-only**: we can list and describe resources and read logs and metrics. It explicitly cannot read secret values, S3 object contents or database items, and cannot change anything.
- Sessions last at most 1 hour by default. The client can delete the role at any time to cut access instantly.

Write access (deployments) comes later, as a separate role per environment, only after we agree on scope. Production writes will always require an approval inside our platform.

Last resort only: an IAM user with access keys. If a client insists, we ask for keys attached to the same read-only policy, store them encrypted, and agree on a rotation date (90 days maximum).

## 3. Secrets and configuration

| We need | Notes |
|---------|-------|
| List of environment variables per environment | Names only at first, e.g. `DATABASE_URL`, `REDIS_URL`, `STRIPE_SECRET` |
| Which are secrets | Values are entered by an admin directly into our platform, which stores them in AWS Secrets Manager. Never send values by email or chat |
| Where secrets live today | If they already use Secrets Manager or SSM, we prefer referencing theirs over copying |

## 4. People and process

- A technical contact on the client side who can approve access and answer architecture questions.
- Who approves production deployments on their side.
- Any compliance constraints (data residency, PCI, HIPAA, no data leaving a region).
- Whether they allow AI coding assistants on their code. **Ask this explicitly and get it in writing**, because our platform sends their code to Anthropic's API for processing.

## 5. New applications (built from scratch)

If we are building something new for the client:
- Where the repository should live (their GitHub organization or ours, transferred later).
- Their preferred stack and cloud services, or permission for us to propose one.
- The AWS account the new app will deploy into, and the same role setup as section 2.

---

## Message to the client (template)

> Hi [name],
>
> To start work on [application], we need the following. None of it involves sharing passwords.
>
> 1. **Code access:** please install our GitHub App on your organization and give it access to: [repo list]. (Link: [install link].) If that is not possible, a fine-grained token from a machine user limited to those repositories also works.
> 2. **AWS access (read-only):** please deploy the attached CloudFormation template in each of these accounts: [dev / staging / prod]. Use platform account ID `[our account id]` and ExternalId `[unique id]`. Send us the Role ARN shown in the stack outputs. The role can only view resources and read logs; it cannot change anything or read your secrets or data. You can delete it at any time.
> 3. **Configuration:** the list of environment variable names per environment, and which ones are secrets. We will set up a secure way to enter secret values, so please do not email them.
> 4. **Approvals:** who on your side approves production releases.
> 5. **AI tooling:** please confirm you are comfortable with us using AI coding assistants (Anthropic's Claude) on this codebase.
>
> Thanks,
> [you]
