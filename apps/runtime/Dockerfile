# Workspace image: the sealed box Claude Code works in, one container per workspace.
# Build: npm run runtime:build   (the API also builds it on first use)
FROM node:22-bookworm-slim

# Common tools client projects need for builds and tests. Add more per client later.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl jq less procps ripgrep \
      python3 python3-pip python3-venv build-essential \
 && rm -rf /var/lib/apt/lists/*

# AWS CLI v2, official bundle for this image's architecture (x86_64 or aarch64). It reads the
# short-lived AWS_* variables the platform injects; no credentials are baked into the image.
# groff-base lets `aws help` render; unzip is only needed during the install and is removed again.
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in x86_64|aarch64) ;; *) echo "Unsupported architecture for AWS CLI v2: $arch" >&2; exit 1 ;; esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends unzip groff-base; \
    tmp="$(mktemp -d)"; \
    curl -fsSL --proto '=https' --tlsv1.2 "https://awscli.amazonaws.com/awscli-exe-linux-${arch}.zip" -o "$tmp/awscliv2.zip"; \
    unzip -q "$tmp/awscliv2.zip" -d "$tmp"; \
    "$tmp/aws/install" --install-dir /usr/local/aws-cli --bin-dir /usr/local/bin; \
    rm -rf "$tmp"; \
    apt-get purge -y --auto-remove unzip; \
    rm -rf /var/lib/apt/lists/*; \
    aws --version

# Same Claude Code version as the Agent SDK in apps/api (see package.json claudeCodeVersion).
ARG CLAUDE_CODE_VERSION=2.1.318
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

# The checkout is a bind mount owned by the host user; it is the only repository in the
# container, so trust it (otherwise git refuses with "dubious ownership").
RUN git config --system --add safe.directory /ws/repo  && git config --system --add safe.directory /ws/git

# Outbound filter used in restricted network mode (runs in its own small container).
COPY egress-proxy.mjs /opt/platform/egress-proxy.mjs

# Gives the browser terminal a real pseudo-terminal (with resizing) over `docker exec -i`.
COPY pty-bridge.py /opt/platform/pty-bridge.py

# Unprivileged user (uid 1000 from the node image). /home/agent is a per-workspace volume.
RUN mkdir -p /home/agent /ws/repo /ws/git && chown -R node:node /home/agent /ws
USER node
ENV HOME=/home/agent \
    CLAUDE_CONFIG_DIR=/home/agent/.claude \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    npm_config_update_notifier=false
WORKDIR /ws/repo

CMD ["sleep", "infinity"]
