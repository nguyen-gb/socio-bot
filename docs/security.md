# Security baseline

- Human users authenticate with scrypt password hashes, short-lived signed access tokens and rotating opaque refresh tokens stored in HTTP-only SameSite cookies by the Next.js BFF.
- Organization membership and OWNER/ADMIN/OPERATOR/VIEWER role checks are enforced by the API. A user cannot override the organization embedded in an access token.
- `CONTROL_API_KEY` is restricted to trusted service-to-service traffic. It must not be exposed to the browser.
- Proxy credentials resolve from `env://NAME` or a traversal-safe `file://relative/path` below `SECRET_ROOT`; the database stores only the reference.
- Do not write credentials, cookies, browser snapshots or proxy authentication into logs.
- Persistent profiles are archived and encrypted with AES-256-GCM before each immutable snapshot is stored. Local encrypted object storage is the default; S3 is opt-in only.
- Failure screenshots may contain sensitive page content. Restrict the object-storage volume and apply an explicit retention policy.
- The CDP gateway accepts only normalized click/text/key commands and requires a scoped, short-lived HMAC token. Raw CDP is never exposed to the browser client.
- Login endpoints are rate limited. Mutations are written to the organization audit log.
- Facebook group writes require ADMIN/OWNER approval of fixed account/group targets. URL validation restricts destinations to HTTPS Facebook group pages. Approval and task state are rechecked before execution; uncertain writes are never resent automatically. Membership questions and CAPTCHA require manual action.
