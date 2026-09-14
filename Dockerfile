# syntax=docker/dockerfile:1
#
# Webwow – production image.
#
# Stages: deps (npm ci) -> builder (next build) -> runner (migrations + next start).
# The runner intentionally ships the *full* node_modules (including devDependencies):
# docker-entrypoint.sh runs the TypeScript knex migrations with ts-node + tsconfig-paths
# before starting Next, and those live in devDependencies. Do not switch the deps stage
# to `npm ci --omit=dev` without moving ts-node/typescript/tsconfig-paths to dependencies.
#
# Node 20 satisfies package.json (>=18) and Next 16 (>=20.9).
FROM node:20-alpine AS base
WORKDIR /app
# Recommended by the Next.js Docker guide for Alpine (sharp / native addons).
RUN apk add --no-cache libc6-compat

# --- Dependencies ---
FROM base AS deps
# Skip husky's git-hook install: there is no .git inside the build context.
ENV HUSKY=0
COPY package.json package-lock.json ./
RUN npm ci

# --- Builder ---
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
# Multi-site mode is a BUILD-TIME + runtime flag (docs/MULTISITE.md): with "1" the published
# pages render per request (host -> site); with "0" they stay fully static as upstream.
# Pass the same value at runtime (docker-compose.yml). Build: --build-arg WEBWOW_MULTI_SITE=1
ARG WEBWOW_MULTI_SITE=0
ENV WEBWOW_MULTI_SITE=$WEBWOW_MULTI_SITE
# IMPORTANT: no DATABASE_URL / ADMIN_* / PAGE_AUTH_SECRET here. `next build` must
# never depend on a database or on secrets; everything is read at request time.
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- Runner ---
FROM base AS runner
ARG WEBWOW_MULTI_SITE=0
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_NO_WARNINGS=1 \
    PORT=3002 \
    HOSTNAME="0.0.0.0" \
    UPLOAD_DIR=/app/uploads \
    WEBWOW_MULTI_SITE=$WEBWOW_MULTI_SITE

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Runtime files. `next start` needs .next, public, package.json, node_modules and
# next.config.ts (headers/redirects/body limits). The knex CLI needs knexfile.ts,
# tsconfig.json (ts-node + path aliases), database/ (migrations) and lib/ + types/
# because several upstream migrations import from `@/lib/*` and `@/types`.
# scripts/ holds the Webwow CLIs (webwow-sites.ts migrates the site databases on start).
# storage/ holds google-fonts.json and sample collections read via process.cwd().
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/storage ./storage
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/database ./database
COPY --from=builder /app/knexfile.ts ./knexfile.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/types ./types
COPY --from=builder /app/scripts ./scripts
COPY --from=builder --chmod=755 /app/docker-entrypoint.sh ./docker-entrypoint.sh

# Uploads live on a volume mounted at UPLOAD_DIR (/app/uploads), see docker-compose.yml.
RUN mkdir -p /app/uploads && chown nextjs:nodejs /app/uploads

USER nextjs

EXPOSE 3002

# The setup/status route is public (no auth) and touches the DB, so it is a good liveness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3002/ycode/api/setup/status || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
