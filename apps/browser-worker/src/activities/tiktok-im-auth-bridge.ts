import type { BrowserContext } from 'playwright';

const TIKTOK_IM_HOST = 'im-api-sg.tiktok.com';
const TIKTOK_IM_PATH = '/v2/message/get_by_user_init';

const AUTH_COOKIE_NAMES = new Set([
  'sessionid',
  'sessionid_ss',
  'sid_tt',
  'sid_tt_ss',
  'sid_guard',
  'uid_tt',
  'uid_tt_ss',
  'passport_auth_status',
  'passport_auth_status_ss',
  'multi_sids',
  'sid_ucp_v1',
  'ssid_ucp_v1',
  'tt_session_tlb_tag',
  'tt_csrf_token',
  'passport_csrf_token',
  'passport_csrf_token_default',
]);

const installedContexts = new WeakSet<BrowserContext>();

/**
 * TikTok's web IM SDK uses SESSION_AUTH. In a managed profile, the login
 * cookies can be host-only for www.tiktok.com even though the SDK sends its
 * protobuf request to im-api-sg.tiktok.com. Chrome then omits those cookies,
 * and the SDK receives InvalidToken (200005).
 *
 * Keep the profile's cookie jar unchanged. For the one first-party IM request
 * that needs it, fetch with the selected auth cookies in memory and fulfill the
 * original browser route with that response. The allowlist is deliberately
 * exact and values are never logged or persisted.
 */
export async function installTikTokImAuthBridge(context: BrowserContext): Promise<void> {
  if (installedContexts.has(context)) return;

  await context.route('**/v2/message/get_by_user_init**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname !== TIKTOK_IM_HOST || requestUrl.pathname !== TIKTOK_IM_PATH) {
      await route.fallback();
      return;
    }

    const hostCookies = (await context.cookies('https://www.tiktok.com'))
      .filter((cookie) => cookie.domain.replace(/^\./, '') === 'www.tiktok.com' && AUTH_COOKIE_NAMES.has(cookie.name));
    if (hostCookies.length === 0) {
      await route.fallback();
      return;
    }

    const headers = await route.request().allHeaders();
    const cookieValues = new Map<string, string>();
    for (const item of (headers.cookie ?? '').split(';')) {
      const separator = item.indexOf('=');
      if (separator > 0) cookieValues.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
    }
    for (const cookie of hostCookies) cookieValues.set(cookie.name, cookie.value);
    const cookie = [...cookieValues.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

    try {
      const response = await route.fetch({ headers: { ...headers, cookie } });
      await route.fulfill({ response });
    } catch {
      // Preserve the original request if TikTok closes the route while the
      // page is navigating. This avoids turning a transient abort into a
      // browser task failure.
      await route.fallback().catch(() => undefined);
    }
  });
  installedContexts.add(context);
}
