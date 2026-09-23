FROM node:20.19.5-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @socio/api... build

FROM node:20.19.5-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app /app
RUN mkdir -p /var/log/socio && chown -R node:node /app /var/log/socio
USER node
EXPOSE 3001
CMD ["sh", "-c", "corepack pnpm --filter @socio/database prisma:deploy && corepack pnpm --filter @socio/database prisma:seed && node apps/api/dist/main.js"]
