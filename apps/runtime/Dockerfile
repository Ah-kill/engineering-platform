# Workspace image: the sealed box Claude Code works in, one container per workspace.
# Build: npm run runtime:build   (the API also builds it on first use)
FROM node:22-bookworm-slim

# Common tools client projects need for builds and tests. Add more per client later.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl jq less procps ripgrep \
      python3 python3-pip python3-venv build-essential \
 && rm -rf /var/lib/apt/lists/*

# Same Claude Code version as the Agent SDK in apps/api (see package.json claudeCodeVersion).
ARG CLAUDE_CODE_VERSION=2.1.318
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

# The checkout is a bind mount owned by the host user; it is the only repository in the
# container, so trust it (otherwise git refuses with "dubious ownership").
RUN git config --system --add safe.directory /ws/repo  && git config --system --add safe.directory /ws/git

# Unprivileged user (uid 1000 from the node image). /home/agent is a per-workspace volume.
RUN mkdir -p /home/agent /ws/repo /ws/git && chown -R node:node /home/agent /ws
USER node
ENV HOME=/home/agent \
    CLAUDE_CONFIG_DIR=/home/agent/.claude \
    DISABLE_AUTOUPDATER=1 \
    npm_config_update_notifier=false
WORKDIR /ws/repo

CMD ["sleep", "infinity"]
