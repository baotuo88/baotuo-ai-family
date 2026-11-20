# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ ./patches/
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY tsconfig.base.json ./
COPY apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY apps/server/src/ ./apps/server/src/
COPY prompts/ ./prompts/
COPY tests/ ./tests/
COPY infra/docker/ ./infra/docker/
COPY scripts/ ./scripts/
RUN pnpm verify
# Verify that the native binary for the build platform was installed.
RUN ./node_modules/.bin/codex --version

FROM dependencies AS production-dependencies
RUN pnpm prune --prod

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=18080 \
    DATA_DIR=/data \
    HOME=/data/home \
    CODEX_CLI_HOME=/data/codex-home \
    CODEX_ADMIN_WORKSPACE=/data/runtime/admin \
    CODEX_FAMILY_WORKSPACE=/data/runtime/family \
    FILE_SEND_ALLOWED_DIRS=/data/outbox:/data/inbox:/data/office
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates bubblewrap git python3 python3-venv ripgrep unzip \
    && ln -s /usr/bin/bwrap /usr/local/bin/bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data \
    && chown node:node /data
COPY --from=production-dependencies /app/node_modules/ ./node_modules/
COPY --from=build /app/dist/ ./dist/
COPY --from=build /app/prompts/ ./prompts/
COPY package.json ./
COPY --chmod=755 infra/docker/entrypoint.sh /usr/local/bin/gateway-entrypoint
COPY infra/docker/healthcheck.cjs /usr/local/lib/gateway-healthcheck.cjs
USER node
EXPOSE 18080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "/usr/local/lib/gateway-healthcheck.cjs"]
ENTRYPOINT ["/usr/local/bin/gateway-entrypoint"]
CMD ["node", "dist/apps/server/index.js"]
