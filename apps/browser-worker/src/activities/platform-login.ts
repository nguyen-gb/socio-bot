import type { BrowserLocaleEnvironment, FingerprintEmulationOverrides, ManagedBrowserSession } from '@socio/browser-runtime';
import { clickPlatformReloadButton, gotoPlatformPage, waitForPlatformPageReady } from '@socio/platform-core';
import type { BrowserContext } from 'playwright';
import type { ProfileCredentials } from '../secrets/secrets.service';
import { classifyChallengePage } from './challenge-signals';

export const PLATFORM_LOGIN = {
  FACEBOOK: { home: 'https://www.facebook.com/', login: 'https://www.facebook.com/login/', authCookies: ['c_user'] },
  INSTAGRAM: { home: 'https://www.instagram.com/', login: 'https://www.instagram.com/accounts/login/', authCookies: ['sessionid'] },
  X: { home: 'https://x.com/home', login: 'https://x.com/i/flow/login', authCookies: ['auth_token'] },
  // TikTok profiles can be authenticated with either the legacy sessionid
  // pair or the sid/uid cookie family. Keep all first-party auth variants in
  // the check so a restored Chrome profile is not mistaken for an anonymous
  // session just because it does not contain the legacy pair.
  TIKTOK: {
    home: 'https://www.tiktok.com/en',
    login: 'https://www.tiktok.com/login',
    authCookies: ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_tt_ss', 'sid_guard', 'uid_tt', 'uid_tt_ss'],
  },
} as const;
export type SupportedPlatform = keyof typeof PLATFORM_LOGIN;

const PLATFORM_SESSION_ORIGINS: Record<SupportedPlatform, readonly string[]> = {
  FACEBOOK: ['https://www.facebook.com', 'https://facebook.com'],
  INSTAGRAM: ['https://www.instagram.com'],
  X: ['https://x.com', 'https://twitter.com'],
  TIKTOK: ['https://www.tiktok.com'],
};

/**
 * Return the first-party origins whose browser storage belongs to a platform
 * profile. The allowlist is shared by login and every automation action so a
 * profile does not silently lose origin state just because the action is not
 * TikTok.
 */
export function platformSessionStateOrigins(platform: SupportedPlatform): readonly string[] {
  return PLATFORM_SESSION_ORIGINS[platform];
}

type BrowserCookie = Parameters<BrowserContext['addCookies']>[0][number];

export interface PlatformSessionInitializationOptions {
  /** Explicit localized platform entry URL. */
  entryUrl?: string;
  /** Locale used to build a platform entry URL when entryUrl is omitted. */
  locale?: string;
  /** Do not redirect a direct-entry flow to the platform login route. */
  allowLoginFallback?: boolean;
  /** Do not submit stored credentials in a direct-entry flow. */
  allowPasswordLogin?: boolean;
}

export function profileLoginSettings(value: unknown): { credentialsRef?: string } {
  const metadata = asRecord(value);
  return typeof metadata.credentialsRef === 'string' ? { credentialsRef: metadata.credentialsRef } : {};
}

export function profileFingerprintSettings(value: unknown): FingerprintEmulationOverrides | undefined {
  const metadata = asRecord(value);
  const fingerprint = metadata.fingerprint;
  if (!fingerprint || typeof fingerprint !== 'object' || Array.isArray(fingerprint)) return undefined;
  // Locale selection was removed from the product. Normalize older
  // configured/native records at read time so existing profiles immediately
  // follow their proxy IP without requiring an edit or database migration.
  return { ...(fingerprint as FingerprintEmulationOverrides), localeMode: 'auto' };
}

export function proxyLocaleEnvironment(value: unknown): BrowserLocaleEnvironment | undefined {
  if (!value) return undefined;
  const proxy = asRecord(value);
  const languages = Array.isArray(proxy.languages)
    ? proxy.languages.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  if (proxy.status !== 'HEALTHY'
    || typeof proxy.locale !== 'string'
    || typeof proxy.timezoneId !== 'string'
    || languages.length === 0) {
    throw new Error('Proxy chưa có locale/languages/timezone hợp lệ. Hãy kiểm tra lại proxy.');
  }
  Intl.getCanonicalLocales(proxy.locale);
  for (const language of languages) Intl.getCanonicalLocales(language);
  new Intl.DateTimeFormat('en-US', { timeZone: proxy.timezoneId });
  return {
    locale: proxy.locale,
    languages,
    timezoneId: proxy.timezoneId,
    source: 'proxy-ip',
  };
}

function languageCode(locale?: string): string {
  return (locale?.split('-')[0] || 'en').toLowerCase();
}

function tiktokLocalePath(locale?: string): string {
  const language = languageCode(locale);
  return language === 'vi' ? 'vi-VN' : language;
}

export function platformHomeUrl(platform: SupportedPlatform, locale?: string): string {
  if (!locale) return PLATFORM_LOGIN[platform].home;
  const language = languageCode(locale);
  if (platform === 'TIKTOK') {
    const path = tiktokLocalePath(locale);
    return `https://www.tiktok.com/${path}${path === 'vi-VN' ? '/' : ''}`;
  }
  if (platform === 'FACEBOOK') {
    const region = locale?.split('-')[1]?.toUpperCase() ?? (language === 'vi' ? 'VN' : 'US');
    return `https://www.facebook.com/?locale=${encodeURIComponent(`${language}_${region}`)}`;
  }
  if (platform === 'INSTAGRAM') return `https://www.instagram.com/?hl=${encodeURIComponent(language)}`;
  return `https://x.com/home?lang=${encodeURIComponent(language)}`;
}

export function platformHomeUrlForProfile(platform: SupportedPlatform, metadata: unknown): string {
  const fingerprint = profileFingerprintSettings(metadata);
  return platformHomeUrl(platform, fingerprint?.localeMode === 'native' ? undefined : fingerprint?.locale);
}

function platformLoginUrl(platform: SupportedPlatform, locale?: string): string {
  if (!locale) return PLATFORM_LOGIN[platform].login;
  if (platform === 'TIKTOK') return `https://www.tiktok.com/${tiktokLocalePath(locale)}/login`;
  const language = languageCode(locale);
  if (platform === 'FACEBOOK') {
    const region = locale.split('-')[1]?.toUpperCase() ?? (language === 'vi' ? 'VN' : 'US');
    return `https://www.facebook.com/login/?locale=${encodeURIComponent(`${language}_${region}`)}`;
  }
  if (platform === 'INSTAGRAM') return `https://www.instagram.com/accounts/login/?hl=${encodeURIComponent(language)}`;
  if (platform === 'X') return `https://x.com/i/flow/login?lang=${encodeURIComponent(language)}`;
  return PLATFORM_LOGIN.X.login;
}

async function hasAuthCookie(session: ManagedBrowserSession, platform: SupportedPlatform): Promise<boolean> {
  const settings = PLATFORM_LOGIN[platform];
  return (await session.context.cookies(settings.home)).some((cookie: { name: string; value: string }) => settings.authCookies.includes(cookie.name as never) && !!cookie.value);
}

export async function isPlatformChallenged(
  session: ManagedBrowserSession,
  platform?: SupportedPlatform,
): Promise<boolean> {
  const url = session.page.url();
  // Route-only checks are fast and work even if the tab is no longer usable.
  if (classifyChallengePage({ url })) return true;
  try {
    // Query visible elements directly: the first matching element may be
    // hidden while another CAPTCHA iframe/dialog is visible.
    const widgetSelectors = [
      'iframe[src*="captcha" i]:visible',
      'iframe[src*="recaptcha" i]:visible',
      'iframe[src*="hcaptcha" i]:visible',
      'iframe[src*="challenges.cloudflare.com" i]:visible',
      'input[name="captcha_response"]:visible',
      '[class*="bdturing" i]:visible',
      '[id*="bdturing" i]:visible',
      ...(platform === 'TIKTOK' ? [
        '[data-e2e*="captcha" i]:visible',
        '[data-e2e*="bdturing" i]:visible',
      ] : []),
    ];
    const visibleWidget = await session.page.locator(widgetSelectors.join(',')).first().isVisible();
    if (visibleWidget) return true;
  } catch { /* A closed page cannot be inspected; never classify as verified. */ }
  try {
    const snapshot = await session.page.evaluate((platformName?: string) => {
      const visible = (element: Element) => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      };
      const foregroundText = [...document.querySelectorAll('h1,h2,[role="alert"],[role="dialog"]')]
        .filter(visible).slice(0, 8).map(element => (element as HTMLElement).innerText || '').join(' ').slice(0, 1200);
      const visibleChallengeText = platformName === 'TIKTOK'
        ? [...document.querySelectorAll<HTMLElement>([
          '[data-e2e*="captcha" i]',
          '[data-e2e*="verify" i]',
          '[class*="captcha" i]',
          '[class*="verify" i]',
          '[class*="bdturing" i]',
          '[id*="captcha" i]',
          '[id*="verify" i]',
          '[id*="bdturing" i]',
        ].join(','))]
          .filter(visible)
          .slice(0, 8)
          .map(element => `${element.innerText || ''} ${element.getAttribute('aria-label') || ''}`)
          .join(' ')
          .trim()
          .slice(0, 1200)
        : '';
      return { title: document.title, foregroundText, visibleChallengeText, bodyText: document.body?.innerText?.trim().slice(0, 401) ?? '' };
    }, platform);
    return classifyChallengePage({ url, ...snapshot }) !== null;
  } catch {
    return false;
  }
}

export async function isPlatformAuthenticated(session: ManagedBrowserSession, platform: SupportedPlatform): Promise<boolean> {
  let url: URL;
  try { url = new URL(session.page.url()); } catch { return false; }
  const baseHost = new URL(PLATFORM_LOGIN[platform].home).hostname.replace(/^www\./, '');
  if (url.hostname !== baseHost && !url.hostname.endsWith(`.${baseHost}`)) return false;
  if (/\/(login|checkpoint|challenge|captcha)(\/|$)/i.test(url.pathname) || await isPlatformChallenged(session, platform)) return false;
  // A TikTok document can retain the authenticated cookies while the actual
  // document has been replaced by its anti-bot/HTTP error surface. Treating
  // that shell as authenticated lets every action continue and later fail in
  // a misleading place (for example, an empty Inbox composer). Stop at the
  // session boundary so the operator gets a retry/login-required result.
  if (platform === 'TIKTOK' && await hasUnusableTikTokDocument(session)) return false;
  if (!(await hasAuthCookie(session, platform))) return false;
  if (await session.page.locator('input[type="password"]:visible').first().isVisible()) return false;
  if (platform === 'FACEBOOK') {
    if (await session.page.locator('input[name="email"]:visible,input[name="pass"]:visible').first().isVisible()) return false;
    // Do not mistake an imported c_user on an unloaded/login page for a valid session.
    return session.page.locator('[role="navigation"]:visible').first().isVisible();
  }
  return true;
}

async function hasUnusableTikTokDocument(session: ManagedBrowserSession): Promise<boolean> {
  try {
    return await session.page.evaluate(() => {
      const visible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0'
          && element.getClientRects().length > 0;
      };
      const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      const title = document.title ?? '';
      if (/access to (?:www\.)?tiktok\.com was denied|you don't have authorization to view this page|http error 403|err_http_response_code_failure/i.test(`${title} ${bodyText}`)) return true;
      if (/^please wait\.?$/i.test(bodyText) && !document.querySelector('[data-e2e], input, button, video')) return true;
      const hasRetry = [...document.querySelectorAll('button,a')]
        .filter(visible)
        .some(element => /refresh|try again|tải lại|thử lại/i.test((element as HTMLElement).innerText || element.getAttribute('aria-label') || ''));
      return hasRetry && /something went wrong|please try again later|page unavailable|không thể tải|đã xảy ra lỗi/i.test(bodyText);
    });
  } catch {
    return false;
  }
}

export async function initializePlatformSession(
  session: ManagedBrowserSession,
  platform: SupportedPlatform,
  credentials?: ProfileCredentials,
  options: PlatformSessionInitializationOptions = {},
): Promise<void> {
  const settings = PLATFORM_LOGIN[platform];
  if (!settings) throw new Error(`Unsupported login platform: ${String(platform)}`);
  // TikTok must always get the same cold-start route, including login and
  // follower/profile actions. The requested surface is opened by the action
  // only after this shared session/bootstrap step completes. Bootstrap starts
  // at /en and uses /vi-VN/ only as its fallback; the bare root is not used.
  const entryUrl = platform === 'TIKTOK'
    ? settings.home
    : options.entryUrl ?? platformHomeUrl(platform, options.locale);
  const allowLoginFallback = options.allowLoginFallback ?? (!options.entryUrl || Boolean(options.locale));
  // A localized home URL is still the normal login flow; only an explicit
  // direct-entry URL without a locale opts out of password submission.
  const allowPasswordLogin = options.allowPasswordLogin ?? (!options.entryUrl || Boolean(options.locale));
  const fallbackUrl = platform === 'TIKTOK' && allowLoginFallback ? platformLoginUrl(platform, options.locale) : undefined;
  // Prefer the latest browser session over potentially stale imported credentials.
  // Legacy snapshots have no session-cookie sidecar, so seed missing auth cookies.
  let importedCookies = false;
  if (credentials?.cookies && !(await hasAuthCookie(session, platform))) {
    try { await session.context.addCookies(parseCookieInput(credentials.cookies, settings.home)); importedCookies = true; }
    catch { /* Invalid imports must not prevent password/manual fallback. */ }
  }
  await gotoPlatformEntryPage(session, platform, entryUrl, fallbackUrl);
  await waitForLoginPage(session, platform);
  if (await isPlatformChallenged(session, platform) || await isPlatformAuthenticated(session, platform)) return;
  if (credentials?.cookies && !importedCookies) {
    try {
      const cookies = parseCookieInput(credentials.cookies, settings.home);
      await session.context.addCookies(cookies);
      // TikTok may have reached /vi-VN/ after /en failed. Applying a newer
      // cookie snapshot must refresh that successful document in place; a
      // second bootstrap would incorrectly navigate /vi-VN/ back to /en.
      if (platform === 'TIKTOK') await reloadTikTokEntryPageOnce(session.page);
      else await gotoPlatformEntryPage(session, platform, entryUrl, fallbackUrl);
      await waitForLoginPage(session, platform);
    } catch { /* A stale/invalid import must not suppress password/manual fallback. */ }
    if (await isPlatformChallenged(session, platform) || await isPlatformAuthenticated(session, platform)) return;
  }
  if (allowPasswordLogin && credentials?.login && credentials.password) {
    if (!session.page.url().includes('/login')) {
      await gotoPlatformPage(session.page, settings.login);
    }
    await attemptPasswordLogin(platform, session, { login: credentials.login, password: credentials.password });
    await waitForLoginPage(session, platform);
  }
}

async function gotoPlatformEntryPage(
  session: ManagedBrowserSession,
  platform: SupportedPlatform,
  entryUrl: string,
  fallbackUrl?: string,
): Promise<void> {
  // TikTok's localized entry can hand the document to its feed route while
  // Chromium is still waiting for DOMContentLoaded. That client-side handoff
  // is reported as ERR_ABORTED at /foryou even though the requested navigation
  // was the requested URL. Use commit for this first navigation and accept the race
  // without requiring the resulting document to remain on a particular route;
  // never navigate to /foryou ourselves.
  if (platform === 'TIKTOK') {
    await gotoTikTokEntryPage(session.page);
    return;
  }
  await gotoPlatformPage(session.page, entryUrl, fallbackUrl);
}

async function gotoTikTokEntryPage(page: ManagedBrowserSession['page']): Promise<void> {
  const entryUrls = ['https://www.tiktok.com/en', 'https://www.tiktok.com/vi-VN/'] as const;
  let lastError: unknown;
  for (const target of entryUrls) {
    try {
      let navigationError: unknown;
      try {
        await page.goto(target, { waitUntil: 'commit', timeout: 45_000 });
      } catch (error) {
        navigationError = error;
      }

      // TikTok can replace the localized document with /foryou while Chromium is
      // still resolving page.goto(). Only that known client-side navigation
      // race counts as a successful entry; every real /en failure falls
      // through to /vi-VN/ without navigating to the bare root.
      if (navigationError) {
        const message = navigationError instanceof Error ? navigationError.message : String(navigationError);
        const navigationRace = /ERR_ABORTED|interrupted by another navigation/i.test(message);
        const navigationTimedOut = /Timeout \d+ms exceeded|Navigation timeout/i.test(message);
        const httpResponseFailure = /ERR_HTTP_RESPONSE_CODE_FAILURE|HTTP ERROR 403/i.test(message);
        if (httpResponseFailure) {
          // Apply the same one-shot browser reload used by profile/video/search
          // surfaces before abandoning /en for /vi-VN/. Chromium's error page
          // may temporarily expose chrome-error:// while Ctrl+R still retries
          // the original requested URL.
          await reloadTikTokEntryPageOnce(page);
          if (await hasUnusableTikTokEntryDocument(page)) throw navigationError;
          return;
        }
        // Chromium can finish and display the requested TikTok document while
        // Playwright is still waiting for the commit notification. Accept that
        // timeout only when the browser is demonstrably on a usable TikTok
        // entry; a timeout on about:blank/error still falls through to vi-VN.
        if ((!navigationRace && !navigationTimedOut) || !isTikTokUsableEntrySurface(page.url())) throw navigationError;
      }

      await waitForPlatformPageReady(page);
      if (await hasUnusableTikTokEntryDocument(page)) throw new Error(`TikTok không tải được trang bắt đầu: ${target}`);

      // Required bootstrap sequence: once the selected entry is confirmed as
      // usable, reload that current document exactly once before campaigns
      // continue. A failed /en reload may fall back to /vi-VN/.
      await reloadTikTokEntryPageOnce(page);
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout?.(350);
    }
  }
  if (lastError) throw lastError;
  throw new Error('TikTok không mở được trang bắt đầu');
}

async function reloadTikTokEntryPageOnce(page: ManagedBrowserSession['page']): Promise<void> {
  // Prefer the Reload control rendered by Chromium's error document. A
  // healthy TikTok document has no DOM access to Chrome's toolbar, so use the
  // browser's cross-platform Ctrl+R command instead of page.reload().
  if (await clickPlatformReloadButton(page, { timeoutMs: 45_000 })) {
    if (await hasUnusableTikTokEntryDocument(page)) {
      throw new Error(`TikTok không tải được sau khi reload: ${page.url()}`);
    }
    return;
  }

  try {
    await page.keyboard.press('Control+R');
    // Give Chromium a short window to start replacing the old document. From
    // this point the current document's readyState is authoritative: it maps
    // directly to the toolbar spinner changing back to the Reload icon. Do not
    // require a navigation event, timeOrigin change or marker disappearance;
    // TikTok/Chromium can preserve those signals even though the visible page
    // has already completed.
    await page.waitForTimeout(500);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const navigationRace = /ERR_ABORTED|interrupted by another navigation/i.test(message);
    if (!navigationRace || !isTikTokUsableEntrySurface(page.url())) throw error;
  }
  await waitForPlatformPageReady(page);
  if (await hasUnusableTikTokEntryDocument(page)) {
    throw new Error(`TikTok không tải được sau khi reload: ${page.url()}`);
  }
}

function isTikTokUsableEntrySurface(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hostname !== 'www.tiktok.com') return false;
    return url.pathname === '/en' || url.pathname === '/en/' || url.pathname === '/vi-VN' || url.pathname === '/vi-VN/' || url.pathname === '/foryou' || url.pathname === '/foryou/';
  } catch {
    return false;
  }
}

async function hasUnusableTikTokEntryDocument(page: ManagedBrowserSession['page']): Promise<boolean> {
  if (!page.evaluate) return false;
  try {
    return await page.evaluate(() => {
      const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      const title = document.title ?? '';
      if (/access to (?:www\.)?tiktok\.com was denied|you don't have authorization to view this page|http error 403|err_http_response_code_failure/i.test(`${title} ${bodyText}`)) return true;
      if (/^please wait\.?$/i.test(bodyText) && !document.querySelector('[data-e2e], input, button, video')) return true;
      const hasRetry = [...document.querySelectorAll('button,a')]
        .some(element => /refresh|try again|tải lại|thử lại/i.test((element as HTMLElement).innerText || element.getAttribute('aria-label') || ''));
      return hasRetry && /something went wrong|please try again later|page unavailable|không thể tải|đã xảy ra lỗi/i.test(bodyText);
    });
  } catch {
    return false;
  }
}

async function waitForLoginPage(session: ManagedBrowserSession, platform: SupportedPlatform): Promise<void> {
  if (platform !== 'FACEBOOK') { await session.page.waitForTimeout(1500); return; }
  await session.page.locator('[role="navigation"]:visible,input[name="email"]:visible,input[name="pass"]:visible,iframe[src*="captcha"]:visible,input[name="captcha_response"]:visible')
    .first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);
}

async function attemptPasswordLogin(platform: SupportedPlatform, session: ManagedBrowserSession, credentials: { login: string; password: string }): Promise<void> {
  const page = session.page;
  try {
    if (platform === 'FACEBOOK') {
      await page.locator('input[name="email"]').fill(credentials.login);
      await page.locator('input[name="pass"]').fill(credentials.password);
      await page.locator('button[name="login"]').click();
    } else if (platform === 'INSTAGRAM') {
      await page.locator('input[name="username"]').fill(credentials.login);
      await page.locator('input[name="password"]').fill(credentials.password);
      await page.locator('button[type="submit"]').click();
    } else if (platform === 'X') {
      const login = page.locator('input[autocomplete="username"]').first();
      await login.waitFor({ state: 'visible', timeout: 15_000 });
      await login.fill(credentials.login);
      await login.press('Enter');
      const password = page.locator('input[name="password"]').first();
      await password.waitFor({ state: 'visible', timeout: 15_000 });
      await password.fill(credentials.password);
      await password.press('Enter');
    } else {
      const login = page.locator('input[name="username"],input[type="text"]').first();
      await login.waitFor({ state: 'visible', timeout: 15_000 });
      await login.fill(credentials.login);
      await page.locator('input[type="password"]').first().fill(credentials.password);
      await page.locator('input[type="password"]').first().press('Enter');
    }
  } catch { /* Leave challenge/unrecognized forms for the operator. */ }
}

export function parseCookieInput(input: string, targetUrl: string): BrowserCookie[] {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Cookie input is empty');
  if (!trimmed.startsWith('[')) return trimmed.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const separator = part.indexOf('=');
    if (separator <= 0) throw new Error('Invalid cookie header');
    return { name: part.slice(0, separator).trim(), value: part.slice(separator + 1).trim(), url: targetUrl };
  });
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('Cookie JSON must be a non-empty array');
  const targetHost = new URL(targetUrl).hostname;
  return parsed.map(entry => {
    const cookie = asRecord(entry);
    if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string') throw new Error('Every cookie requires string name and value');
    const domain = typeof cookie.domain === 'string' ? cookie.domain : undefined;
    if (domain) {
      const normalized = domain.replace(/^\./, '').toLowerCase();
      if (targetHost !== normalized && !targetHost.endsWith(`.${normalized}`)) throw new Error(`Cookie domain ${domain} does not match ${targetHost}`);
    }
    const sameSite = cookie.sameSite === 'Strict' || cookie.sameSite === 'Lax' || cookie.sameSite === 'None' ? cookie.sameSite : undefined;
    return {
      name: cookie.name, value: cookie.value,
      ...(domain ? { domain, path: typeof cookie.path === 'string' ? cookie.path : '/' } : { url: targetUrl }),
      ...(typeof cookie.expires === 'number' ? { expires: cookie.expires } : {}),
      ...(typeof cookie.httpOnly === 'boolean' ? { httpOnly: cookie.httpOnly } : {}),
      ...(typeof cookie.secure === 'boolean' ? { secure: cookie.secure } : {}),
      ...(sameSite ? { sameSite } : {}),
    } satisfies BrowserCookie;
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
