# Review browser fingerprint, proxy and challenge handling (2026-10-13)

## Scope

Reviewed the supplied Socio Bot source: Playwright browser runtime,
interactive login, background task execution, account statuses, proxy
connectivity, worker settings, and TikTok challenge fixture mode. This change
set strengthens normal browser operation and challenge handling. It does not
implement fingerprint deception, hidden automation indicators, TLS/JA3/JA4
spoofing, proxy rotation to evade restrictions, CAPTCHA-solving services, or
CAPTCHA token injection.

## Findings and changes

| Finding | Existing behavior | Change |
|---|---|---|
| Challenge false positives | `isPlatformChallenged()` matched words including `robot`, `captcha` and `xác minh` anywhere in `document.body.innerText`, including ordinary posts | A conservative classifier checks checkpoint URLs, visible challenge widgets, page titles, primary visible messages and short challenge interstitials; normal long feeds are not treated as challenges |
| Hidden first widget | The code checked `.first().isVisible()` on a mixed selector, which could be false when the first widget was hidden but the next was visible | Use `:visible` on the selectors *before* selecting the first matching element |
| Verification after an action | An adapter could return success after navigating onto a challenge page | Re-check the resulting page after adapter execution and set `accountChallenged` + `requiresAction`, triggering existing `CHALLENGED` / `REQUIRES_ACTION` state transitions; retain failure artifacts |
| Invalid locale or timezone | Malformed `BROWSER_LOCALE` or `BROWSER_TIMEZONE_ID` was only rejected during browser launch | Validate values at worker startup with `Intl` before work begins |
| Documentation mismatch | Operations text claimed anonymous search sent a DNT header, while runtime deliberately did not | Corrected the operations runbook |

## Existing controls retained

- Persistent Chromium profiles and encrypted session-cookie sidecars; don't alter existing cookie restoration or snapshot semantics.
- One-profile-at-a-time lease and active-session protection; don't rotate identities or proxy addresses.
- Authenticated actions remain blocked when login is required or verification has been detected.
- Explicit approval for external posting, and protection against replay of uncertain sends.
- TikTok `success`, `empty`, and `challenge` fixture scenarios outside production.
- Manual interactive browser verification. Operator resumes a task only after the platform confirms the account is usable.

## Test status

- Seven isolated classifier scenarios were compiled and executed with the locally available TypeScript compiler and Node.js: passed.
- Syntax/transpilation checks completed for all six modified/added TypeScript files: passed.
- The full monorepo suite was **not run**: `pnpm@10.15.1` was not present in the environment, and the runtime was unable to download it from the package registry. This is **not** a claim of full integration validation.
- No live third-party CAPTCHA, anti-bot defenses, or sessions were exercised.

## Recommended verification in an authorized staging environment

1. `corepack pnpm install --frozen-lockfile`
2. `corepack pnpm --filter @socio/browser-worker typecheck`
3. `corepack pnpm --filter @socio/browser-worker test`
4. Run a normal authenticated session with harmless fixture pages: no challenge should be reported merely because a page talks about CAPTCHA.
5. Run a staging challenge fixture: expect `CHALLENGED`, `REQUIRES_ACTION`, failure artifacts, and no automatic replay of an uncertain external action.
6. Test locale/timezone values as valid and invalid inputs before starting workers.

## Limitations

Platform markup changes often. Any non-bypassing DOM detector can miss new
verification interfaces, especially cross-origin iframe and blank HTTP-403/429
screens; evidence from network logs and interactive viewing remains necessary.
No claim is made that these changes defeat CAPTCHA or prevent third-party rate
limits, account restrictions, or anti-bot challenges.
