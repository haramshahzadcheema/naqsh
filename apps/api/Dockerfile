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

# FreeCAD, so a HOSTED Naqsh can build real geometry rather than only
# offering the mock environments. Without this the container has no
# `freecadcmd`, environmentDiscovery.ts reports FreeCAD unavailable
# (correctly), and the deployed app can only demo the in-memory CAD.
#
# `freecad-python3` is the headless Python-scriptable package -- NOT the
# `freecad` GUI metapackage, which drags in X11 and Qt for a display this
# container will never have.
#
# Debian bookworm ships FreeCAD 0.20.2 rather than the 1.1.x commonly
# installed locally. Every TypeId this adapter uses (Part::Box,
# Part::Cylinder, Part::Torus, Part::Wedge), plus Placement, the boolean
# features and Part::Fillet, all exist in 0.20 -- but that is a real
# version difference, so the deployed image should be smoke-tested with
# runner.py's own `health` operation rather than assumed equivalent.
#
# This is a ~460MB download and dominates both build time and image size.
# It is the price of the hosted instance producing genuine .FCStd files.
RUN apt-get update  && apt-get install -y --no-install-recommends freecad-python3  && rm -rf /var/lib/apt/lists/*

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
# runner.py is DATA, not code esbuild can bundle: the adapter passes its
# path to a freecadcmd subprocess. Without it the bundle would resolve a
# path that does not exist inside the image.
COPY packages/adapters/freecad ./packages/adapters/freecad
ENV NAQSH_FREECAD_RUNNER=/app/packages/adapters/freecad/runner.py

RUN mkdir -p /app/data && chown -R node:node /app/data /app/bundle.mjs
USER node

EXPOSE 8080
CMD ["node", "bundle.mjs"]
