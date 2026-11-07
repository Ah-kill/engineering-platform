# Developer onboarding

How a new developer gets from "I have an account" to a reviewed pull request, on a laptop or a
phone. Ten minutes of setup, once. For what an org admin sets up beforehand, see the
[README](../README.md#using-it); for the API behind each screen, [04-api.md](04-api.md).

---

## 1. Your account

An org admin creates your account under **Developers** and sends you the address of the platform
and a first password. You start with **no access** to any client: the admin (or an app admin)
grants you a role on a client, an application or one environment.

| Role | What it lets you do |
|------|---------------------|
| Viewer | See the client or application and its environments |
| Developer | Also open workspaces and work with Claude (development and staging) |
| App admin | Also manage environments, variables, network access, AWS and who has access |
| App creator | Create new applications under a client |

Production environments are protected: you need a grant on that exact environment, which only an
org admin can give. Until then production shows as *view only*.

First sign-in:

1. Open the platform address and sign in with the email and password you were given.
2. **Account** → *Change password*. Use 12 or more characters; a password manager helps.
   Changing it signs out your other devices.

## 2. Two-step login (do this on day one)

**Account** → *Two-step login* → *Set up two-step login*.

1. Scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator,
   1Password, Bitwarden and similar). If you are setting up on the phone itself, copy the key shown
   under the code into the app instead.
2. Enter the 6-digit code the app shows and press *Turn on*.
3. **Save the 10 recovery codes** in your password manager. Each signs you in once if you lose your
   phone. They are shown only at this moment; you can make new ones later (the old ones stop working).

From now on sign-in asks for a code after your password. Turning it on signs out every other device.
After 10 wrong codes in a row, two-step sign-in pauses for 15 minutes.

Lost your phone and your recovery codes? An org admin can reset two-step login for you under
**Developers**; set it up again straight after signing in.

### Signed-in devices

**Account** → *Signed-in devices* lists every browser where you are signed in, with its address and
when it signed in. *Sign out* ends one session (signing out *This device* takes you back to the
sign-in page); *Sign out all other devices* keeps only the one you are using. If you see a device
you do not recognise: sign it out, change your password, and tell an admin. Every sign-out is in
the audit log.

## 3. Claude credential

**Claude & GitHub** → *How Claude signs in*. Pick one:

- **API key**: create a key at platform.claude.com and paste it. Billed per use to that account.
- **Claude subscription**: on your own computer run `claude setup-token`. It opens the usual Claude
  sign-in page and prints a token valid for a year; paste it here. Confirm with your lead that this
  use is covered by your plan before relying on it.

Rules: the credential is **yours alone**, never a shared one. It is stored encrypted and only ever
shown as its last four characters. It is given to Claude runs in your own workspaces (commands Claude
runs can read it, as in a local terminal) but never to the browser terminal.

*Default model*: the list comes live from Claude Code and your account. "Default", "Opus", "Sonnet"
and "Haiku" always mean the newest version of that model.

## 4. GitHub token

**Claude & GitHub** → *GitHub*. Create a **fine-grained personal access token** on GitHub:

- *Resource owner*: the client's organization (one token per organization; you can save a token per
  GitHub owner and a default one).
- *Repository access*: only the repositories you work on.
- *Permissions*: **Contents** read and write, **Pull requests** read and write. Nothing else.
- An expiry date. Put a reminder in your calendar to renew it.

The token never enters the workspace container. Fetch, pull and push run in the platform itself,
only while Claude is idle, after a safety check of the repository's git settings.

## 5. The daily workflow

### Open a workspace

**Home** shows *continue where you left off*. Otherwise: **Clients** → client → application →
*New workspace* → pick the environment (usually *development*) and a branch. A new branch is created
from the default branch unless you untick that. The first workspace on a server can take a few
minutes while the workspace image builds; after that it is a clone, seconds to a minute.

Each workspace is your own checkout in its own container. Its network access follows the
application's setting: by default only Claude, GitHub, the npm and PyPI registries and the hosts an
app admin added (plus AWS endpoints when the environment has an AWS role).

### Work with Claude

1. Describe the change in **Plan** mode. Claude reads the code and proposes a plan; it does not edit.
2. Read the plan. Ask for changes in the chat, or press **Approve and execute**.
3. In **Execute** mode Claude edits files and runs commands. Risky commands (deleting files,
   `docker`, cloud CLIs, deploy or migration scripts, and so on) stop and wait for you: **Allow** or
   **Reject**. An unanswered request is refused after 15 minutes. Pushing, changing git settings and
   reading credentials are always blocked.
4. **Stop** ends a run at any time. A run also stops at the turn, time and cost limits set by the
   server, and at your monthly budget if an admin set one (see the **Usage** page).

Instructions in the repository (`CLAUDE.md`, READMEs, comments) are treated as untrusted. The
platform's own rules, and the application's project instructions set by an app admin, take precedence.

### Review, commit, push, pull request

- **Changes** lists every changed file; open one for a side-by-side diff. Discard what you do not want.
- Write a commit message and **Commit** (you are the author).
- **Push** sends the branch to GitHub. Pushing to the default branch or to `main`, `master`,
  `production`, `prod` or `release` is refused: push a feature branch.
- **Pull request** opens one against the workspace's base branch. Merging follows the client's own
  GitHub rules.

### Terminal

The **Terminal** tab opens a shell **inside the workspace container**: same files, same network
rules, the environment's variables and (when configured) short-lived AWS credentials, but not your
Claude or GitHub credential. Up to 3 terminals per workspace; one closes after an hour without
activity. Use it for tests, package installs and quick checks. Terminal contents are not recorded;
opening and closing are.

### Variables, secrets and AWS

App admins set per-environment variables and secrets (any service, or import a `.env` file).
Secrets are stored encrypted, never shown again in full, and redacted from stored and streamed
output where possible. When an environment has an AWS role, each Claude run and terminal receives
short-lived AWS credentials limited to that environment (and to the allowed actions, if the
environment has a session policy). There are never long-lived AWS keys in a workspace.

### Housekeeping

- Delete conversations and workspaces you no longer need from **Home** or the application page.
  Unpushed work in a deleted workspace is gone.
- Push your branches at the end of the day: the server's workspace folder is not a backup.

## 6. On a phone

The whole workflow works on a phone browser.

- With Tailscale (the recommended setup in [03-deployment.md](03-deployment.md)): install the Tailscale
  app, sign in with your work account, open the platform address, then **Add to Home Screen**.
- In a workspace the tabs at the bottom switch between **Files**, **Code**, **Claude**, **Changes** and
  **Terminal**. Claude opens first: plan, approve, then review the diff in Changes.
- Keep the authenticator app on a different device from your password manager if you can, and turn
  on the phone's screen lock. A lost phone: sign it out from *Signed-in devices* on another device
  and tell an admin.

## 7. Troubleshooting

| Symptom | What to do |
|---------|------------|
| "Invalid email or password" | Check caps lock and the address. Too many attempts are rate-limited for a minute. |
| "Too many wrong codes" | Two-step sign-in is paused for 15 minutes. Check the phone's clock is set automatically. A recovery code also works. |
| Signed out unexpectedly | Sessions last 12 hours by default. A password change, two-step change, admin reset or *Sign out all other devices* also ends sessions. |
| Client or application missing | You have no grant on it yet. Ask an admin. |
| Production shows *view only* | Production needs a grant on that exact environment, from an org admin. |
| "Connect a repository to this application first" | An app admin connects the GitHub repository on the application page. |
| Workspace stuck on *creating* or *failed* | Usually the GitHub token cannot read the repository (owner, repositories or expiry). Fix the token, delete the workspace and create it again. |
| "Docker is not running" | Server-side: Docker must be running on the platform host. Tell the admin. |
| Claude fails to start / 401 from Anthropic | Your Claude credential is missing, expired or revoked. Save a new one under **Claude & GitHub**. |
| "You have used $X of your $Y monthly Claude budget" | Your monthly limit is reached. Ask an org admin to raise it (**Organisation**), or wait for the 1st (UTC). |
| A package install or `curl` fails with a proxy error | The host is not on the application's network allowlist. Ask an app admin to add it under *Network access*. |
| Push refused | You are on a protected or default branch: create a feature branch (*Branches*), commit there, push. |
| "Claude is working in this workspace" | Git operations that use your token wait until Claude is idle. Wait or press **Stop**. |
| Terminal says "too many terminals" | Close one of the three open terminals (other tabs or devices count too). |
| AWS commands fail with AccessDenied | The environment's role or its session policy does not allow that action. Ask an app admin; production changes need an org admin. |

Still stuck: send an admin the time and the workspace name. Everything relevant is in the audit
log, and the server logs carry no secrets.
