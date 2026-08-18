# syntax=docker/dockerfile:1.7
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun, mounted RO at /app/src by host
#   - globally-installed Node CLIs (claude-code, agent-browser): pnpm + Node
#
# Source is never baked in — /app/src is provided by a shared read-only
# bind mount at runtime (see src/container-runner.ts). Source-only changes
# never require an image rebuild.

FROM node:22-slim

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin versions for reproducibility. Bump deliberately — unpinned installs mean
# every rebuild silently picks up the latest and can break in lockstep across
# all users. The global Node CLIs (claude-code, agent-browser) are
# pinned in cli-tools.json so a skill can add one with a json-merge; Bun (the
# runtime) is pinned here because it installs from a different source.
ARG BUN_VERSION=1.3.12

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so outbound.db writes finalize on
# SIGTERM instead of being orphaned by the shell entrypoint.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libasound2 \
        libpangocairo-1.0-0 \
        libcups2 \
        libdrm2 \
        libxshmfence1 \
        ca-certificates \
        curl \
        git \
        tini \
        unzip \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# Chromium path for agent-browser / Playwright consumers
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Belt-and-braces: prevent Playwright's postinstall from downloading its own
# ~300MB Chromium. We've already installed the system one above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# ---- agent-runner deps -------------------------------------------------------
# Deps are cached independently of CLI versions. Source is NOT baked in —
# it's provided by the shared RO mount at runtime.
WORKDIR /app

COPY agent-runner/package.json agent-runner/bun.lock ./

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- pnpm + global Node CLIs -------------------------------------------------
# Most stable first, most frequently bumped last. Bumping claude-code
# (the most common change) only invalidates one layer.
#
# only-built-dependencies gates pnpm's supply-chain policy:
#   - agent-browser has a postinstall build step.
#   - @anthropic-ai/claude-code's postinstall downloads the native Claude
#     binary (linux-arm64 variant on our image). Without the allowlist
#     the SDK fails at spawn time with "native binary not found".
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Pin pnpm to match the host (package.json packageManager). pnpm 11 stopped
# honoring `only-built-dependencies[]=` in .npmrc for global installs, which
# silently skips claude-code's native-binary postinstall and agent-browser's
# bin chmod — the agent then crashes at runtime with "native binary not
# installed". Keep this in lockstep with package.json's `packageManager`.
ARG PNPM_VERSION=10.34.5
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# The npm bundled with node:22-slim (10.9.8) vendors tar <7.5.19, which
# carries a fixable critical (GHSA-23hp-3jrh-7fpw) that the publish gate
# refuses to ship. Patch-level bump only. Drop this once the base image
# ships npm >= 10.9.9.
ARG NPM_VERSION=10.9.9
RUN npm install -g npm@${NPM_VERSION}

# Global Node CLIs the agent invokes at runtime live in cli-tools.json so a
# skill can add one with a json-merge instead of editing this Dockerfile.
# install-cli-tools.sh installs each via pnpm (pinned), writing the per-tool
# only-built-dependencies opt-ins it reads from the manifest.
#
# Some tools (e.g. @wyre-technology/ninjaone-mcp) are scoped packages hosted on
# GitHub Packages, which requires an auth token even for public packages. A
# BuildKit secret carries that token in only for this RUN's process — it is
# never persisted as a build-arg or image layer var. The npmrc line is written
# and stripped in the same RUN so the final layer's file content never
# contains it either. build.sh passes the secret when NODE_AUTH_TOKEN is set;
# omitting it is fine for images that don't need any GitHub-Packages-hosted
# tool.
COPY cli-tools.json install-cli-tools.sh /tmp/
RUN --mount=type=cache,target=/root/.cache/pnpm \
    --mount=type=secret,id=npm_auth_token \
    if [ -f /run/secrets/npm_auth_token ]; then \
      echo "@wyre-technology:registry=https://npm.pkg.github.com" >> /root/.npmrc && \
      echo "//npm.pkg.github.com/:_authToken=$(cat /run/secrets/npm_auth_token)" >> /root/.npmrc; \
    fi && \
    sh /tmp/install-cli-tools.sh /tmp/cli-tools.json && \
    (sed -i '/npm.pkg.github.com/d' /root/.npmrc 2>/dev/null || true)

# ---- Microsoft 365 mail MCP wrapper -------------------------------------------
# @softeria/ms-365-mcp-server has no client-credentials (app-only) auth mode —
# see container/ms365-mail-mcp-wrapper.js for why this wrapper exists.
COPY ms365-mail-mcp-wrapper.js /usr/local/bin/ms365-mail-mcp-wrapper.js
RUN chmod +x /usr/local/bin/ms365-mail-mcp-wrapper.js

# ---- UniFi MCP server (Python, stdio) -----------------------------------------
# unifi-mcp-server is a PyPI package; this image is Node-only, so install it
# via uv's isolated tool environments (auto-downloads its own Python — no
# system python3/pip needed) rather than pulling in a full apt toolchain.
# UV_TOOL_BIN_DIR lands the console-script shim in /usr/local/bin alongside
# uv itself and everything else spawned as an MCP stdio command. UV_TOOL_DIR
# and UV_PYTHON_INSTALL_DIR keep both the venv AND uv's own managed-Python
# download out of /root — this RUN executes as root (USER node is set later,
# below), and the venv's python symlink chains through the managed-Python
# dir too, so both need to be relocated or the node user can't exec either.
RUN curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh && \
    UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin UV_PYTHON_INSTALL_DIR=/opt/uv-python \
      /usr/local/bin/uv tool install unifi-mcp-server==0.2.5 && \
    chmod -R a+rX /opt/uv-tools /opt/uv-python

# ---- CIPP MCP server (Node, stdio) --------------------------------------------
# cipp-mcp isn't published to any package registry yet — only as a Docker image
# (ghcr.io/wyre-technology/cipp-mcp) — so it doesn't fit cli-tools.json (pnpm
# packages only). Plain TypeScript/Node with no native deps, so build it from
# source at a pinned commit instead of standing up a second companion
# container like sentinelone-mcp needed. Defaults to stdio transport already
# (MCP_TRANSPORT unset), so no extra env is needed to run it that way.
# chmod -R a+rX matters here too: this RUN is root, the agent runs as node.
ARG CIPP_MCP_REF=099a3e27e1d40df90955855140c7c8acba930a2c
RUN git clone https://github.com/atlan-it-masters/NC_cipp-mcp.git /opt/cipp-mcp && \
    cd /opt/cipp-mcp && \
    git checkout "${CIPP_MCP_REF}" && \
    npm ci --ignore-scripts && \
    npm run build && \
    npm prune --omit=dev && \
    rm -rf .git && \
    printf '#!/bin/sh\nexec node /opt/cipp-mcp/dist/entry.js "$@"\n' > /usr/local/bin/cipp-mcp && \
    chmod +x /usr/local/bin/cipp-mcp && \
    chmod -R a+rX /opt/cipp-mcp

# ---- Wazuh MCP server (Rust, stdio) -------------------------------------------
# mcp-server-wazuh is a Rust crate with no crates.io/npm/pip distribution —
# building it from source would mean adding a full Rust toolchain
# (build-essential, pkg-config, libssl-dev, perl) to this shared image just
# for one static binary. The upstream project (this fork is a byte-identical
# mirror of gbrigandi/mcp-server-wazuh, verified by matching commit SHA at
# v0.3.0) publishes prebuilt static-pie linux-amd64 release binaries — use
# one of those instead, pinned by sha256.
RUN curl -fsSL -o /usr/local/bin/mcp-server-wazuh \
      https://github.com/gbrigandi/mcp-server-wazuh/releases/download/v0.3.0/mcp-server-wazuh-linux-amd64 && \
    echo "8a18cb44007d4834ee77ae8975355f404c49bda8c0d686e534994e3514134834  /usr/local/bin/mcp-server-wazuh" | sha256sum -c - && \
    chmod +x /usr/local/bin/mcp-server-wazuh

# ---- Veeam Intelligence MCP server (Node, stdio) -------------------------------
# veeam-intelligence-mcp-server isn't published to any package registry —
# build it from source at a pinned commit, same shape as cipp-mcp above.
ARG VEEAM_MCP_REF=929c4cc239f39157f3e3aefe207953fcea38c8c4
RUN git clone https://github.com/atlan-it-masters/NC_veeam-mcp-server.git /opt/veeam-mcp && \
    cd /opt/veeam-mcp && \
    git checkout "${VEEAM_MCP_REF}" && \
    npm ci && \
    npm run build && \
    npm prune --omit=dev && \
    rm -rf .git && \
    printf '#!/bin/sh\nexec node /opt/veeam-mcp/build/index.js "$@"\n' > /usr/local/bin/veeam-mcp && \
    chmod +x /usr/local/bin/veeam-mcp && \
    chmod -R a+rX /opt/veeam-mcp

# ---- ncl CLI wrapper ----------------------------------------------------------
# Actual script lives in the mounted source at /app/src/cli/ncl.ts.
RUN printf '#!/bin/sh\nexec bun /app/src/cli/ncl.ts "$@"\n' > /usr/local/bin/ncl && \
    chmod +x /usr/local/bin/ncl

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
RUN mkdir -p /workspace/group /workspace/extra && \
    chown -R node:node /workspace && \
    chmod 777 /home/node

# Drop setuid-root from the binaries Debian ships (mount, su, passwd, ...). The
# agent runs unprivileged and needs none of them.
RUN find / -xdev -perm -4000 -type f -exec chmod u-s {} + || true

USER node
WORKDIR /workspace/group

# Only applies to a bare `docker run` — the host spawn overrides ENTRYPOINT and
# passes --init instead (see hardeningArgs in src/container-runner.ts).
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]

# ---- Provenance labels -------------------------------------------------------
# LAST on purpose. An ARG invalidates every layer below it, so declaring these
# up with the other build-args would make an otherwise-cached rebuild redo
# `bun install` and the pnpm global CLIs on every existing install, for two
# pieces of metadata. Labels have no filesystem effect, so they cost nothing here.
#
# Which lockfile the baked /app/node_modules came from: /app/src is mounted from
# the host checkout at every spawn, so an image and a checkout whose lockfiles
# disagree fail as a missing module inside a `--rm` container with no logs.
# container/pull.sh checks this before retagging. build.sh passes it; a bare
# `docker build` leaves it empty, which the pull path treats as unverifiable.
#
# image-source defaults to `local` so anything built from this file is honest
# unless its builder says otherwise — the retag cannot forge it after the fact.
ARG AGENT_RUNNER_LOCK_SHA256=
LABEL dev.nanoclaw.agent-runner-lock-sha256="${AGENT_RUNNER_LOCK_SHA256}"
ARG IMAGE_SOURCE=local
LABEL dev.nanoclaw.image-source="${IMAGE_SOURCE}"
