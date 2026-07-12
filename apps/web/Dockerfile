# F2: web dashboard image. Build context is the REPO ROOT:
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=... .
# NEXT_PUBLIC_* is inlined at build time by Next.js, so the API origin is a
# build arg, not a runtime env.

FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
ARG NEXT_PUBLIC_API_URL=http://localhost:4100
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY tools ./tools
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @dental/web build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /repo
RUN corepack enable
COPY --from=build /repo /repo
EXPOSE 3000
CMD ["pnpm", "--filter", "@dental/web", "start"]
