# API summary

Facebook group endpoints and approval workflow: [Facebook feature guide](facebook.md).

All routes use the `/api` prefix.

## Authentication

- `POST /auth/login` with email, password and optional organization ID.
- `POST /auth/refresh` rotates an opaque refresh token.
- `POST /auth/logout` revokes a refresh token.
- `GET /auth/me` returns the token principal.

The browser dashboard stores tokens only in HTTP-only, SameSite=strict cookies. Direct API clients send `Authorization: Bearer <access-token>`. Internal services use `x-api-key` or `Authorization: Service <CONTROL_API_KEY>`; organization-scoped service calls also provide `x-organization-id`.

## Resources

- Accounts: `GET/POST /accounts`, `GET /accounts/:id`
- Proxies: `GET/POST /proxies`, `POST /proxies/:id/test`, `POST /proxies/:id/assign`, `POST /proxies/:id/release`
- Schedules: `GET/POST /schedules`, `GET/DELETE /schedules/:id`, `POST /schedules/:id/enable|disable|trigger`
- Media: `GET/POST /media`, `GET /media/:id`; multipart field name is `file`, maximum 25 MiB
- Tasks: `GET/POST /tasks`, `GET /tasks/:id`
- Publish review: `POST /tasks/:id/approve`, `POST /tasks/:id/reject`
- Interactive login: `POST/GET /accounts/:id/login-sessions`, `GET/DELETE /login-sessions/:id`

Mutation permissions are enforced by organization role. Operators may create tasks, upload media and run interactive login. Account/proxy management and publication approval require ADMIN or OWNER.
