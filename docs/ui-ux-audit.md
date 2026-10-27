# Socio Bot admin UI/UX audit

Audit date: 2026-10-22  
Scope: `apps/web/app` admin UI, shared Ant Design configuration, global styling, and browser session workflow.

## Baseline

- Next.js 16.3.4 App Router with React 19.2.8.
- Ant Design 6.6.3 with `@ant-design/cssinjs` 2.1.2.
- Server-side style extraction remains in `app/style-registry.tsx` and is mounted from `app/layout.tsx`.
- The working tree contained pre-existing changes outside the UI scope. Those files were left untouched.
- The web package typecheck passed before and after this UI pass. A restricted baseline test/build attempt was blocked by Node `spawn EPERM`; the same checks were rerun with the required process permission and passed.

## Route inventory

The dashboard is a single protected shell. The hash is the existing navigation state, so these are intentionally documented as views rather than separate Next routes.

| Route / view | Purpose | Primary UI family | Audit status | Verification status |
| --- | --- | --- | --- | --- |
| `/login` | Authentication | Split sign-in form, validation, error feedback | Refined | Typechecked; browser smoke exists |
| `/` / `#overview` | Operational overview | Metrics, active sessions, setup checklist | Refined | Existing dashboard smoke covers desktop/mobile |
| `/` / `#accounts` | Browser profiles | Search/filter table, create/edit credential and fingerprint modal | Refined | Existing smoke covers create/edit/error/viewer flows |
| `/` / `#proxies` | Proxy infrastructure | Search table, health checks, assignment and credential modal | Refined | Existing smoke covers assignment/credentials |
| `/` / `#facebook` | Facebook automation | Summary, action toolbar, campaigns/groups/collections, review dialogs | Refined | Existing dashboard smoke reaches route; dedicated interaction coverage remains limited |
| `/` / `#tiktok` | TikTok automation | Campaign table, search/report modal, approval and action dialogs | Refined | `scripts/tiktok-ui-smoke.mjs` covers report/approval/create/mobile |
| `/` / `#schedules` | Scheduled operations | Create modal, schedule table, enable/run/delete confirmations | Refined | Existing dashboard smoke covers create and confirmation |
| `/` / `#tasks` | Operational task queue | Status filter, progress/result details, approval controls | Refined | Existing dashboard smoke covers filtering and permission states |
| `/sessions/[sessionId]` | Remote browser session | Browser tabs, URL bar, live frame, keyboard controls, close flow | Refined | Existing smoke covers ended-session and no-spinner state |

API route handlers under `app/api/**` are implementation endpoints rather than standalone admin pages. Their request/response contracts were not changed by this UI pass.

## Findings and remediation

| ID | Severity | Finding | Remediation / status |
| --- | --- | --- | --- |
| UI-01 | P1 | Theme decisions were embedded directly in `Providers`, while feature styles independently repeated colors, dimensions, and surfaces. | Added `app/design-system.ts` and made `socioTheme` the single `ConfigProvider` theme. Added shared CSS variables for surfaces, borders, focus, radii, and shadows. Done. |
| UI-02 | P1 | Section headings, icon action buttons, and status-tag color rules were duplicated across dashboard, Facebook, TikTok, and session views. | Added `app/admin-ui.tsx` with `PageSectionTitle`, `ActionButton`, and `StatusTag`; migrated the affected route families. Done. |
| UI-03 | P1 | API failures were announced through a toast but did not remain visible in the page context. | Dashboard now keeps a retryable inline connection note visible while a query is failed, while retaining the toast for first-notice feedback. Done. |
| UI-04 | P1 | Long form workflows and result dialogs need a bounded scroll area and stable footer on small screens. | Existing modal body/footer rules and TikTok result footer behavior were retained and documented; representative smoke coverage exists at 360/390/768px. Done for the current workflows. |
| UI-05 | P2 | Tables contain dense operational data and need a predictable overflow strategy. | Ant Table sizing is centralized; feature tables use internal horizontal scrolling and responsive toolbars. Done. |
| UI-06 | P2 | Navigation needed stronger semantics for screen-reader users. | Main navigation has an accessible label, active items expose `aria-current`, refresh status is announced through a live region, and icon-only actions retain accessible labels/tooltips. Done. |
| UI-07 | P2 | Feature workspaces still contain some justified inline layout styles and feature-specific selectors. | Kept business-specific layout close to the feature; shared visual primitives are now centralized. Further extraction is optional follow-up, not a blocker. |
| UI-08 | P3 | The working tree has many unrelated backend/worker changes, making a full-repository visual regression claim unsafe. | UI changes were isolated to `apps/web/app/**` and this audit document. Full monorepo checks remain separately attributable. Done. |
| UI-09 | P2 | The top-level Content view duplicated the media workflow without being an operational destination, while long task errors expanded table rows uncontrollably. | Removed the redundant `#media` navigation/view. Media upload and selection remain contextual in campaign composers; task detail now has bounded, clamped error text with the full value available on hover. Done. |
| UI-10 | P2 | Facebook and TikTok campaign tables exposed different columns, action labels, and small fixed page sizes, making execution and result review inconsistent. | Standardized both campaign tables to the same columns and action vocabulary, added shared run/retry/result affordances, unified Facebook result viewing with the TikTok-style modal, fixed the action column to the right edge, and introduced shared 20/50/100 page-size options with a 10-row option. Done. |
| UI-11 | P0 | Proxy connectivity and quality were conflated, so a reachable proxy with high latency could look healthy; approved campaigns with zero tasks also looked complete. | Proxy status now says “Kết nối được” while latency is formatted as seconds and highlighted when slow. Campaigns with no allocated tasks show “Chưa có tác vụ” and a separate status instead of 0/0 completion. Done. |
| UI-12 | P0/P1 | Task details could make rows very tall and filters were limited to status, while full execution context was hard to inspect. | Error summaries are clamped to two lines; task filters now cover status, action, profile, and date range; a task drawer exposes account, approval, campaign, full error text, and latest run result. Done. |
| UI-13 | P1 | Overview onboarding banner and campaign creation toolbars competed with operational content and presented too many equal-weight actions. | Completed setup collapses to a compact ready strip; Facebook/TikTok use one primary “Tạo chiến dịch” menu with typed actions; TikTok summary prioritizes running, failed, and completed campaigns. Done. |

## Design system decisions

- Primary color remains the established restrained green (`#217a67`); no new brand palette was invented.
- Layout uses warm neutral surfaces, subtle borders, limited shadows, and 8/12px control/card radii.
- Control heights are 32/40/48px for small/default/large interactions.
- Tables use a muted header surface, 14px vertical cell rhythm, and internal horizontal scrolling where columns require it.
- Operational tables use a 20-row default with shared 10/20/50/100 page-size choices; detail columns stay short and open full context in a drawer or result dialog.
- Status semantics are consistent: green for healthy/success, blue for active/queued, orange for attention/pending, and red for failure/closed-risk states.
- Focus remains visible with a shared green focus ring; reduced-motion behavior remains enabled in global CSS.
- Ant Design remains the only component library. Existing custom SVG icons remain in `app/ui.tsx`.

## Verification checklist

The following reflects the current evidence, not assumptions:

- [x] App Router, protected shell, shared providers, and CSS-in-JS registry inspected.
- [x] All user-facing admin routes and hash views inventoried.
- [x] Ant Design theme centralized without changing the SSR registry.
- [x] Shared page headings, action buttons, and status tags migrated.
- [x] Dashboard query failures have a persistent retry affordance.
- [x] Navigation and icon-only controls retain accessible names.
- [x] Web package typecheck passes after the refactor.
- [x] Web package Node tests pass (6 tests).
- [x] Production build passes and generates the expected App Router route list.
- [x] Fixture-based dashboard smoke passes across navigation, forms, permissions, API errors, ended sessions, login, and 768/390/360px viewports.
- [x] Fixture-based TikTok smoke passes across report, approval, create flow, and mobile no-overflow.
- [ ] Live-backend media upload and destructive workflows verified against a real service; smoke fixtures intentionally intercept API writes.
- [ ] Full visual review at exactly 375px and 1440px rerun after the refactor.

## Follow-up recommendations

1. Add a dedicated Facebook smoke script or split the broad dashboard smoke into route-family suites.
2. Run Playwright smoke tests in an environment that permits child-process spawning and capture fresh screenshots from this revision.
3. Keep new feature pages on `socioTheme` and `admin-ui.tsx`; avoid introducing page-local status maps or icon-only buttons without labels.
4. Consider moving the longest Facebook action workflows to dedicated pages or drawers if their form length continues to grow; preserve the current API and approval semantics. Keep media upload and selection contextual to those workflows rather than reintroducing a standalone library tab.
