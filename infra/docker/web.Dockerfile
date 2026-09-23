FROM node:20.19.5-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @socio/web build

FROM node:20.19.5-bookworm-slim AS runtime
WORKDIR /app/apps/web
ENV NODE_ENV=production
COPY --chown=node:node --from=build /app/apps/web/.next/standalone ./
COPY --chown=node:node --from=build /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
