# Operations runbook

## Required production secrets

- `CONTROL_API_KEY`: internal service credential, at least 24 characters.
- `ACCESS_TOKEN_SECRET`: independent HMAC key, at least 32 characters.
- `REMOTE_SESSION_SECRET`: independent HMAC key, at least 32 characters.
- `PROFILE_ENCRYPTION_KEY`: base64-encoded random 32-byte AES key. It encrypts browser snapshots, per-profile session-cookie state, and account/proxy credentials submitted through the dashboard. Losing it makes those values unrecoverable.
- `BOOTSTRAP_ADMIN_PASSWORD`: only used by the explicit seed command.

Generate the profile key with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Do not rotate `PROFILE_ENCRYPTION_KEY` until existing snapshots have been re-encrypted.

## Health and metrics

### Local Windows startup

From the repository directory, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-local.ps1 -SkipMigrate
```

Use `-InfrastructureOnly` to start/check only PostgreSQL, Redis and Temporal without launching applications. PostgreSQL is launched through a detached hidden `pg_ctl` process; Ctrl+C stops the application terminal, not the database. The script uses `pg_isready`, not just TCP, and verifies API readiness when the application ports are already open.

Check `http://localhost:3001/api/health/ready` before using the dashboard. `/health/live` only confirms that the API process is alive; it can return 200 while the database is unavailable. PostgreSQL logs are in `.local/logs/postgres.log`. Do not delete `postmaster.pid` or reset/reinitialize the data directory to repair a busy port. First determine whether the cluster is running or has a verified orphan child; do not stop unrelated PostgreSQL services.

- API liveness: `GET /api/health/live`
- API readiness: `GET /api/health/ready`
- API Prometheus metrics: `GET /api/metrics` (internal API key only)
- Worker liveness: `GET :3010/health`
- Worker metrics: `GET :3010/metrics`

Application logs are newline-delimited JSON. Propagate `x-request-id` from the ingress; the API generates one when absent and returns it in the response.

The optional Compose monitoring profile exposes Grafana (`127.0.0.1:3002`) and Prometheus (`127.0.0.1:9090`) only on localhost. Loki has no host port and requires a tenant header. API and browser-worker logs use separate volumes so their non-root runtime users retain write access; Promtail mounts both volumes read-only. Create `secrets/control-api-key` with the exact control key before starting the profile.

## Scaling

The Kubernetes base under `infra/k8s/` uses managed PostgreSQL, Redis, Temporal and S3, non-root containers, HPA, PDB, TLS ingress and ingress isolation. Run the migration Job before rolling out the API. Worker scale-out requires `REMOTE_SESSION_REDIS_RELAY=true`; keep Redis private and authenticated in production.

## Backup and restore

Back up PostgreSQL and the object-storage volume together. Profile snapshot rows reference immutable encrypted objects by URI and version. Test restore regularly using a copy of both stores and the production profile encryption key.

## Incident response

1. Drain workers and stop new task creation.
2. Revoke affected refresh tokens and rotate access/remote-session secrets.
3. Rotate platform credentials at the platform provider.
4. Preserve audit logs and failure artifacts according to the retention policy.
5. Resume with a single canary worker before restoring full capacity.

## External publishing boundary

Reviewed Facebook group join/text-post campaigns are enabled separately from the generic connector. See [facebook.md](facebook.md). Test on authorized groups before use; questions, CAPTCHA, account restrictions and ambiguous outcomes require manual action.

`PUBLISH_POST` requests require ADMIN approval and remain held as `DRAFT`. This repository does not send them to an external platform by default. Enabling a real connector requires explicit authorization for the target Page/account, a platform-issued token supplied through a secret provider, and a staging verification before production dispatch.
