# Socio V1 architecture

Socio is split into two planes:

- **Control plane:** Next.js Admin, NestJS API, PostgreSQL, Redis, Temporal and object storage.
- **Execution plane:** independent TypeScript workers that own Playwright/Chromium processes.

The API never launches a browser from an HTTP request. It persists an idempotent task and starts a durable Temporal workflow. A worker reserves capacity, obtains a distributed profile lease, restores the latest encrypted profile snapshot, opens the persistent Chromium profile, executes a platform adapter, closes Chromium, writes a new immutable snapshot and records the result.

## Invariants

1. One platform account owns one browser profile.
2. Only one worker may lease a profile at a time.
3. Tasks for an account are serialized by the profile lease.
4. Credentials and browser state are not stored as plaintext database fields.
5. Browser endpoints are never exposed without authentication.
6. Official platform APIs are preferred where they support the required operation.

## Browser login path

An operator creates a bounded login session through the API. Temporal assigns it to a worker, which exposes JPEG screencast frames and normalized keyboard/mouse commands through a short-lived HMAC-authenticated WebSocket. With multiple worker pods, a Redis pub/sub relay carries only validated commands and frames to the owning worker; the access token is never relayed. Authentication is confirmed from the Facebook `c_user` cookie. The browser closes on success, expiry or operator request and the profile is snapshotted before its distributed lease is released.

Temporal Schedule owns recurring timing. Each occurrence materializes an idempotent Task before execution. Health/profile tasks dispatch to the normal worker queue; recurring publish occurrences become approval drafts and never bypass human review.

## V1 boundaries

Facebook, Instagram, X and TikTok implement the same adapter contract for health/profile checks. Facebook additionally supports joined-group inventory, reviewed group-join campaigns and reviewed text-post campaigns with account selection and fixed destinations. Generic `PUBLISH_POST` remains disabled. Future platform actions belong in their platform adapter and workspace feature module. Anti-detection, fingerprint spoofing and CAPTCHA bypass are out of scope. See [facebook.md](facebook.md).

See [workflows.md](./workflows.md), [security.md](./security.md), [api.md](./api.md) and [operations.md](./operations.md).
