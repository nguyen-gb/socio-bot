import type { ManagedBrowserSession } from '@socio/browser-runtime';
import { gotoPlatformPage } from '@socio/platform-core';
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
    home: 'https://www.tiktok.com/',
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
  /** Legacy option retained for callers; TikTok always starts at its root. */
  entryUrl?: string;
  /** Do not redirect a direct-entry flow to the platform login route. */
  allowLoginFallback?: boolean;
  /** Do not submit stored credentials in a direct-entry flow. */
  allowPasswordLogin?: boolean;
}

export function profileLoginSettings(value: unknown): { credentialsRef?: string } {
  const metadata = asRecord(value);
  return typeof metadata.credentialsRef === 'string' ? { credentialsRef: metadata.credentialsRef } : {};
}

async function hasAuthCookie(session: ManagedBrowserSession, platform: SupportedPlatform): Promise<boolean> {
  const settings = PLATFORM_LOGIN[platform];
  return (await session.context.cookies(settings.home)).some(cookie => settings.authCookies.includes(cookie.name as never) && !!cookie.value);
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
  // only after this shared session/bootstrap step completes.
  const entryUrl = platform === 'TIKTOK' ? settings.home : options.entryUrl ?? settings.home;
  const allowLoginFallback = options.allowLoginFallback ?? !options.entryUrl;
  const allowPasswordLogin = options.allowPasswordLogin ?? !options.entryUrl;
  const fallbackUrl = platform === 'TIKTOK' && allowLoginFallback ? settings.login : undefined;
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
      await gotoPlatformEntryPage(session, platform, entryUrl, fallbackUrl);
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
  // TikTok's root entry can hand the document to its feed route while
  // Chromium is still waiting for DOMContentLoaded. That client-side handoff
  // is reported as ERR_ABORTED at /foryou even though the requested navigation
  // was the root URL. Use commit for this first navigation and accept the race
  // without requiring the resulting document to remain on a particular route;
  // never navigate to /foryou ourselves.
  if (platform === 'TIKTOK' && entryUrl === PLATFORM_LOGIN.TIKTOK.home) {
    try {
      await session.page.goto(entryUrl, { waitUntil: 'commit', timeout: 45_000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isNavigationRace = /ERR_ABORTED|ERR_HTTP_RESPONSE_CODE_FAILURE|interrupted by another navigation|chrome-error:\/\/chromewebdata/i.test(message);
      await session.page.waitForTimeout?.(350);
      if (!isNavigationRace) throw error;
    }
    return;
  }
  try {
    await gotoPlatformPage(session.page, entryUrl, fallbackUrl);
  } catch (error) {
    // TikTok can render a usable profile surface while Chromium reports the
    // entry response as ERR_HTTP_RESPONSE_CODE_FAILURE. In a direct-entry
    // flow, retry at commit so the worker can inspect that rendered surface;
    // importantly, do not hide the problem by navigating to Home or Login.
    if (platform !== 'TIKTOK' || fallbackUrl || !isHttpResponseCodeFailure(error)) throw error;
    await session.page.waitForTimeout?.(750);
    await session.page.goto(entryUrl, { waitUntil: 'commit', timeout: 45_000 });
  }
}

function isHttpResponseCodeFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ERR_HTTP_RESPONSE_CODE_FAILURE/i.test(message);
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
