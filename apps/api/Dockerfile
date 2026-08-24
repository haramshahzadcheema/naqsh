# Builds and runs the real @naqsh/api server -- the SAME code every
# `npm run dev --workspace=@naqsh/api` invocation runs, esbuild-bundled
# into one file so it can run under plain `node` without the monorepo's
# dev-time workspace resolution (every workspace package's package.json
# deliberately points `main` at its TS source for fast `tsx watch`
# iteration, which plain `node` cannot execute -- see
# apps/api/scripts/build-container-bundle.mjs's own doc comment for the
# real failure this works around, confirmed by actually hitting it).
#
# Built from the MONOREPO ROOT as the build context (not apps/api alone),
# because bundling needs every sibling workspace package's real source
# present (@naqsh/core, @naqsh/schemas, @naqsh/adapters,
# @naqsh/model-providers).
#
#   docker build -f apps/api/Dockerfile -t naqsh-api .
#   docker run -p 8080:8080 -e GEMINI_API_KEY=... naqsh-api

FROM node:20-slim AS builder
WORKDIR /app

# Dependencies first for layer caching.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/model-providers/package.json packages/model-providers/package.json
RUN npm ci

# Real source for apps/api and every workspace package it imports.
COPY apps/api apps/api
COPY packages/core packages/core
COPY packages/adapters packages/adapters
COPY packages/schemas packages/schemas
COPY packages/model-providers packages/model-providers
RUN node apps/api/scripts/build-container-bundle.mjs

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Cloud Run injects PORT at deploy time; 8080 matches its default so a
# local `docker run` without -e PORT behaves the same way.
ENV PORT=8080
# Where uploaded files and the real JSON-file project state live inside
# the container. On Cloud Run's default (no mounted volume), this
# directory is EPHEMERAL -- wiped on every new revision/cold start/scale-
# to-zero. Fine for a demo; a real deployment needs a Cloud Run volume
# mount (GCS FUSE or Filestore) or a swap to a managed datastore before
# this matters for anything beyond a hackathon submission.
ENV NAQSH_DATA_DIR=/app/data

COPY --from=builder /app/apps/api/dist/bundle.mjs ./bundle.mjs

RUN mkdir -p /app/data && chown -R node:node /app/data /app/bundle.mjs
USER node

EXPOSE 8080
CMD ["node", "bundle.mjs"]
