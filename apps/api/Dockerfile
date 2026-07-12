# F2: API control plane image (multi-stage). Build context is the REPO ROOT:
#   docker build -f apps/api/Dockerfile .
# Stage 1 installs the pnpm workspace and compiles shared/db/api; stage 2
# keeps the built workspace + production node_modules. The whole workspace is
# copied (not `pnpm deploy`-pruned) — simpler and correct for workspace:*
# deps; image-size optimization is a later concern, documented trade-off.

FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY tools ./tools
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @dental/shared build \
 && pnpm --filter @dental/db build \
 && pnpm --filter @dental/api build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /repo
RUN corepack enable
COPY --from=build /repo /repo
EXPOSE 4100
# Temporal worker runs in-process (same as the dev topology).
CMD ["node", "apps/api/dist/main.js"]
