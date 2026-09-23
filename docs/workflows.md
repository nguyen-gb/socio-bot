# Task workflow

```text
API request
  -> validate organization, account and idempotency key
  -> create Task in PostgreSQL
  -> start Temporal workflow
  -> wait until scheduledAt when present
  -> activity loads account/profile/proxy
  -> acquire Redis profile lease
  -> restore latest encrypted snapshot from object storage
  -> create TaskRun
  -> reserve local browser slot
  -> launch persistent Chromium context
  -> execute platform adapter
  -> close browser context
  -> archive, encrypt and persist the next profile snapshot version
  -> persist result
  -> release slot and profile lease
```

Login-required and unsupported actions are non-retry outcomes. Infrastructure failures are retried by Temporal up to the task-specific limit. An idempotency key is required so client retries do not create duplicate actions.

## Interactive login workflow

```text
operator -> create bounded login session
  -> Temporal activity acquires the profile lease
  -> restore snapshot and launch persistent Chromium
  -> register authenticated CDP screencast gateway
  -> operator completes login from the Admin UI
  -> worker confirms the platform session cookie
  -> close Chromium and save encrypted snapshot
  -> release browser slot and Redis lease
```

## Publication review workflow

Generic `PUBLISH_POST` tasks are created as `DRAFT/PENDING`. ADMIN/OWNER approval is audited but remains held; the generic connector is disabled.

Facebook group campaigns snapshot the account/group pairs and content into `DRAFT/PENDING` tasks. ADMIN/OWNER approves the whole campaign, scheduling each account's tasks at the configured interval. Workers recheck approval, cancellation, account/proxy state and profile lease before sending. Group writes have one send attempt; ambiguous outcomes require manual verification rather than automatic retry. See [facebook.md](facebook.md).
