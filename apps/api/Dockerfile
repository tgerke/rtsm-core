# Build context is the repo root (see infra/compose.yaml)
FROM docker.io/library/node:22-slim

RUN npm install -g pnpm@11.9.0
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/schemas/package.json packages/schemas/
RUN pnpm install --frozen-lockfile --filter @rtsm-core/api...

COPY packages/core packages/core
COPY packages/db packages/db
COPY packages/schemas packages/schemas
COPY apps/api apps/api

EXPOSE 3002
CMD ["pnpm", "--filter", "@rtsm-core/api", "start"]
