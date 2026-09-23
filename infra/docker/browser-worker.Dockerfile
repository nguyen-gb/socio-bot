FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
RUN corepack enable
COPY . .
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @socio/browser-worker... build
RUN mkdir -p /var/lib/socio/profiles /var/lib/socio/artifacts /var/lib/socio/object-storage /var/log/socio /run/secrets/socio && chown -R pwuser:pwuser /app /var/lib/socio /var/log/socio /run/secrets/socio
ENV NODE_ENV=production
USER pwuser
EXPOSE 3010
CMD ["node", "apps/browser-worker/dist/main.js"]
