# syntax=docker/dockerfile:1
# XO: one Node process + one SQLite file. The image never contains the OpenRouter key or any
# database (see .dockerignore); supply the key at run time (OPENROUTER_API_KEY or a mounted file).

# TODO(step 12): after the first real build, pin the base image by digest (node:26-slim@sha256:...).
ARG NODE_IMAGE=node:26-slim

# ---- build: install all dependencies, build the client ----
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION=12.15.0
RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.client.json vite.config.ts ./
COPY src ./src
RUN pnpm build

# ---- prod-deps: production dependencies only ----
FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION=12.15.0
RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    XO_HOST=0.0.0.0 \
    XO_PORT=3000 \
    XO_DB_PATH=/data/xo.db
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY --from=build /app/dist/client ./dist/client
# The data directory must exist and belong to the non-root user before VOLUME, so a fresh volume inherits it.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
VOLUME /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.XO_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/server/main.ts"]
