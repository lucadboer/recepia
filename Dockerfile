# syntax=docker/dockerfile:1.7
# recepia service image (ADR 0011): build with tsc, install production dependencies only, run on
# distroless Node 24 as a non-root user. Migrations are a one-off: `docker run … src/db/migrate.js`.

ARG BUILD_IMAGE=node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e

# --- dependencies manifest (cached until the lockfile changes) -------------------------------------
FROM ${BUILD_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# --- compile TypeScript -----------------------------------------------------------------------------
FROM base AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# --- production dependencies only (flat node_modules, no install scripts) ---------------------------
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted

# --- runtime ----------------------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS runtime
LABEL org.opencontainers.image.title="recepia" \
      org.opencontainers.image.description="WhatsApp agent that books routine dental appointments" \
      org.opencontainers.image.source="https://github.com/lucadboer/recepia" \
      org.opencontainers.image.licenses="UNLICENSED"
WORKDIR /app
ENV NODE_ENV=production PORT=3000
# The repository layout is preserved, so files read at runtime relative to the code
# (migrations, prompts, pricing table, package.json) are found where the code expects them.
COPY --from=prod-deps --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/dist/src ./src
COPY --chown=nonroot:nonroot src/db/migrations ./src/db/migrations
COPY --chown=nonroot:nonroot src/llm/pricing.json ./src/llm/pricing.json
COPY --chown=nonroot:nonroot prompts ./prompts
COPY --chown=nonroot:nonroot package.json ./
USER nonroot
EXPOSE 3000
# No shell or curl in distroless: the probe is a one-line Node fetch against /healthz.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# The distroless entrypoint is node; these are its arguments.
CMD ["--enable-source-maps", "--import", "./src/telemetry/register.js", "src/server.js"]
