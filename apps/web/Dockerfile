# Builds the real @naqsh/web frontend and serves the static bundle.
#
# Built from the MONOREPO ROOT as the build context (not apps/web alone),
# because the Vite build type-checks against every workspace package it
# imports (@naqsh/schemas most of all) -- exactly like apps/api/Dockerfile.
#
#   docker build -f apps/web/Dockerfile -t naqsh-web \
#     --build-arg VITE_API_BASE_URL=https://naqsh-api-xxxx.run.app .
#   docker run -p 8080:8080 naqsh-web
#
# VITE_API_BASE_URL is a BUILD-time argument, not a runtime one: Vite
# inlines `import.meta.env.*` into the bundle at build time, so it must be
# known when the image is built. Deploying the frontend against a
# different API means rebuilding the image -- an accepted tradeoff for
# shipping a fully static, zero-runtime-config bundle.

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

# Real source for apps/web and every workspace package it imports.
COPY apps/web apps/web
COPY packages/core packages/core
COPY packages/adapters packages/adapters
COPY packages/schemas packages/schemas
COPY packages/model-providers packages/model-providers

# Defaults to localhost so a plain `docker build` with no --build-arg
# still produces a working local-development image rather than a bundle
# pointing at nothing.
ARG VITE_API_BASE_URL=http://localhost:3001
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build --workspace=@naqsh/web

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Cloud Run injects PORT; 8080 matches its default so a local `docker run`
# without -e PORT behaves identically.
ENV PORT=8080

# `serve` rather than nginx: one small dependency, and its SPA rewrite
# (--single) is what makes a deep link like /design work on refresh
# instead of 404-ing, since react-router owns those paths client-side.
RUN npm install --global serve@14

COPY --from=builder /app/apps/web/dist ./dist

USER node
EXPOSE 8080
CMD ["sh", "-c", "serve --single --listen ${PORT} dist"]
