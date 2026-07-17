# F2/F4: edge synchronizer image — the artifact that would ship on-prem
# (F4 step 3 packages this as a signed installer/container). Build context is
# the REPO ROOT:
#   docker build -f apps/edge-sync/Dockerfile .
# Runs via tsx (same as dev): the edge is an ESM workspace package whose
# in-container behavior should match the on-host behavior exactly.

FROM node:22-slim
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY tools ./tools
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @dental/shared build && pnpm --filter @dental/simulator build
# Cursor/outbox state lives in /repo/edge-sync-state — mount a volume there
# to survive restarts (compose does; on Railway the state is ephemeral, which
# is safe: capture restarts from epoch and the cloud dedups by event id).
CMD ["pnpm", "--filter", "@dental/edge-sync", "dev"]
