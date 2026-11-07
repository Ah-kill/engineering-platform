# Running the platform for 2–3 developers

This guide puts the platform on one Ubuntu server: Postgres, Docker for the workspace containers,
and the platform itself (one Node process that serves both the API and the web app). Then it
covers two ways to reach it:

- **(a) Caddy** with automatic HTTPS on a public DNS name.
- **(b) Tailscale** (`tailscale serve`): private access from your laptops and phones, including
  while travelling, with nothing exposed to the internet. **This is the recommended setup.**

Pick one. `WEB_ORIGIN` has to be the single URL people open, so do not run both for the same server.

Files used here: [`deploy/engineering-platform.service`](../deploy/engineering-platform.service),
[`deploy/Caddyfile`](../deploy/Caddyfile), [`deploy/platform.env.example`](../deploy/platform.env.example).

## Why the platform is not in a container

The platform starts and stops a Docker container for every workspace through the docker CLI.
To do that from inside a container it would need the host's Docker socket mounted in. Anyone
who can talk to that socket can start a privileged container that mounts the host's disk, so it
would be root on the host anyway, while looking isolated. Running it as a plain systemd service
under a dedicated user is honest about that, simpler to debug, and the containers that matter
(the ones running Claude and the code it writes) stay isolated as before.

A single machine is fine for a pilot and a small team. A container escape would land next to
the database, though, so once you hold many clients' credentials, move the workspace containers to
a second machine (see section 0.3 of [01-architecture-and-research.md](01-architecture-and-research.md)).

## 1. Server

A VM with 4 vCPU, 16 GB RAM and 100 GB disk handles 2–3 people with a few workspaces each (every
workspace container is limited to 2 CPUs and 4 GB by default). Ubuntu 24.04 LTS.

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl ca-certificates gnupg ufw postgresql

# Node.js 22 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Docker Engine (official repository)
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
```

### Dedicated user

Membership of the `docker` group is equivalent to root. The platform needs it, so give it a user
of its own that nobody logs in as and that runs nothing else.

```bash
sudo useradd --system --home-dir /var/lib/engineering-platform --create-home --shell /usr/sbin/nologin eplatform
sudo usermod -aG docker eplatform
sudo mkdir -p /var/lib/engineering-platform/workspaces /etc/engineering-platform
sudo chown -R eplatform:eplatform /var/lib/engineering-platform
sudo chmod 750 /var/lib/engineering-platform
```

### Postgres

Bound to localhost (the Ubuntu default; check `listen_addresses` in `postgresql.conf`) with a long
random password. Workspace containers can reach the host through the Docker bridge, so never
leave a database on this machine without a password or listening on all interfaces.

```bash
PGPASS=$(openssl rand -base64 30 | tr -d '/+=')
echo "$PGPASS"   # goes into DATABASE_URL below
sudo -u postgres psql -c "CREATE ROLE platform LOGIN CREATEROLE PASSWORD '$PGPASS';"
sudo -u postgres createdb -O platform engineering_platform
```

`CREATEROLE` is needed the first time only: the first migration creates the restricted
`platform_app` role that every request runs as (row-level security). You can remove it after the
first start with `ALTER ROLE platform NOCREATEROLE;`.

## 2. Install and build

```bash
sudo mkdir -p /opt/engineering-platform && sudo chown eplatform:eplatform /opt/engineering-platform
sudo -u eplatform git clone https://github.com/YOUR_ORG/engineering-platform.git /opt/engineering-platform
cd /opt/engineering-platform
sudo -u eplatform npm ci
sudo -u eplatform npm run build          # web app (apps/web/dist) + API (apps/api/dist)
sudo -u eplatform npm run runtime:build  # the workspace image for the bundled Claude Code version
```

`npm run runtime:build` takes a few minutes. Without it the image is built the first time someone
opens a workspace, and that person waits.

## 3. Configuration

```bash
sudo cp deploy/platform.env.example /etc/engineering-platform/platform.env
sudo chown root:eplatform /etc/engineering-platform/platform.env
sudo chmod 640 /etc/engineering-platform/platform.env
sudo nano /etc/engineering-platform/platform.env
```

| Variable | Value | Why |
|----------|-------|-----|
| `WEB_ORIGIN` | the exact URL in the browser, e.g. `https://platform-host.your-tailnet.ts.net` | Every change from any other origin is refused |
| `COOKIE_SECURE` | `true` | Sign-in cookie is only sent over HTTPS |
| `DATABASE_URL` | `postgres://platform:PASSWORD@127.0.0.1:5432/engineering_platform` | Without it, an embedded database in a local folder is used |
| `VAULT_KEY` | `openssl rand -base64 32`, generated once | Encrypts saved Anthropic keys, subscription tokens and GitHub tokens |
| `WORKSPACES_DIR` | `/var/lib/engineering-platform/workspaces` (set in the unit) | Workspace checkouts; mounted into the containers |

The unit file also sets `NODE_ENV=production`, `SERVE_WEB=true` (the API serves `apps/web/dist`
with an SPA fallback and a Content-Security-Policy), `HOST=127.0.0.1` and `PORT=4000`. Only Caddy or
Tailscale on the same machine talk to port 4000.

**`VAULT_KEY` is the one secret you cannot recreate.** Put a copy in your password manager now.
If it is lost, the database is still fine but every saved credential must be entered again.
If you leave it unset, a key is generated into `VAULT_KEY_FILE` instead; then that file is what
you must back up.

Other settings (budgets, container limits, session length) are listed in the [README](../README.md#settings-environment-variables-in-appsapienv-all-optional).

## 4. Service

```bash
sudo cp deploy/engineering-platform.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now engineering-platform
journalctl -u engineering-platform -f      # watch it start; migrations run automatically
curl -s http://127.0.0.1:4000/api/health   # {"ok":true}
```

Create your organization and first admin (prints a generated password):

```bash
cd /opt/engineering-platform/apps/api
sudo -u eplatform bash -c 'set -a; . /etc/engineering-platform/platform.env; set +a; \
  node dist/cli/create-admin.js --org "So N So" --email you@example.com --name "Your Name"'
```

## 5a. Public HTTPS with Caddy

Use this when people must reach the platform from machines you do not control. You need a DNS name
pointing at the server and ports 80/443 open.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo cp /opt/engineering-platform/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # your domain and e-mail
sudo systemctl reload caddy
```

Caddy gets and renews the certificate by itself. The example config:

- proxies everything to `127.0.0.1:4000`, which serves both the web app and `/api`;
- passes WebSocket upgrades (the web terminal) straight through; Caddy's `reverse_proxy` does
  this with no extra settings, keeping the browser's `Host` and `Origin`, and `stream_close_delay`
  keeps open sockets alive across a config reload;
- flushes streamed responses immediately (`flush_interval -1`) so Claude's output appears live;
- compresses the web app's files but not `/api` responses.

Set `WEB_ORIGIN=https://your.domain` and `TRUST_PROXY_HOPS=1` (one reverse proxy in front of the API),
then restart the service. With that, the login rate limit applies per client address instead of
one shared limit for everyone behind the proxy. Leave it at 0 when the API is reached directly.

## 5b. Private access with Tailscale (recommended)

Tailscale puts the server, your laptops and your phones on one private network. Nothing is
exposed to the internet: no open ports and no public login page to attack. It works the same from
a hotel or a train, and the phone apps (iOS, Android) need no other setup.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                  # log in; name the machine e.g. "platform"
```

In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates** (DNS page). Then:

```bash
sudo tailscale serve --bg 4000     # https://platform.<your-tailnet>.ts.net -> 127.0.0.1:4000
tailscale serve status
```

`tailscale serve` terminates HTTPS with a real certificate for the `ts.net` name and proxies to
the platform, WebSockets included. It is reachable only by devices signed in to your tailnet.
Do **not** use `tailscale funnel`, which publishes the service to the whole internet.

Set `WEB_ORIGIN=https://platform.<your-tailnet>.ts.net` and `COOKIE_SECURE=true`, then
`sudo systemctl restart engineering-platform`. On each phone: install Tailscale, sign in, open
the URL, and add it to the home screen.

Tighten who can reach it with a Tailscale ACL (only your team's accounts to `tag:platform:443`), and
turn on key expiry for laptops and phones so a lost device drops off by itself.

With Tailscale you can also close SSH to the world and use `tailscale ssh` or SSH over the tailnet.

## 6. Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH              # or only on tailscale0 once Tailscale works:
# sudo ufw allow in on tailscale0 to any port 22
sudo ufw allow 80,443/tcp           # only for 5a (Caddy); not needed for Tailscale
sudo ufw enable
```

Docker publishes container ports past ufw. The platform does not publish any workspace ports, so
this is fine; just never `docker run -p` other things on this host without knowing that.

## 7. Backups

Two things to back up, plus one optional:

1. **The database**, daily with `pg_dump`.
2. **`VAULT_KEY`** (or the `vault.key` file if you did not set it). Without it a restored database
   has unreadable credentials. Keep it in your password manager, **not** in the same place as the
   dumps: together they decrypt every saved token.
3. Optional: `/var/lib/engineering-platform/workspaces`. Checkouts can be recreated from GitHub, but
   uncommitted or unpushed work exists only there. Ask developers to push their branches.

```bash
sudo mkdir -p /var/backups/engineering-platform && sudo chown postgres: /var/backups/engineering-platform
sudo tee /etc/cron.d/engineering-platform-backup >/dev/null <<'EOF'
# Daily database dump at 02:30, keep 14 days
30 2 * * * postgres pg_dump -Fc engineering_platform > /var/backups/engineering-platform/db-$(date +\%F).dump && find /var/backups/engineering-platform -name 'db-*.dump' -mtime +14 -delete
EOF
```

`pg_dump` runs as the `postgres` superuser, so row-level security does not hide any rows.
Copy the dumps off the machine (restic, rclone to object storage, or the VM provider's snapshots).
A dump that only lives on the server it protects is not a backup.

### Restore drill (do it once now, then every few months)

```bash
# 1. Restore the latest dump into a scratch database on the same server
sudo -u postgres createdb -O platform ep_restore_test
sudo -u postgres pg_restore --no-owner --role=platform -d ep_restore_test /var/backups/engineering-platform/db-YYYY-MM-DD.dump

# 2. Start a second copy of the platform against it, on another port, with the same VAULT_KEY
cd /opt/engineering-platform/apps/api
sudo -u eplatform bash -c 'set -a; . /etc/engineering-platform/platform.env; set +a; \
  DATABASE_URL=${DATABASE_URL%/*}/ep_restore_test PORT=4901 WORKSPACES_DIR=/tmp/ep-restore SERVE_WEB=true \
  WEB_ORIGIN=http://127.0.0.1:4901 COOKIE_SECURE=false node dist/main.js'

# 3. From your laptop: ssh -L 4901:127.0.0.1:4901 server, open http://127.0.0.1:4901,
#    sign in, open "Claude & GitHub": the model list loading proves the saved key decrypts.
#    Check clients, applications and the Usage page look right. Then stop it and clean up:
sudo -u postgres dropdb ep_restore_test
```

Dumps do not contain roles. On a brand-new server, first create the `platform` role and an empty
database (section 1), then `CREATE ROLE platform_app NOLOGIN; GRANT platform_app TO platform;`, and
only then run `pg_restore` into it.

## 8. Updating

```bash
cd /opt/engineering-platform
sudo -u eplatform git pull
sudo -u eplatform npm ci
sudo -u eplatform npm run build
sudo systemctl restart engineering-platform    # migrations run on start
journalctl -u engineering-platform -n 50
```

Restarting stops running Claude sessions, so pick a quiet moment. Take a `pg_dump` first when
the update contains new migrations (`apps/api/migrations`).

To move to a newer Claude Code (new models, fixes):

```bash
sudo -u eplatform npm run update:claude        # newest Agent SDK, rebuilt workspace image, API tests
sudo -u eplatform npm run build
sudo systemctl restart engineering-platform
```

Commit the resulting `package-lock.json` change in the repository rather than leaving the server
ahead of git, or the next `git pull` will conflict.

## 9. Monitoring basics

- **Health:** `GET /api/health` returns `{"ok":true}` without signing in. Point an uptime checker at
  it (for Tailscale, a check running inside the tailnet, or a cron job on the server that mails you).
- **Logs:** `journalctl -u engineering-platform -f` (JSON lines; `| jq` helps). Caddy writes to
  `/var/log/caddy/platform.log`. Everything security-relevant users do is also in the in-app
  **Audit log**.
- **Spend:** the **Usage** page shows cost per day, developer, application and model. Admins see
  the whole organization, developers their own. `AGENT_MAX_BUDGET_USD` caps each run.
- **Disk:** `df -h /var/lib` and `docker system df`. Old workspace images pile up after Claude Code
  updates; remove them with `docker image prune`.
- **Docker:** `systemctl status docker`; the platform logs a warning at start when Docker is not running.

## 10. Security checklist

- [ ] Reached through Tailscale (preferred) or Caddy with HTTPS; port 4000 bound to `127.0.0.1` only.
- [ ] `COOKIE_SECURE=true` and `WEB_ORIGIN` equal to the exact public URL.
- [ ] Firewall: deny incoming except SSH (better: SSH only over Tailscale) and 80/443 for Caddy.
- [ ] Postgres listens on localhost only, uses a long random password, and `pg_hba.conf` uses `scram-sha-256`.
- [ ] `VAULT_KEY` is set from `platform.env` (mode 0640, root:eplatform), copied to the password manager, and stored apart from the database dumps.
- [ ] The platform runs as the dedicated `eplatform` user. The `docker` group is root-equivalent: nobody else is in it, nobody logs in as this user, and it runs nothing else.
- [ ] Nothing mounts `/var/run/docker.sock` into a container.
- [ ] Unattended security updates on (`sudo apt install unattended-upgrades`), and Docker/Node updated regularly.
- [ ] Daily `pg_dump` copied off the machine, and a restore drill done.
- [ ] Each developer uses their own Claude credential and a fine-grained GitHub token limited to client repositories.
- [ ] Org admin accounts are few; the Audit log is reviewed now and then.

## Running on EC2: protect the instance metadata service

When the platform runs on an EC2 instance, its own AWS identity (the one that calls
`sts:AssumeRole` into client roles) is usually the **instance role**. The instance metadata
service at `169.254.169.254` gives that role's credentials to anything on the machine that
can reach it, including, in principle, code running in a workspace container.

- Workspaces in the default **Only allowed sites** network mode cannot reach it: their
  Docker network has no route out except the filtering proxy, which only allows listed host names.
- Workspaces in **Unrestricted** network mode are *not* blocked by the platform. Without
  protection, a malicious build script or a prompt-injected command could read the platform's
  base AWS credentials. On their own they cannot assume a client role (that also needs the
  client's ExternalId, which stays encrypted in the database), but they are the platform's
  identity towards every client and must never leave the server.

Require **IMDSv2 with a hop limit of 1** on the instance. IMDSv2 needs a session token from
a `PUT` request first, and a hop limit of 1 means the token reply cannot cross the extra
network hop into a container, so containers get no token and no credentials, while the
platform process on the host keeps working. Some newer AMIs (for example Amazon Linux 2023)
default to a hop limit of 2 precisely so that containers *can* reach the service; change it.

```bash
# Existing instance (from a machine with EC2 admin rights)
aws ec2 modify-instance-metadata-options --instance-id i-0123456789abcdef0 \
  --http-tokens required --http-put-response-hop-limit 1 --http-endpoint enabled

# Launch templates / CloudFormation: MetadataOptions:
#   HttpTokens: required
#   HttpPutResponseHopLimit: 1
```

Defense in depth, optional: drop container traffic to the metadata address on the host. The
`DOCKER-USER` chain only sees forwarded (container) traffic, so the host itself is unaffected.

```bash
sudo iptables -I DOCKER-USER -d 169.254.169.254/32 -j DROP
# Persist it with your firewall tooling (for example iptables-persistent).
```

Check from inside a workspace in Unrestricted mode (browser terminal). Both commands should
fail or time out:

```bash
curl -s -m 3 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'
curl -s -m 3 http://169.254.169.254/latest/meta-data/iam/security-credentials/
```

Related notes for the AWS integration:
- The workspace image ships **AWS CLI v2** (`aws --version` in a terminal). It uses the
  short-lived `AWS_*` variables the platform injects at run start and terminal open.
- An environment can narrow those credentials with a **session policy** (*AWS access* →
  *Enforced permissions*): read-only investigation, deploy (Lambda + CloudFormation), or a
  custom list. It can only remove permissions from the client's role, never add any.
- In "Only allowed sites" mode the platform opens STS, IAM and the regional endpoints of common
  services for the environment's region. S3 is deliberately not among them (bucket hosts in
  any account would become reachable). For deployments that upload artifacts, add the specific
  bucket host, e.g. `my-artifacts.s3.eu-west-1.amazonaws.com`, to the application's allowed sites.
