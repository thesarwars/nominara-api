# syntax=docker/dockerfile:1
#
# The API and the gateway ship from ONE image and differ only by CMD. They
# share the whole module graph, and two images built from the same source
# would drift the first time someone rebuilt one and not the other.
#
# THE BUILD STEP IS NOT OPTIONAL. NestJS resolves constructor parameters from
# `emitDecoratorMetadata`, which esbuild does not implement — so `tsx
# src/main.ts` dies at boot with "Nest can't resolve dependencies of the
# AuthGuard (?, Symbol(PG_POOL))". `tsc` emits it. That is why this compiles
# rather than running the sources directly.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Pinned rather than "latest": package.json carries no `packageManager` field,
# so corepack has nothing to read and an unpinned pnpm would resolve
# differently over time against a lockfile that does not move.
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

# ---- dependencies (full, for the compiler) ---------------------------------
FROM base AS build
WORKDIR /app
# pnpm-workspace.yaml carries the fastify override AND the `allowBuilds`
# decisions; without it pnpm 11 halts on ERR_PNPM_IGNORED_BUILDS.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY contracts ./contracts
COPY src ./src
# rootDir is ".", so output lands at dist/src/** and dist/contracts/**.
RUN pnpm exec tsc -p tsconfig.build.json

# ---- production dependencies only ------------------------------------------
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

# ---- runtime ---------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# `tsc` emits .js and copies NOTHING else, but two non-TypeScript assets are
# read from disk at run time, both at paths resolved relative to the compiled
# file's own location. Neither is optional and neither fails at build time:
#
#   migrations/sql  migrate-runner.js does readdir(__dirname/migrations/sql).
#                   Without it `migrate` exits 1 on ENOENT and the stack never
#                   starts, which is exactly how this was found.
#   openapi.generated.json
#                   serve.js reads dist/contracts/openapi.generated.json to
#                   serve the spec — deliberately the COMMITTED document
#                   rather than a boot-time regeneration, so it has to travel
#                   with the build.
COPY --from=build /app/src/db/migrations/sql ./dist/src/db/migrations/sql
COPY --from=build /app/contracts/openapi.generated.json ./dist/contracts/openapi.generated.json

# Unprivileged, and it matters more than usual here: this process holds the
# unwrapped DEK-wrapping key and the token-signing private key in memory.
USER node

# 4000 is the API (PORT), 3001 the gateway (GATEWAY_PORT). One image, two
# roles, selected by the compose `command`.
EXPOSE 4000 3001

# /health/live, not /health/ready. Readiness deliberately FAILS until the
# database migration version matches the build's, so using it here would mean
# a correctly-waiting container reported itself broken. Node 24 has global
# fetch, so this needs no curl in the image.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/main.js"]
