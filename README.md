# Socio

Server-side multi-account automation foundation built with NestJS, Temporal, Playwright and Chromium.

## Repository

```text
apps/api                    NestJS control API
apps/web                    Next.js admin dashboard
apps/browser-worker         Temporal + Playwright execution worker
packages/contracts          Runtime schemas and TypeScript contracts
packages/database           Prisma schema, migration and client
packages/browser-runtime    Persistent Chromium and browser slots
packages/platform-core      Platform adapter contracts
packages/facebook-adapter   Facebook health/session and group automation adapter
packages/web-platform-adapters Instagram/X/TikTok health/profile adapters
packages/temporal-workflows Durable task workflows
packages/object-storage     Local/S3 objects and encrypted profile snapshots
packages/remote-session-auth Short-lived remote browser access tokens
```

## Local setup

Requirements: Node.js 20.19+, pnpm 10 and Docker with Compose.

1. Copy `.env.example` to `.env` and replace every `replace-with-*` value.
2. Install dependencies with `corepack pnpm install`.
3. Start infrastructure with `docker compose up -d postgres redis temporal temporal-ui minio`.
4. Run `corepack pnpm --filter @socio/database prisma:deploy` and `corepack pnpm --filter @socio/database prisma:seed`.
5. Start applications with `corepack pnpm dev`.

Admin: `http://localhost:3000`  
API liveness: `http://localhost:3001/api/health/live`  
Temporal UI: `http://localhost:8080`  
MinIO console: `http://localhost:9001`

The seeded development login is `owner@socio.local` with the value of
`BOOTSTRAP_ADMIN_PASSWORD`.

To build all application containers:

```sh
docker compose --profile app up --build
```

For local monitoring, place the exact `CONTROL_API_KEY` value in
`secrets/control-api-key`, set `GRAFANA_ADMIN_PASSWORD`, then run:

```sh
docker compose --profile app --profile monitoring up --build
```

Grafana and Prometheus bind only to localhost on ports 3002 and 9090. Loki is
reachable only on the private Compose monitoring network. Kubernetes manifests
and operational prerequisites are in `infra/k8s/`.

## Implemented scope

The V1 control and execution planes include organization-scoped JWT/RBAC,
rotating refresh tokens, audit logs, account/profile/proxy/media records,
idempotent Temporal tasks, distributed profile leases, browser slot limits,
interactive short-lived remote login, encrypted versioned profile snapshots,
before/after/failure screenshots, sanitized HAR and console artifacts,
failure Playwright traces, recurring Temporal schedules, Redis WebSocket relay,
health checks and Prometheus/Grafana/Loki observability.

Facebook now supports group inventory sync, joining a list of group links and
text posts to all or N joined groups per account. Account selection, frozen
campaign drafts, ADMIN review, spacing, cancellation and per-target results are
available in the Facebook workspace. See [docs/facebook.md](docs/facebook.md).

Generic `PUBLISH_POST` requests remain held; only explicitly reviewed Facebook
group campaign actions are enabled for external writes. Real Facebook behavior
must be checked on authorized test groups before campaign use.
